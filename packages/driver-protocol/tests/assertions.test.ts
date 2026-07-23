import { describe, expect, it } from "vitest";

import {
  DRIVER_PROTOCOL_VERSION,
  DriverProtocolError,
  assertAgentCapabilities,
  assertAgentEvent,
  assertAgentEventSequence,
  type AgentCapabilities,
  type RunCompletedEvent,
  type RunStartedEvent,
} from "../src/index.js";

const timestamp = "2026-07-23T00:00:00.000Z";

function capabilities(): AgentCapabilities {
  return {
    protocolVersion: DRIVER_PROTOCOL_VERSION,
    driver: {
      id: "fake",
      displayName: "Fake Driver",
      driverVersion: "1.0.0",
    },
    sessions: {
      persistentIds: true,
      resume: true,
      successorSessions: true,
    },
    events: {
      streaming: true,
      strictOrdering: true,
    },
    permissions: {
      mode: "interactive",
      decisions: ["allow", "deny"],
    },
    cancellation: {
      supported: true,
      terminalEvent: true,
    },
    contextUsage: {
      mode: "exact",
    },
  };
}

function startedEvent(): RunStartedEvent {
  return {
    protocolVersion: DRIVER_PROTOCOL_VERSION,
    eventId: "event-1",
    sequence: 1,
    occurredAt: timestamp,
    runId: "run-1",
    sessionId: "session-1",
    type: "run.started",
    preparedTaskId: "prepared-1",
  };
}

function completedEvent(): RunCompletedEvent {
  return {
    protocolVersion: DRIVER_PROTOCOL_VERSION,
    eventId: "event-2",
    sequence: 2,
    occurredAt: timestamp,
    runId: "run-1",
    sessionId: "session-1",
    type: "run.completed",
  };
}

describe("Driver Protocol 运行时断言", () => {
  it("接受完整且自洽的能力声明", () => {
    const declaration: unknown = capabilities();

    expect(() => assertAgentCapabilities(declaration)).not.toThrow();
  });

  it("拒绝不支持的协议版本和不确定的取消语义", () => {
    const wrongVersion = {
      ...capabilities(),
      protocolVersion: "2.0",
    };
    const nondeterministicCancellation = {
      ...capabilities(),
      cancellation: {
        supported: true,
        terminalEvent: false,
      },
    };

    expectProtocolError(
      () => assertAgentCapabilities(wrongVersion),
      "DRIVER_PROTOCOL_VERSION_UNSUPPORTED",
    );
    expectProtocolError(
      () => assertAgentCapabilities(nondeterministicCancellation),
      "DRIVER_CAPABILITIES_INVALID",
    );
  });

  it("拒绝缺少 Run、Session 或事件关联 ID 的事件", () => {
    const missingRunId = {
      ...startedEvent(),
      runId: "",
    };

    expectProtocolError(() => assertAgentEvent(missingRunId), "DRIVER_EVENT_CORRELATION_MISSING");
  });

  it("拒绝乱序事件、未配对权限响应和终态后的事件", () => {
    expectProtocolError(
      () => assertAgentEventSequence([startedEvent(), { ...completedEvent(), sequence: 3 }]),
      "DRIVER_EVENT_SEQUENCE_VIOLATION",
    );

    expectProtocolError(
      () =>
        assertAgentEventSequence([
          startedEvent(),
          {
            protocolVersion: DRIVER_PROTOCOL_VERSION,
            eventId: "event-2",
            sequence: 2,
            occurredAt: timestamp,
            runId: "run-1",
            sessionId: "session-1",
            type: "permission.responded",
            permissionId: "permission-missing",
            toolCallId: "tool-1",
            decision: "allow",
          },
          { ...completedEvent(), eventId: "event-3", sequence: 3 },
        ]),
      "DRIVER_EVENT_SEQUENCE_VIOLATION",
    );

    expectProtocolError(
      () =>
        assertAgentEventSequence([
          startedEvent(),
          completedEvent(),
          {
            ...completedEvent(),
            eventId: "event-3",
            sequence: 3,
            type: "output.delta",
            messageId: "message-1",
            channel: "assistant",
            delta: "late",
          },
        ]),
      "DRIVER_EVENT_SEQUENCE_VIOLATION",
    );
  });
});

function expectProtocolError(operation: () => void, code: DriverProtocolError["code"]): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(DriverProtocolError);
    expect((error as DriverProtocolError).code).toBe(code);
    return;
  }

  throw new Error(`Expected DriverProtocolError with code ${code}`);
}
