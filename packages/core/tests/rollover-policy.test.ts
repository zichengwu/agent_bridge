import {
  DOMAIN_SCHEMA_VERSION,
  type AgentSessionBinding,
  type ContextPackage,
  type ContinuationSnapshot,
  type DomainJsonValue,
} from "@agent-bridge/schemas";
import { describe, expect, it } from "vitest";

import {
  CoreDomainError,
  completeSessionRollover,
  computeContentHash,
  createSessionRolloverPlan,
  evaluateProviderContextErrorRollover,
  evaluateSessionRollover,
  failSessionRollover,
  type CoreDomainErrorCode,
  type CreateSessionRolloverPlanInput,
  type RolloverBoundaryFacts,
  type SessionRolloverDecision,
} from "../src/index.js";

const sourceTime = "2026-07-27T10:00:00+08:00";
const snapshotTime = "2026-07-27T10:01:00+08:00";
const successorTime = "2026-07-27T10:02:00+08:00";
const requestedTime = "2026-07-27T10:03:00+08:00";
const completedTime = "2026-07-27T10:04:00+08:00";
const baseCommit = "aaaaaaa";
const headCommit = "bbbbbbb";
const sourceContextHash = `sha256:${"c".repeat(64)}`;

const safeBoundary: RolloverBoundaryFacts = {
  at_input_boundary: true,
  open_tool_call_count: 0,
  pending_permission_count: 0,
  atomic_step_in_progress: false,
};

describe("70% Session 滚动阈值", () => {
  it.each([
    [699, "NOT_REQUIRED"],
    [700, "PLAN_ROLLOVER"],
    [701, "PLAN_ROLLOVER"],
  ] as const)("默认阈值下 used=%s → %s", (usedTokens, action) => {
    const decision = evaluateSessionRollover({
      usage: { mode: "exact", used_tokens: usedTokens, max_tokens: 1000 },
      boundary: safeBoundary,
    });

    expect(decision.action).toBe(action);
    expect(decision.effective_ratio).toBe(0.7);
    expect(decision.limiting_sources).toEqual(["default"]);
  });

  it.each(["exact", "estimated"] as const)("%s 用量使用同一供应商无关算法", (mode) => {
    const decision = evaluateSessionRollover({
      usage: { mode, used_tokens: 60, max_tokens: 100 },
      ratios: { task: 0.65, project: 0.6, driver: 0.68 },
      boundary: safeBoundary,
    });

    expect(decision).toMatchObject({
      action: "PLAN_ROLLOVER",
      effective_ratio: 0.6,
      used_ratio: 0.6,
      usage_mode: mode,
      limiting_sources: ["project"],
    });
  });

  it("TaskContract、Project、Driver 和 70% 上限取最小合法值", () => {
    const decision = evaluateSessionRollover({
      usage: { mode: "exact", used_tokens: 55, max_tokens: 100 },
      ratios: { task: 0.65, project: 0.55, driver: 0.55 },
      boundary: safeBoundary,
    });

    expect(decision.effective_ratio).toBe(0.55);
    expect(decision.limiting_sources).toEqual(["project", "driver"]);
    expect(decision.action).toBe("PLAN_ROLLOVER");
  });

  it("所有配置高于 70% 时仍由默认上限限制", () => {
    const decision = evaluateSessionRollover({
      usage: { mode: "exact", used_tokens: 70, max_tokens: 100 },
      ratios: { task: 0.9, project: 0.8, driver: 1 },
      boundary: safeBoundary,
    });

    expect(decision.effective_ratio).toBe(0.7);
    expect(decision.limiting_sources).toEqual(["default"]);
    expect(decision.action).toBe("PLAN_ROLLOVER");
  });

  it.each([0, -0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])("拒绝非法配置比例 %s", (ratio) => {
    const error = expectCoreError(
      () =>
        evaluateSessionRollover({
          usage: { mode: "exact", used_tokens: 10, max_tokens: 100 },
          ratios: { project: ratio },
          boundary: safeBoundary,
        }),
      "ROLLOVER_PLAN_INVALID",
    );
    expect(error.details.reason).toBe("ROLLOVER_RATIO_INVALID");
  });

  it.each([undefined, 0, -1, 1.5])("缺失或非法 max_tokens=%s 时拒绝", (maxTokens) => {
    const error = expectCoreError(
      () =>
        evaluateSessionRollover({
          usage: { mode: "estimated", used_tokens: 10, max_tokens: maxTokens },
          boundary: safeBoundary,
        }),
      "ROLLOVER_PLAN_INVALID",
    );
    expect(error.details.reason).toBe("CONTEXT_LIMIT_MISSING_OR_INVALID");
  });

  it("达到阈值但不在安全边界时确定性等待", () => {
    const decision = evaluateSessionRollover({
      usage: { mode: "exact", used_tokens: 70, max_tokens: 100 },
      boundary: {
        at_input_boundary: false,
        open_tool_call_count: 1,
        pending_permission_count: 1,
        atomic_step_in_progress: true,
      },
    });

    expect(decision).toMatchObject({
      action: "WAIT_FOR_SAFE_BOUNDARY",
      reason: "UNSAFE_BOUNDARY",
      unsafe_reasons: [
        "NOT_AT_INPUT_BOUNDARY",
        "OPEN_TOOL_CALLS",
        "PENDING_PERMISSIONS",
        "ATOMIC_STEP_IN_PROGRESS",
      ],
    });
  });

  it("非法用量错误不泄漏输入内容", () => {
    const secret = "provider-secret-payload";
    const error = expectCoreError(
      () =>
        evaluateSessionRollover({
          usage: { mode: secret, used_tokens: 1, max_tokens: 10 },
          boundary: safeBoundary,
        }),
      "ROLLOVER_PLAN_INVALID",
    );
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});

describe("Provider 提前上下文错误的纯领域边界", () => {
  it("首次错误且处于安全边界时只授权一次滚动计划", () => {
    expect(
      evaluateProviderContextErrorRollover({
        prior_attempt_count: 0,
        boundary: safeBoundary,
      }),
    ).toEqual({
      action: "PLAN_ROLLOVER",
      reason: "PROVIDER_CONTEXT_ERROR",
      attempt_number: 1,
    });
  });

  it("首次错误但边界不安全时等待，不调用 Driver", () => {
    expect(
      evaluateProviderContextErrorRollover({
        prior_attempt_count: 0,
        boundary: { ...safeBoundary, pending_permission_count: 1 },
      }),
    ).toEqual({
      action: "WAIT_FOR_SAFE_BOUNDARY",
      reason: "PROVIDER_CONTEXT_ERROR_UNSAFE_BOUNDARY",
      attempt_number: 1,
      unsafe_reasons: ["PENDING_PERMISSIONS"],
    });
  });

  it("已有一次滚动尝试时确定要求 run 失败", () => {
    const decision = evaluateProviderContextErrorRollover({
      prior_attempt_count: 1,
      boundary: safeBoundary,
    });
    expect(decision).toEqual({
      action: "FAIL_RUN",
      reason: "PROVIDER_CONTEXT_ERROR_ATTEMPT_EXHAUSTED",
      prior_attempt_count: 1,
    });

    const input = planInput();
    input.decision = decision;
    const error = expectCoreError(() => createSessionRolloverPlan(input), "ROLLOVER_FAILED");
    expect(error.details.reason).toBe("PROVIDER_CONTEXT_ERROR_ATTEMPT_EXHAUSTED");
  });
});

describe("Session 滚动计划与一致性结果", () => {
  it("成功路径保持 scope，旧 Session SUPERSEDED，后继 Session ACTIVE", () => {
    const plan = createSessionRolloverPlan(planInput());

    expect(plan.previous_binding.status).toBe("ACTIVE");
    expect(plan.pending_binding.status).toBe("ROLLOVER_PENDING");
    expect(plan.successor_binding.status).toBe("CREATED");

    const result = completeSessionRollover(plan, completedTime);

    expect(result.status).toBe("SUCCEEDED");
    expect(result.previous_binding.status).toBe("SUPERSEDED");
    expect(result.successor_binding.status).toBe("ACTIVE");
    expect(result.successor_binding.predecessor_session_id).toBe("session-source");
    expect(result.bindings.filter((binding) => binding.status === "ACTIVE")).toHaveLength(1);
    for (const field of ["task_id", "task_version", "run_id", "driver_id", "role"] as const) {
      expect(result.successor_binding[field]).toBe(result.previous_binding[field]);
    }
  });

  it("低于阈值时创建计划返回 ROLLOVER_NOT_REQUIRED", () => {
    const input = planInput();
    input.decision = decision(69, safeBoundary);

    const error = expectCoreError(() => createSessionRolloverPlan(input), "ROLLOVER_NOT_REQUIRED");
    expect(error.details).toMatchObject({ reason: "BELOW_THRESHOLD", used_ratio: 0.69 });
  });

  it("不安全边界创建计划返回 ROLLOVER_UNSAFE_BOUNDARY", () => {
    const input = planInput();
    input.decision = decision(70, { ...safeBoundary, open_tool_call_count: 1 });

    const error = expectCoreError(
      () => createSessionRolloverPlan(input),
      "ROLLOVER_UNSAFE_BOUNDARY",
    );
    expect(error.details.unsafe_reasons).toEqual(["OPEN_TOOL_CALLS"]);
  });

  it.each([
    ["task_id", "other-task"],
    ["task_version", 2],
    ["run_id", "other-run"],
    ["driver_id", "other-driver"],
    ["role", "tester"],
  ] as const)("后继 Session 的 %s scope 冲突时拒绝", (field, value) => {
    const input = planInput();
    input.successor_binding = binding({
      ...input.successor_binding,
      [field]: value,
    });

    const error = expectCoreError(() => createSessionRolloverPlan(input), "ROLLOVER_PLAN_INVALID");
    expect(error.details).toEqual({
      entity: "agent_session",
      reason: "SUCCESSOR_SCOPE_MISMATCH",
      conflict_fields: [field],
    });
  });

  it.each([
    ["session_id", "session-source"],
    ["external_session_id", "external-source"],
    ["binding_id", "binding-source"],
    ["predecessor_session_id", "other-session"],
  ] as const)("后继 %s 不满足全新/predecessor 约束时拒绝", (field, value) => {
    const input = planInput();
    input.successor_binding = binding({ ...input.successor_binding, [field]: value });

    const error = expectCoreError(() => createSessionRolloverPlan(input), "ROLLOVER_PLAN_INVALID");
    expect(error.details.reason).toBe("SUCCESSOR_IDENTITY_INVALID");
  });

  it.each([
    ["task_id", "other-task"],
    ["task_version", 2],
    ["run_id", "other-run"],
    ["session_id", "other-session"],
    ["source_context_package_id", "other-context"],
    ["source_context_package_hash", `sha256:${"f".repeat(64)}`],
  ] as const)("Snapshot 的 %s 关联冲突时拒绝", (field, value) => {
    const input = planInput();
    input.snapshot = snapshot({ [field]: value });

    const error = expectCoreError(() => createSessionRolloverPlan(input), "ROLLOVER_PLAN_INVALID");
    expect(error.details.reason).toBe("SNAPSHOT_SCOPE_MISMATCH");
  });

  it("Snapshot 内容哈希不匹配时拒绝", () => {
    const input = planInput();
    input.snapshot = {
      ...input.snapshot,
      current_step: "tampered",
    };

    const error = expectCoreError(() => createSessionRolloverPlan(input), "ROLLOVER_PLAN_INVALID");
    expect(error.details.reason).toBe("SNAPSHOT_CONTENT_HASH_MISMATCH");
  });

  it.each([
    ["target_session_id", "other-session"],
    ["run_id", "other-run"],
  ] as const)("后继 Context 的 %s 冲突时拒绝", (field, value) => {
    const input = planInput();
    input.successor_context_package = contextPackage(input.snapshot, { [field]: value });

    const error = expectCoreError(() => createSessionRolloverPlan(input), "ROLLOVER_PLAN_INVALID");
    expect(error.details.reason).toBe("SUCCESSOR_CONTEXT_SCOPE_MISMATCH");
  });

  it("后继 Context 内嵌的 Snapshot 必须与计划 Snapshot 完全一致", () => {
    const input = planInput();
    input.successor_context_package = contextPackage(
      snapshot({ current_step: "Different checkpoint" }),
    );
    input.successor_binding = binding({
      ...input.successor_binding,
      context_package_hash: input.successor_context_package.content_hash,
    });

    const error = expectCoreError(() => createSessionRolloverPlan(input), "ROLLOVER_PLAN_INVALID");
    expect(error.details.reason).toBe("SUCCESSOR_CONTEXT_SNAPSHOT_INVALID");
  });

  it("后继 Context 只允许 rollover 白名单组件", () => {
    const input = planInput();
    const context = input.successor_context_package;
    input.successor_context_package = rehashContext({
      ...context,
      components: [
        ...context.components,
        {
          component_id: "review-finding-forbidden",
          kind: "review_finding",
          version: 1,
          source: "human",
          content_hash: computeContentHash({ finding_id: "finding-1" }),
          content: { finding_id: "finding-1" },
        },
      ],
    });
    input.successor_binding = binding({
      ...input.successor_binding,
      context_package_hash: input.successor_context_package.content_hash,
    });

    const error = expectCoreError(() => createSessionRolloverPlan(input), "ROLLOVER_PLAN_INVALID");
    expect(error.details.reason).toBe("SUCCESSOR_CONTEXT_COMPONENTS_INVALID");
  });

  it("同 run+role 已有双 ACTIVE 时在计划前拒绝", () => {
    const input = planInput();
    input.bindings = [
      ...input.bindings,
      binding({
        binding_id: "binding-conflict",
        session_id: "session-conflict",
        external_session_id: "external-conflict",
        status: "ACTIVE",
      }),
    ];

    expectCoreError(() => createSessionRolloverPlan(input), "SESSION_ACTIVE_CONFLICT");
  });

  it.each(["SUCCESSOR_CREATION", "SUCCESSOR_ACTIVATION", "ROLLOVER_FINALIZATION"] as const)(
    "%s 失败返回确定性失败结果并使两个 Session FAILED",
    (stage) => {
      const plan = createSessionRolloverPlan(planInput());
      const result = failSessionRollover(plan, completedTime, stage);

      expect(result).toMatchObject({
        status: "FAILED",
        error_code: "ROLLOVER_FAILED",
        error_details: {
          entity: "agent_session",
          reason: "ROLLOVER_OPERATION_FAILED",
          failure_stage: stage,
        },
        run_transition: "FAIL",
      });
      expect(result.previous_binding.status).toBe("FAILED");
      expect(result.successor_binding.status).toBe("FAILED");
      expect(result.bindings.filter((item) => item.status === "ACTIVE")).toHaveLength(0);
      expect(result.snapshot.snapshot_id).toBe("snapshot-1");
    },
  );

  it("未知失败阶段稳定返回 ROLLOVER_PLAN_INVALID", () => {
    const plan = createSessionRolloverPlan(planInput());
    const error = expectCoreError(
      () => failSessionRollover(plan, completedTime, "provider-secret-stage"),
      "ROLLOVER_PLAN_INVALID",
    );
    expect(error.details.reason).toBe("FAILURE_STAGE_INVALID");
    expect(JSON.stringify(error)).not.toContain("provider-secret-stage");
  });
});

function decision(usedTokens: number, boundary: RolloverBoundaryFacts): SessionRolloverDecision {
  return evaluateSessionRollover({
    usage: { mode: "exact", used_tokens: usedTokens, max_tokens: 100 },
    boundary,
  });
}

function planInput(): MutablePlanInput {
  const current = binding();
  const checkpoint = snapshot();
  const context = contextPackage(checkpoint);
  const successor = binding({
    binding_id: "binding-successor",
    session_id: "session-successor",
    external_session_id: "external-successor",
    predecessor_session_id: current.session_id,
    status: "CREATED",
    context_package_id: context.context_package_id,
    context_package_hash: context.content_hash,
    created_at: successorTime,
  });
  return {
    decision: decision(70, safeBoundary),
    bindings: [current],
    current_session_id: current.session_id,
    snapshot: checkpoint,
    successor_binding: successor,
    successor_context_package: context,
    requested_at: requestedTime,
  };
}

type MutablePlanInput = {
  -readonly [Key in keyof CreateSessionRolloverPlanInput]: CreateSessionRolloverPlanInput[Key];
};

function binding(overrides: Partial<AgentSessionBinding> = {}): AgentSessionBinding {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    binding_id: "binding-source",
    session_id: "session-source",
    external_session_id: "external-source",
    task_id: "target-task",
    task_version: 1,
    run_id: "run-target",
    driver_id: "driver-primary",
    role: "developer",
    status: "ACTIVE",
    context_package_id: "context-source",
    context_package_hash: sourceContextHash,
    created_at: sourceTime,
    ...overrides,
  };
}

function snapshot(overrides: Readonly<Record<string, unknown>> = {}): ContinuationSnapshot {
  const payload = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    snapshot_id: "snapshot-1",
    snapshot_version: 1,
    task_id: "target-task",
    task_version: 1,
    run_id: "run-target",
    session_id: "session-source",
    source_context_package_id: "context-source",
    source_context_package_hash: sourceContextHash,
    current_step: "Create a successor session",
    completed: ["Reached the rollover threshold"],
    remaining_plan: ["Activate the successor"],
    git_state: {
      repository_id: "repository-1",
      base_commit: baseCommit,
      head_commit: headCommit,
      changed_files: ["packages/core/src/rollover-policy.ts"],
    },
    recent_verification: [],
    blockers: [],
    next_actions: ["Continue in the successor"],
    artifact_ids: [],
    created_at: snapshotTime,
    ...overrides,
  } as const;
  return withHash(payload);
}

function contextPackage(
  checkpoint: ContinuationSnapshot,
  overrides: Readonly<Record<string, unknown>> = {},
): ContextPackage {
  const baselineContent = { project_id: "project-1", baseline_version: 1, baseline: {} };
  const taskContent = { task_id: "target-task", task_version: 1 };
  const payload = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    context_package_id: "context-successor",
    task_id: "target-task",
    task_version: 1,
    run_id: "run-target",
    target_session_id: "session-successor",
    components: [
      {
        component_id: "baseline-project-1",
        kind: "project_baseline",
        version: 1,
        source: "bridge",
        content_hash: computeContentHash(baselineContent),
        content: baselineContent,
      },
      {
        component_id: "task-version:target-task:v1",
        kind: "task_version",
        version: 1,
        source: "bridge",
        content_hash: computeContentHash(taskContent),
        content: taskContent,
      },
      {
        component_id: checkpoint.snapshot_id,
        kind: "continuation_snapshot",
        version: checkpoint.snapshot_version,
        source: "bridge",
        content_hash: checkpoint.content_hash,
        content: checkpoint,
      },
    ],
    created_at: successorTime,
    metadata: { scenario: "ROLLOVER" },
    ...overrides,
  } as const;
  return withHash(payload) as unknown as ContextPackage;
}

function withHash<T extends Readonly<Record<string, unknown>>>(
  payload: T,
): T & { readonly content_hash: string } {
  return {
    ...payload,
    content_hash: computeContentHash(payload as unknown as DomainJsonValue),
  };
}

function rehashContext(value: ContextPackage): ContextPackage {
  const payload = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "content_hash"),
  );
  return withHash(payload) as unknown as ContextPackage;
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
