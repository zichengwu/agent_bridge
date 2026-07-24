import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export type ClaudeFormalProviderScenario = "write" | "review" | "deny" | "cancel" | "resume";

export interface ClaudeFormalProviderAudit {
  readonly requests: number;
  readonly controlRequests: number;
  readonly rejectedRequests: number;
  readonly paths: readonly string[];
  readonly models: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly realProviderRequests: 0;
}

export interface ClaudeFormalMockProvider {
  readonly url: string;
  audit(): ClaudeFormalProviderAudit;
  waitForRequests(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

const ALLOWED_PATH = "/anthropic/v1/messages";
const ALLOWED_MODEL = "deepseek-v4-pro";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REQUESTS = 8;

export async function startClaudeFormalMockProvider(input: {
  readonly scenario: ClaudeFormalProviderScenario;
  readonly syntheticToken: string;
}): Promise<ClaudeFormalMockProvider> {
  const state = {
    requests: 0,
    controlRequests: 0,
    rejectedRequests: 0,
    paths: [] as string[],
    models: [] as string[],
    inputTokens: 0,
    outputTokens: 0,
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response, input, state);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("CLAUDE_B_SIMULATED_PROVIDER_ADDRESS_MISSING");
  }

  return {
    url: `http://127.0.0.1:${address.port}/anthropic`,
    audit: () => ({
      ...structuredClone(state),
      realProviderRequests: 0,
    }),
    waitForRequests: async (count, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (state.requests < count) {
        if (Date.now() >= deadline) {
          throw new Error("CLAUDE_B_SIMULATED_PROVIDER_TIMEOUT");
        }
        await delay(20);
      }
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  policy: {
    readonly scenario: ClaudeFormalProviderScenario;
    readonly syntheticToken: string;
  },
  state: {
    requests: number;
    controlRequests: number;
    rejectedRequests: number;
    paths: string[];
    models: string[];
    inputTokens: number;
    outputTokens: number;
  },
): Promise<void> {
  try {
    const path = normalizePath(request.url);
    if (!isLoopbackHost(request.headers.host)) {
      reject(response, 404, state);
      return;
    }
    if (
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
    if (request.method !== "POST" || path !== ALLOWED_PATH) {
      reject(response, 404, state);
      return;
    }
    const authorization = request.headers.authorization;
    const apiKey = request.headers["x-api-key"];
    if (authorization !== `Bearer ${policy.syntheticToken}` && apiKey !== policy.syntheticToken) {
      reject(response, 401, state);
      return;
    }
    if (!(request.headers["content-type"] ?? "").toLowerCase().includes("application/json")) {
      reject(response, 415, state);
      return;
    }
    if (state.requests >= MAX_REQUESTS) {
      reject(response, 429, state);
      return;
    }
    const body = await readJsonBody(request);
    const model = typeof body.model === "string" ? body.model : "";
    if (model !== ALLOWED_MODEL) {
      reject(response, 403, state);
      return;
    }

    state.requests += 1;
    state.paths.push(path);
    state.models.push(model);
    const inputTokens = Math.max(1, Math.ceil(JSON.stringify(body).length / 4));
    const outputTokens = 12;
    state.inputTokens += inputTokens;
    state.outputTokens += outputTokens;

    if (policy.scenario === "cancel" || (policy.scenario === "resume" && state.requests === 3)) {
      await waitForCancellation(response);
      return;
    }
    writeAnthropicResponse(response, {
      body,
      scenario: policy.scenario,
      requestIndex: state.requests,
      model,
      inputTokens,
      outputTokens,
    });
  } catch {
    reject(response, 400, state);
  }
}

function writeAnthropicResponse(
  response: ServerResponse,
  input: {
    readonly body: Record<string, unknown>;
    readonly scenario: ClaudeFormalProviderScenario;
    readonly requestIndex: number;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
  },
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const tool = selectTool(input.body, input.scenario, input.requestIndex);
  sendAnthropicEvent(response, "message_start", {
    type: "message_start",
    message: {
      id: `msg_agent_bridge_claude_${input.requestIndex}`,
      type: "message",
      role: "assistant",
      model: input.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: input.inputTokens, output_tokens: 0 },
    },
  });

  if (tool !== undefined) {
    const toolCallId = `toolu_agent_bridge_claude_${input.requestIndex}`;
    sendAnthropicEvent(response, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: toolCallId,
        name: tool.name,
        input: {},
      },
    });
    sendAnthropicEvent(response, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) },
    });
    sendAnthropicEvent(response, "content_block_stop", {
      type: "content_block_stop",
      index: 0,
    });
    sendAnthropicEvent(response, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: input.outputTokens },
    });
  } else {
    const text =
      input.scenario === "review"
        ? '{"findings":[],"conclusion":"passed"}'
        : "Claude Agent formal local simulation completed safely.";
    sendAnthropicEvent(response, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    sendAnthropicEvent(response, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    });
    sendAnthropicEvent(response, "content_block_stop", {
      type: "content_block_stop",
      index: 0,
    });
    sendAnthropicEvent(response, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: input.outputTokens },
    });
  }
  sendAnthropicEvent(response, "message_stop", { type: "message_stop" });
  response.end();
}

function selectTool(
  body: Record<string, unknown>,
  scenario: ClaudeFormalProviderScenario,
  requestIndex: number,
): { readonly name: string; readonly input: Record<string, unknown> } | undefined {
  const available = toolNames(body);
  if (scenario === "write") {
    if (requestIndex === 1) {
      return selectNamedTool(body, available, "Read", "src/sum.ts");
    }
    if (requestIndex === 2) {
      return selectNamedTool(
        body,
        available,
        "Write",
        "src/sum.ts",
        "export const sum = (a, b) => a + b;\n",
      );
    }
    return undefined;
  }
  if (scenario === "review" && requestIndex === 1) {
    return selectNamedTool(body, available, "Read", "src/sum.ts");
  }
  if (scenario === "deny" && requestIndex === 1) {
    return selectNamedTool(body, available, "Write", "../outside.txt", "out-of-scope\n");
  }
  if (scenario === "resume") {
    if (requestIndex === 1) {
      return selectNamedTool(body, available, "Read", "src/sum.ts");
    }
    if (requestIndex === 2) {
      return selectNamedTool(
        body,
        available,
        "Write",
        "src/sum.ts",
        "export const sum = (a, b) => a + b;\n",
      );
    }
  }
  return undefined;
}

function selectNamedTool(
  body: Record<string, unknown>,
  available: readonly string[],
  expectedName: string,
  path: string,
  content?: string,
): { readonly name: string; readonly input: Record<string, unknown> } | undefined {
  const name = available.find(
    (candidate) => candidate.toLowerCase() === expectedName.toLowerCase(),
  );
  if (name === undefined) {
    return undefined;
  }
  const serialized = JSON.stringify(body.tools ?? []);
  const pathKey = serialized.includes('"filePath"')
    ? "filePath"
    : serialized.includes('"file_path"')
      ? "file_path"
      : "path";
  return {
    name,
    input: {
      [pathKey]: path,
      ...(content === undefined ? {} : { content }),
    },
  };
}

function toolNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.flatMap((tool): string[] => {
    if (typeof tool !== "object" || tool === null) {
      return [];
    }
    const record = tool as Record<string, unknown>;
    return typeof record.name === "string" ? [record.name] : [];
  });
}

function sendAnthropicEvent(
  response: ServerResponse,
  event: string,
  value: Record<string, unknown>,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

async function waitForCancellation(response: ServerResponse): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 30_000);
    response.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (!response.destroyed) {
    response.destroy();
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new RangeError("request too large");
    }
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("request must be an object");
  }
  return value as Record<string, unknown>;
}

function normalizePath(value: string | undefined): string {
  if (value === undefined || /^https?:\/\//i.test(value)) {
    return "__invalid__";
  }
  const url = new URL(value, "http://127.0.0.1");
  if (url.pathname.includes("..") || decodeURIComponent(url.pathname).includes("..")) {
    return "__invalid__";
  }
  return url.pathname;
}

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) {
    return false;
  }
  const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

function reject(
  response: ServerResponse,
  status: number,
  state: { rejectedRequests: number },
): void {
  state.rejectedRequests += 1;
  if (!response.headersSent) {
    response.writeHead(status, { "content-type": "application/json" });
  }
  response.end(JSON.stringify({ error: { message: "Mock Provider request rejected" } }));
}
