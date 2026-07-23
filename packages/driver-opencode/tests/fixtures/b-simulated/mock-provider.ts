import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export type FormalProviderScenario = "write" | "deny" | "cancel" | "resume";

export interface FormalProviderAudit {
  readonly requests: number;
  readonly rejectedRequests: number;
  readonly paths: readonly string[];
  readonly models: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly realProviderRequests: 0;
}

export interface FormalMockProvider {
  readonly url: string;
  audit(): FormalProviderAudit;
  waitForRequests(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

const ALLOWED_PATH = "/v1/chat/completions";
const ALLOWED_MODEL = "deepseek-v4-pro";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REQUESTS = 6;

export async function startFormalMockProvider(input: {
  readonly scenario: FormalProviderScenario;
  readonly syntheticToken: string;
}): Promise<FormalMockProvider> {
  const state = {
    requests: 0,
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
    throw new Error("OPENCODE_B_SIMULATED_PROVIDER_ADDRESS_MISSING");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    audit: () => ({
      ...structuredClone(state),
      realProviderRequests: 0,
    }),
    waitForRequests: async (count, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (state.requests < count) {
        if (Date.now() >= deadline) {
          throw new Error("OPENCODE_B_SIMULATED_PROVIDER_TIMEOUT");
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
    readonly scenario: FormalProviderScenario;
    readonly syntheticToken: string;
  },
  state: {
    requests: number;
    rejectedRequests: number;
    paths: string[];
    models: string[];
    inputTokens: number;
    outputTokens: number;
  },
): Promise<void> {
  try {
    const path = normalizePath(request.url);
    if (
      request.method !== "POST" ||
      path !== ALLOWED_PATH ||
      !isLoopbackHost(request.headers.host)
    ) {
      reject(response, 404, state);
      return;
    }
    if (request.headers.authorization !== `Bearer ${policy.syntheticToken}`) {
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

    if (policy.scenario === "cancel" || (policy.scenario === "resume" && state.requests === 2)) {
      await waitForCancellation(response);
      return;
    }
    const tool =
      state.requests === 1
        ? selectTool(body, policy.scenario === "deny" ? "../outside.txt" : "src/sum.ts")
        : undefined;
    writeOpenAiResponse(response, {
      model,
      inputTokens,
      outputTokens,
      tool,
      text:
        policy.scenario === "deny"
          ? "The unsafe write was denied and no file was changed."
          : "The allowed file was updated and verified.",
    });
  } catch {
    reject(response, 400, state);
  }
}

function selectTool(
  body: Record<string, unknown>,
  path: string,
): { readonly name: string; readonly input: Record<string, unknown> } | undefined {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const names = tools.flatMap((tool): string[] => {
    if (typeof tool !== "object" || tool === null) {
      return [];
    }
    const record = tool as Record<string, unknown>;
    if (typeof record.name === "string") {
      return [record.name];
    }
    if (typeof record.function === "object" && record.function !== null) {
      const name = (record.function as Record<string, unknown>).name;
      return typeof name === "string" ? [name] : [];
    }
    return [];
  });
  const name = names.find((candidate) => /^(write|edit)$/i.test(candidate));
  if (name === undefined) {
    return undefined;
  }
  const serializedTools = JSON.stringify(tools);
  const pathKey = serializedTools.includes('"filePath"')
    ? "filePath"
    : serializedTools.includes('"file_path"')
      ? "file_path"
      : "path";
  const content = "export const sum = (a, b) => a + b;\n";
  if (/edit/i.test(name) && serializedTools.includes("oldString")) {
    return {
      name,
      input: {
        [pathKey]: path,
        oldString: "export const sum = (a, b) => a - b;",
        newString: content.trim(),
      },
    };
  }
  return {
    name,
    input: {
      [pathKey]: path,
      content,
    },
  };
}

function writeOpenAiResponse(
  response: ServerResponse,
  input: {
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly tool?: { readonly name: string; readonly input: Record<string, unknown> };
    readonly text: string;
  },
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const id = "chatcmpl-agent-bridge-formal-b-simulated";
  const created = 1_700_000_000;
  if (input.tool !== undefined) {
    sendChunk(response, {
      id,
      object: "chat.completion.chunk",
      created,
      model: input.model,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_agent_bridge_formal",
                type: "function",
                function: {
                  name: input.tool.name,
                  arguments: JSON.stringify(input.tool.input),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    sendChunk(response, {
      id,
      object: "chat.completion.chunk",
      created,
      model: input.model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: usage(input),
    });
  } else {
    sendChunk(response, {
      id,
      object: "chat.completion.chunk",
      created,
      model: input.model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: input.text },
          finish_reason: null,
        },
      ],
    });
    sendChunk(response, {
      id,
      object: "chat.completion.chunk",
      created,
      model: input.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: usage(input),
    });
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

function usage(input: { readonly inputTokens: number; readonly outputTokens: number }) {
  return {
    prompt_tokens: input.inputTokens,
    completion_tokens: input.outputTokens,
    total_tokens: input.inputTokens + input.outputTokens,
  };
}

function sendChunk(response: ServerResponse, value: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
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
