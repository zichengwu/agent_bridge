import {
  DOMAIN_SCHEMA_VERSION,
  type DomainJsonValue,
  type HandoffPackage,
  type TaskRelation,
  type TaskRelationType,
  type TaskVersion,
} from "@agent-bridge/schemas";
import { describe, expect, it } from "vitest";

import {
  CoreDomainError,
  computeContentHash,
  selectExplicitHandoffs,
  type CoreDomainErrorCode,
  type HandoffCandidate,
} from "../src/index.js";

const timestamp = "2026-07-27T10:00:00+08:00";
const targetBase = "bbbbbbb";
const sourceBase = "aaaaaaa";
const sourceHead = "ccccccc";

describe("Handoff 显式选择与完整性策略", () => {
  it.each(["depends_on", "related_to", "supersedes", "follow_up_of"] as const)(
    "接受显式选择且完整的 %s Handoff",
    (type) => {
      const candidate = handoffCandidate(type, true);
      const result = selectExplicitHandoffs(selectionInput(type, [candidate]));

      expect(result.handoffs).toHaveLength(1);
      expect(result.handoffs[0]?.handoff.handoff_id).toBe("handoff-source-v1");
      expect(result.warnings).toEqual([]);
    },
  );

  it("拒绝注入未显式选择的 Handoff", () => {
    const input = selectionInput("depends_on", [handoffCandidate("depends_on", true)]);
    input.target_task_version = taskVersion("depends_on", []);

    const error = expectCoreError(() => selectExplicitHandoffs(input), "CONTEXT_PACKAGE_INVALID");
    expect(error.details.reason).toBe("HANDOFF_NOT_EXPLICITLY_SELECTED");
  });

  it("显式选择的 Handoff 缺失时不静默忽略", () => {
    const error = expectCoreError(
      () => selectExplicitHandoffs(selectionInput("depends_on", [])),
      "CONTEXT_PACKAGE_INVALID",
    );
    expect(error.details.reason).toBe("SELECTED_HANDOFF_MISSING");
  });

  it("重复 Handoff 稳定拒绝", () => {
    const candidate = handoffCandidate("depends_on", true);
    const error = expectCoreError(
      () => selectExplicitHandoffs(selectionInput("depends_on", [candidate, candidate])),
      "HANDOFF_INTEGRITY_ERROR",
    );
    expect(error.details.reason).toBe("DUPLICATE_HANDOFF");
  });

  it("内容哈希不匹配时返回 HANDOFF_INTEGRITY_ERROR", () => {
    const candidate = handoffCandidate("depends_on", true);
    candidate.handoff = {
      ...candidate.handoff,
      completed: ["tampered"],
    };

    const error = expectCoreError(
      () => selectExplicitHandoffs(selectionInput("depends_on", [candidate])),
      "HANDOFF_INTEGRITY_ERROR",
    );
    expect(error.details.reason).toBe("CONTENT_HASH_MISMATCH");
  });

  it("字段来源与权威事实不一致时拒绝", () => {
    const candidate = handoffCandidate("depends_on", true);
    candidate.authority = {
      ...candidate.authority,
      field_sources: {
        ...candidate.authority.field_sources,
        completed: "human",
      },
    };

    const error = expectCoreError(
      () => selectExplicitHandoffs(selectionInput("depends_on", [candidate])),
      "HANDOFF_INTEGRITY_ERROR",
    );
    expect(error.details.reason).toBe("FIELD_SOURCES_MISMATCH");
  });

  it.each([
    ["task_id", "other-task", "AUTHORITATIVE_SOURCE_TASK_MISMATCH"],
    ["task_version", 2, "AUTHORITATIVE_SOURCE_TASK_MISMATCH"],
    ["repository_id", "other-repository", "REPOSITORY_MISMATCH"],
    ["base_commit", "ddddddd", "AUTHORITATIVE_COMMIT_MISMATCH"],
    ["head_commit", "eeeeeee", "AUTHORITATIVE_COMMIT_MISMATCH"],
  ] as const)("权威来源字段 %s 冲突时拒绝", (field, value, reason) => {
    const candidate = handoffCandidate("depends_on", true);
    candidate.authority = { ...candidate.authority, [field]: value };

    const error = expectCoreError(
      () => selectExplicitHandoffs(selectionInput("depends_on", [candidate])),
      "HANDOFF_INTEGRITY_ERROR",
    );
    expect(error.details.reason).toBe(reason);
  });

  it("关系必须由目标 TaskVersion 显式声明且精确指向来源版本", () => {
    const candidate = handoffCandidate("depends_on", true);
    candidate.relation = {
      ...candidate.relation,
      relation_id: "relation-not-declared",
    };

    const error = expectCoreError(
      () => selectExplicitHandoffs(selectionInput("depends_on", [candidate])),
      "HANDOFF_INTEGRITY_ERROR",
    );
    expect(error.details.reason).toBe("RELATION_NOT_DECLARED");
  });

  it("commit 包含事实必须精确对应来源 head 与目标 base", () => {
    const candidate = handoffCandidate("depends_on", true);
    candidate.containment = {
      ...candidate.containment,
      target_base_commit: "ddddddd",
    };

    const error = expectCoreError(
      () => selectExplicitHandoffs(selectionInput("depends_on", [candidate])),
      "HANDOFF_INTEGRITY_ERROR",
    );
    expect(error.details.reason).toBe("COMMIT_CONTAINMENT_FACT_MISMATCH");
  });

  it("depends_on 来源 head 未包含在目标 base 时阻断", () => {
    const error = expectCoreError(
      () =>
        selectExplicitHandoffs(
          selectionInput("depends_on", [handoffCandidate("depends_on", false)]),
        ),
      "STALE_HANDOFF",
    );

    expect(error.details).toEqual({
      entity: "handoff",
      reason: "SOURCE_HEAD_NOT_IN_TARGET_BASE",
      relation_id: "relation-source-v1",
      handoff_id: "handoff-source-v1",
      relation_type: "depends_on",
    });
  });

  it("related_to 陈旧时返回稳定、非阻塞警告", () => {
    const result = selectExplicitHandoffs(
      selectionInput("related_to", [handoffCandidate("related_to", false)]),
    );

    expect(result.handoffs).toHaveLength(1);
    expect(result.warnings).toEqual([
      {
        code: "STALE_RELATED_HANDOFF",
        blocking: false,
        reason: "SOURCE_HEAD_NOT_IN_TARGET_BASE",
        relation_id: "relation-source-v1",
        handoff_id: "handoff-source-v1",
        relation_type: "related_to",
      },
    ]);
  });

  it.each(["supersedes", "follow_up_of"] as const)("%s 陈旧事实不产生额外阻断或警告", (type) => {
    const result = selectExplicitHandoffs(selectionInput(type, [handoffCandidate(type, false)]));

    expect(result.handoffs).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("敏感字段扫描拒绝 Handoff 且错误不泄漏值", () => {
    const secret = "sk-sensitive-value-123456";
    const candidate = handoffCandidate("depends_on", true);
    candidate.handoff = handoff({
      metadata: {
        api_key: secret,
      },
    });

    const error = expectCoreError(
      () => selectExplicitHandoffs(selectionInput("depends_on", [candidate])),
      "HANDOFF_INTEGRITY_ERROR",
    );
    expect(error.details.reason).toBe("SENSITIVE_CONTENT");
    expect(error.details.finding_paths).toEqual(["/metadata/api_key"]);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("错误边界不回显非法输入内容", () => {
    const secret = "provider-secret-payload";
    const error = expectCoreError(
      () => selectExplicitHandoffs({ private_payload: secret }),
      "HANDOFF_INTEGRITY_ERROR",
    );

    expect(JSON.stringify(error)).not.toContain(secret);
  });
});

function selectionInput(
  type: TaskRelationType,
  candidates: HandoffCandidate[],
): {
  target_task_version: TaskVersion;
  repository_id: string;
  candidates: HandoffCandidate[];
} {
  return {
    target_task_version: taskVersion(type),
    repository_id: "repository-1",
    candidates,
  };
}

function taskVersion(type: TaskRelationType, selected = ["handoff-source-v1"]): TaskVersion {
  const payload = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "target-task",
    task_version: 1,
    project_id: "project-1",
    base_commit: targetBase,
    policy_version: "1.0",
    objective: "Use an explicit handoff",
    role: "developer",
    business_rules: [],
    scope: { read: ["src/**"], write: ["src/**"], deny: [] },
    acceptance_commands: ["pnpm test"],
    git: { branch: "agent/target-task/developer" },
    relations: [
      {
        relation_id: "relation-source-v1",
        type,
        target: { task_id: "source-task", task_version: 1 },
      },
    ],
    selected_handoff_ids: selected,
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

function handoff(overrides: Readonly<Record<string, unknown>> = {}): HandoffPackage {
  const payload = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    handoff_id: "handoff-source-v1",
    handoff_version: 1,
    source_task: {
      task_id: "source-task",
      task_version: 1,
      final_run_id: "run-source",
    },
    code_state: {
      repository_id: "repository-1",
      base_commit: sourceBase,
      head_commit: sourceHead,
    },
    completed: ["Implemented source contract"],
    decisions: ["Keep the public contract stable"],
    contracts: ["POST /source"],
    changed_files: ["src/source.ts"],
    verification: { status: "passed", artifact_ids: ["artifact-source"] },
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
    ...overrides,
  } as const;
  return withHash(payload);
}

function relation(type: TaskRelationType): TaskRelation {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    relation_id: "relation-source-v1",
    type,
    source: { task_id: "target-task", task_version: 1 },
    target: { task_id: "source-task", task_version: 1 },
    created_at: timestamp,
  };
}

function handoffCandidate(type: TaskRelationType, contained: boolean): MutableCandidate {
  const value = handoff();
  return {
    handoff: value,
    relation: relation(type),
    authority: {
      task_id: value.source_task.task_id,
      task_version: value.source_task.task_version,
      repository_id: value.code_state.repository_id,
      base_commit: value.code_state.base_commit,
      head_commit: value.code_state.head_commit,
      field_sources: value.field_sources,
    },
    containment: {
      source_head_commit: value.code_state.head_commit,
      target_base_commit: targetBase,
      is_contained: contained,
    },
  };
}

type MutableCandidate = {
  -readonly [Key in keyof HandoffCandidate]: HandoffCandidate[Key];
};

function withHash<T extends Readonly<Record<string, unknown>>>(
  payload: T,
): T & { readonly content_hash: string } {
  return {
    ...payload,
    content_hash: computeContentHash(payload as unknown as DomainJsonValue),
  };
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
