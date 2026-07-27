import {
  DOMAIN_SCHEMA_VERSION,
  type ContextPackage,
  type ContinuationSnapshot,
  type DomainJsonValue,
  type HandoffPackage,
  type TaskRelation,
  type TaskVersion,
} from "@agent-bridge/schemas";
import { describe, expect, it } from "vitest";

import {
  CONTEXT_ASSEMBLY_SCENARIOS,
  CoreDomainError,
  assembleContextPackage,
  computeContentHash,
  hasValidDocumentContentHash,
  type ContextAssemblyInput,
  type ContextAssemblyScenario,
  type CoreDomainErrorCode,
  type HandoffSelectionResult,
  type ProjectBaselineInput,
} from "../src/index.js";

const timestamp = "2026-07-27T10:00:00+08:00";
const snapshotTime = "2026-07-27T10:01:00+08:00";
const baseCommit = "aaaaaaa";
const headCommit = "bbbbbbb";
const sourceContextHash = `sha256:${"c".repeat(64)}`;

describe("Context Package 白名单组装策略", () => {
  it.each(CONTEXT_ASSEMBLY_SCENARIOS)("接受 %s 的最小合法白名单", (scenario) => {
    const result = assembleContextPackage(assemblyInput(scenario));

    expect(result.context_package.metadata?.scenario).toBe(scenario);
    expect(result.context_package.components.map((component) => component.kind)).toEqual(
      expectedKinds(scenario),
    );
    expect(Object.isFrozen(result.context_package)).toBe(true);
    expect(hasValidDocumentContentHash(asRecord(result.context_package))).toBe(true);
  });

  it.each([
    ["NEW_TASK", "review_findings", [reviewFinding()]],
    ["NEW_TASK_VERSION", "verification_results", [verificationResult()]],
    ["SAME_VERSION_REWORK", "failure_summary", failureSummary()],
    ["ROLLOVER", "review_findings", [reviewFinding()]],
    ["MANUAL_RETRY", "continuation_snapshot", snapshot()],
  ] as const)("%s 拒绝场景外组件 %s", (scenario, field, component) => {
    const input = assemblyInput(scenario);
    Object.assign(input, { [field]: component });

    expectCoreError(() => assembleContextPackage(input), "CONTEXT_PACKAGE_INVALID");
  });

  it("同版本返工必须至少包含 finding 或 verification", () => {
    const input = assemblyInput("SAME_VERSION_REWORK");
    input.review_findings = [];

    const error = expectCoreError(() => assembleContextPackage(input), "CONTEXT_PACKAGE_INVALID");
    expect(error.details.reason).toBe("REWORK_COMPONENTS_INVALID");
  });

  it("滚动必须包含 Snapshot、predecessor 且目标 Session 全新", () => {
    const missing = assemblyInput("ROLLOVER");
    delete missing.continuation_snapshot;
    expectCoreError(() => assembleContextPackage(missing), "CONTEXT_PACKAGE_INVALID");

    const reused = assemblyInput("ROLLOVER");
    reused.target_session_id = reused.predecessor_session_id as string;
    const error = expectCoreError(() => assembleContextPackage(reused), "CONTEXT_PACKAGE_INVALID");
    expect(error.details.reason).toBe("ROLLOVER_TARGET_SESSION_NOT_NEW");
  });

  it("手工重跑必须带旧 run 的失败摘要", () => {
    const missing = assemblyInput("MANUAL_RETRY");
    delete missing.failure_summary;
    expectCoreError(() => assembleContextPackage(missing), "CONTEXT_PACKAGE_INVALID");

    const sameRun = assemblyInput("MANUAL_RETRY");
    sameRun.failure_summary = {
      ...(sameRun.failure_summary as NonNullable<ContextAssemblyInput["failure_summary"]>),
      source_run_id: sameRun.run_id,
    };
    const error = expectCoreError(() => assembleContextPackage(sameRun), "CONTEXT_PACKAGE_INVALID");
    expect(error.details.reason).toBe("FAILURE_SUMMARY_SCOPE_MISMATCH");
  });

  it("同类组件输入顺序不影响最终顺序和内容哈希", () => {
    const first = assemblyInput("SAME_VERSION_REWORK");
    first.review_findings = [reviewFinding("finding-z"), reviewFinding("finding-a")];
    const second = assemblyInput("SAME_VERSION_REWORK");
    second.review_findings = [reviewFinding("finding-a"), reviewFinding("finding-z")];

    const firstPackage = assembleContextPackage(first).context_package;
    const secondPackage = assembleContextPackage(second).context_package;

    expect(firstPackage.components.map((component) => component.component_id)).toEqual(
      secondPackage.components.map((component) => component.component_id),
    );
    expect(firstPackage.content_hash).toBe(secondPackage.content_hash);
  });

  it("Handoff 按固定位置和 ID 排序，related_to 警告写入结果与包元数据", () => {
    const input = assemblyInput("NEW_TASK");
    input.task_version = taskVersion(1, ["handoff-z", "handoff-a"]);
    input.handoff_selection = handoffSelection([handoff("handoff-z"), handoff("handoff-a")]);

    const result = assembleContextPackage(input);

    expect(
      result.context_package.components
        .filter((component) => component.kind === "handoff")
        .map((component) => component.component_id),
    ).toEqual(["handoff-a", "handoff-z"]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "STALE_RELATED_HANDOFF", blocking: false }),
    ]);
    expect(result.context_package.metadata?.handoff_warnings).toEqual(result.warnings);
  });

  it("Handoff 警告输入顺序不影响最终顺序和内容哈希", () => {
    const handoffs = [handoff("handoff-z"), handoff("handoff-a")];
    const first = assemblyInput("NEW_TASK");
    first.task_version = taskVersion(1, ["handoff-z", "handoff-a"]);
    first.handoff_selection = {
      ...handoffSelection(handoffs),
      warnings: [handoffWarning("handoff-z"), handoffWarning("handoff-a")],
    };
    const second = assemblyInput("NEW_TASK");
    second.task_version = first.task_version;
    second.handoff_selection = {
      ...handoffSelection(handoffs),
      warnings: [handoffWarning("handoff-a"), handoffWarning("handoff-z")],
    };

    const firstResult = assembleContextPackage(first);
    const secondResult = assembleContextPackage(second);

    expect(firstResult.warnings.map((warning) => warning.handoff_id)).toEqual([
      "handoff-a",
      "handoff-z",
    ]);
    expect(firstResult.context_package.content_hash).toBe(
      secondResult.context_package.content_hash,
    );
  });

  it("Handoff 选择集合必须与 TaskVersion 完全一致", () => {
    const input = assemblyInput("NEW_TASK");
    input.task_version = taskVersion(1, ["handoff-required"]);

    const error = expectCoreError(() => assembleContextPackage(input), "CONTEXT_PACKAGE_INVALID");
    expect(error.details.reason).toBe("HANDOFF_SELECTION_MISMATCH");
  });

  it("Context 入口会重新校验 Handoff 关系作用域", () => {
    const input = assemblyInput("NEW_TASK");
    input.task_version = taskVersion(1, ["handoff-a"]);
    const selection = handoffSelection([handoff("handoff-a")]);
    input.handoff_selection = {
      ...selection,
      handoffs: [
        {
          ...selection.handoffs[0]!,
          relation: {
            ...selection.handoffs[0]!.relation,
            source: { task_id: "other-task", task_version: 1 },
          },
        },
      ],
    };

    const error = expectCoreError(() => assembleContextPackage(input), "CONTEXT_PACKAGE_INVALID");
    expect(error.details.reason).toBe("HANDOFF_RELATION_SCOPE_MISMATCH");
  });

  it("Handoff 警告只接受固定结构且不允许任意附加内容", () => {
    const secret = "provider-secret-warning";
    const input = assemblyInput("NEW_TASK");
    input.task_version = taskVersion(1, ["handoff-a"]);
    const selection = handoffSelection([handoff("handoff-a")]);
    input.handoff_selection = {
      ...selection,
      warnings: [{ ...selection.warnings[0]!, private_payload: secret }],
    } as unknown as HandoffSelectionResult;

    const error = expectCoreError(() => assembleContextPackage(input), "CONTEXT_PACKAGE_INVALID");
    expect(error.details.reason).toBe("HANDOFF_WARNING_INVALID");
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("重复组件 ID 不静默去重", () => {
    const input = assemblyInput("SAME_VERSION_REWORK");
    input.review_findings = [reviewFinding("shared-component")];
    input.verification_results = [verificationResult("shared-component")];

    const error = expectCoreError(() => assembleContextPackage(input), "CONTEXT_PACKAGE_INVALID");
    expect(error.details.reason).toBe("DUPLICATE_COMPONENT_ID");
  });

  it.each([
    ["task_id", "other-task"],
    ["task_version", 2],
    ["run_id", "other-run"],
    ["session_id", "other-session"],
  ] as const)("返工 finding 的 %s 关联冲突时拒绝", (field, value) => {
    const input = assemblyInput("SAME_VERSION_REWORK");
    input.review_findings = [{ ...reviewFinding(), [field]: value }];

    const error = expectCoreError(() => assembleContextPackage(input), "CONTEXT_PACKAGE_INVALID");
    expect(error.details.reason).toBe("REVIEW_FINDING_SCOPE_MISMATCH");
  });

  it.each([
    ["task_id", "other-task"],
    ["task_version", 2],
    ["run_id", "other-run"],
    ["session_id", "other-session"],
  ] as const)("滚动 Snapshot 的 %s 关联冲突时拒绝", (field, value) => {
    const input = assemblyInput("ROLLOVER");
    input.continuation_snapshot = snapshot({ [field]: value });

    const error = expectCoreError(() => assembleContextPackage(input), "CONTEXT_PACKAGE_INVALID");
    expect(error.details.reason).toBe("CONTINUATION_SNAPSHOT_SCOPE_MISMATCH");
  });

  it.each([
    ["project_id", "other-project", "PROJECT_BASELINE_SCOPE_MISMATCH"],
    ["baseline_version", 2, "PROJECT_BASELINE_SCOPE_MISMATCH"],
    ["content_hash", `sha256:${"f".repeat(64)}`, "PROJECT_BASELINE_CONTENT_HASH_MISMATCH"],
  ] as const)("Project Baseline 的 %s 冲突时拒绝", (field, value, reason) => {
    const input = assemblyInput("NEW_TASK");
    input.project_baseline = { ...input.project_baseline, [field]: value };

    const error = expectCoreError(() => assembleContextPackage(input), "CONTEXT_PACKAGE_INVALID");
    expect(error.details.reason).toBe(reason);
  });

  it("TaskVersion 内容被修改但哈希未更新时拒绝", () => {
    const input = assemblyInput("NEW_TASK");
    input.task_version = { ...input.task_version, objective: "tampered" };

    const error = expectCoreError(() => assembleContextPackage(input), "CONTEXT_PACKAGE_INVALID");
    expect(error.details.reason).toBe("TASK_VERSION_CONTENT_HASH_MISMATCH");
  });

  it.each(["messages", "transcript", "internal_reasoning", "api_key"])(
    "组件 content 中禁止字段 %s",
    (field) => {
      const secret = "sensitive-component-value";
      const input = assemblyInput("NEW_TASK");
      input.project_baseline = baseline({ [field]: secret });

      const error = expectCoreError(
        () => assembleContextPackage(input),
        "CONTEXT_CONTENT_FORBIDDEN",
      );
      expect(error.details.component_kind).toBe("project_baseline");
      expect(JSON.stringify(error)).not.toContain(secret);
    },
  );

  it("输出只包含 Schema 允许组件且不接受任意额外顶层内容", () => {
    const input = {
      ...assemblyInput("NEW_TASK"),
      full_transcript: ["forbidden"],
    };

    const error = expectCoreError(() => assembleContextPackage(input), "CONTEXT_PACKAGE_INVALID");
    expect(error.details.reason).toBe("ASSEMBLY_INPUT_INVALID");
  });
});

function expectedKinds(scenario: ContextAssemblyScenario): string[] {
  const kinds = ["project_baseline", "task_version"];
  if (scenario === "SAME_VERSION_REWORK") {
    kinds.push("review_finding");
  }
  if (scenario === "ROLLOVER") {
    kinds.push("continuation_snapshot");
  }
  if (scenario === "MANUAL_RETRY") {
    kinds.push("failure_summary");
  }
  return kinds;
}

function assemblyInput(scenario: ContextAssemblyScenario): MutableAssemblyInput {
  const version = scenario === "NEW_TASK_VERSION" ? 2 : 1;
  const input: MutableAssemblyInput = {
    scenario,
    context_package_id: `context-${scenario.toLowerCase().replaceAll("_", "-")}`,
    task_version: taskVersion(version),
    run_id: "run-target",
    target_session_id: "session-target",
    created_at: "2026-07-27T10:02:00+08:00",
    project_baseline: baseline(),
  };
  if (scenario === "SAME_VERSION_REWORK") {
    input.review_findings = [reviewFinding()];
  }
  if (scenario === "ROLLOVER") {
    input.predecessor_session_id = "session-source";
    input.continuation_snapshot = snapshot();
  }
  if (scenario === "MANUAL_RETRY") {
    input.failure_summary = failureSummary();
  }
  return input;
}

type MutableAssemblyInput = {
  -readonly [Key in keyof ContextAssemblyInput]: ContextAssemblyInput[Key];
};

function taskVersion(version: number, selectedHandoffIds: readonly string[] = []): TaskVersion {
  const payload = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "target-task",
    task_version: version,
    project_id: "project-1",
    base_commit: baseCommit,
    policy_version: "1.0",
    objective: "Assemble a strict context package",
    role: "developer",
    business_rules: [],
    scope: { read: ["src/**"], write: ["src/**"], deny: [] },
    acceptance_commands: ["pnpm test"],
    git: { branch: `agent/target-task-v${version}/developer` },
    relations: selectedHandoffIds.map((handoffId) => ({
      relation_id: `relation-${handoffId}`,
      type: "related_to" as const,
      target: { task_id: `source-${handoffId}`, task_version: 1 },
    })),
    selected_handoff_ids: selectedHandoffIds,
    context_policy: {
      project_baseline_version: 1,
      rollover_ratio: 0.7,
      inherit_full_transcript: false,
    },
    limits: { timeout_seconds: 3600, max_review_cycles: 3, max_agent_count: 4 },
    required_output: ["commit_sha"],
    created_at: timestamp,
  } as const;
  return withHash(payload);
}

function baseline(
  content: DomainJsonValue = { constraints: ["No provider calls"] },
): ProjectBaselineInput {
  const payload = {
    project_id: "project-1",
    baseline_version: 1,
    baseline: content,
  };
  return {
    component_id: "baseline-project-1",
    project_id: payload.project_id,
    baseline_version: payload.baseline_version,
    content,
    content_hash: computeContentHash(payload),
  };
}

function reviewFinding(componentId = "review-finding-1") {
  return {
    component_id: componentId,
    version: 1,
    source: "human" as const,
    task_id: "target-task",
    task_version: 1,
    run_id: "run-target",
    session_id: "session-target",
    finding: {
      finding_id: componentId,
      severity: "warning" as const,
      summary: "Add a deterministic boundary test",
    },
  };
}

function verificationResult(componentId = "verification-result-1") {
  return {
    component_id: componentId,
    version: 1,
    source: "verification" as const,
    task_id: "target-task",
    task_version: 1,
    run_id: "run-target",
    session_id: "session-target",
    verification: {
      command: "pnpm test",
      status: "passed" as const,
      exit_code: 0,
      artifact_ids: ["artifact-test"],
    },
  };
}

function failureSummary() {
  return {
    component_id: "failure-summary-1",
    version: 1,
    task_id: "target-task",
    task_version: 1,
    source_run_id: "run-failed",
    source_session_id: "session-failed",
    summary: { code: "TEST_FAILED", next_action: "Run the focused test" },
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
    current_step: "Prepare successor context",
    completed: ["Measured context usage"],
    remaining_plan: ["Create successor session"],
    git_state: {
      repository_id: "repository-1",
      base_commit: baseCommit,
      head_commit: headCommit,
      changed_files: ["packages/core/src/context-policy.ts"],
    },
    recent_verification: [],
    blockers: [],
    next_actions: ["Activate successor"],
    artifact_ids: [],
    created_at: snapshotTime,
    ...overrides,
  } as const;
  return withHash(payload);
}

function handoffSelection(handoffs: readonly HandoffPackage[]): HandoffSelectionResult {
  return {
    handoffs: handoffs.map((item) => ({ handoff: item, relation: handoffRelation(item) })),
    warnings: [handoffWarning("handoff-a")],
  };
}

function handoffWarning(handoffId: string) {
  return {
    code: "STALE_RELATED_HANDOFF" as const,
    blocking: false as const,
    reason: "SOURCE_HEAD_NOT_IN_TARGET_BASE" as const,
    relation_id: `relation-${handoffId}`,
    handoff_id: handoffId,
    relation_type: "related_to" as const,
  };
}

function handoff(id: string): HandoffPackage {
  const payload = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    handoff_id: id,
    handoff_version: 1,
    source_task: { task_id: `source-${id}`, task_version: 1, final_run_id: `run-${id}` },
    code_state: {
      repository_id: "repository-1",
      base_commit: baseCommit,
      head_commit: headCommit,
    },
    completed: [],
    decisions: [],
    contracts: [],
    changed_files: [],
    verification: { status: "not_run", artifact_ids: [] },
    known_issues: [],
    downstream_notes: [],
    field_sources: {
      completed: "agent",
      decisions: "human",
      contracts: "bridge",
      known_issues: "agent",
      downstream_notes: "agent",
    },
    generated_at: timestamp,
  } as const;
  return withHash(payload);
}

function handoffRelation(value: HandoffPackage): TaskRelation {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    relation_id: `relation-${value.handoff_id}`,
    type: "related_to",
    source: { task_id: "target-task", task_version: 1 },
    target: {
      task_id: value.source_task.task_id,
      task_version: value.source_task.task_version,
    },
    created_at: timestamp,
  };
}

function withHash<T extends Readonly<Record<string, unknown>>>(
  payload: T,
): T & { readonly content_hash: string } {
  return {
    ...payload,
    content_hash: computeContentHash(payload as unknown as DomainJsonValue),
  };
}

function asRecord(value: ContextPackage): Readonly<Record<string, unknown>> {
  return value as unknown as Readonly<Record<string, unknown>>;
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
