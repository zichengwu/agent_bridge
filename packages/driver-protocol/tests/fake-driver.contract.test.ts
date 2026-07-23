import { describe, expect, it } from "vitest";

import {
  DRIVER_PROTOCOL_VERSION,
  assertAgentCapabilities,
  assertAgentEventSequence,
  type AgentCapabilities,
  type AgentDriver,
  type AgentEvent,
  type AgentResult,
  type CancelTaskRequest,
  type CancellationReceipt,
  type ContextUsage,
  type HealthStatus,
  type JsonObject,
  type PermissionResponse,
  type PrepareTaskRequest,
  type PreparedTask,
  type RespondToPermissionRequest,
  type ResumeTaskRequest,
  type RunHandle,
  type SessionHandle,
  type StartTaskRequest,
  type SuccessorSessionRequest,
} from "../src/index.js";

const timestamp = "2026-07-23T00:00:00.000Z";

class FakeDriver implements AgentDriver {
  private readonly events = new Map<string, AgentEvent[]>();
  private readonly results = new Map<string, AgentResult>();
  private readonly runs = new Map<string, RunHandle>();
  private nextRun = 1;
  private nextSession = 1;

  describeCapabilities(): Promise<AgentCapabilities> {
    return Promise.resolve({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      driver: {
        id: "fake",
        displayName: "Contract Fake Driver",
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
    });
  }

  prepareTask(request: PrepareTaskRequest): Promise<PreparedTask> {
    return Promise.resolve({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      preparedTaskId: `prepared-${request.idempotencyKey}`,
      taskId: request.taskId,
      taskVersion: request.taskVersion,
      driverId: "fake",
      preparedAt: timestamp,
    });
  }

  startTask(request: StartTaskRequest): Promise<RunHandle> {
    const runId = `run-${this.nextRun++}`;
    const session = this.createSession(runId);
    const run: RunHandle = {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId,
      state: "waiting_permission",
      session,
      startedAt: timestamp,
    };
    this.runs.set(runId, run);
    this.events.set(runId, [
      {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        eventId: `${runId}-event-1`,
        sequence: 1,
        occurredAt: timestamp,
        runId,
        sessionId: session.sessionId,
        type: "run.started",
        preparedTaskId: request.preparedTask.preparedTaskId,
      },
      {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        eventId: `${runId}-event-2`,
        sequence: 2,
        occurredAt: timestamp,
        runId,
        sessionId: session.sessionId,
        type: "permission.requested",
        permission: {
          permissionId: `${runId}-permission-1`,
          toolCallId: `${runId}-tool-1`,
          kind: "filesystem.write",
          title: "Write a contract fixture",
        },
      },
    ]);
    return Promise.resolve(run);
  }

  resumeTask(request: ResumeTaskRequest): Promise<RunHandle> {
    const run = this.requireRun(request.runId);
    if (run.session.sessionId !== request.sessionId) {
      throw new Error("Cannot resume a non-active session");
    }
    this.append(request.runId, {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      eventId: this.nextEventId(request.runId),
      sequence: this.nextSequence(request.runId),
      occurredAt: timestamp,
      runId: request.runId,
      sessionId: request.sessionId,
      type: "run.resumed",
      reason: request.reason,
    });
    const resumed = {
      ...run,
      state: "running" as const,
    };
    this.runs.set(request.runId, resumed);
    return Promise.resolve(resumed);
  }

  streamEvents(runId: string): AsyncIterable<AgentEvent> {
    const snapshot = [...this.requireEvents(runId)];
    return {
      [Symbol.asyncIterator]() {
        const iterator = snapshot[Symbol.iterator]();
        return {
          next: () => Promise.resolve(iterator.next()),
        };
      },
    };
  }

  getContextUsage(sessionId: string): Promise<ContextUsage> {
    return Promise.resolve({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      sessionId,
      source: "driver_exact",
      usedTokens: 256,
      maxTokens: 4096,
      measuredAt: timestamp,
    });
  }

  createSuccessorSession(request: SuccessorSessionRequest): Promise<SessionHandle> {
    const run = this.requireRun(request.runId);
    if (run.session.sessionId !== request.predecessorSessionId) {
      throw new Error("Predecessor is not active");
    }
    const successor = this.createSession(request.runId, request.predecessorSessionId);
    this.append(request.runId, {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      eventId: this.nextEventId(request.runId),
      sequence: this.nextSequence(request.runId),
      occurredAt: timestamp,
      runId: request.runId,
      sessionId: successor.sessionId,
      type: "session.successor_created",
      predecessorSessionId: request.predecessorSessionId,
      reason: request.reason,
    });
    this.runs.set(request.runId, {
      ...run,
      session: successor,
    });
    return Promise.resolve(successor);
  }

  sendFeedback(): Promise<void> {
    return Promise.resolve();
  }

  respondToPermission(request: RespondToPermissionRequest): Promise<PermissionResponse> {
    this.append(request.runId, {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      eventId: this.nextEventId(request.runId),
      sequence: this.nextSequence(request.runId),
      occurredAt: timestamp,
      runId: request.runId,
      sessionId: request.sessionId,
      type: "permission.responded",
      permissionId: request.permissionId,
      toolCallId: request.toolCallId,
      decision: request.decision,
      reason: request.reason,
    });
    return Promise.resolve({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: request.runId,
      sessionId: request.sessionId,
      permissionId: request.permissionId,
      toolCallId: request.toolCallId,
      decision: request.decision,
      respondedAt: timestamp,
    });
  }

  cancelTask(request: CancelTaskRequest): Promise<CancellationReceipt> {
    this.append(request.runId, {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      eventId: this.nextEventId(request.runId),
      sequence: this.nextSequence(request.runId),
      occurredAt: timestamp,
      runId: request.runId,
      sessionId: request.sessionId,
      type: "run.cancellation_requested",
      reason: request.reason,
    });
    this.append(request.runId, {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      eventId: this.nextEventId(request.runId),
      sequence: this.nextSequence(request.runId),
      occurredAt: timestamp,
      runId: request.runId,
      sessionId: request.sessionId,
      type: "run.cancelled",
      reason: request.reason,
    });
    this.results.set(request.runId, {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: request.runId,
      sessionId: request.sessionId,
      status: "cancelled",
      summary: "Cancelled by contract test",
      output: {},
      artifacts: [],
      completedAt: timestamp,
    });
    return Promise.resolve({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: request.runId,
      sessionId: request.sessionId,
      accepted: true,
      requestedAt: timestamp,
    });
  }

  collectResult(runId: string): Promise<AgentResult> {
    const result = this.results.get(runId);
    if (result === undefined) {
      throw new Error(`Result is not ready for ${runId}`);
    }
    return Promise.resolve(result);
  }

  healthCheck(): Promise<HealthStatus> {
    return Promise.resolve({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      driverId: "fake",
      status: "healthy",
      checkedAt: timestamp,
    });
  }

  complete(runId: string): void {
    const run = this.requireRun(runId);
    this.append(runId, {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      eventId: this.nextEventId(runId),
      sequence: this.nextSequence(runId),
      occurredAt: timestamp,
      runId,
      sessionId: run.session.sessionId,
      type: "usage.updated",
      usage: {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        sessionId: run.session.sessionId,
        source: "driver_exact",
        usedTokens: 256,
        maxTokens: 4096,
        measuredAt: timestamp,
      },
    });
    this.append(runId, {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      eventId: this.nextEventId(runId),
      sequence: this.nextSequence(runId),
      occurredAt: timestamp,
      runId,
      sessionId: run.session.sessionId,
      type: "run.completed",
    });
    this.results.set(runId, {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId,
      sessionId: run.session.sessionId,
      status: "succeeded",
      summary: "Contract flow completed",
      output: { accepted: true },
      artifacts: [],
      usage: {
        inputTokens: 128,
        outputTokens: 128,
      },
      completedAt: timestamp,
    });
  }

  private append(runId: string, event: AgentEvent): void {
    this.requireEvents(runId).push(event);
  }

  private createSession(runId: string, predecessorSessionId?: string): SessionHandle {
    const sessionId = `session-${this.nextSession++}`;
    return {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      sessionId,
      externalSessionId: `external-${sessionId}`,
      runId,
      state: "active",
      createdAt: timestamp,
      predecessorSessionId,
    };
  }

  private nextEventId(runId: string): string {
    return `${runId}-event-${this.nextSequence(runId)}`;
  }

  private nextSequence(runId: string): number {
    return this.requireEvents(runId).length + 1;
  }

  private requireEvents(runId: string): AgentEvent[] {
    const events = this.events.get(runId);
    if (events === undefined) {
      throw new Error(`Unknown run ${runId}`);
    }
    return events;
  }

  private requireRun(runId: string): RunHandle {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new Error(`Unknown run ${runId}`);
    }
    return run;
  }
}

async function collectEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function taskRequest(idempotencyKey: string): PrepareTaskRequest<JsonObject> {
  return {
    protocolVersion: DRIVER_PROTOCOL_VERSION,
    taskId: "task-contract",
    taskVersion: 1,
    idempotencyKey,
    task: {
      objective: "Exercise the provider-free Driver Contract",
    },
  };
}

describe("Fake Driver Contract", () => {
  it("覆盖启动、权限、恢复、后继 Session、用量、结果和健康检查", async () => {
    const driver = new FakeDriver();
    const declaredCapabilities = await driver.describeCapabilities();
    assertAgentCapabilities(declaredCapabilities);

    const prepared = await driver.prepareTask(taskRequest("success"));
    const started = await driver.startTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      preparedTask: prepared,
      context: {
        contextPackageId: "context-1",
      },
    });

    const permission = await driver.respondToPermission({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: started.runId,
      sessionId: started.session.sessionId,
      permissionId: `${started.runId}-permission-1`,
      toolCallId: `${started.runId}-tool-1`,
      decision: "allow",
      reason: "Contract fixture is inside the allowed scope",
    });
    const resumed = await driver.resumeTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: started.runId,
      sessionId: started.session.sessionId,
      reason: "Resume after permission response",
    });
    const successor = await driver.createSuccessorSession({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: resumed.runId,
      predecessorSessionId: resumed.session.sessionId,
      reason: "Context rollover",
      context: {
        continuationSnapshotId: "snapshot-1",
      },
    });
    const usage = await driver.getContextUsage(successor.sessionId);
    driver.complete(started.runId);

    const events = await collectEvents(driver.streamEvents(started.runId));
    const result = await driver.collectResult(started.runId);
    const health = await driver.healthCheck();

    assertAgentEventSequence(events);
    expect(permission.decision).toBe("allow");
    expect(successor.predecessorSessionId).toBe(started.session.sessionId);
    expect(usage.source).toBe("driver_exact");
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "permission.requested",
      "permission.responded",
      "run.resumed",
      "session.successor_created",
      "usage.updated",
      "run.completed",
    ]);
    expect(result).toMatchObject({
      status: "succeeded",
      sessionId: successor.sessionId,
    });
    expect(health.status).toBe("healthy");
  });

  it("取消产生确定终态并保留可收集结果", async () => {
    const driver = new FakeDriver();
    const prepared = await driver.prepareTask(taskRequest("cancel"));
    const started = await driver.startTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      preparedTask: prepared,
      context: {
        contextPackageId: "context-cancel",
      },
    });

    const receipt = await driver.cancelTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: started.runId,
      sessionId: started.session.sessionId,
      reason: "User requested cancellation",
    });
    const events = await collectEvents(driver.streamEvents(started.runId));
    const result = await driver.collectResult(started.runId);

    assertAgentEventSequence(events);
    expect(receipt.accepted).toBe(true);
    expect(events.at(-1)?.type).toBe("run.cancelled");
    expect(result.status).toBe("cancelled");
  });
});
