import { describe, expect, it } from "vitest";

import {
  DRIVER_PROTOCOL_VERSION,
  asJsonObject,
  assertAgentEventSequence,
  type AgentEvent,
} from "@agent-bridge/driver-protocol";

import { OpenCodeDriver } from "../src/driver.js";
import { FakeOpenCodeRuntime } from "./fixtures/fake-runtime.js";

const now = () => new Date("2026-07-23T00:00:00.000Z");

describe("OpenCode Driver Contract", () => {
  it("覆盖启动、事件、权限、恢复、后继 Session、结果和健康检查", async () => {
    const runtime = new FakeOpenCodeRuntime();
    const driver = new OpenCodeDriver(runtime, {
      workDirectory: "/virtual/worktree",
      now,
      createRunId: () => "run-success",
    });
    const prepared = await driver.prepareTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      taskId: "task-1",
      taskVersion: 1,
      idempotencyKey: "start",
      task: { objective: "Exercise OpenCode Contract" },
    });
    const run = await driver.startTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      preparedTask: prepared,
      context: { contextPackageId: "context-1" },
    });
    expect(() => asJsonObject(run)).not.toThrow();
    expect(() => asJsonObject(driver.exportRecoveryState(run.runId))).not.toThrow();
    const iterator = driver.streamEvents(run.runId)[Symbol.asyncIterator]();
    const events: AgentEvent[] = [];
    events.push(await nextEvent(iterator));

    runtime.emit({
      type: "permission.requested",
      sessionId: run.session.sessionId,
      permissionId: "permission-1",
      messageId: "message-1",
      callId: "tool-1",
      permission: "edit",
      title: "Write allowed file",
      metadata: { path: "allowed.txt" },
    });
    events.push(await nextEvent(iterator));

    const permission = await driver.respondToPermission({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: run.runId,
      sessionId: run.session.sessionId,
      permissionId: "permission-1",
      toolCallId: "tool-1",
      decision: "allow",
    });
    events.push(await nextEvent(iterator));

    runtime.emit({
      type: "tool",
      sessionId: run.session.sessionId,
      messageId: "message-1",
      partId: "part-tool",
      callId: "tool-1",
      toolName: "write",
      status: "running",
      input: { path: "allowed.txt" },
    });
    runtime.emit({
      type: "tool",
      sessionId: run.session.sessionId,
      messageId: "message-1",
      partId: "part-tool",
      callId: "tool-1",
      toolName: "write",
      status: "completed",
      input: { path: "allowed.txt" },
      output: "written",
    });
    events.push(await nextEvent(iterator), await nextEvent(iterator));

    await driver.resumeTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: run.runId,
      sessionId: run.session.sessionId,
      reason: "Resume after permission",
    });
    events.push(await nextEvent(iterator));

    const successor = await driver.createSuccessorSession({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: run.runId,
      predecessorSessionId: run.session.sessionId,
      reason: "Context rollover",
      context: { continuationSnapshotId: "snapshot-1" },
    });
    events.push(await nextEvent(iterator));

    await driver.sendFeedback({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: run.runId,
      sessionId: successor.sessionId,
      feedbackId: "feedback-1",
      feedback: { message: "Finish the task" },
    });

    runtime.emit({
      type: "text",
      sessionId: successor.sessionId,
      messageId: "message-2",
      partId: "part-text",
      text: "Completed",
      delta: "Completed",
    });
    runtime.emit({
      type: "usage",
      sessionId: successor.sessionId,
      messageId: "message-2",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      completed: true,
    });
    runtime.emit({
      type: "session.idle",
      sessionId: successor.sessionId,
    });
    events.push(await nextEvent(iterator), await nextEvent(iterator), await nextEvent(iterator));
    expect((await iterator.next()).done).toBe(true);

    const usage = await driver.getContextUsage(successor.sessionId);
    const result = await driver.collectResult(run.runId);
    const health = await driver.healthCheck();

    assertAgentEventSequence(events);
    expect(permission.decision).toBe("allow");
    expect(runtime.permissionResponses).toEqual([
      {
        sessionId: run.session.sessionId,
        permissionId: "permission-1",
        decision: "allow",
      },
    ]);
    expect(successor.predecessorSessionId).toBe(run.session.sessionId);
    expect(usage.usedTokens).toBe(15);
    expect(result).toMatchObject({
      status: "succeeded",
      sessionId: successor.sessionId,
      summary: "Completed",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
      },
    });
    expect(health.status).toBe("healthy");
    expect(runtime.prompts).toHaveLength(2);
    await driver.close();
  });

  it("取消产生确定终态和可收集结果", async () => {
    const runtime = new FakeOpenCodeRuntime();
    const driver = new OpenCodeDriver(runtime, {
      workDirectory: "/virtual/worktree",
      now,
      createRunId: () => "run-cancel",
    });
    const prepared = await driver.prepareTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      taskId: "task-cancel",
      taskVersion: 1,
      idempotencyKey: "cancel",
      task: { objective: "Cancel safely" },
    });
    const run = await driver.startTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      preparedTask: prepared,
      context: { contextPackageId: "context-cancel" },
    });

    const receipt = await driver.cancelTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: run.runId,
      sessionId: run.session.sessionId,
      reason: "User cancelled",
    });
    const events = await collectEvents(driver.streamEvents(run.runId));
    const result = await driver.collectResult(run.runId);

    assertAgentEventSequence(events);
    expect(receipt.accepted).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "run.cancellation_requested",
      "run.cancelled",
    ]);
    expect(runtime.abortedSessions).toEqual([run.session.sessionId]);
    expect(result.status).toBe("cancelled");
    await driver.close();
  });

  it("权限拒绝通过一等接口返回并进入权威事件流", async () => {
    const runtime = new FakeOpenCodeRuntime();
    const driver = new OpenCodeDriver(runtime, {
      workDirectory: "/virtual/worktree",
      now,
      createRunId: () => "run-deny",
    });
    const prepared = await driver.prepareTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      taskId: "task-deny",
      taskVersion: 1,
      idempotencyKey: "deny",
      task: { objective: "Deny unsafe write" },
    });
    const run = await driver.startTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      preparedTask: prepared,
      context: { contextPackageId: "context-deny" },
    });
    const iterator = driver.streamEvents(run.runId)[Symbol.asyncIterator]();
    const events = [await nextEvent(iterator)];

    runtime.emit({
      type: "permission.requested",
      sessionId: run.session.sessionId,
      permissionId: "permission-deny",
      messageId: "message-deny",
      callId: "tool-deny",
      permission: "external_directory",
      title: "Write outside worktree",
      metadata: { path: "../outside.txt" },
    });
    events.push(await nextEvent(iterator));
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
    await driver.cancelTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: run.runId,
      sessionId: run.session.sessionId,
      reason: "Denied operation ends fixture",
    });
    events.push(await nextEvent(iterator), await nextEvent(iterator));

    assertAgentEventSequence(events);
    expect(response.decision).toBe("deny");
    expect(runtime.permissionResponses.at(-1)?.decision).toBe("deny");
    expect(events[2]).toMatchObject({
      type: "permission.responded",
      decision: "deny",
    });
    await driver.close();
  });
});

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
