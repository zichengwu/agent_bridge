import { createServer, type IncomingMessage, type Server } from "node:http";

import type { BLayerCandidateId, ProviderUsage } from "../contract.js";
import {
  mockUsage,
  writeMockResponse,
  type MockProtocol,
  type MockScenario,
} from "./mock-provider.js";

export interface GatewayLimits {
  maxRequests: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostMicros: number;
  maxBodyBytes: number;
}

export interface GatewayPolicy {
  candidate: BLayerCandidateId;
  protocol: MockProtocol;
  scenario: MockScenario;
  syntheticToken: string;
  allowedPaths: string[];
  allowedModel: string;
  logicalUpstreamOrigin: "https://api.deepseek.com";
  limits: GatewayLimits;
}

export interface GatewayAudit extends ProviderUsage {
  rejectedRequests: number;
  paths: string[];
  models: string[];
  rejectedModels: string[];
  rejectedPaths: string[];
  rejectionReasons: string[];
  rejectedMethods: string[];
  logicalUpstreamOrigin: string;
  realProviderRequests: 0;
  controlRequests: number;
}

export interface ProviderGateway {
  url: string;
  audit(): GatewayAudit;
  close(): Promise<void>;
}

const INPUT_PRICE_MICROS_PER_MILLION = 435_000;
const OUTPUT_PRICE_MICROS_PER_MILLION = 870_000;

export async function startProviderGateway(policy: GatewayPolicy): Promise<ProviderGateway> {
  if (new URL(policy.logicalUpstreamOrigin).hostname !== "api.deepseek.com") {
    throw new Error("PROVIDER_DOMAIN_NOT_ALLOWED");
  }
  const state: GatewayAudit = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    simulatedCostMicros: 0,
    circuitOpen: false,
    rejectedRequests: 0,
    paths: [],
    models: [],
    rejectedModels: [],
    rejectedPaths: [],
    rejectionReasons: [],
    rejectedMethods: [],
    logicalUpstreamOrigin: policy.logicalUpstreamOrigin,
    realProviderRequests: 0,
    controlRequests: 0,
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response, policy, state);
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Provider gateway did not expose a TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    audit: () => structuredClone(state),
    close: () => closeServer(server),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: import("node:http").ServerResponse,
  policy: GatewayPolicy,
  state: GatewayAudit,
): Promise<void> {
  try {
    if (state.circuitOpen) {
      reject(response, 429, "circuit_open", state);
      return;
    }
    if (!isLoopbackHost(request.headers.host)) {
      reject(response, 403, "host_not_allowed", state);
      return;
    }
    const path = normalizedPath(request.url);
    if (
      policy.protocol === "anthropic" &&
      path === "/anthropic" &&
      ["GET", "POST", "HEAD", "OPTIONS"].includes(request.method ?? "")
    ) {
      state.controlRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        request.method === "HEAD"
          ? undefined
          : JSON.stringify({ status: "loopback-gateway-ready" }),
      );
      return;
    }
    if (request.method !== "POST" || !policy.allowedPaths.includes(path)) {
      state.rejectedPaths.push(path);
      state.rejectedMethods.push(request.method ?? "unknown");
      reject(response, 404, "route_not_allowed", state);
      return;
    }
    if (!isAuthorized(request, policy.syntheticToken)) {
      reject(response, 401, "synthetic_token_invalid", state);
      return;
    }
    if (!(request.headers["content-type"] ?? "").toLowerCase().includes("application/json")) {
      reject(response, 415, "content_type_not_allowed", state);
      return;
    }
    const body = await readJsonBody(request, policy.limits.maxBodyBytes);
    const model = typeof body.model === "string" ? body.model : "";
    if (model !== policy.allowedModel) {
      state.rejectedModels.push(model);
      reject(response, 403, "model_not_allowed", state);
      return;
    }
    const usage = mockUsage(body);
    const nextCost = calculateCostMicros(usage.inputTokens, usage.outputTokens);
    if (
      state.requests + 1 > policy.limits.maxRequests ||
      state.inputTokens + usage.inputTokens > policy.limits.maxInputTokens ||
      state.outputTokens + usage.outputTokens > policy.limits.maxOutputTokens ||
      state.simulatedCostMicros + nextCost > policy.limits.maxCostMicros
    ) {
      state.circuitOpen = true;
      reject(response, 429, "budget_exceeded", state);
      return;
    }

    state.requests += 1;
    state.inputTokens += usage.inputTokens;
    state.outputTokens += usage.outputTokens;
    state.simulatedCostMicros += nextCost;
    state.paths.push(path);
    state.models.push(model);
    await writeMockResponse(
      response,
      {
        protocol: policy.protocol,
        model,
        scenario: policy.scenario,
        requestIndex: state.requests,
        body,
      },
      usage,
    );
  } catch (error) {
    state.circuitOpen = true;
    if (!response.headersSent) {
      reject(response, error instanceof RangeError ? 413 : 400, "invalid_request", state);
    } else {
      response.destroy();
    }
  }
}

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":", 1)[0];
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

function normalizedPath(value: string | undefined): string {
  if (value === undefined || /^https?:\/\//i.test(value)) {
    return "__invalid__";
  }
  const url = new URL(value, "http://127.0.0.1");
  if (url.pathname.includes("..") || decodeURIComponent(url.pathname).includes("..")) {
    return "__invalid__";
  }
  return url.pathname;
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const authorization = request.headers.authorization;
  const apiKey = request.headers["x-api-key"];
  return authorization === `Bearer ${token}` || apiKey === token;
}

async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const buffer of request as AsyncIterable<Buffer>) {
    size += buffer.length;
    if (size > maxBodyBytes) {
      throw new RangeError("request body too large");
    }
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function calculateCostMicros(inputTokens: number, outputTokens: number): number {
  return Math.ceil(
    (inputTokens * INPUT_PRICE_MICROS_PER_MILLION +
      outputTokens * OUTPUT_PRICE_MICROS_PER_MILLION) /
      1_000_000,
  );
}

function reject(
  response: import("node:http").ServerResponse,
  status: number,
  code: string,
  state: GatewayAudit,
): void {
  state.rejectedRequests += 1;
  state.rejectionReasons.push(code);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({ error: { type: code, message: "Provider gateway rejected request" } }),
  );
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, rejectPromise) => {
    server.close((error) => (error === undefined ? resolve() : rejectPromise(error)));
  });
}

export function defaultGatewayLimits(): GatewayLimits {
  return {
    maxRequests: 12,
    maxInputTokens: 200_000,
    maxOutputTokens: 16_000,
    maxCostMicros: 120_000,
    maxBodyBytes: 2 * 1024 * 1024,
  };
}
