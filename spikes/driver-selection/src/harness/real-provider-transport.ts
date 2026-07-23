import { request as httpsRequest, type RequestOptions } from "node:https";
import type { IncomingHttpHeaders } from "node:http";

import type { ProviderProtocol } from "./provider-policy.js";

export interface UpstreamRequest {
  protocol: ProviderProtocol;
  origin: "https://api.deepseek.com";
  path: "/chat/completions" | "/anthropic/v1/messages";
  body: Buffer;
  credential: Buffer;
  sourceHeaders: IncomingHttpHeaders;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface UpstreamResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Buffer>;
  destroy(): void;
}

export interface UpstreamTransport {
  send(request: UpstreamRequest): Promise<UpstreamResponse>;
}

export class DeepSeekHttpsTransport implements UpstreamTransport {
  send(input: UpstreamRequest): Promise<UpstreamResponse> {
    const options = createRequestOptions(input);
    return new Promise((resolve, reject) => {
      const request = httpsRequest(options, (response) => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: response as AsyncIterable<Buffer>,
          destroy: () => response.destroy(),
        });
      });
      const onAbort = () => request.destroy(new Error("UPSTREAM_ABORTED"));
      input.signal.addEventListener("abort", onAbort, { once: true });
      request.once("error", reject);
      request.once("close", () => input.signal.removeEventListener("abort", onAbort));
      request.setTimeout(input.timeoutMs, () => request.destroy(new Error("UPSTREAM_TIMEOUT")));
      request.end(input.body);
    });
  }
}

export function createRequestOptions(input: UpstreamRequest): RequestOptions {
  if (input.origin !== "https://api.deepseek.com") {
    throw new Error("PROVIDER_DOMAIN_NOT_ALLOWED");
  }
  const credential = input.credential.toString("utf8");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream, application/json",
    "content-length": String(input.body.length),
    "user-agent": "agent-bridge-driver-selection-b-real",
  };
  if (input.protocol === "openai") {
    headers.authorization = `Bearer ${credential}`;
  } else {
    headers["x-api-key"] = credential;
    copyHeader(input.sourceHeaders, headers, "anthropic-version");
    copyHeader(input.sourceHeaders, headers, "anthropic-beta");
  }
  return {
    protocol: "https:",
    hostname: "api.deepseek.com",
    port: 443,
    method: "POST",
    path: input.path,
    servername: "api.deepseek.com",
    headers,
    agent: false,
  };
}

function copyHeader(
  source: IncomingHttpHeaders,
  target: Record<string, string>,
  name: string,
): void {
  const value = source[name];
  if (typeof value === "string") target[name] = value;
}
