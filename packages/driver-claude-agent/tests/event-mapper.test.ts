import { describe, expect, it } from "vitest";

import { assertAgentEventSequence, type AgentEvent } from "@agent-bridge/driver-protocol";

import { ClaudeAgentDriverError, redactClaudeText } from "../src/errors.js";
import { ClaudeEventMapper } from "../src/event-mapper.js";
import type { ClaudeRuntimeEvent } from "../src/runtime.js";

const now = () => new Date("2026-07-24T00:00:00.000Z");

describe("Claude Agent 统一事件映射", () => {
  it("映射文本、工具、权限、估算用量和唯一完成终态", () => {
    const mapper = new ClaudeEventMapper("run-1", "session-1", now);
    const events: AgentEvent[] = [mapper.start("prepared-1")];

    events.push(
      ...mapper.map({
        type: "tool.started",
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "Write",
        input: { file_path: "src/sum.ts" },
      }),
      ...mapper.map({
        type: "permission.requested",
        sessionId: "session-1",
        permissionId: "permission-1",
        toolCallId: "tool-1",
        toolName: "Write",
        title: "Write src/sum.ts",
        input: { file_path: "src/sum.ts" },
      }),
      mapper.permissionResponded({
        permissionId: "permission-1",
        toolCallId: "tool-1",
        decision: "allow",
      }),
      ...mapper.map({
        type: "tool.completed",
        sessionId: "session-1",
        toolCallId: "tool-1",
        outcome: "succeeded",
        output: "written",
      }),
      ...mapper.map({
        type: "assistant.text",
        sessionId: "session-1",
        messageId: "message-1",
        text: "Completed",
      }),
      ...mapper.map({
        type: "usage",
        sessionId: "session-1",
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
      }),
      ...mapper.map({
        type: "result",
        sessionId: "session-1",
        status: "succeeded",
        summary: "Completed",
        retryable: false,
      }),
    );

    assertAgentEventSequence(events);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "tool.started",
      "permission.requested",
      "permission.responded",
      "tool.completed",
      "output.delta",
      "usage.updated",
      "run.completed",
    ]);
    expect(events[6]).toMatchObject({
      type: "usage.updated",
      usage: {
        source: "driver_estimate",
        usedTokens: 15,
      },
    });
  });

  it("权限拒绝把对应工具结果归一化为 denied", () => {
    const mapper = new ClaudeEventMapper("run-deny", "session-deny", now);
    const events: AgentEvent[] = [mapper.start("prepared-deny")];
    events.push(
      ...mapper.map({
        type: "tool.started",
        sessionId: "session-deny",
        toolCallId: "tool-deny",
        toolName: "Write",
        input: { file_path: "../outside.txt" },
      }),
      ...mapper.map({
        type: "permission.requested",
        sessionId: "session-deny",
        permissionId: "permission-deny",
        toolCallId: "tool-deny",
        toolName: "Write",
        title: "Write outside worktree",
        input: { file_path: "../outside.txt" },
      }),
      mapper.permissionResponded({
        permissionId: "permission-deny",
        toolCallId: "tool-deny",
        decision: "deny",
      }),
      ...mapper.map({
        type: "tool.completed",
        sessionId: "session-deny",
        toolCallId: "tool-deny",
        outcome: "failed",
        errorCode: "CLAUDE_TOOL_ERROR",
        errorMessage: "denied",
      }),
      mapper.cancellationRequested("Fixture finished"),
      mapper.cancelled("Fixture finished"),
    );

    assertAgentEventSequence(events);
    expect(events[4]).toMatchObject({
      type: "tool.completed",
      outcome: "denied",
    });
  });

  it("拒绝缺失或错误的 Session、Tool 和 Permission 关联", () => {
    const mapper = new ClaudeEventMapper("run-invalid", "session-valid", now);
    mapper.start("prepared-invalid");

    expect(() =>
      mapper.map({
        type: "assistant.text",
        sessionId: "",
        messageId: "message-1",
        text: "invalid",
      }),
    ).toThrowError(ClaudeAgentDriverError);
    expect(() =>
      mapper.map({
        type: "tool.completed",
        sessionId: "session-valid",
        toolCallId: "tool-missing",
        outcome: "succeeded",
      }),
    ).toThrowError(ClaudeAgentDriverError);

    mapper.map({
      type: "tool.started",
      sessionId: "session-valid",
      toolCallId: "tool-1",
      toolName: "Read",
      input: {},
    });
    expect(() =>
      mapper.map({
        type: "permission.requested",
        sessionId: "session-other",
        permissionId: "permission-1",
        toolCallId: "tool-1",
        toolName: "Read",
        title: "Read",
        input: {},
      }),
    ).toThrowError(ClaudeAgentDriverError);
  });

  it("拒绝重复终态", () => {
    const mapper = new ClaudeEventMapper("run-terminal", "session-terminal", now);
    mapper.start("prepared-terminal");
    mapper.map({
      type: "result",
      sessionId: "session-terminal",
      status: "succeeded",
      summary: "done",
      retryable: false,
    });

    expect(() =>
      mapper.map({
        type: "result",
        sessionId: "session-terminal",
        status: "succeeded",
        summary: "duplicate",
        retryable: false,
      }),
    ).toThrowError(ClaudeAgentDriverError);
  });

  it("取消请求后拒绝迟到事件进入权威流", () => {
    const mapper = new ClaudeEventMapper("run-cancel", "session-cancel", now);
    const events: AgentEvent[] = [
      mapper.start("prepared-cancel"),
      mapper.cancellationRequested("User cancelled"),
    ];
    const lateEvent: ClaudeRuntimeEvent = {
      type: "tool.started",
      sessionId: "session-cancel",
      toolCallId: "tool-late",
      toolName: "Write",
      input: { file_path: "late.txt" },
    };

    expect(mapper.map(lateEvent)).toEqual([]);
    events.push(mapper.cancelled("User cancelled"));

    assertAgentEventSequence(events);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "run.cancellation_requested",
      "run.cancelled",
    ]);
  });

  it("事件和错误离开 Driver 边界前完成凭据与隔离路径脱敏", () => {
    const privatePath = "/private/tmp/claude-isolated";
    const secret = "synthetic-secret-value";
    const redact = (value: string) => redactClaudeText(value, [privatePath], [secret]);
    const mapper = new ClaudeEventMapper("run-redact", "session-redact", now, redact);
    const events: AgentEvent[] = [mapper.start("prepared-redact")];
    events.push(
      ...mapper.map({
        type: "assistant.text",
        sessionId: "session-redact",
        messageId: "message-redact",
        text: `Bearer ${secret} ${privatePath}/file.ts`,
      }),
      ...mapper.map({
        type: "runtime.error",
        sessionId: "session-redact",
        code: "CLAUDE_RUNTIME_ERROR",
        message: `api_key=${secret} at ${privatePath}`,
        retryable: false,
      }),
    );

    assertAgentEventSequence(events);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(privatePath);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("[ISOLATED_PATH]");
  });
});
