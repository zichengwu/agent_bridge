import { describe, expect, it } from "vitest";

import { assertAgentEventSequence, type AgentEvent } from "@agent-bridge/driver-protocol";

import { OpenCodeDriverError } from "../src/errors.js";
import { OpenCodeEventMapper } from "../src/event-mapper.js";

const now = () => new Date("2026-07-23T00:00:00.000Z");

describe("OpenCode 统一事件映射", () => {
  it("去重工具状态并生成严格有序的完成流", () => {
    const mapper = new OpenCodeEventMapper("run-1", "session-1", now);
    const events: AgentEvent[] = [mapper.start("prepared-1")];

    events.push(
      ...mapper.map({
        type: "tool",
        sessionId: "session-1",
        messageId: "message-1",
        partId: "part-1",
        callId: "tool-1",
        toolName: "write",
        status: "running",
        input: { path: "allowed.txt" },
      }),
    );
    events.push(
      ...mapper.map({
        type: "tool",
        sessionId: "session-1",
        messageId: "message-1",
        partId: "part-1",
        callId: "tool-1",
        toolName: "write",
        status: "running",
        input: { path: "allowed.txt" },
      }),
    );
    events.push(
      ...mapper.map({
        type: "tool",
        sessionId: "session-1",
        messageId: "message-1",
        partId: "part-1",
        callId: "tool-1",
        toolName: "write",
        status: "completed",
        input: { path: "allowed.txt" },
        output: "written",
      }),
    );
    events.push(
      ...mapper.map({
        type: "session.idle",
        sessionId: "session-1",
      }),
    );

    assertAgentEventSequence(events);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "tool.started",
      "tool.completed",
      "run.completed",
    ]);
  });

  it("拒绝没有待处理请求的权限响应", () => {
    const mapper = new OpenCodeEventMapper("run-1", "session-1", now);
    mapper.start("prepared-1");

    expect(() =>
      mapper.map({
        type: "permission.responded",
        sessionId: "session-1",
        permissionId: "permission-missing",
        response: "once",
      }),
    ).toThrowError(OpenCodeDriverError);
  });
});
