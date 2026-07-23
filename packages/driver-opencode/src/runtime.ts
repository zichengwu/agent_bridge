import { createServer } from "node:net";
import { delimiter, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createOpencode, type Event as OpenCodeSdkEvent } from "@opencode-ai/sdk";

import { buildOpenCodeConfig, type OpenCodeProviderConfiguration } from "./config.js";
import { OpenCodeDriverError } from "./errors.js";

export interface OpenCodeRuntimeSession {
  readonly id: string;
}

export interface OpenCodeRuntimeHealth {
  readonly healthy: boolean;
  readonly version: string;
}

export interface OpenCodeRuntimeTextPart {
  readonly type: "text";
  readonly sessionId: string;
  readonly messageId: string;
  readonly partId: string;
  readonly text: string;
  readonly delta?: string;
}

export interface OpenCodeRuntimeToolPart {
  readonly type: "tool";
  readonly sessionId: string;
  readonly messageId: string;
  readonly partId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly status: "pending" | "running" | "completed" | "error";
  readonly input: Readonly<Record<string, unknown>>;
  readonly output?: string;
  readonly error?: string;
}

export interface OpenCodeRuntimePermissionRequested {
  readonly type: "permission.requested";
  readonly sessionId: string;
  readonly permissionId: string;
  readonly messageId: string;
  readonly callId?: string;
  readonly permission: string;
  readonly title: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface OpenCodeRuntimePermissionResponded {
  readonly type: "permission.responded";
  readonly sessionId: string;
  readonly permissionId: string;
  readonly response: string;
}

export interface OpenCodeRuntimeUsage {
  readonly type: "usage";
  readonly sessionId: string;
  readonly messageId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly completed: boolean;
}

export interface OpenCodeRuntimeSessionIdle {
  readonly type: "session.idle";
  readonly sessionId: string;
}

export interface OpenCodeRuntimeSessionCreated {
  readonly type: "session.created";
  readonly sessionId: string;
}

export interface OpenCodeRuntimeSessionError {
  readonly type: "session.error";
  readonly sessionId?: string;
  readonly code: string;
  readonly retryable: boolean;
}

export type OpenCodeRuntimeEvent =
  | OpenCodeRuntimeTextPart
  | OpenCodeRuntimeToolPart
  | OpenCodeRuntimePermissionRequested
  | OpenCodeRuntimePermissionResponded
  | OpenCodeRuntimeUsage
  | OpenCodeRuntimeSessionCreated
  | OpenCodeRuntimeSessionIdle
  | OpenCodeRuntimeSessionError;

export interface OpenCodeRuntime {
  readonly version: string;
  healthCheck(): Promise<OpenCodeRuntimeHealth>;
  createSession(input: {
    readonly directory: string;
    readonly title: string;
    readonly parentSessionId?: string;
  }): Promise<OpenCodeRuntimeSession>;
  getSession(sessionId: string, directory: string): Promise<OpenCodeRuntimeSession>;
  subscribe(directory: string, signal: AbortSignal): Promise<AsyncIterable<OpenCodeRuntimeEvent>>;
  prompt(sessionId: string, directory: string, prompt: string): Promise<void>;
  respondToPermission(input: {
    readonly sessionId: string;
    readonly permissionId: string;
    readonly directory: string;
    readonly decision: "allow" | "deny";
  }): Promise<void>;
  abortSession(sessionId: string, directory: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface OpenCodeSdkRuntimeOptions {
  readonly hostname?: string;
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly provider?: OpenCodeProviderConfiguration;
}

export class OpenCodeSdkRuntime implements OpenCodeRuntime {
  readonly version = "1.18.3";

  private constructor(
    private readonly client: Awaited<ReturnType<typeof createOpencode>>["client"],
    private readonly server: Awaited<ReturnType<typeof createOpencode>>["server"],
    private readonly serverController: AbortController,
  ) {}

  static async start(options: OpenCodeSdkRuntimeOptions = {}): Promise<OpenCodeSdkRuntime> {
    const serverController = new AbortController();
    try {
      const instance = await startSdkInstance(options, serverController);
      return new OpenCodeSdkRuntime(instance.client, instance.server, serverController);
    } catch (error) {
      serverController.abort();
      throw runtimeFailure("Unable to start OpenCode Headless Server", error);
    }
  }

  async healthCheck(): Promise<OpenCodeRuntimeHealth> {
    try {
      const response = await fetch(`${this.server.url}/global/health`);
      const body = (await response.json()) as {
        healthy?: unknown;
        version?: unknown;
      };
      return {
        healthy: response.ok && body.healthy === true,
        version: typeof body.version === "string" ? body.version : this.version,
      };
    } catch (error) {
      throw runtimeFailure("OpenCode health check failed", error);
    }
  }

  async createSession(input: {
    readonly directory: string;
    readonly title: string;
    readonly parentSessionId?: string;
  }): Promise<OpenCodeRuntimeSession> {
    try {
      const response = await this.client.session.create({
        body: {
          title: input.title,
          parentID: input.parentSessionId,
        },
        query: { directory: input.directory },
        throwOnError: true,
      });
      return { id: response.data.id };
    } catch (error) {
      throw runtimeFailure("OpenCode session creation failed", error);
    }
  }

  async getSession(sessionId: string, directory: string): Promise<OpenCodeRuntimeSession> {
    try {
      const response = await this.client.session.get({
        path: { id: sessionId },
        query: { directory },
        throwOnError: true,
      });
      return { id: response.data.id };
    } catch (error) {
      throw runtimeFailure("OpenCode session lookup failed", error);
    }
  }

  async subscribe(
    directory: string,
    signal: AbortSignal,
  ): Promise<AsyncIterable<OpenCodeRuntimeEvent>> {
    try {
      const subscription = await this.client.event.subscribe({
        query: { directory },
        signal,
      });
      return normalizeEventStream(subscription.stream);
    } catch (error) {
      throw runtimeFailure("OpenCode event subscription failed", error);
    }
  }

  async prompt(sessionId: string, directory: string, prompt: string): Promise<void> {
    try {
      await this.client.session.promptAsync({
        path: { id: sessionId },
        query: { directory },
        body: {
          parts: [{ type: "text", text: prompt }],
        },
        throwOnError: true,
      });
    } catch (error) {
      throw runtimeFailure("OpenCode prompt submission failed", error);
    }
  }

  async respondToPermission(input: {
    readonly sessionId: string;
    readonly permissionId: string;
    readonly directory: string;
    readonly decision: "allow" | "deny";
  }): Promise<void> {
    try {
      await this.client.postSessionIdPermissionsPermissionId({
        path: {
          id: input.sessionId,
          permissionID: input.permissionId,
        },
        query: { directory: input.directory },
        body: {
          response: input.decision === "allow" ? "once" : "reject",
        },
        throwOnError: true,
      });
    } catch (error) {
      throw runtimeFailure("OpenCode permission response failed", error);
    }
  }

  async abortSession(sessionId: string, directory: string): Promise<boolean> {
    try {
      const response = await this.client.session.abort({
        path: { id: sessionId },
        query: { directory },
        throwOnError: true,
      });
      return response.data;
    } catch (error) {
      throw runtimeFailure("OpenCode session cancellation failed", error);
    }
  }

  async close(): Promise<void> {
    this.server.close();
    this.serverController.abort();
    await delay(300);
  }
}

async function startSdkInstance(
  options: OpenCodeSdkRuntimeOptions,
  serverController: AbortController,
): Promise<Awaited<ReturnType<typeof createOpencode>>> {
  const originalPath = process.env.PATH;
  const packageBinDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "node_modules",
    ".bin",
  );
  process.env.PATH =
    originalPath === undefined
      ? packageBinDirectory
      : `${packageBinDirectory}${delimiter}${originalPath}`;
  try {
    const port = options.port ?? (await reserveTcpPort());
    return await createOpencode({
      hostname: options.hostname ?? "127.0.0.1",
      port,
      signal: serverController.signal,
      timeout: options.timeoutMs ?? 15_000,
      config: buildOpenCodeConfig(options.provider),
    });
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
}

function reserveTcpPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve an OpenCode loopback port"));
        return;
      }
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function* normalizeEventStream(
  stream: AsyncIterable<OpenCodeSdkEvent>,
): AsyncIterable<OpenCodeRuntimeEvent> {
  for await (const event of stream) {
    const normalized = normalizeSdkEvent(event);
    if (normalized !== undefined) {
      yield normalized;
    }
  }
}

function normalizeSdkEvent(event: OpenCodeSdkEvent): OpenCodeRuntimeEvent | undefined {
  switch (event.type) {
    case "message.part.updated": {
      const { part } = event.properties;
      if (part.type === "text") {
        return {
          type: "text",
          sessionId: part.sessionID,
          messageId: part.messageID,
          partId: part.id,
          text: part.text,
          delta: event.properties.delta,
        };
      }
      if (part.type === "tool") {
        return {
          type: "tool",
          sessionId: part.sessionID,
          messageId: part.messageID,
          partId: part.id,
          callId: part.callID,
          toolName: part.tool,
          status: part.state.status,
          input: part.state.input,
          output: part.state.status === "completed" ? part.state.output : undefined,
          error: part.state.status === "error" ? part.state.error : undefined,
        };
      }
      return undefined;
    }
    case "permission.updated":
      return {
        type: "permission.requested",
        sessionId: event.properties.sessionID,
        permissionId: event.properties.id,
        messageId: event.properties.messageID,
        callId: event.properties.callID,
        permission: event.properties.type,
        title: event.properties.title,
        metadata: event.properties.metadata,
      };
    case "permission.replied":
      return {
        type: "permission.responded",
        sessionId: event.properties.sessionID,
        permissionId: event.properties.permissionID,
        response: event.properties.response,
      };
    case "message.updated": {
      const { info } = event.properties;
      if (info.role !== "assistant") {
        return undefined;
      }
      return {
        type: "usage",
        sessionId: info.sessionID,
        messageId: info.id,
        inputTokens: info.tokens.input,
        outputTokens: info.tokens.output,
        cacheReadTokens: info.tokens.cache.read,
        cacheWriteTokens: info.tokens.cache.write,
        completed: info.time.completed !== undefined,
      };
    }
    case "session.idle":
      return {
        type: "session.idle",
        sessionId: event.properties.sessionID,
      };
    case "session.created":
      return {
        type: "session.created",
        sessionId: event.properties.info.id,
      };
    case "session.error": {
      const error = event.properties.error;
      return {
        type: "session.error",
        sessionId: event.properties.sessionID,
        code: error?.name ?? "OpenCodeSessionError",
        retryable: error?.name === "APIError" && error.data.isRetryable,
      };
    }
    default:
      return undefined;
  }
}

function runtimeFailure(message: string, cause: unknown): OpenCodeDriverError {
  return new OpenCodeDriverError("OPENCODE_RUNTIME_ERROR", message, {
    cause: cause instanceof Error ? cause.name : typeof cause,
  });
}
