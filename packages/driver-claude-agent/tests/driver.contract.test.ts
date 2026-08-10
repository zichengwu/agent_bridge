import { describe, expect, it } from "vitest";

import {
  DRIVER_PROTOCOL_VERSION,
  DriverProtocolError,
  asJsonObject,
  assertAgentEventSequence,
  type AgentEvent,
  type PrepareTaskRequest,
} from "@agent-bridge/driver-protocol";

import { ClaudeAgentDriver, type ClaudeAgentDriverRecoveryState } from "../src/driver.js";
import { ClaudeAgentDriverError } from "../src/errors.js";
import { FakeClaudeRuntime } from "./fixtures/fake-runtime.js";

const now = () => new Date("2026-07-24T00:00:00.000Z");

describe("Claude Agent Driver Contract", () => {
  it("覆盖恢复、后继 Session、反馈、权限、用量、结果和健康检查", async () => {
    const runtime = new FakeClaudeRuntime();
    const firstDriver = new ClaudeAgentDriver(runtime, {
      workDirectory: "/virtual/claude-worktree",
      now,
      createRunId: () => "run-success",
    });
    const prepared = await firstDriver.prepareTask(taskRequest("success"));
    const started = await firstDriver.startTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      preparedTask: prepared,
      context: { contextPackageId: "context-1" },
    });
    const recovery = firstDriver.exportRecoveryState(started.runId);
    expect(() => asJsonObject(started)).not.toThrow();
    expect(() => asJsonObject(recovery)).not.toThrow();
    await firstDriver.close();

    const driver = new ClaudeAgentDriver(runtime, {
      workDirectory: "/virtual/claude-worktree",
      now,
      recoveryStates: [recovery],
    });
    const resumed = await driver.resumeTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: started.runId,
      sessionId: started.session.sessionId,
      reason: "Driver process restarted",
      context: { recovery: true },
    });
    const successor = await driver.createSuccessorSession({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: resumed.runId,
      predecessorSessionId: resumed.session.sessionId,
      reason: "Context rollover",
      context: { continuationSnapshotId: "snapshot-1" },
    });
    await driver.sendFeedback({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: resumed.runId,
      sessionId: successor.sessionId,
      feedbackId: "feedback-1",
      feedback: { message: "Finish the task" },
    });

    const iterator = driver.streamEvents(resumed.runId)[Symbol.asyncIterator]();
    const events = [
      await nextEvent(iterator),
      await nextEvent(iterator),
      await nextEvent(iterator),
    ];
    runtime.emit({
      type: "tool.started",
      sessionId: successor.sessionId,
      toolCallId: "tool-1",
      toolName: "Write",
      input: { file_path: "src/sum.ts" },
    });
    runtime.emit({
      type: "permission.requested",
      sessionId: successor.sessionId,
      permissionId: "permission-1",
      toolCallId: "tool-1",
      toolName: "Write",
      title: "Write src/sum.ts",
      input: { file_path: "src/sum.ts" },
    });
    events.push(await nextEvent(iterator), await nextEvent(iterator));

    const permission = await driver.respondToPermission({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: resumed.runId,
      sessionId: successor.sessionId,
      permissionId: "permission-1",
      toolCallId: "tool-1",
      decision: "allow",
      reason: "Inside the allowed worktree",
    });
    events.push(await nextEvent(iterator));

    runtime.emit({
      type: "tool.completed",
      sessionId: successor.sessionId,
      toolCallId: "tool-1",
      outcome: "succeeded",
      output: { changed: "src/sum.ts" },
    });
    runtime.emit({
      type: "assistant.text",
      sessionId: successor.sessionId,
      messageId: "message-1",
      text: "Completed safely",
    });
    runtime.emit({
      type: "usage",
      sessionId: successor.sessionId,
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
    });
    runtime.emit({
      type: "result",
      sessionId: successor.sessionId,
      status: "succeeded",
      summary: "Completed safely",
      retryable: false,
    });
    events.push(
      await nextEvent(iterator),
      await nextEvent(iterator),
      await nextEvent(iterator),
      await nextEvent(iterator),
    );
    expect((await iterator.next()).done).toBe(true);

    const usage = await driver.getContextUsage(successor.sessionId);
    const result = await driver.collectResult(resumed.runId);
    const health = await driver.healthCheck();

    assertAgentEventSequence(events);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "run.resumed",
      "session.successor_created",
      "tool.started",
      "permission.requested",
      "permission.responded",
      "tool.completed",
      "output.delta",
      "usage.updated",
      "run.completed",
    ]);
    expect(permission.decision).toBe("allow");
    expect(successor.predecessorSessionId).toBe(started.session.sessionId);
    expect(successor.externalSessionId).not.toBe(started.session.externalSessionId);
    expect(runtime.permissionResponses).toEqual([
      {
        permissionId: "permission-1",
        toolCallId: "tool-1",
        decision: "allow",
      },
    ]);
    expect(runtime.startInputs).toHaveLength(4);
    expect(runtime.startInputs[1]).toMatchObject({
      resumeSessionId: started.session.sessionId,
      forkSession: false,
    });
    expect(runtime.startInputs[2]).toMatchObject({
      resumeSessionId: started.session.sessionId,
      forkSession: true,
    });
    expect(runtime.startInputs[3]).toMatchObject({
      resumeSessionId: successor.sessionId,
      forkSession: false,
    });
    expect(usage).toMatchObject({
      source: "driver_estimate",
      usedTokens: 25,
    });
    expect(result).toMatchObject({
      status: "succeeded",
      sessionId: successor.sessionId,
      summary: "Completed safely",
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        cacheReadTokens: 4,
        cacheWriteTokens: 1,
      },
    });
    expect(health.status).toBe("healthy");
    await driver.close();
  });

  it("权限拒绝先进入权威事件流，再释放 Runtime 等待", async () => {
    const runtime = new FakeClaudeRuntime();
    const driver = createDriver(runtime, "run-deny");
    const run = await start(driver, "deny");
    const iterator = driver.streamEvents(run.runId)[Symbol.asyncIterator]();
    const events = [await nextEvent(iterator)];

    runtime.emit({
      type: "tool.started",
      sessionId: run.session.sessionId,
      toolCallId: "tool-deny",
      toolName: "Write",
      input: { file_path: "../outside.txt" },
    });
    runtime.emit({
      type: "permission.requested",
      sessionId: run.session.sessionId,
      permissionId: "permission-deny",
      toolCallId: "tool-deny",
      toolName: "Write",
      title: "Write outside worktree",
      input: { file_path: "../outside.txt" },
    });
    events.push(await nextEvent(iterator), await nextEvent(iterator));
    const response = await driver.respondToPermission({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: run.runId,
      sessionId: run.session.sessionId,
      permissionId: "permission-deny",
      toolCallId: "tool-deny",
      decision: "deny",
      reason: "Outside the allowed worktree",
    });
    events.push(await nextEvent(iterator));

    runtime.emit({
      type: "tool.completed",
      sessionId: run.session.sessionId,
      toolCallId: "tool-deny",
      outcome: "failed",
      errorCode: "CLAUDE_TOOL_ERROR",
      errorMessage: "denied",
    });
    events.push(await nextEvent(iterator));
    await driver.cancelTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: run.runId,
      sessionId: run.session.sessionId,
      reason: "Denied fixture completed",
    });
    events.push(await nextEvent(iterator), await nextEvent(iterator));

    assertAgentEventSequence(events);
    expect(response.decision).toBe("deny");
    expect(events[3]).toMatchObject({
      type: "permission.responded",
      decision: "deny",
    });
    expect(events[4]).toMatchObject({
      type: "tool.completed",
      outcome: "denied",
    });
    expect(runtime.permissionResponses.at(-1)?.decision).toBe("deny");
    await driver.close();
  });

  it("取消形成确定终态并保留可收集结果", async () => {
    const runtime = new FakeClaudeRuntime();
    const driver = createDriver(runtime, "run-cancel");
    const run = await start(driver, "cancel");

    const receipt = await driver.cancelTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: run.runId,
      sessionId: run.session.sessionId,
      reason: "User cancelled",
    });
    const events = await collectEvents(driver.streamEvents(run.runId));
    const result = await driver.collectResult(run.runId);
    const repeated = await driver.cancelTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: run.runId,
      sessionId: run.session.sessionId,
      reason: "Duplicate cancellation",
    });

    assertAgentEventSequence(events);
    expect(receipt.accepted).toBe(true);
    expect(repeated.accepted).toBe(false);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "run.cancellation_requested",
      "run.cancelled",
    ]);
    expect(runtime.cancelledSessions).toEqual([run.session.sessionId]);
    expect(result.status).toBe("cancelled");
    await driver.close();
  });

  it("准备幂等并拒绝非法协议版本、未知 Run/Session 和未就绪结果", async () => {
    const runtime = new FakeClaudeRuntime();
    const driver = createDriver(runtime, "run-validation");
    const first = await driver.prepareTask(taskRequest("same"));
    const second = await driver.prepareTask(taskRequest("same"));

    expect(second).toEqual(first);
    expect(() =>
      driver.prepareTask({
        ...taskRequest("wrong-version"),
        protocolVersion: "2.0",
      } as unknown as PrepareTaskRequest),
    ).toThrowError(DriverProtocolError);
    expect(() => driver.streamEvents("run-missing")).toThrowError(ClaudeAgentDriverError);
    expect(() => driver.getContextUsage("session-missing")).toThrowError(ClaudeAgentDriverError);

    const run = await driver.startTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      preparedTask: first,
      context: { contextPackageId: "context-validation" },
    });
    expect(() => driver.collectResult(run.runId)).toThrowError(
      expect.objectContaining({ code: "CLAUDE_RESULT_NOT_READY" }),
    );
    await expect(
      driver.resumeTask({
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        runId: run.runId,
        sessionId: "session-other",
        reason: "invalid",
      }),
    ).rejects.toMatchObject({
      code: "CLAUDE_SESSION_MISMATCH",
    });
    await expect(
      driver.respondToPermission({
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        runId: run.runId,
        sessionId: run.session.sessionId,
        permissionId: "permission-missing",
        toolCallId: "tool-missing",
        decision: "allow",
      }),
    ).rejects.toMatchObject({
      code: "CLAUDE_PERMISSION_MISMATCH",
    });
    await driver.cancelTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: run.runId,
      sessionId: run.session.sessionId,
      reason: "End validation fixture",
    });
    await driver.close();
  });

  it("降级组件缺失时健康检查稳定返回 degraded", async () => {
    const runtime = new FakeClaudeRuntime();
    runtime.health = {
      status: "degraded",
      sdkVersion: runtime.sdkVersion,
      runtimeVersion: runtime.runtimeVersion,
      message: "Claude Code executable is unavailable",
    };
    const driver = createDriver(runtime, "run-health");

    await expect(driver.healthCheck()).resolves.toMatchObject({
      driverId: "claude-agent",
      status: "degraded",
      message: "Claude Code executable is unavailable",
    });
    await driver.close();
  });

  it("拒绝不一致的可导出恢复状态", async () => {
    const runtime = new FakeClaudeRuntime();
    const driver = createDriver(runtime, "run-recovery");
    const run = await start(driver, "recovery");
    const state = driver.exportRecoveryState(run.runId);
    await driver.close();
    const invalid: ClaudeAgentDriverRecoveryState = {
      ...state,
      handle: {
        ...state.handle,
        session: {
          ...state.handle.session,
          externalSessionId: "session-tampered",
        },
      },
    };

    expect(
      () =>
        new ClaudeAgentDriver(runtime, {
          workDirectory: "/virtual/claude-worktree",
          now,
          recoveryStates: [invalid],
        }),
    ).toThrowError(ClaudeAgentDriverError);
  });
});

function createDriver(runtime: FakeClaudeRuntime, runId: string): ClaudeAgentDriver {
  return new ClaudeAgentDriver(runtime, {
    workDirectory: "/virtual/claude-worktree",
    now,
    createRunId: () => runId,
  });
}

async function start(driver: ClaudeAgentDriver, key: string) {
  const prepared = await driver.prepareTask(taskRequest(key));
  return driver.startTask({
    protocolVersion: DRIVER_PROTOCOL_VERSION,
    preparedTask: prepared,
    context: { contextPackageId: `context-${key}` },
  });
}

function taskRequest(idempotencyKey: string): PrepareTaskRequest {
  return {
    protocolVersion: DRIVER_PROTOCOL_VERSION,
    taskId: `task-${idempotencyKey}`,
    taskVersion: 1,
    idempotencyKey,
    task: {
      objective: "Exercise the provider-free Claude Driver Contract",
    },
  };
}

async function nextEvent(iterator: AsyncIterator<AgentEvent>): Promise<AgentEvent> {
  const next = await iterator.next();
  if (next.done) {
    throw new Error("Expected another Agent event");
  }
  return next.value;
}

async function collectEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
