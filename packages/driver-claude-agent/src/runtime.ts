import { access } from "node:fs/promises";

import {
  query,
  type PermissionResult,
  type Query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildClaudeAgentEnvironment,
  buildClaudeAgentQueryOptions,
  type ClaudeAgentIsolationConfiguration,
  type ClaudeAgentProviderConfiguration,
  type ClaudeAgentSecurityConfiguration,
} from "./config.js";
import { CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION } from "./capabilities.js";
import { ClaudeAgentDriverError, redactClaudeText } from "./errors.js";

export interface ClaudeRuntimeHealth {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly sdkVersion: string;
  readonly runtimeVersion: string;
  readonly message: string;
}

export interface ClaudeRuntimeSessionReady {
  readonly type: "session.ready";
  readonly sessionId: string;
}

export interface ClaudeRuntimeAssistantText {
  readonly type: "assistant.text";
  readonly sessionId: string;
  readonly messageId: string;
  readonly text: string;
}

export interface ClaudeRuntimeToolStarted {
  readonly type: "tool.started";
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ClaudeRuntimePermissionRequested {
  readonly type: "permission.requested";
  readonly sessionId: string;
  readonly permissionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly title: string;
  readonly description?: string;
  readonly blockedPath?: string;
  readonly decisionReason?: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ClaudeRuntimeToolCompleted {
  readonly type: "tool.completed";
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly outcome: "succeeded" | "failed" | "denied" | "cancelled";
  readonly output?: unknown;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface ClaudeRuntimeUsage {
  readonly type: "usage";
  readonly sessionId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface ClaudeRuntimeResult {
  readonly type: "result";
  readonly sessionId: string;
  readonly status: "succeeded" | "failed";
  readonly summary: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable: boolean;
}

export interface ClaudeRuntimeError {
  readonly type: "runtime.error";
  readonly sessionId: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type ClaudeRuntimeEvent =
  | ClaudeRuntimeSessionReady
  | ClaudeRuntimeAssistantText
  | ClaudeRuntimeToolStarted
  | ClaudeRuntimePermissionRequested
  | ClaudeRuntimeToolCompleted
  | ClaudeRuntimeUsage
  | ClaudeRuntimeResult
  | ClaudeRuntimeError;

export interface ClaudeRuntimeQuery {
  readonly sessionId: string;
  readonly events: AsyncIterable<ClaudeRuntimeEvent>;
  respondToPermission(input: {
    readonly permissionId: string;
    readonly toolCallId: string;
    readonly decision: "allow" | "deny";
    readonly reason?: string;
  }): Promise<void>;
  cancel(): Promise<boolean>;
  close(): void;
}

export interface ClaudeRuntime {
  readonly sdkVersion: string;
  readonly runtimeVersion: string;
  healthCheck(): Promise<ClaudeRuntimeHealth>;
  startQuery(input: {
    readonly workDirectory: string;
    readonly prompt: string;
    readonly resumeSessionId?: string;
    readonly forkSession?: boolean;
  }): Promise<ClaudeRuntimeQuery>;
  close(): Promise<void>;
}

export interface ClaudeAgentSdkRuntimeOptions {
  readonly isolation: ClaudeAgentIsolationConfiguration;
  readonly provider?: ClaudeAgentProviderConfiguration;
  readonly security?: ClaudeAgentSecurityConfiguration;
  readonly pathToClaudeCodeExecutable?: string;
  readonly sessionReadyTimeoutMs?: number;
}

interface PendingPermission {
  readonly toolCallId: string;
  readonly deferred: Deferred<PermissionResult>;
}

export class ClaudeAgentSdkRuntime implements ClaudeRuntime {
  readonly sdkVersion = CLAUDE_AGENT_SDK_VERSION;
  readonly runtimeVersion = CLAUDE_CODE_VERSION;

  private readonly activeQueries = new Set<ClaudeRuntimeQuery>();
  private readonly environment: Record<string, string>;
  private readonly privatePaths: readonly string[];
  private readonly privateValues: readonly string[];

  constructor(private readonly options: ClaudeAgentSdkRuntimeOptions) {
    this.environment = buildClaudeAgentEnvironment({
      isolation: options.isolation,
      provider: options.provider,
    });
    this.privatePaths = [
      options.isolation.homeDirectory,
      options.isolation.tempDirectory,
      options.isolation.configDirectory,
      options.isolation.dataDirectory,
      options.isolation.cacheDirectory,
      options.isolation.claudeConfigDirectory,
    ];
    this.privateValues = [options.provider?.authToken, options.provider?.apiKey].filter(
      (value): value is string => value !== undefined && value.length > 0,
    );
  }

  async healthCheck(): Promise<ClaudeRuntimeHealth> {
    if (this.options.pathToClaudeCodeExecutable !== undefined) {
      try {
        await access(this.options.pathToClaudeCodeExecutable);
      } catch {
        return {
          status: "degraded",
          sdkVersion: this.sdkVersion,
          runtimeVersion: this.runtimeVersion,
          message: "Claude Code executable is unavailable",
        };
      }
    }
    if (!hasExplicitProviderConfiguration(this.options.provider)) {
      return {
        status: "degraded",
        sdkVersion: this.sdkVersion,
        runtimeVersion: this.runtimeVersion,
        message: "Claude Provider configuration is incomplete",
      };
    }
    return {
      status: typeof query === "function" ? "healthy" : "unhealthy",
      sdkVersion: this.sdkVersion,
      runtimeVersion: this.runtimeVersion,
      message: `Claude Agent SDK ${this.sdkVersion}; Claude Code ${this.runtimeVersion}`,
    };
  }

  async startQuery(input: {
    readonly workDirectory: string;
    readonly prompt: string;
    readonly resumeSessionId?: string;
    readonly forkSession?: boolean;
  }): Promise<ClaudeRuntimeQuery> {
    if (!hasExplicitProviderConfiguration(this.options.provider)) {
      throw new ClaudeAgentDriverError(
        "CLAUDE_RUNTIME_ERROR",
        "Claude queries require an explicit isolated Provider URL, model, and credential",
      );
    }
    const controller = new AbortController();
    const events = new RuntimeEventQueue();
    const sessionReady = new Deferred<string>();
    const pendingPermissions = new Map<string, PendingPermission>();
    let activeSessionId: string | undefined;

    const canUseTool = async (
      toolName: string,
      toolInput: Record<string, unknown>,
      permission: {
        readonly signal: AbortSignal;
        readonly blockedPath?: string;
        readonly decisionReason?: string;
        readonly title?: string;
        readonly displayName?: string;
        readonly description?: string;
        readonly toolUseID: string;
        readonly requestId: string;
      },
    ): Promise<PermissionResult> => {
      const sessionId = requireRuntimeCorrelation(activeSessionId, "sessionId");
      const permissionId = requireRuntimeCorrelation(permission.requestId, "permissionId");
      const toolCallId = requireRuntimeCorrelation(permission.toolUseID, "toolCallId");
      if (pendingPermissions.has(permissionId)) {
        throw new ClaudeAgentDriverError(
          "CLAUDE_PERMISSION_MISMATCH",
          "Claude repeated a pending permission request",
          { permissionId },
        );
      }
      const deferred = new Deferred<PermissionResult>();
      pendingPermissions.set(permissionId, { toolCallId, deferred });
      events.push({
        type: "tool.started",
        sessionId,
        toolCallId,
        toolName,
        input: toolInput,
      });
      events.push({
        type: "permission.requested",
        sessionId,
        permissionId,
        toolCallId,
        toolName,
        title: permission.title ?? permission.displayName ?? `Claude requests ${toolName}`,
        description: permission.description,
        blockedPath: permission.blockedPath,
        decisionReason: permission.decisionReason,
        input: toolInput,
      });

      const abort = () => {
        if (pendingPermissions.delete(permissionId)) {
          deferred.resolve({
            behavior: "deny",
            message: "Agent Bridge cancelled the pending permission request.",
            interrupt: true,
            toolUseID: toolCallId,
            decisionClassification: "user_reject",
          });
        }
      };
      permission.signal.addEventListener("abort", abort, { once: true });
      controller.signal.addEventListener("abort", abort, { once: true });
      try {
        return await deferred.promise;
      } finally {
        permission.signal.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", abort);
      }
    };

    const sdkQuery = query({
      prompt: input.prompt,
      options: buildClaudeAgentQueryOptions({
        environment: this.environment,
        workDirectory: input.workDirectory,
        security: this.options.security,
        pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable,
        resumeSessionId: input.resumeSessionId,
        forkSession: input.forkSession,
        abortController: controller,
        canUseTool,
      }),
    });

    const pump = this.pumpSdkMessages(
      sdkQuery,
      events,
      sessionReady,
      pendingPermissions,
      (sessionId) => {
        activeSessionId = sessionId;
      },
      controller.signal,
    );
    void pump;

    let sessionId: string;
    try {
      sessionId = await withTimeout(
        sessionReady.promise,
        this.options.sessionReadyTimeoutMs ?? 10_000,
        "Claude did not emit a Session ID before the startup timeout",
      );
    } catch (error) {
      controller.abort();
      sdkQuery.close();
      throw runtimeFailure(
        "Unable to start the isolated Claude Agent query",
        error,
        this.privatePaths,
        this.privateValues,
      );
    }

    const runtimeQuery: ClaudeRuntimeQuery = {
      sessionId,
      events: events.stream(),
      respondToPermission: (response) => {
        const pending = pendingPermissions.get(response.permissionId);
        if (pending === undefined) {
          throw new ClaudeAgentDriverError(
            "CLAUDE_PERMISSION_NOT_PENDING",
            "Claude permission request is no longer pending",
            { permissionId: response.permissionId },
          );
        }
        if (pending.toolCallId !== response.toolCallId) {
          throw new ClaudeAgentDriverError(
            "CLAUDE_PERMISSION_MISMATCH",
            "Claude permission response toolCallId does not match",
            {
              permissionId: response.permissionId,
              expected: pending.toolCallId,
              received: response.toolCallId,
            },
          );
        }
        pendingPermissions.delete(response.permissionId);
        pending.deferred.resolve(
          response.decision === "allow"
            ? {
                behavior: "allow",
                toolUseID: response.toolCallId,
                decisionClassification: "user_temporary",
              }
            : {
                behavior: "deny",
                message: response.reason ?? "Agent Bridge denied this tool request.",
                interrupt: false,
                toolUseID: response.toolCallId,
                decisionClassification: "user_reject",
              },
        );
        return Promise.resolve();
      },
      cancel: () => {
        controller.abort();
        sdkQuery.close();
        return Promise.resolve(true);
      },
      close: () => {
        controller.abort();
        sdkQuery.close();
      },
    };
    this.activeQueries.add(runtimeQuery);
    void pump.finally(() => this.activeQueries.delete(runtimeQuery));
    return runtimeQuery;
  }

  close(): Promise<void> {
    for (const activeQuery of this.activeQueries) {
      activeQuery.close();
    }
    this.activeQueries.clear();
    return Promise.resolve();
  }

  private async pumpSdkMessages(
    sdkQuery: Query,
    events: RuntimeEventQueue,
    sessionReady: Deferred<string>,
    pendingPermissions: Map<string, PendingPermission>,
    setActiveSession: (sessionId: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let sessionId: string | undefined;
    const toolNames = new Map<string, string>();
    const completedToolCalls = new Set<string>();
    try {
      for await (const message of sdkQuery) {
        const messageSessionId = sdkSessionId(message);
        if (messageSessionId !== undefined) {
          if (sessionId === undefined) {
            sessionId = messageSessionId;
            setActiveSession(messageSessionId);
            sessionReady.resolve(messageSessionId);
            events.push({
              type: "session.ready",
              sessionId: messageSessionId,
            });
          } else if (messageSessionId !== sessionId) {
            throw new ClaudeAgentDriverError(
              "CLAUDE_SESSION_MISMATCH",
              "Claude changed Session ID within one query",
              { expected: sessionId, received: messageSessionId },
            );
          }
        }
        if (sessionId !== undefined) {
          for (const event of normalizeSdkMessage(
            message,
            sessionId,
            toolNames,
            completedToolCalls,
            this.redact.bind(this),
          )) {
            events.push(event);
          }
        }
      }
      if (sessionId === undefined && !signal.aborted) {
        sessionReady.reject(
          new ClaudeAgentDriverError(
            "CLAUDE_EVENT_CORRELATION_MISSING",
            "Claude query ended without a Session ID",
          ),
        );
      }
    } catch (error) {
      if (sessionId === undefined) {
        sessionReady.reject(error);
      } else if (!signal.aborted) {
        events.push({
          type: "runtime.error",
          sessionId,
          code: error instanceof ClaudeAgentDriverError ? error.code : "CLAUDE_RUNTIME_ERROR",
          message: this.redact(error instanceof Error ? error.message : String(error)),
          retryable: false,
        });
      }
    } finally {
      for (const [permissionId, pending] of pendingPermissions) {
        pending.deferred.resolve({
          behavior: "deny",
          message: "Claude query ended before Agent Bridge answered the permission request.",
          interrupt: true,
          toolUseID: pending.toolCallId,
          decisionClassification: "user_reject",
        });
        pendingPermissions.delete(permissionId);
      }
      events.close();
    }
  }

  private redact(value: string): string {
    return redactClaudeText(value, this.privatePaths, this.privateValues);
  }
}

function normalizeSdkMessage(
  message: SDKMessage,
  sessionId: string,
  toolNames: Map<string, string>,
  completedToolCalls: Set<string>,
  redact: (value: string) => string,
): ClaudeRuntimeEvent[] {
  const events: ClaudeRuntimeEvent[] = [];
  if (message.type === "assistant") {
    const blocks = asArray((message.message as { readonly content?: unknown }).content);
    for (const [index, block] of blocks.entries()) {
      const record = asRecord(block);
      if (record?.type === "text" && typeof record.text === "string") {
        events.push({
          type: "assistant.text",
          sessionId,
          messageId: `${message.uuid}:text:${index}`,
          text: record.text,
        });
      }
      if (
        record?.type === "tool_use" &&
        typeof record.id === "string" &&
        typeof record.name === "string"
      ) {
        const input = asRecord(record.input) ?? {};
        toolNames.set(record.id, record.name);
        events.push({
          type: "tool.started",
          sessionId,
          toolCallId: record.id,
          toolName: record.name,
          input,
        });
      }
    }
  }

  if (message.type === "user") {
    const blocks = asArray((message.message as { readonly content?: unknown }).content);
    for (const block of blocks) {
      const record = asRecord(block);
      if (record?.type !== "tool_result" || typeof record.tool_use_id !== "string") {
        continue;
      }
      const toolCallId = record.tool_use_id;
      if (completedToolCalls.has(toolCallId)) {
        continue;
      }
      completedToolCalls.add(toolCallId);
      const isError = record.is_error === true;
      events.push({
        type: "tool.completed",
        sessionId,
        toolCallId,
        outcome: isError ? "failed" : "succeeded",
        output: record.content ?? message.tool_use_result,
        errorCode: isError ? "CLAUDE_TOOL_ERROR" : undefined,
        errorMessage: isError ? "Claude tool returned an error" : undefined,
      });
    }
  }

  if (message.type === "system" && message.subtype === "permission_denied") {
    if (!completedToolCalls.has(message.tool_use_id)) {
      completedToolCalls.add(message.tool_use_id);
      events.push({
        type: "tool.completed",
        sessionId,
        toolCallId: message.tool_use_id,
        outcome: "denied",
        errorCode: "CLAUDE_TOOL_DENIED",
        errorMessage: redact(message.message),
      });
    }
  }

  if (message.type === "result") {
    for (const denial of message.permission_denials) {
      if (completedToolCalls.has(denial.tool_use_id)) {
        continue;
      }
      completedToolCalls.add(denial.tool_use_id);
      events.push({
        type: "tool.completed",
        sessionId,
        toolCallId: denial.tool_use_id,
        outcome: "denied",
        errorCode: "CLAUDE_TOOL_DENIED",
        errorMessage: "Agent Bridge denied the Claude tool request",
      });
    }
    events.push({
      type: "usage",
      sessionId,
      inputTokens: nonNegativeInteger(message.usage.input_tokens),
      outputTokens: nonNegativeInteger(message.usage.output_tokens),
      cacheReadTokens: nonNegativeInteger(message.usage.cache_read_input_tokens),
      cacheWriteTokens: nonNegativeInteger(message.usage.cache_creation_input_tokens),
    });
    if (message.subtype === "success" && !message.is_error) {
      events.push({
        type: "result",
        sessionId,
        status: "succeeded",
        summary: message.result,
        retryable: false,
      });
    } else {
      const errorMessage =
        message.subtype === "success"
          ? "Claude result was marked as an error"
          : message.errors.join("; ") || `Claude result subtype ${message.subtype}`;
      events.push({
        type: "result",
        sessionId,
        status: "failed",
        summary: "Claude run failed",
        errorCode: claudeResultErrorCode(message.subtype),
        errorMessage: redact(errorMessage),
        retryable: isRetryableClaudeResult(errorMessage),
      });
    }
  }
  return events;
}

function sdkSessionId(message: SDKMessage): string | undefined {
  return "session_id" in message && typeof message.session_id === "string"
    ? message.session_id
    : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function nonNegativeInteger(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function claudeResultErrorCode(subtype: string): string {
  return `CLAUDE_${subtype.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}`;
}

function isRetryableClaudeResult(message: string): boolean {
  return /rate.?limit|overload|timeout|temporar|connection/i.test(message);
}

function hasExplicitProviderConfiguration(
  provider: ClaudeAgentProviderConfiguration | undefined,
): boolean {
  return (
    provider?.baseUrl !== undefined &&
    provider.baseUrl.trim().length > 0 &&
    provider.model !== undefined &&
    provider.model.trim().length > 0 &&
    ((provider.authToken !== undefined && provider.authToken.length > 0) ||
      (provider.apiKey !== undefined && provider.apiKey.length > 0))
  );
}

function requireRuntimeCorrelation(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ClaudeAgentDriverError(
      "CLAUDE_EVENT_CORRELATION_MISSING",
      `Claude Runtime ${field} must be a non-empty string`,
      { field },
    );
  }
  return value;
}

function runtimeFailure(
  message: string,
  cause: unknown,
  privatePaths: readonly string[],
  privateValues: readonly string[],
): ClaudeAgentDriverError {
  return new ClaudeAgentDriverError("CLAUDE_RUNTIME_ERROR", message, {
    cause: cause instanceof Error ? cause.name : typeof cause,
    reason: redactClaudeText(
      cause instanceof Error ? cause.message : String(cause),
      privatePaths,
      privateValues,
    ).slice(0, 500),
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeout.unref();
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolvePromise!: (value: T) => void;
  private rejectPromise!: (reason?: unknown) => void;
  private settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  resolve(value: T): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolvePromise(value);
  }

  reject(reason: unknown): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.rejectPromise(reason instanceof Error ? reason : new Error(String(reason)));
  }
}

class RuntimeEventQueue {
  private closed = false;
  private readonly events: ClaudeRuntimeEvent[] = [];
  private readonly listeners = new Set<() => void>();

  push(event: ClaudeRuntimeEvent): void {
    if (this.closed) {
      return;
    }
    this.events.push(event);
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  async *stream(): AsyncIterable<ClaudeRuntimeEvent> {
    let cursor = 0;
    while (true) {
      while (cursor < this.events.length) {
        yield this.events[cursor++]!;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.listeners.add(resolve);
      });
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
    this.listeners.clear();
  }
}
