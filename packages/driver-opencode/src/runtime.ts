import { createServer } from "node:net";
import { basename, delimiter, dirname, resolve } from "node:path";
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
  readonly patterns?: string | readonly string[];
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
  readonly executablePath?: string;
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
        signal,
      });
      return normalizeEventStream(subscription.stream, this.client, directory);
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
    await this.stopInstance();
  }

  private async stopInstance(): Promise<void> {
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
  const executableDirectory =
    options.executablePath === undefined ? packageBinDirectory : dirname(options.executablePath);
  if (options.executablePath !== undefined && basename(options.executablePath) !== "opencode") {
    throw new OpenCodeDriverError(
      "OPENCODE_RUNTIME_ERROR",
      "The isolated OpenCode executable must be named opencode",
    );
  }
  process.env.PATH =
    originalPath === undefined
      ? executableDirectory
      : `${executableDirectory}${delimiter}${originalPath}`;
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
  client: Awaited<ReturnType<typeof createOpencode>>["client"],
  directory: string,
): AsyncIterable<OpenCodeRuntimeEvent> {
  const assistantMessageIds = new Set<string>();
  const knownMessageIds = new Set<string>();
  const pendingParts = new Map<string, OpenCodeSdkEvent[]>();
  for await (const event of stream) {
    if (event.type === "message.part.updated") {
      const messageId = event.properties.part.messageID;
      if (!knownMessageIds.has(messageId)) {
        const pending = pendingParts.get(messageId) ?? [];
        pending.push(event);
        pendingParts.set(messageId, pending);
        continue;
      }
    }
    if (event.type === "message.updated") {
      knownMessageIds.add(event.properties.info.id);
      if (event.properties.info.role === "assistant") {
        assistantMessageIds.add(event.properties.info.id);
      } else {
        assistantMessageIds.delete(event.properties.info.id);
      }
      const pending = pendingParts.get(event.properties.info.id) ?? [];
      pendingParts.delete(event.properties.info.id);
      for (const partEvent of pending) {
        const normalizedPart = normalizeSdkEvent(partEvent, assistantMessageIds);
        if (normalizedPart !== undefined) {
          yield normalizedPart;
        }
      }
    }
    const normalized = normalizeSdkEvent(event, assistantMessageIds);
    if (normalized !== undefined) {
      if (normalized.type === "session.idle") {
        const messages = await client.session.messages({
          path: { id: normalized.sessionId },
          query: { directory },
          throwOnError: true,
        });
        for (const message of messages.data) {
          if (message.info.role !== "assistant") {
            continue;
          }
          for (const part of message.parts) {
            if (part.type === "text" && part.text.length > 0) {
              yield {
                type: "text",
                sessionId: part.sessionID,
                messageId: part.messageID,
                partId: part.id,
                text: part.text,
              };
            }
          }
        }
      }
      yield normalized;
    }
  }
}

function normalizeSdkEvent(
  event: OpenCodeSdkEvent,
  assistantMessageIds: ReadonlySet<string>,
): OpenCodeRuntimeEvent | undefined {
  const genericEvent = event as unknown as {
    readonly type: string;
    readonly properties: Readonly<Record<string, unknown>>;
  };
  if (genericEvent.type === "permission.asked") {
    const properties = genericEvent.properties;
    const tool =
      typeof properties.tool === "object" && properties.tool !== null
        ? (properties.tool as Readonly<Record<string, unknown>>)
        : undefined;
    if (
      typeof properties.id !== "string" ||
      typeof properties.sessionID !== "string" ||
      typeof properties.permission !== "string"
    ) {
      return undefined;
    }
    return {
      type: "permission.requested",
      sessionId: properties.sessionID,
      permissionId: properties.id,
      messageId: typeof tool?.messageID === "string" ? tool.messageID : properties.id,
      callId: typeof tool?.callID === "string" ? tool.callID : undefined,
      permission: properties.permission,
      title: `OpenCode requests ${properties.permission}`,
      patterns: Array.isArray(properties.patterns)
        ? properties.patterns.filter((pattern): pattern is string => typeof pattern === "string")
        : undefined,
      metadata:
        typeof properties.metadata === "object" && properties.metadata !== null
          ? (properties.metadata as Readonly<Record<string, unknown>>)
          : {},
    };
  }
  if (genericEvent.type === "permission.replied") {
    const properties = genericEvent.properties;
    const permissionId =
      typeof properties.permissionID === "string"
        ? properties.permissionID
        : typeof properties.requestID === "string"
          ? properties.requestID
          : undefined;
    const response =
      typeof properties.response === "string"
        ? properties.response
        : typeof properties.reply === "string"
          ? properties.reply
          : undefined;
    if (
      typeof properties.sessionID !== "string" ||
      permissionId === undefined ||
      response === undefined
    ) {
      return undefined;
    }
    return {
      type: "permission.responded",
      sessionId: properties.sessionID,
      permissionId,
      response,
    };
  }

  switch (event.type) {
    case "message.part.updated": {
      const { part } = event.properties;
      if (!assistantMessageIds.has(part.messageID)) {
        return undefined;
      }
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
        patterns: event.properties.pattern,
        metadata: event.properties.metadata,
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
    reason: sanitizeRuntimeCause(cause),
  });
}

function sanitizeRuntimeCause(cause: unknown): string {
  if (!(cause instanceof Error)) {
    return typeof cause;
  }
  return cause.message
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|x-api-key|access[_-]?token|authorization|cookie)["'\s:=]+)[^\s,"'}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(?:\/[^\s:]+)+/g, (path) => classifyRuntimePath(path))
    .slice(0, 500);
}

function classifyRuntimePath(path: string): string {
  const roots: Array<readonly [string, string | undefined]> = [
    ["WORK_DIRECTORY", process.cwd()],
    ["ISOLATED_HOME", process.env.HOME],
    ["ISOLATED_TEMP", process.env.TMPDIR],
    ["ISOLATED_CONFIG", process.env.XDG_CONFIG_HOME],
    ["ISOLATED_DATA", process.env.XDG_DATA_HOME],
    ["ISOLATED_CACHE", process.env.XDG_CACHE_HOME],
    ["OPENCODE_CONFIG", process.env.OPENCODE_CONFIG_DIR],
  ];
  const match = roots.find(([, root]) => root !== undefined && path.startsWith(root));
  return match === undefined ? "[PATH]" : `[${match[0]}]`;
}
