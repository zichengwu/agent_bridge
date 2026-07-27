import {
  DOMAIN_SCHEMA_VERSION,
  type AgentSessionBinding,
  type AgentSessionBindingStatus,
} from "@agent-bridge/schemas";
import { describe, expect, it } from "vitest";

import {
  CoreDomainError,
  selectAgentSession,
  type CoreDomainErrorCode,
  type SessionScope,
} from "../src/index.js";

const timestamp = "2026-07-24T10:00:00+08:00";
const laterTimestamp = "2026-07-24T10:01:00+08:00";
const hash = `sha256:${"a".repeat(64)}`;

const target: SessionScope = {
  task_id: "task-1",
  task_version: 1,
  run_id: "run-1",
  driver_id: "driver-1",
  role: "developer",
};

describe("Session 绑定与选择矩阵", () => {
  it.each([
    ["NEW_TASK", []],
    ["NEW_TASK_VERSION", [binding({ task_version: 1 })]],
  ] as const)("%s 确定创建新 Session", (reason, bindings) => {
    expect(
      selectAgentSession({
        reason,
        target: reason === "NEW_TASK_VERSION" ? { ...target, task_version: 2 } : target,
        bindings,
      }),
    ).toEqual({
      action: "CREATE_NEW",
      reason,
    });
  });

  it("手工重跑要求新 run 并确定创建新 Session", () => {
    expect(
      selectAgentSession({
        reason: "MANUAL_RETRY",
        target: { ...target, run_id: "run-2" },
        previous_run_id: "run-1",
        bindings: [binding({ status: "FAILED" })],
      }),
    ).toEqual({
      action: "CREATE_NEW",
      reason: "MANUAL_RETRY",
    });
  });

  it("同版本返工仅复用显式指定、精确匹配的当前 ACTIVE Session", () => {
    const current = binding();

    expect(
      selectAgentSession({
        reason: "SAME_VERSION_REWORK",
        target,
        current_session_id: current.session_id,
        bindings: [current],
      }),
    ).toEqual({
      action: "REUSE_CURRENT",
      reason: "SAME_VERSION_REWORK",
      binding: current,
    });
  });

  it("不按数组顺序或最近 Session 推断权威当前 Session", () => {
    const current = binding();
    const laterButUnselected = binding({
      binding_id: "binding-2",
      session_id: "session-2",
      external_session_id: "external-2",
      run_id: "run-2",
      created_at: laterTimestamp,
    });

    const decision = selectAgentSession({
      reason: "SAME_VERSION_REWORK",
      target,
      current_session_id: current.session_id,
      bindings: [current, laterButUnselected],
    });

    expect(decision.action).toBe("REUSE_CURRENT");
    if (decision.action === "REUSE_CURRENT") {
      expect(decision.binding.session_id).toBe("session-1");
    }
  });

  it.each(["NEW_TASK", "NEW_TASK_VERSION", "MANUAL_RETRY"] as const)(
    "%s 拒绝调用方请求复用旧 Session",
    (reason) => {
      expectCoreError(
        () =>
          selectAgentSession({
            reason,
            target: { ...target, run_id: reason === "MANUAL_RETRY" ? "run-2" : "run-1" },
            previous_run_id: reason === "MANUAL_RETRY" ? "run-1" : undefined,
            current_session_id: "session-1",
            bindings: [binding()],
          }),
        "SESSION_SCOPE_CONFLICT",
      );
    },
  );

  it("手工重跑拒绝沿用原 run_id", () => {
    const error = expectCoreError(
      () =>
        selectAgentSession({
          reason: "MANUAL_RETRY",
          target,
          previous_run_id: target.run_id,
          bindings: [binding({ status: "FAILED" })],
        }),
      "SESSION_SELECTION_INVALID",
    );
    expect(error.details.reason).toBe("MANUAL_RETRY_REQUIRES_NEW_RUN");
  });

  it.each([
    ["task_id", "task-2"],
    ["task_version", 2],
    ["run_id", "run-2"],
    ["driver_id", "driver-2"],
    ["role", "tester"],
  ] as const)("跨 %s 复用稳定返回 SESSION_SCOPE_CONFLICT", (field, value) => {
    const scopedBinding = binding({ [field]: value });
    const error = expectCoreError(
      () =>
        selectAgentSession({
          reason: "SAME_VERSION_REWORK",
          target,
          current_session_id: scopedBinding.session_id,
          bindings: [scopedBinding],
        }),
      "SESSION_SCOPE_CONFLICT",
    );

    expect(error.details.conflict_fields).toEqual([field]);
  });

  it("缺少或找不到明确当前 Session 时不猜测", () => {
    expectCoreError(
      () =>
        selectAgentSession({
          reason: "SAME_VERSION_REWORK",
          target,
          bindings: [binding()],
        }),
      "SESSION_CURRENT_MISSING",
    );

    expectCoreError(
      () =>
        selectAgentSession({
          reason: "SAME_VERSION_REWORK",
          target,
          current_session_id: "session-missing",
          bindings: [binding()],
        }),
      "SESSION_CURRENT_MISSING",
    );
  });

  it.each(["CREATED", "ROLLOVER_PENDING", "SUPERSEDED", "CLOSED", "FAILED"] as const)(
    "%s Session 不可续用",
    (status) => {
      const current = binding({ status });
      const error = expectCoreError(
        () =>
          selectAgentSession({
            reason: "SAME_VERSION_REWORK",
            target,
            current_session_id: current.session_id,
            bindings: [current],
          }),
        "SESSION_NOT_RESUMABLE",
      );

      expect(error.details.current_status).toBe(status);
    },
  );

  it("重复或矛盾绑定稳定返回 SESSION_BINDING_INVALID", () => {
    const duplicate = binding({
      binding_id: "binding-2",
      external_session_id: "external-2",
      task_id: "task-2",
    });

    expectCoreError(
      () =>
        selectAgentSession({
          reason: "SAME_VERSION_REWORK",
          target,
          current_session_id: "session-1",
          bindings: [binding(), duplicate],
        }),
      "SESSION_BINDING_INVALID",
    );
  });

  it("同一 run+role 双 ACTIVE 在选择前即稳定拒绝", () => {
    const second = binding({
      binding_id: "binding-2",
      session_id: "session-2",
      external_session_id: "external-2",
    });

    expectCoreError(
      () =>
        selectAgentSession({
          reason: "SAME_VERSION_REWORK",
          target,
          current_session_id: "session-1",
          bindings: [binding(), second],
        }),
      "SESSION_ACTIVE_CONFLICT",
    );
  });

  it("未知选择场景与非法绑定不泄漏输入内容", () => {
    const secret = "provider-secret-payload";
    const scenarioError = expectCoreError(
      () =>
        selectAgentSession({
          reason: secret,
          target,
          bindings: [],
        }),
      "SESSION_SELECTION_INVALID",
    );
    const bindingError = expectCoreError(
      () =>
        selectAgentSession({
          reason: "SAME_VERSION_REWORK",
          target,
          current_session_id: "session-1",
          bindings: [{ ...binding(), private_payload: secret }],
        }),
      "SESSION_BINDING_INVALID",
    );

    expect(JSON.stringify(scenarioError)).not.toContain(secret);
    expect(JSON.stringify(bindingError)).not.toContain(secret);
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
