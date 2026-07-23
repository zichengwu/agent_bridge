import {
  DRIVER_PROTOCOL_VERSION,
  AgentEventSequenceValidator,
  type AgentEvent,
  type DriverError,
  type JsonObject,
  type JsonValue,
  type PermissionKind,
} from "@agent-bridge/driver-protocol";

import { OpenCodeDriverError } from "./errors.js";
import type { OpenCodeRuntimeEvent } from "./runtime.js";

export class OpenCodeEventMapper {
  private activeSessionId: string;
  private nextSequence = 1;
  private terminal = false;
  private readonly completedToolCalls = new Set<string>();
  private readonly emittedTextParts = new Set<string>();
  private readonly openToolCalls = new Set<string>();
  private readonly permissionToolCalls = new Map<string, string>();
  private readonly respondedPermissions = new Set<string>();
  private readonly validator = new AgentEventSequenceValidator();

  constructor(
    private readonly runId: string,
    sessionId: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.activeSessionId = sessionId;
  }

  get sessionId(): string {
    return this.activeSessionId;
  }

  get isTerminal(): boolean {
    return this.terminal;
  }

  start(preparedTaskId: string): AgentEvent {
    return this.emit({
      type: "run.started",
      preparedTaskId,
    });
  }

  resume(reason: string): AgentEvent {
    return this.emit({
      type: "run.resumed",
      reason,
    });
  }

  successor(sessionId: string, reason: string): AgentEvent {
    this.assertSuccessorBoundary();
    const predecessorSessionId = this.activeSessionId;
    this.activeSessionId = sessionId;
    return this.emit({
      type: "session.successor_created",
      predecessorSessionId,
      reason,
    });
  }

  cancellationRequested(reason: string): AgentEvent {
    return this.emit({
      type: "run.cancellation_requested",
      reason,
    });
  }

  cancelled(reason: string): AgentEvent {
    return this.emit({
      type: "run.cancelled",
      reason,
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
    return this.emit({
      type: "permission.responded",
      permissionId: input.permissionId,
      toolCallId: input.toolCallId,
      decision: input.decision,
      reason: input.reason,
    });
  }

  assertPermissionResponse(permissionId: string, toolCallId: string): void {
    const expectedToolCallId = this.permissionToolCalls.get(permissionId);
    if (expectedToolCallId === undefined || expectedToolCallId !== toolCallId) {
      throw new OpenCodeDriverError(
        "OPENCODE_PERMISSION_MISMATCH",
        "Permission response does not match a pending OpenCode request",
        {
          permissionId,
          toolCallId,
        },
      );
    }
  }

  assertSuccessorBoundary(): void {
    if (this.terminal || this.openToolCalls.size > 0 || this.permissionToolCalls.size > 0) {
      throw new OpenCodeDriverError(
        "OPENCODE_SUCCESSOR_NOT_SAFE",
        "OpenCode successor Session requires a safe event boundary",
      );
    }
  }

  map(event: OpenCodeRuntimeEvent): AgentEvent[] {
    if (this.terminal) {
      return [];
    }

    switch (event.type) {
      case "text": {
        const delta = event.delta ?? (this.emittedTextParts.has(event.partId) ? "" : event.text);
        this.emittedTextParts.add(event.partId);
        if (delta.length === 0) {
          return [];
        }
        return [
          this.emit({
            type: "output.delta",
            messageId: event.messageId,
            channel: "assistant",
            delta,
          }),
        ];
      }
      case "tool":
        return this.mapTool(event);
      case "permission.requested": {
        if (this.permissionToolCalls.has(event.permissionId)) {
          return [];
        }
        const toolCallId = event.callId ?? event.messageId;
        this.permissionToolCalls.set(event.permissionId, toolCallId);
        return [
          this.emit({
            type: "permission.requested",
            permission: {
              permissionId: event.permissionId,
              toolCallId,
              kind: permissionKind(event.permission),
              title: event.title,
              details: toJsonObject(event.metadata),
            },
          }),
        ];
      }
      case "permission.responded": {
        if (this.respondedPermissions.has(event.permissionId)) {
          return [];
        }
        const toolCallId = this.permissionToolCalls.get(event.permissionId);
        if (toolCallId === undefined) {
          throw new OpenCodeDriverError(
            "OPENCODE_PERMISSION_MISMATCH",
            "OpenCode emitted a permission response without a pending request",
            { permissionId: event.permissionId },
          );
        }
        return [
          this.permissionResponded({
            permissionId: event.permissionId,
            toolCallId,
            decision: event.response === "reject" ? "deny" : "allow",
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
              source: "driver_exact",
              usedTokens: event.inputTokens + event.outputTokens,
              measuredAt: this.now().toISOString(),
            },
          }),
        ];
      case "session.created":
        return [];
      case "session.idle":
        return [this.emit({ type: "run.completed" })];
      case "session.error":
        return [
          this.emit({
            type: "run.failed",
            error: {
              code: event.code,
              message: "OpenCode reported a session error",
              retryable: event.retryable,
            },
          }),
        ];
    }
  }

  private mapTool(event: Extract<OpenCodeRuntimeEvent, { type: "tool" }>): AgentEvent[] {
    if (this.completedToolCalls.has(event.callId)) {
      return [];
    }

    const mapped: AgentEvent[] = [];
    if (!this.openToolCalls.has(event.callId)) {
      this.openToolCalls.add(event.callId);
      mapped.push(
        this.emit({
          type: "tool.started",
          toolCallId: event.callId,
          toolName: event.toolName,
          input: toJsonObject(event.input),
        }),
      );
    }

    if (event.status === "completed" || event.status === "error") {
      this.openToolCalls.delete(event.callId);
      this.completedToolCalls.add(event.callId);
      const error: DriverError | undefined =
        event.status === "error"
          ? {
              code: "OPENCODE_TOOL_ERROR",
              message: "OpenCode tool failed",
              retryable: false,
            }
          : undefined;
      mapped.push(
        this.emit({
          type: "tool.completed",
          toolCallId: event.callId,
          outcome: event.status === "completed" ? "succeeded" : "failed",
          output: event.output,
          error,
        }),
      );
    }

    return mapped;
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
            readonly source: "driver_exact";
            readonly usedTokens: number;
            readonly measuredAt: string;
          };
        }
      | {
          readonly type: "session.successor_created";
          readonly predecessorSessionId: string;
          readonly reason: string;
        }
      | {
          readonly type: "run.cancellation_requested";
          readonly reason: string;
        }
      | { readonly type: "run.completed" }
      | {
          readonly type: "run.failed";
          readonly error: DriverError;
        }
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
}

function permissionKind(permission: string): PermissionKind {
  const normalized = permission.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("shell")) {
    return "process.execute";
  }
  if (normalized.includes("web") || normalized.includes("network")) {
    return "network.access";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("external")
  ) {
    return "filesystem.write";
  }
  if (normalized.includes("read")) {
    return "filesystem.read";
  }
  return "tool.use";
}

function toJsonObject(value: Readonly<Record<string, unknown>>): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const json = toJsonValue(item);
    if (json !== undefined) {
      result[key] = json;
    }
  }
  return result;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => toJsonValue(item))
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (typeof value === "object") {
    return toJsonObject(value as Readonly<Record<string, unknown>>);
  }
  return undefined;
}
