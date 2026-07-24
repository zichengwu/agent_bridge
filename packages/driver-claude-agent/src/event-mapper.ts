import {
  DRIVER_PROTOCOL_VERSION,
  AgentEventSequenceValidator,
  type AgentEvent,
  type DriverError,
  type JsonObject,
  type JsonValue,
  type PermissionKind,
} from "@agent-bridge/driver-protocol";

import { ClaudeAgentDriverError, redactClaudeJson } from "./errors.js";
import type { ClaudeRuntimeEvent } from "./runtime.js";

export interface ClaudeEventMapperRecoveryState {
  readonly version: 1;
}

export class ClaudeEventMapper {
  private activeSessionId: string;
  private cancelling = false;
  private nextSequence = 1;
  private terminal = false;
  private readonly completedToolCalls = new Set<string>();
  private readonly deniedToolCalls = new Set<string>();
  private readonly openToolCalls = new Set<string>();
  private readonly permissionToolCalls = new Map<string, string>();
  private readonly respondedPermissions = new Set<string>();
  private readonly validator = new AgentEventSequenceValidator();

  constructor(
    private readonly runId: string,
    sessionId: string,
    private readonly now: () => Date = () => new Date(),
    private readonly redact: (value: string) => string = (value) => value,
    recovery?: {
      readonly events: readonly AgentEvent[];
      readonly state: ClaudeEventMapperRecoveryState;
    },
  ) {
    this.activeSessionId = requireCorrelationId(sessionId, "sessionId");
    if (recovery !== undefined) {
      if (recovery.state.version !== 1) {
        throw new ClaudeAgentDriverError(
          "CLAUDE_RECOVERY_STATE_INVALID",
          "Claude event mapper recovery version is unsupported",
        );
      }
      for (const event of recovery.events) {
        this.restoreEvent(event);
      }
    }
  }

  get sessionId(): string {
    return this.activeSessionId;
  }

  get isTerminal(): boolean {
    return this.terminal;
  }

  snapshotRecoveryState(): ClaudeEventMapperRecoveryState {
    return { version: 1 };
  }

  start(preparedTaskId: string): AgentEvent {
    return this.emit({
      type: "run.started",
      preparedTaskId: requireCorrelationId(preparedTaskId, "preparedTaskId"),
    });
  }

  resume(reason: string): AgentEvent {
    return this.emit({
      type: "run.resumed",
      reason: this.redact(reason),
    });
  }

  successor(sessionId: string, reason: string): AgentEvent {
    this.assertSafeBoundary();
    const predecessorSessionId = this.activeSessionId;
    this.activeSessionId = requireCorrelationId(sessionId, "sessionId");
    return this.emit({
      type: "session.successor_created",
      predecessorSessionId,
      reason: this.redact(reason),
    });
  }

  cancellationRequested(reason: string): AgentEvent {
    this.cancelling = true;
    return this.emit({
      type: "run.cancellation_requested",
      reason: this.redact(reason),
    });
  }

  cancelled(reason: string): AgentEvent {
    return this.emit({
      type: "run.cancelled",
      reason: this.redact(reason),
    });
  }

  permissionResponded(input: {
    readonly permissionId: string;
    readonly toolCallId: string;
    readonly decision: "allow" | "deny";
    readonly reason?: string;
  }): AgentEvent {
    this.assertPermissionResponse(input.permissionId, input.toolCallId);
    this.permissionToolCalls.delete(input.permissionId);
    this.respondedPermissions.add(input.permissionId);
    if (input.decision === "deny") {
      this.deniedToolCalls.add(input.toolCallId);
    }
    return this.emit({
      type: "permission.responded",
      permissionId: input.permissionId,
      toolCallId: input.toolCallId,
      decision: input.decision,
      reason: input.reason === undefined ? undefined : this.redact(input.reason),
    });
  }

  assertPermissionResponse(permissionId: string, toolCallId: string): void {
    const expectedToolCallId = this.permissionToolCalls.get(permissionId);
    if (expectedToolCallId === undefined || expectedToolCallId !== toolCallId) {
      throw new ClaudeAgentDriverError(
        "CLAUDE_PERMISSION_MISMATCH",
        "Permission response does not match a pending Claude tool request",
        {
          permissionId,
          toolCallId,
        },
      );
    }
  }

  assertSafeBoundary(): void {
    if (
      this.terminal ||
      this.cancelling ||
      this.openToolCalls.size > 0 ||
      this.permissionToolCalls.size > 0
    ) {
      throw new ClaudeAgentDriverError(
        "CLAUDE_SUCCESSOR_NOT_SAFE",
        "Claude Session transition requires a safe event boundary",
      );
    }
  }

  map(event: ClaudeRuntimeEvent): AgentEvent[] {
    if (this.cancelling) {
      return [];
    }
    if (this.terminal) {
      throw new ClaudeAgentDriverError(
        "CLAUDE_EVENT_AFTER_TERMINAL",
        "Claude emitted an event after the terminal event",
        { type: event.type },
      );
    }

    this.assertRuntimeEventCorrelation(event);
    switch (event.type) {
      case "session.ready":
        return [];
      case "assistant.text":
        if (event.text.length === 0) {
          return [];
        }
        return [
          this.emit({
            type: "output.delta",
            messageId: event.messageId,
            channel: "assistant",
            delta: this.redact(event.text),
          }),
        ];
      case "tool.started":
        if (this.completedToolCalls.has(event.toolCallId)) {
          throw new ClaudeAgentDriverError(
            "CLAUDE_EVENT_AFTER_TERMINAL",
            "Claude restarted an already completed tool call",
            { toolCallId: event.toolCallId },
          );
        }
        if (this.openToolCalls.has(event.toolCallId)) {
          return [];
        }
        this.openToolCalls.add(event.toolCallId);
        return [
          this.emit({
            type: "tool.started",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: toJsonObject(event.input, this.redact),
          }),
        ];
      case "permission.requested":
        if (this.respondedPermissions.has(event.permissionId)) {
          throw new ClaudeAgentDriverError(
            "CLAUDE_PERMISSION_MISMATCH",
            "Claude repeated a permission request that was already answered",
            { permissionId: event.permissionId },
          );
        }
        if (this.permissionToolCalls.has(event.permissionId)) {
          return [];
        }
        if (!this.openToolCalls.has(event.toolCallId)) {
          throw new ClaudeAgentDriverError(
            "CLAUDE_PERMISSION_MISMATCH",
            "Claude permission request does not reference an active tool call",
            { permissionId: event.permissionId, toolCallId: event.toolCallId },
          );
        }
        this.permissionToolCalls.set(event.permissionId, event.toolCallId);
        return [
          this.emit({
            type: "permission.requested",
            permission: {
              permissionId: event.permissionId,
              toolCallId: event.toolCallId,
              kind: permissionKind(event.toolName),
              title: this.redact(event.title),
              description:
                event.description === undefined ? undefined : this.redact(event.description),
              details: toJsonObject(
                {
                  toolName: event.toolName,
                  input: event.input,
                  blockedPath: event.blockedPath,
                  decisionReason: event.decisionReason,
                },
                this.redact,
              ),
            },
          }),
        ];
      case "tool.completed": {
        if (this.completedToolCalls.has(event.toolCallId)) {
          return [];
        }
        if (!this.openToolCalls.delete(event.toolCallId)) {
          throw new ClaudeAgentDriverError(
            "CLAUDE_EVENT_CORRELATION_MISSING",
            "Claude tool result does not reference an active tool call",
            { toolCallId: event.toolCallId },
          );
        }
        this.completedToolCalls.add(event.toolCallId);
        const denied = event.outcome === "denied" || this.deniedToolCalls.has(event.toolCallId);
        const error: DriverError | undefined =
          event.outcome === "failed" && !denied
            ? {
                code: event.errorCode ?? "CLAUDE_TOOL_ERROR",
                message: this.redact(event.errorMessage ?? "Claude tool failed"),
                retryable: false,
              }
            : undefined;
        return [
          this.emit({
            type: "tool.completed",
            toolCallId: event.toolCallId,
            outcome: denied ? "denied" : event.outcome,
            output: redactClaudeJson(event.output, this.redact),
            error,
          }),
        ];
      }
      case "usage":
        return [
          this.emit({
            type: "usage.updated",
            usage: {
              protocolVersion: DRIVER_PROTOCOL_VERSION,
              sessionId: this.activeSessionId,
              source: "driver_estimate",
              usedTokens: event.inputTokens + event.outputTokens,
              measuredAt: this.now().toISOString(),
            },
          }),
        ];
      case "result":
        if (event.status === "succeeded") {
          return [this.emit({ type: "run.completed" })];
        }
        return [
          this.emit({
            type: "run.failed",
            error: {
              code: event.errorCode ?? "CLAUDE_RUN_FAILED",
              message: this.redact(event.errorMessage ?? "Claude run failed"),
              retryable: event.retryable,
            },
          }),
        ];
      case "runtime.error":
        return [
          this.emit({
            type: "run.failed",
            error: {
              code: event.code,
              message: this.redact(event.message),
              retryable: event.retryable,
            },
          }),
        ];
    }
  }

  private assertRuntimeEventCorrelation(event: ClaudeRuntimeEvent): void {
    const sessionId = requireCorrelationId(event.sessionId, "sessionId");
    if (sessionId !== this.activeSessionId) {
      throw new ClaudeAgentDriverError(
        "CLAUDE_SESSION_MISMATCH",
        "Claude event does not reference the active Session",
        { expected: this.activeSessionId, received: sessionId },
      );
    }
    switch (event.type) {
      case "assistant.text":
        requireCorrelationId(event.messageId, "messageId");
        break;
      case "tool.started":
      case "tool.completed":
        requireCorrelationId(event.toolCallId, "toolCallId");
        break;
      case "permission.requested":
        requireCorrelationId(event.permissionId, "permissionId");
        requireCorrelationId(event.toolCallId, "toolCallId");
        break;
      default:
        break;
    }
  }

  private emit(
    payload:
      | { readonly type: "run.started"; readonly preparedTaskId: string }
      | { readonly type: "run.resumed"; readonly reason: string }
      | {
          readonly type: "output.delta";
          readonly messageId: string;
          readonly channel: "assistant" | "system";
          readonly delta: string;
        }
      | {
          readonly type: "tool.started";
          readonly toolCallId: string;
          readonly toolName: string;
          readonly input?: JsonObject;
        }
      | {
          readonly type: "tool.completed";
          readonly toolCallId: string;
          readonly outcome: "succeeded" | "failed" | "denied" | "cancelled";
          readonly output?: JsonValue;
          readonly error?: DriverError;
        }
      | {
          readonly type: "permission.requested";
          readonly permission: {
            readonly permissionId: string;
            readonly toolCallId: string;
            readonly kind: PermissionKind;
            readonly title: string;
            readonly description?: string;
            readonly details?: JsonObject;
          };
        }
      | {
          readonly type: "permission.responded";
          readonly permissionId: string;
          readonly toolCallId: string;
          readonly decision: "allow" | "deny";
          readonly reason?: string;
        }
      | {
          readonly type: "usage.updated";
          readonly usage: {
            readonly protocolVersion: typeof DRIVER_PROTOCOL_VERSION;
            readonly sessionId: string;
            readonly source: "driver_estimate";
            readonly usedTokens: number;
            readonly measuredAt: string;
          };
        }
      | {
          readonly type: "session.successor_created";
          readonly predecessorSessionId: string;
          readonly reason: string;
        }
      | { readonly type: "run.cancellation_requested"; readonly reason: string }
      | { readonly type: "run.completed" }
      | { readonly type: "run.failed"; readonly error: DriverError }
      | { readonly type: "run.cancelled"; readonly reason: string },
  ): AgentEvent {
    const event = {
      ...payload,
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      eventId: `${this.runId}:event:${this.nextSequence}`,
      sequence: this.nextSequence,
      occurredAt: this.now().toISOString(),
      runId: this.runId,
      sessionId: this.activeSessionId,
    } as AgentEvent;
    this.validator.accept(event);
    this.nextSequence += 1;
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      this.terminal = true;
    }
    return event;
  }

  private restoreEvent(event: AgentEvent): void {
    if (event.runId !== this.runId) {
      throw new ClaudeAgentDriverError(
        "CLAUDE_RECOVERY_STATE_INVALID",
        "Recovery event does not reference the restored Claude Run",
      );
    }
    this.validator.accept(event);
    this.nextSequence = event.sequence + 1;
    this.activeSessionId = event.sessionId;
    switch (event.type) {
      case "tool.started":
        this.openToolCalls.add(event.toolCallId);
        break;
      case "tool.completed":
        this.openToolCalls.delete(event.toolCallId);
        this.completedToolCalls.add(event.toolCallId);
        break;
      case "permission.requested":
        this.permissionToolCalls.set(event.permission.permissionId, event.permission.toolCallId);
        break;
      case "permission.responded":
        this.permissionToolCalls.delete(event.permissionId);
        this.respondedPermissions.add(event.permissionId);
        if (event.decision === "deny") {
          this.deniedToolCalls.add(event.toolCallId);
        }
        break;
      case "run.cancellation_requested":
        this.cancelling = true;
        break;
      case "run.completed":
      case "run.failed":
      case "run.cancelled":
        this.terminal = true;
        break;
      default:
        break;
    }
  }
}

function requireCorrelationId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ClaudeAgentDriverError(
      "CLAUDE_EVENT_CORRELATION_MISSING",
      `Claude event ${field} must be a non-empty string`,
      { field },
    );
  }
  return value;
}

function permissionKind(toolName: string): PermissionKind {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("shell")) {
    return "process.execute";
  }
  if (normalized.includes("web") || normalized.includes("network")) {
    return "network.access";
  }
  if (normalized.includes("write") || normalized.includes("edit")) {
    return "filesystem.write";
  }
  if (normalized.includes("read") || normalized.includes("glob") || normalized.includes("grep")) {
    return "filesystem.read";
  }
  return "tool.use";
}

function toJsonObject(
  value: Readonly<Record<string, unknown>>,
  redact: (value: string) => string,
): JsonObject {
  const json = redactClaudeJson(value, redact);
  return typeof json === "object" && json !== null && !Array.isArray(json)
    ? (json as JsonObject)
    : {};
}
