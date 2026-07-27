import {
  DOMAIN_SCHEMA_VERSION,
  type AgentSessionBinding,
  type AgentSessionBindingStatus,
} from "@agent-bridge/schemas";
import { describe, expect, it } from "vitest";

import {
  AGENT_SESSION_STATUSES,
  AGENT_SESSION_TERMINAL_STATUSES,
  AGENT_SESSION_TRANSITION_EVENTS,
  CoreDomainError,
  assertAgentSessionCanAcceptInput,
  canAgentSessionAcceptInput,
  getAllowedAgentSessionTransitionEvents,
  isAgentSessionTerminalStatus,
  readAgentSessionBinding,
  readAgentSessionBindingSet,
  transitionAgentSessionBinding,
  transitionAgentSessionStatus,
  type AgentSessionTransitionEvent,
  type CoreDomainErrorCode,
} from "../src/index.js";

const timestamp = "2026-07-24T10:00:00+08:00";
const laterTimestamp = "2026-07-24T10:01:00+08:00";
const hash = `sha256:${"a".repeat(64)}`;

const legalTransitions = [
  ["CREATED", "ACTIVATE", "ACTIVE"],
  ["CREATED", "FAIL", "FAILED"],
  ["ACTIVE", "REQUEST_ROLLOVER", "ROLLOVER_PENDING"],
  ["ACTIVE", "CLOSE", "CLOSED"],
  ["ACTIVE", "FAIL", "FAILED"],
  ["ROLLOVER_PENDING", "SUPERSEDE", "SUPERSEDED"],
  ["ROLLOVER_PENDING", "FAIL", "FAILED"],
] as const satisfies readonly (readonly [
  AgentSessionBindingStatus,
  AgentSessionTransitionEvent,
  AgentSessionBindingStatus,
])[];

const legalTransitionKeys = new Set(
  legalTransitions.map(([status, event]) => JSON.stringify([status, event])),
);

describe("Agent Session Binding 生命周期", () => {
  it.each(legalTransitions)("%s + %s → %s", (current, event, expected) => {
    expect(transitionAgentSessionStatus(current, event)).toBe(expected);
  });

  it.each(AGENT_SESSION_STATUSES)("%s 的合法与非法转换完整受控", (status) => {
    const allowed = new Set(getAllowedAgentSessionTransitionEvents(status));

    for (const event of AGENT_SESSION_TRANSITION_EVENTS) {
      const expectedLegal = legalTransitionKeys.has(JSON.stringify([status, event]));
      expect(allowed.has(event)).toBe(expectedLegal);
      if (!expectedLegal) {
        expectCoreError(
          () => transitionAgentSessionStatus(status, event),
          "SESSION_STATE_TRANSITION_INVALID",
        );
      }
    }
  });

  it("终态稳定且只有 ACTIVE 可以接收输入", () => {
    expect(AGENT_SESSION_TERMINAL_STATUSES).toEqual(["SUPERSEDED", "CLOSED", "FAILED"]);
    for (const status of AGENT_SESSION_STATUSES) {
      expect(canAgentSessionAcceptInput(status)).toBe(status === "ACTIVE");
    }
    for (const status of AGENT_SESSION_TERMINAL_STATUSES) {
      expect(isAgentSessionTerminalStatus(status)).toBe(true);
      expect(getAllowedAgentSessionTransitionEvents(status)).toEqual([]);
      expectCoreError(
        () => assertAgentSessionCanAcceptInput(binding({ status })),
        "SESSION_NOT_RESUMABLE",
      );
    }
  });

  it("Binding 转换返回不可变副本，并为终态记录关闭时间", () => {
    const active = binding({ status: "ACTIVE" });

    const closed = transitionAgentSessionBinding(active, "CLOSE", laterTimestamp);

    expect(closed.status).toBe("CLOSED");
    expect(closed.closed_at).toBe(laterTimestamp);
    expect(Object.isFrozen(closed)).toBe(true);
    expect(active.status).toBe("ACTIVE");
  });

  it("激活时强制一个 run + role 最多一个 ACTIVE Session", () => {
    const created = binding({
      binding_id: "binding-2",
      session_id: "session-2",
      external_session_id: "external-2",
      status: "CREATED",
    });
    const active = binding({ status: "ACTIVE" });

    const error = expectCoreError(
      () => transitionAgentSessionBinding(created, "ACTIVATE", laterTimestamp, [active]),
      "SESSION_ACTIVE_CONFLICT",
    );

    expect(error.details.conflict_fields).toEqual(["run_id", "role"]);
  });

  it("Binding 集合拒绝重复 ID 与同 run+role 双 ACTIVE", () => {
    expectCoreError(
      () =>
        readAgentSessionBindingSet([
          binding(),
          binding({
            binding_id: "binding-2",
            external_session_id: "external-2",
          }),
        ]),
      "SESSION_BINDING_INVALID",
    );

    expectCoreError(
      () =>
        readAgentSessionBindingSet([
          binding(),
          binding({
            binding_id: "binding-2",
            session_id: "session-2",
            external_session_id: "external-2",
          }),
        ]),
      "SESSION_ACTIVE_CONFLICT",
    );
  });

  it("拒绝自引用 predecessor、终态缺少 closed_at 和非终态携带 closed_at", () => {
    expectCoreError(
      () => readAgentSessionBinding(binding({ predecessor_session_id: "session-1" })),
      "SESSION_BINDING_INVALID",
    );

    const terminalWithoutClose = {
      ...binding({ status: "ACTIVE" }),
      status: "FAILED",
    };
    expectCoreError(() => readAgentSessionBinding(terminalWithoutClose), "SESSION_BINDING_INVALID");

    expectCoreError(
      () => readAgentSessionBinding({ ...binding(), closed_at: laterTimestamp }),
      "SESSION_BINDING_INVALID",
    );
  });

  it("未知 Session 状态或事件稳定拒绝且不回显内容", () => {
    const secret = "sensitive-session-input";
    const error = expectCoreError(
      () => transitionAgentSessionStatus(secret, secret),
      "SESSION_STATE_TRANSITION_INVALID",
    );

    expect(error.details).toEqual({
      entity: "agent_session",
      current_status: "UNKNOWN",
      transition_event: "UNKNOWN",
    });
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});

function binding(overrides: Partial<AgentSessionBinding> = {}): AgentSessionBinding {
  const status = overrides.status ?? "ACTIVE";
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    binding_id: "binding-1",
    session_id: "session-1",
    external_session_id: "external-1",
    task_id: "task-1",
    task_version: 1,
    run_id: "run-1",
    driver_id: "driver-1",
    role: "developer",
    status,
    context_package_id: "context-1",
    context_package_hash: hash,
    created_at: timestamp,
    ...(isTerminal(status) ? { closed_at: laterTimestamp } : {}),
    ...overrides,
  };
}

function isTerminal(status: AgentSessionBindingStatus): boolean {
  return status === "SUPERSEDED" || status === "CLOSED" || status === "FAILED";
}

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
