import process from "node:process";

import { DRIVER_PROTOCOL_VERSION, runStdioDriverHost } from "@agent-bridge/driver-protocol";

const timestamp = "2026-07-28T00:00:00.000Z";

function createDriver() {
  return {
    async describeCapabilities() {
      return {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        driver: { id: "fixture", displayName: "Fixture", driverVersion: "1.0.0" },
        sessions: { persistentIds: true, resume: true, successorSessions: true },
        events: { streaming: true, strictOrdering: true },
        permissions: { mode: "interactive", decisions: ["allow", "deny"] },
        cancellation: { supported: true, terminalEvent: true },
        contextUsage: { mode: "exact" },
      };
    },
    async prepareTask(request) {
      return {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        preparedTaskId: `prepared-${request.taskId}`,
        taskId: request.taskId,
        taskVersion: request.taskVersion,
        driverId: "fixture",
        preparedAt: timestamp,
      };
    },
    async startTask() {
      return {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        runId: "run-fixture",
        state: "running",
        session: {
          protocolVersion: DRIVER_PROTOCOL_VERSION,
          sessionId: "session-fixture",
          externalSessionId: "external-fixture",
          runId: "run-fixture",
          state: "active",
          createdAt: timestamp,
        },
        startedAt: timestamp,
      };
    },
    async resumeTask(request) {
      return {
        ...(await this.startTask()),
        runId: request.runId,
        session: { ...(await this.startTask()).session, sessionId: request.sessionId },
      };
    },
    streamEvents(runId) {
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            protocolVersion: DRIVER_PROTOCOL_VERSION,
            eventId: "event-1",
            sequence: 1,
            occurredAt: timestamp,
            runId,
            sessionId: "session-fixture",
            type: "run.completed",
          };
        },
      };
    },
    async getContextUsage(sessionId) {
      return {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        sessionId,
        source: "driver_exact",
        usedTokens: 1,
        maxTokens: 10,
        measuredAt: timestamp,
      };
    },
    async createSuccessorSession(request) {
      return {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        sessionId: "session-successor",
        externalSessionId: "external-successor",
        runId: request.runId,
        state: "active",
        createdAt: timestamp,
        predecessorSessionId: request.predecessorSessionId,
      };
    },
    async sendFeedback() {},
    async respondToPermission(request) {
      return {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        runId: request.runId,
        sessionId: request.sessionId,
        permissionId: request.permissionId,
        toolCallId: request.toolCallId,
        decision: request.decision,
        respondedAt: timestamp,
      };
    },
    async cancelTask(request) {
      return {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        runId: request.runId,
        sessionId: request.sessionId,
        accepted: true,
        requestedAt: timestamp,
      };
    },
    async collectResult(runId) {
      return {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        runId,
        sessionId: "session-fixture",
        status: "succeeded",
        summary: "fixture complete",
        output: {},
        artifacts: [],
        completedAt: timestamp,
      };
    },
    async healthCheck() {
      return {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        driverId: "fixture",
        status: "healthy",
        checkedAt: timestamp,
      };
    },
    async exportRecoveryState(runId) {
      return { runId, checkpoint: "fixture" };
    },
    async close() {},
  };
}

await runStdioDriverHost({
  hostId: "fixture-worker",
  input: process.stdin,
  output: process.stdout,
  factory: { create: async () => createDriver() },
}).catch(() => {
  process.stderr.write("Driver fixture failed\n");
  process.exitCode = 1;
});
