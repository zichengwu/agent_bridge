import { describe, expect, it } from "vitest";

import {
  AGENT_RUN_STATUSES,
  AGENT_RUN_TERMINAL_STATUSES,
  AGENT_RUN_TRANSITION_EVENTS,
  CoreDomainError,
  getAllowedAgentRunTransitionEvents,
  isAgentRunTerminalStatus,
  transitionAgentRunStatus,
  type AgentRunStatus,
  type AgentRunTransitionEvent,
  type CoreDomainErrorCode,
} from "../src/index.js";

const legalTransitions = [
  ["created", "START", "running"],
  ["created", "FAIL", "failed"],
  ["running", "WAIT_FOR_PERMISSION", "waiting_permission"],
  ["running", "REQUEST_CANCELLATION", "cancelling"],
  ["running", "SUCCEED", "succeeded"],
  ["running", "FAIL", "failed"],
  ["running", "INTERRUPT", "interrupted"],
  ["waiting_permission", "RESUME", "running"],
  ["waiting_permission", "REQUEST_CANCELLATION", "cancelling"],
  ["waiting_permission", "FAIL", "failed"],
  ["waiting_permission", "INTERRUPT", "interrupted"],
  ["cancelling", "CONFIRM_CANCELLED", "cancelled"],
  ["cancelling", "FAIL", "failed"],
  ["cancelling", "INTERRUPT", "interrupted"],
] as const satisfies readonly (readonly [
  AgentRunStatus,
  AgentRunTransitionEvent,
  AgentRunStatus,
])[];

const legalTransitionKeys = new Set(
  legalTransitions.map(([status, event]) => JSON.stringify([status, event])),
);

describe("Agent Run 生命周期", () => {
  it.each(legalTransitions)("%s + %s → %s", (current, event, expected) => {
    expect(transitionAgentRunStatus(current, event)).toBe(expected);
  });

  it.each(AGENT_RUN_STATUSES)("%s 的合法与非法转换完整受控", (status) => {
    const allowed = new Set(getAllowedAgentRunTransitionEvents(status));

    for (const event of AGENT_RUN_TRANSITION_EVENTS) {
      const expectedLegal = legalTransitionKeys.has(JSON.stringify([status, event]));
      expect(allowed.has(event)).toBe(expectedLegal);
      if (!expectedLegal) {
        expectCoreError(
          () => transitionAgentRunStatus(status, event),
          "AGENT_RUN_STATE_TRANSITION_INVALID",
        );
      }
    }
  });

  it("取消必须经过 cancelling，不能由 running 直接确认取消", () => {
    expectCoreError(
      () => transitionAgentRunStatus("running", "CONFIRM_CANCELLED"),
      "AGENT_RUN_STATE_TRANSITION_INVALID",
    );
    expect(transitionAgentRunStatus("running", "REQUEST_CANCELLATION")).toBe("cancelling");
    expect(transitionAgentRunStatus("cancelling", "CONFIRM_CANCELLED")).toBe("cancelled");
  });

  it("所有 Run 终态不可复活", () => {
    expect(AGENT_RUN_TERMINAL_STATUSES).toEqual([
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
    ]);
    for (const status of AGENT_RUN_TERMINAL_STATUSES) {
      expect(isAgentRunTerminalStatus(status)).toBe(true);
      expect(getAllowedAgentRunTransitionEvents(status)).toEqual([]);
    }
  });

  it("未知状态或事件使用稳定错误且不泄漏输入", () => {
    const secret = "sensitive-run-input";
    const error = expectCoreError(
      () => transitionAgentRunStatus(secret, secret),
      "AGENT_RUN_STATE_TRANSITION_INVALID",
    );

    expect(error.details).toEqual({
      entity: "agent_run",
      current_status: "UNKNOWN",
      transition_event: "UNKNOWN",
    });
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});

function expectCoreError(operation: () => unknown, code: CoreDomainErrorCode): CoreDomainError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreDomainError);
    expect((error as CoreDomainError).code).toBe(code);
    return error as CoreDomainError;
  }
  throw new Error(`Expected CoreDomainError with code ${code}`);
}
