import { DriverProtocolError } from "./errors.js";
import { DRIVER_PROTOCOL_VERSION, type AgentCapabilities, type AgentEvent } from "./types.js";

type UnknownRecord = Record<string, unknown>;

const EVENT_TYPES = new Set([
  "run.started",
  "run.resumed",
  "output.delta",
  "tool.started",
  "tool.completed",
  "permission.requested",
  "permission.responded",
  "usage.updated",
  "session.successor_created",
  "run.cancellation_requested",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

const PERMISSION_KINDS = new Set([
  "filesystem.read",
  "filesystem.write",
  "process.execute",
  "network.access",
  "tool.use",
  "other",
]);

const CONTEXT_USAGE_SOURCES = new Set(["driver_exact", "driver_estimate", "bridge_estimate"]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(
  code: ConstructorParameters<typeof DriverProtocolError>[0],
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new DriverProtocolError(code, message, details);
}

function requireRecord(
  value: unknown,
  field: string,
  code: ConstructorParameters<typeof DriverProtocolError>[0],
): UnknownRecord {
  if (!isRecord(value)) {
    fail(code, `${field} must be an object`, { field });
  }

  return value;
}

function requireString(
  value: unknown,
  field: string,
  code: ConstructorParameters<typeof DriverProtocolError>[0],
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(code, `${field} must be a non-empty string`, { field });
  }

  return value;
}

function requireBoolean(
  value: unknown,
  field: string,
  code: ConstructorParameters<typeof DriverProtocolError>[0],
): boolean {
  if (typeof value !== "boolean") {
    fail(code, `${field} must be a boolean`, { field });
  }

  return value;
}

function requireNonNegativeInteger(
  value: unknown,
  field: string,
  code: ConstructorParameters<typeof DriverProtocolError>[0],
): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    fail(code, `${field} must be a non-negative integer`, { field });
  }

  return Number(value);
}

function requireTimestamp(
  value: unknown,
  field: string,
  code: ConstructorParameters<typeof DriverProtocolError>[0],
): string {
  const timestamp = requireString(value, field, code);
  if (Number.isNaN(Date.parse(timestamp))) {
    fail(code, `${field} must be an ISO-compatible timestamp`, { field });
  }

  return timestamp;
}

function requireProtocolVersion(value: unknown, subject: "capabilities" | "event"): void {
  if (value !== DRIVER_PROTOCOL_VERSION) {
    fail("DRIVER_PROTOCOL_VERSION_UNSUPPORTED", `Unsupported ${subject} protocol version`, {
      expected: DRIVER_PROTOCOL_VERSION,
      received: value,
    });
  }
}

function requireCorrelationId(value: unknown, field: string): string {
  return requireString(value, field, "DRIVER_EVENT_CORRELATION_MISSING");
}

function assertDriverError(value: unknown, field: string): void {
  const error = requireRecord(value, field, "DRIVER_EVENT_INVALID");
  requireString(error.code, `${field}.code`, "DRIVER_EVENT_INVALID");
  requireString(error.message, `${field}.message`, "DRIVER_EVENT_INVALID");
  requireBoolean(error.retryable, `${field}.retryable`, "DRIVER_EVENT_INVALID");
}

export function assertAgentCapabilities(value: unknown): asserts value is AgentCapabilities {
  const capabilities = requireRecord(value, "capabilities", "DRIVER_CAPABILITIES_INVALID");
  requireProtocolVersion(capabilities.protocolVersion, "capabilities");

  const driver = requireRecord(capabilities.driver, "driver", "DRIVER_CAPABILITIES_INVALID");
  requireString(driver.id, "driver.id", "DRIVER_CAPABILITIES_INVALID");
  requireString(driver.displayName, "driver.displayName", "DRIVER_CAPABILITIES_INVALID");
  requireString(driver.driverVersion, "driver.driverVersion", "DRIVER_CAPABILITIES_INVALID");

  const sessions = requireRecord(capabilities.sessions, "sessions", "DRIVER_CAPABILITIES_INVALID");
  const persistentIds = requireBoolean(
    sessions.persistentIds,
    "sessions.persistentIds",
    "DRIVER_CAPABILITIES_INVALID",
  );
  requireBoolean(sessions.resume, "sessions.resume", "DRIVER_CAPABILITIES_INVALID");
  const successorSessions = requireBoolean(
    sessions.successorSessions,
    "sessions.successorSessions",
    "DRIVER_CAPABILITIES_INVALID",
  );
  if (!persistentIds || !successorSessions) {
    fail(
      "DRIVER_CAPABILITIES_INVALID",
      "Persistent session IDs and successor sessions are required",
      { persistentIds, successorSessions },
    );
  }

  const events = requireRecord(capabilities.events, "events", "DRIVER_CAPABILITIES_INVALID");
  const streaming = requireBoolean(
    events.streaming,
    "events.streaming",
    "DRIVER_CAPABILITIES_INVALID",
  );
  const strictOrdering = requireBoolean(
    events.strictOrdering,
    "events.strictOrdering",
    "DRIVER_CAPABILITIES_INVALID",
  );
  if (!streaming || !strictOrdering) {
    fail("DRIVER_CAPABILITIES_INVALID", "Streaming and strict event ordering are required", {
      streaming,
      strictOrdering,
    });
  }

  const permissions = requireRecord(
    capabilities.permissions,
    "permissions",
    "DRIVER_CAPABILITIES_INVALID",
  );
  if (permissions.mode !== "none" && permissions.mode !== "interactive") {
    fail("DRIVER_CAPABILITIES_INVALID", "permissions.mode must be none or interactive", {
      field: "permissions.mode",
    });
  }
  if (!Array.isArray(permissions.decisions)) {
    fail("DRIVER_CAPABILITIES_INVALID", "permissions.decisions must be an array", {
      field: "permissions.decisions",
    });
  }
  const decisions = new Set(permissions.decisions);
  if ([...decisions].some((decision) => decision !== "allow" && decision !== "deny")) {
    fail("DRIVER_CAPABILITIES_INVALID", "permissions.decisions contains an unsupported decision");
  }
  if (
    (permissions.mode === "none" && decisions.size !== 0) ||
    (permissions.mode === "interactive" && (!decisions.has("allow") || !decisions.has("deny")))
  ) {
    fail("DRIVER_CAPABILITIES_INVALID", "Permission mode and decisions are inconsistent", {
      mode: permissions.mode,
    });
  }

  const cancellation = requireRecord(
    capabilities.cancellation,
    "cancellation",
    "DRIVER_CAPABILITIES_INVALID",
  );
  const cancellationSupported = requireBoolean(
    cancellation.supported,
    "cancellation.supported",
    "DRIVER_CAPABILITIES_INVALID",
  );
  const terminalEvent = requireBoolean(
    cancellation.terminalEvent,
    "cancellation.terminalEvent",
    "DRIVER_CAPABILITIES_INVALID",
  );
  if (!cancellationSupported || !terminalEvent) {
    fail(
      "DRIVER_CAPABILITIES_INVALID",
      "Deterministic cancellation with a terminal event is required",
      { cancellationSupported, terminalEvent },
    );
  }

  const contextUsage = requireRecord(
    capabilities.contextUsage,
    "contextUsage",
    "DRIVER_CAPABILITIES_INVALID",
  );
  if (
    contextUsage.mode !== "exact" &&
    contextUsage.mode !== "estimated" &&
    contextUsage.mode !== "unavailable"
  ) {
    fail("DRIVER_CAPABILITIES_INVALID", "contextUsage.mode is unsupported", {
      field: "contextUsage.mode",
    });
  }
}

export function assertAgentEvent(value: unknown): asserts value is AgentEvent {
  const event = requireRecord(value, "event", "DRIVER_EVENT_INVALID");
  requireProtocolVersion(event.protocolVersion, "event");
  requireCorrelationId(event.eventId, "eventId");
  const sequence = requireNonNegativeInteger(event.sequence, "sequence", "DRIVER_EVENT_INVALID");
  if (sequence === 0) {
    fail("DRIVER_EVENT_INVALID", "sequence must be greater than zero", {
      field: "sequence",
    });
  }
  requireTimestamp(event.occurredAt, "occurredAt", "DRIVER_EVENT_INVALID");
  requireCorrelationId(event.runId, "runId");
  requireCorrelationId(event.sessionId, "sessionId");

  const type = requireString(event.type, "type", "DRIVER_EVENT_INVALID");
  if (!EVENT_TYPES.has(type)) {
    fail("DRIVER_EVENT_INVALID", "Unsupported event type", { type });
  }

  switch (type) {
    case "run.started":
      requireCorrelationId(event.preparedTaskId, "preparedTaskId");
      break;
    case "run.resumed":
    case "run.cancellation_requested":
    case "run.cancelled":
      requireString(event.reason, "reason", "DRIVER_EVENT_INVALID");
      break;
    case "output.delta":
      requireCorrelationId(event.messageId, "messageId");
      if (event.channel !== "assistant" && event.channel !== "system") {
        fail("DRIVER_EVENT_INVALID", "output.delta channel is unsupported");
      }
      if (typeof event.delta !== "string") {
        fail("DRIVER_EVENT_INVALID", "output.delta delta must be a string");
      }
      break;
    case "tool.started":
      requireCorrelationId(event.toolCallId, "toolCallId");
      requireString(event.toolName, "toolName", "DRIVER_EVENT_INVALID");
      break;
    case "tool.completed":
      requireCorrelationId(event.toolCallId, "toolCallId");
      if (
        event.outcome !== "succeeded" &&
        event.outcome !== "failed" &&
        event.outcome !== "denied" &&
        event.outcome !== "cancelled"
      ) {
        fail("DRIVER_EVENT_INVALID", "tool.completed outcome is unsupported");
      }
      if (event.error !== undefined) {
        assertDriverError(event.error, "error");
      }
      break;
    case "permission.requested": {
      const permission = requireRecord(event.permission, "permission", "DRIVER_EVENT_INVALID");
      requireCorrelationId(permission.permissionId, "permission.permissionId");
      requireCorrelationId(permission.toolCallId, "permission.toolCallId");
      const kind = requireString(permission.kind, "permission.kind", "DRIVER_EVENT_INVALID");
      if (!PERMISSION_KINDS.has(kind)) {
        fail("DRIVER_EVENT_INVALID", "permission.kind is unsupported", { kind });
      }
      requireString(permission.title, "permission.title", "DRIVER_EVENT_INVALID");
      break;
    }
    case "permission.responded":
      requireCorrelationId(event.permissionId, "permissionId");
      requireCorrelationId(event.toolCallId, "toolCallId");
      if (event.decision !== "allow" && event.decision !== "deny") {
        fail("DRIVER_EVENT_INVALID", "permission.responded decision is unsupported");
      }
      break;
    case "usage.updated": {
      const usage = requireRecord(event.usage, "usage", "DRIVER_EVENT_INVALID");
      requireProtocolVersion(usage.protocolVersion, "event");
      requireCorrelationId(usage.sessionId, "usage.sessionId");
      if (!CONTEXT_USAGE_SOURCES.has(String(usage.source))) {
        fail("DRIVER_EVENT_INVALID", "usage.source is unsupported", {
          source: usage.source,
        });
      }
      requireNonNegativeInteger(usage.usedTokens, "usage.usedTokens", "DRIVER_EVENT_INVALID");
      if (usage.maxTokens !== undefined) {
        const maxTokens = requireNonNegativeInteger(
          usage.maxTokens,
          "usage.maxTokens",
          "DRIVER_EVENT_INVALID",
        );
        if (maxTokens === 0) {
          fail("DRIVER_EVENT_INVALID", "usage.maxTokens must be greater than zero");
        }
      }
      requireTimestamp(usage.measuredAt, "usage.measuredAt", "DRIVER_EVENT_INVALID");
      break;
    }
    case "session.successor_created":
      requireCorrelationId(event.predecessorSessionId, "predecessorSessionId");
      requireString(event.reason, "reason", "DRIVER_EVENT_INVALID");
      break;
    case "run.failed":
      assertDriverError(event.error, "error");
      break;
    case "run.completed":
      break;
  }
}

interface PendingPermission {
  readonly toolCallId: string;
}

export class AgentEventSequenceValidator {
  private activeSessionId?: string;
  private cancellationRequested = false;
  private expectedSequence = 1;
  private runId?: string;
  private started = false;
  private terminal = false;
  private readonly eventIds = new Set<string>();
  private readonly openToolCalls = new Set<string>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  accept(value: unknown): AgentEvent {
    assertAgentEvent(value);
    const event = value;

    if (this.terminal) {
      this.sequenceFailure("Events are not allowed after a terminal event", event);
    }
    if (event.sequence !== this.expectedSequence) {
      this.sequenceFailure("Event sequence must be contiguous", event, {
        expectedSequence: this.expectedSequence,
      });
    }
    if (this.eventIds.has(event.eventId)) {
      this.sequenceFailure("eventId must be unique within a run", event);
    }

    if (!this.started) {
      if (event.type !== "run.started") {
        this.sequenceFailure("The first event must be run.started", event);
      }
      this.started = true;
      this.runId = event.runId;
      this.activeSessionId = event.sessionId;
    } else {
      if (event.type === "run.started") {
        this.sequenceFailure("run.started may only occur once", event);
      }
      if (event.runId !== this.runId) {
        this.sequenceFailure("An event stream cannot contain multiple runs", event, {
          expectedRunId: this.runId,
        });
      }
      if (event.type === "session.successor_created") {
        if (event.predecessorSessionId !== this.activeSessionId) {
          this.sequenceFailure("A successor must reference the active session", event, {
            activeSessionId: this.activeSessionId,
          });
        }
        if (event.sessionId === event.predecessorSessionId) {
          this.sequenceFailure("A successor session must have a new sessionId", event);
        }
        if (this.openToolCalls.size > 0 || this.pendingPermissions.size > 0) {
          this.sequenceFailure("A successor session requires a safe event boundary", event);
        }
        this.activeSessionId = event.sessionId;
      } else if (event.sessionId !== this.activeSessionId) {
        this.sequenceFailure("Event sessionId is not the active session", event, {
          activeSessionId: this.activeSessionId,
        });
      }
    }

    switch (event.type) {
      case "tool.started":
        if (this.openToolCalls.has(event.toolCallId)) {
          this.sequenceFailure("toolCallId is already active", event);
        }
        this.openToolCalls.add(event.toolCallId);
        break;
      case "tool.completed":
        if (!this.openToolCalls.delete(event.toolCallId)) {
          this.sequenceFailure("tool.completed must reference an active tool call", event);
        }
        break;
      case "permission.requested":
        if (this.pendingPermissions.has(event.permission.permissionId)) {
          this.sequenceFailure("permissionId is already pending", event);
        }
        this.pendingPermissions.set(event.permission.permissionId, {
          toolCallId: event.permission.toolCallId,
        });
        break;
      case "permission.responded": {
        const pending = this.pendingPermissions.get(event.permissionId);
        if (pending === undefined) {
          this.sequenceFailure("permission.responded must reference a pending request", event);
        }
        if (pending.toolCallId !== event.toolCallId) {
          this.sequenceFailure("Permission response toolCallId does not match its request", event);
        }
        this.pendingPermissions.delete(event.permissionId);
        break;
      }
      case "usage.updated":
        if (event.usage.sessionId !== event.sessionId) {
          this.sequenceFailure("Usage must reference the event session", event);
        }
        break;
      case "run.cancellation_requested":
        if (this.cancellationRequested) {
          this.sequenceFailure("Cancellation may only be requested once per run", event);
        }
        this.cancellationRequested = true;
        break;
      case "run.completed":
        if (this.openToolCalls.size > 0 || this.pendingPermissions.size > 0) {
          this.sequenceFailure("A completed run cannot have pending tools or permissions", event);
        }
        this.terminal = true;
        break;
      case "run.cancelled":
        if (!this.cancellationRequested) {
          this.sequenceFailure("run.cancelled requires run.cancellation_requested", event);
        }
        this.terminal = true;
        break;
      case "run.failed":
        this.terminal = true;
        break;
      default:
        break;
    }

    this.eventIds.add(event.eventId);
    this.expectedSequence += 1;
    return event;
  }

  assertTerminal(): void {
    if (!this.terminal) {
      fail("DRIVER_EVENT_SEQUENCE_VIOLATION", "Event stream must end with a terminal event", {
        nextExpectedSequence: this.expectedSequence,
      });
    }
  }

  private sequenceFailure(
    message: string,
    event: AgentEvent,
    details?: Readonly<Record<string, unknown>>,
  ): never {
    fail("DRIVER_EVENT_SEQUENCE_VIOLATION", message, {
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type,
      ...details,
    });
  }
}

export function assertAgentEventSequence(
  events: Iterable<unknown>,
): asserts events is Iterable<AgentEvent> {
  const validator = new AgentEventSequenceValidator();
  for (const event of events) {
    validator.accept(event);
  }
  validator.assertTerminal();
}
