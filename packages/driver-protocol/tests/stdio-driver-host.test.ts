import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  DRIVER_PROTOCOL_VERSION,
  DRIVER_TRANSPORT_VERSION,
  readJsonLines,
  runStdioDriverHost,
  type AgentCapabilities,
  type AgentDriver,
  type DriverHostFactory,
} from "../src/index.js";

describe("stdio Driver Host", () => {
  it("完成初始化、健康检查、重复 request 拒绝和关闭", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const host = runStdioDriverHost({
      hostId: "test-worker",
      input,
      output,
      factory: fakeFactory(),
    });

    for (const message of [
      request("request-init", "initialize", { workDirectory: "/tmp/worktree" }),
      request("request-health", "healthCheck", {}),
      request("request-health", "healthCheck", {}),
      request("request-stop", "shutdown", {}),
    ]) {
      input.write(`${JSON.stringify(message)}\n`);
    }
    input.end();
    await host;
    output.end();

    const messages: unknown[] = [];
    for await (const message of readJsonLines(output)) {
      messages.push(message);
    }
    expect(messages).toMatchObject([
      { kind: "ready", hostId: "test-worker" },
      { kind: "response", requestId: "request-init", ok: true },
      {
        kind: "response",
        requestId: "request-health",
        ok: true,
        result: { status: "healthy" },
      },
      {
        kind: "response",
        requestId: "request-health",
        ok: false,
        error: { code: "DRIVER_TRANSPORT_REQUEST_DUPLICATE" },
      },
      { kind: "response", requestId: "request-stop", ok: true },
    ]);
  });
});

function request(requestId: string, method: string, params: object) {
  return {
    kind: "request",
    transportVersion: DRIVER_TRANSPORT_VERSION,
    requestId,
    method,
    params,
  };
}

function fakeFactory(): DriverHostFactory {
  return {
    create: () => Promise.resolve(fakeDriver()),
  };
}

function fakeDriver(): AgentDriver & { close(): Promise<void> } {
  const capabilities: AgentCapabilities = {
    protocolVersion: DRIVER_PROTOCOL_VERSION,
    driver: { id: "fake", displayName: "Fake", driverVersion: "1.0.0" },
    sessions: { persistentIds: true, resume: true, successorSessions: true },
    events: { streaming: true, strictOrdering: true },
    permissions: { mode: "interactive", decisions: ["allow", "deny"] },
    cancellation: { supported: true, terminalEvent: true },
    contextUsage: { mode: "exact" },
  };
  return {
    describeCapabilities: () => Promise.resolve(capabilities),
    prepareTask: () => Promise.reject(unsupported()),
    startTask: () => Promise.reject(unsupported()),
    resumeTask: () => Promise.reject(unsupported()),
    streamEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
    getContextUsage: () => Promise.reject(unsupported()),
    createSuccessorSession: () => Promise.reject(unsupported()),
    sendFeedback: () => Promise.resolve(),
    respondToPermission: () => Promise.reject(unsupported()),
    cancelTask: () => Promise.reject(unsupported()),
    collectResult: () => Promise.reject(unsupported()),
    healthCheck: () =>
      Promise.resolve({
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        driverId: "fake",
        status: "healthy",
        checkedAt: "2026-07-28T00:00:00.000Z",
      }),
    close: () => Promise.resolve(),
  };
}

function unsupported(): Error {
  return new Error("UNSUPPORTED_IN_TEST");
}
