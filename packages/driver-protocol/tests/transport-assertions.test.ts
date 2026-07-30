import { describe, expect, it } from "vitest";

import {
  DRIVER_PROTOCOL_VERSION,
  DRIVER_TRANSPORT_VERSION,
  DriverTransportError,
  assertDriverTransportMessage,
  readDriverWorkerInitialization,
} from "../src/index.js";

describe("Driver Transport 运行时断言", () => {
  it.each([
    {
      kind: "ready",
      transportVersion: DRIVER_TRANSPORT_VERSION,
      hostId: "worker-1",
    },
    {
      kind: "request",
      transportVersion: DRIVER_TRANSPORT_VERSION,
      requestId: "request-1",
      method: "healthCheck",
      params: {},
    },
    {
      kind: "response",
      transportVersion: DRIVER_TRANSPORT_VERSION,
      requestId: "request-1",
      ok: true,
      result: null,
    },
    {
      kind: "event",
      transportVersion: DRIVER_TRANSPORT_VERSION,
      subscriptionId: "subscription-1",
      event: {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        eventId: "event-1",
        sequence: 1,
        occurredAt: "2026-07-28T00:00:00.000Z",
        runId: "run-1",
        sessionId: "session-1",
        type: "run.completed",
      },
    },
    {
      kind: "stream_closed",
      transportVersion: DRIVER_TRANSPORT_VERSION,
      subscriptionId: "subscription-1",
    },
  ])("接受 $kind 消息", (message) => {
    expect(() => assertDriverTransportMessage(message)).not.toThrow();
  });

  it.each([
    ["unsupported version", { kind: "ready", transportVersion: "2.0", hostId: "worker-1" }],
    [
      "unknown method",
      {
        kind: "request",
        transportVersion: DRIVER_TRANSPORT_VERSION,
        requestId: "request-1",
        method: "vendor.magic",
        params: {},
      },
    ],
    [
      "unknown field",
      {
        kind: "ready",
        transportVersion: DRIVER_TRANSPORT_VERSION,
        hostId: "worker-1",
        secret: "must-not-be-accepted",
      },
    ],
  ])("拒绝 %s", (_label, message) => {
    expect(() => assertDriverTransportMessage(message)).toThrowError(DriverTransportError);
  });

  it("初始化对象只允许工作目录、非敏感配置和恢复状态", () => {
    const initialization = readDriverWorkerInitialization({
      workDirectory: "/tmp/worktree",
      configuration: { mode: "isolated" },
      recoveryStates: [{ runId: "run-1" }],
    });
    expect(initialization).toEqual({
      workDirectory: "/tmp/worktree",
      configuration: { mode: "isolated" },
      recoveryStates: [{ runId: "run-1" }],
    });
    expect(Object.isFrozen(initialization)).toBe(true);
    expect(() =>
      readDriverWorkerInitialization({ workDirectory: "/tmp/worktree", credentials: "secret" }),
    ).toThrowError(DriverTransportError);
    expect(() =>
      readDriverWorkerInitialization({ workDirectory: "relative/worktree" }),
    ).toThrowError(DriverTransportError);
  });
});
