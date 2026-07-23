import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { RealProviderUsage } from "../contract.js";
import {
  assertRealGatewayPolicy,
  calculateProviderCostMicros,
  type RealGatewayPolicy,
} from "./provider-policy.js";
import { ProviderStreamAuditor } from "./provider-stream-audit.js";
import { DeepSeekHttpsTransport, type UpstreamTransport } from "./real-provider-transport.js";

export interface RealProviderGatewayCore {
  url: string;
  audit(): RealProviderUsage;
  close(): Promise<void>;
}

export async function startRealProviderGatewayCore(input: {
  policy: RealGatewayPolicy;
  credential: Buffer;
  transport?: UpstreamTransport;
}): Promise<RealProviderGatewayCore> {
  assertRealGatewayPolicy(input.policy);
  const transport = input.transport ?? new DeepSeekHttpsTransport();
  const startedAt = Date.now();
  const state: RealProviderUsage = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicrosUsd: 0,
    rejectedRequests: 0,
    realProviderRequests: 0,
    circuitOpen: false,
    models: [],
    paths: [],
    statusCodes: [],
    requestIds: [],
    terminalReasons: [],
    errorClasses: [],
  };
  const server = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      input.policy,
      input.credential,
      transport,
      state,
      startedAt,
    );
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("REAL_GATEWAY_NO_ADDRESS");
  return {
    url: `http://127.0.0.1:${address.port}`,
    audit: () => structuredClone(state),
    close: () => closeServer(server),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  policy: RealGatewayPolicy,
  credential: Buffer,
  transport: UpstreamTransport,
  state: RealProviderUsage,
  startedAt: number,
): Promise<void> {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  try {
    if (state.circuitOpen) return reject(response, 429, "circuit_open", state);
    if (Date.now() - startedAt >= policy.limits.maxWallClockMs) {
      state.circuitOpen = true;
      return reject(response, 429, "wall_clock_exceeded", state);
    }
    const path = normalizedPath(request.url);
    if (policy.protocol === "anthropic" && path === "/anthropic") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "real-gateway-ready" }));
      return;
    }
    if (
      request.method !== "POST" ||
      path !== policy.localPath ||
      !isLoopbackHost(request.headers.host)
    ) {
      return reject(response, 404, "route_not_allowed", state);
    }
    if (!isAuthorized(request, policy.syntheticToken)) {
      return reject(response, 401, "synthetic_token_invalid", state);
    }
    const originalBody = await readBody(request, policy.limits.maxBodyBytes);
    const body = prepareRequestBody(originalBody, policy);
    const estimatedInput = Math.max(1, Math.ceil(body.length / 4));
    const requestedOutput = requestedOutputTokens(body);
    const reservedCost = calculateProviderCostMicros(
      state.inputTokens + estimatedInput,
      state.outputTokens + requestedOutput,
      policy.price,
    );
    if (
      state.requests + 1 > policy.limits.maxRequests ||
      state.inputTokens + estimatedInput > policy.limits.maxInputTokens ||
      state.outputTokens + requestedOutput > policy.limits.maxOutputTokens ||
      reservedCost > policy.limits.maxCostMicros
    ) {
      state.circuitOpen = true;
      return reject(response, 429, "budget_exceeded", state);
    }

    state.requests += 1;
    state.realProviderRequests += 1;
    state.paths.push(policy.upstreamPath);
    const upstream = await transport.send({
      protocol: policy.protocol,
      origin: policy.upstreamOrigin,
      path: policy.upstreamPath,
      body,
      credential,
      sourceHeaders: request.headers,
      timeoutMs: policy.limits.maxRequestMs,
      signal: controller.signal,
    });
    state.statusCodes.push(upstream.statusCode);
    if (upstream.statusCode >= 300 && upstream.statusCode < 400) {
      state.circuitOpen = true;
      upstream.destroy();
      return reject(response, 502, "upstream_redirect_rejected", state);
    }
    if (upstream.statusCode >= 400) {
      state.circuitOpen = true;
      state.errorClasses.push(`http_${upstream.statusCode}`);
    }

    response.writeHead(upstream.statusCode, responseHeaders(upstream.headers));
    const auditor = new ProviderStreamAuditor(policy.protocol);
    let responseBytes = 0;
    for await (const chunk of upstream.body) {
      responseBytes += chunk.length;
      if (responseBytes > policy.limits.maxResponseBytes) {
        state.circuitOpen = true;
        upstream.destroy();
        throw new Error("UPSTREAM_RESPONSE_TOO_LARGE");
      }
      auditor.push(chunk);
      if (!response.write(chunk))
        await new Promise<void>((resolve) => response.once("drain", resolve));
    }
    response.end();
    const evidence = auditor.finish();
    mergeEvidence(state, evidence);
    if (!evidence.modelObserved || evidence.models.some((model) => model !== policy.allowedModel)) {
      state.circuitOpen = true;
      state.errorClasses.push(
        evidence.modelObserved ? "response_model_not_allowed" : "response_model_missing",
      );
    }
    if (upstream.statusCode < 400 && !evidence.usageObserved) {
      state.circuitOpen = true;
      state.errorClasses.push("usage_missing");
    }
    state.costMicrosUsd = calculateProviderCostMicros(
      state.inputTokens,
      state.outputTokens,
      policy.price,
    );
    if (state.costMicrosUsd >= policy.limits.maxCostMicros) state.circuitOpen = true;
  } catch (error) {
    if (controller.signal.aborted) {
      state.terminalReasons.push("client_cancelled");
      if (!response.headersSent) {
        response.writeHead(499, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { type: "client_cancelled" } }));
      } else {
        response.destroy();
      }
      return;
    }
    state.circuitOpen = true;
    state.errorClasses.push(classifyError(error));
    if (!response.headersSent) reject(response, 502, "upstream_failure", state);
    else response.destroy();
  }
}

function prepareRequestBody(body: Buffer, policy: RealGatewayPolicy): Buffer {
  const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  if (parsed.model !== policy.allowedModel) throw new Error("PROVIDER_MODEL_NOT_ALLOWED");
  parsed.max_tokens = Math.min(numberOr(parsed.max_tokens, 2_048), 2_048);
  if (policy.protocol === "openai") {
    parsed.stream_options = { include_usage: true };
    if (typeof parsed.max_completion_tokens === "number") {
      parsed.max_completion_tokens = Math.min(parsed.max_completion_tokens, 2_048);
    }
  }
  return Buffer.from(JSON.stringify(parsed));
}

function requestedOutputTokens(body: Buffer): number {
  const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  return numberOr(parsed.max_completion_tokens ?? parsed.max_tokens, 2_048);
}

function mergeEvidence(
  state: RealProviderUsage,
  evidence: ReturnType<ProviderStreamAuditor["finish"]>,
): void {
  state.inputTokens += evidence.inputTokens;
  state.outputTokens += evidence.outputTokens;
  pushUnique(state.models, evidence.models);
  pushUnique(state.requestIds, evidence.requestIds);
  pushUnique(state.terminalReasons, evidence.terminalReasons);
}

function pushUnique(target: string[], values: string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value);
}

function responseHeaders(headers: import("node:http").IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = { "content-type": "application/json" };
  for (const name of ["content-type", "request-id", "x-request-id"]) {
    const value = headers[name];
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

function normalizedPath(value: string | undefined): string {
  if (value === undefined || /^https?:\/\//i.test(value)) return "__invalid__";
  return new URL(value, "http://127.0.0.1").pathname;
}

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  return ["127.0.0.1", "localhost", "::1"].includes(
    host.replace(/^\[|\]$/g, "").split(":", 1)[0] ?? "",
  );
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  return (
    request.headers.authorization === `Bearer ${token}` || request.headers["x-api-key"] === token
  );
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new RangeError("REQUEST_BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function classifyError(error: unknown): string {
  if (error instanceof RangeError) return "request_too_large";
  if (error instanceof SyntaxError) return "invalid_json";
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message))
    return error.message.toLowerCase();
  return "upstream_failure";
}

function reject(
  response: ServerResponse,
  status: number,
  code: string,
  state: RealProviderUsage,
): void {
  state.rejectedRequests += 1;
  state.errorClasses.push(code);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({ error: { type: code, message: "Provider gateway rejected request" } }),
  );
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
