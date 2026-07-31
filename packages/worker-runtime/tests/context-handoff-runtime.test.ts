import {
  InMemoryDomainRepository,
  computeContentHash,
  type AgentRunRecord,
  type AuthoritativeDomainEventType,
  type DomainRecordWrite,
  type DomainRepository,
} from "@agent-bridge/core";
import {
  DOMAIN_SCHEMA_VERSION,
  type DomainJsonValue,
  type TaskRelation,
  type TaskResult,
  type TaskVersion,
} from "@agent-bridge/schemas";
import { describe, expect, it } from "vitest";

import { ContextHandoffRuntime, type GitClient, type RuntimeAuditInput } from "../src/index.js";

const timestamp = "2026-07-31T10:00:00.000Z";
const later = "2026-07-31T10:01:00.000Z";

describe("运行期 Context 与 Handoff 持久化编排", () => {
  it("从 Repository 权威事实生成 Handoff，再组装并事务保存 Context", async () => {
    const repository = new InMemoryDomainRepository();
    await seedSource(repository);
    const git: GitClient = {
      run: () => Promise.resolve({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    };
    const runtime = new ContextHandoffRuntime(repository, git);

    const handoff = await runtime.generateHandoff({
      handoff_id: "handoff-source",
      handoff_version: 1,
      source_task: { task_id: "source-task", task_version: 1 },
      final_run_id: "run-source",
      repository_id: "repository-1",
      completed: ["完成来源能力"],
      decisions: ["保持 Driver 中立"],
      contracts: ["ContextPackage 1.0"],
      known_issues: [],
      downstream_notes: ["目标任务只注入本 Handoff"],
      field_sources: {
        completed: "agent",
        decisions: "human",
        contracts: "bridge",
        known_issues: "agent",
        downstream_notes: "agent",
      },
      generated_at: later,
      audit: audit("generate-handoff", "event-handoff", later),
    });
    expect(handoff).toMatchObject({
      changed_files: ["src/source.ts"],
      verification: {
        status: "passed",
        artifact_ids: ["verification-log", "verification-report"],
      },
    });
    expect(await repository.getHandoffPackage("handoff-source", 1)).toBeDefined();

    await seedTarget(repository);
    const context = await runtime.prepareContext({
      task: { task_id: "target-task", task_version: 1 },
      run_id: "run-target",
      target_session_id: "session-target",
      scenario: "NEW_TASK",
      context_package_id: "context-target",
      project_baseline: baseline(),
      repository_id: "repository-1",
      repository_path: "/repository",
      selected_handoffs: [{ handoff_id: "handoff-source", handoff_version: 1 }],
      audit: audit("prepare-context", "event-context", later),
    });

    expect(context.context_package.components.map((component) => component.kind)).toEqual([
      "project_baseline",
      "task_version",
      "handoff",
    ]);
    expect(await repository.getContextPackage("context-target")).toMatchObject({
      value: { content_hash: context.context_package.content_hash },
    });
  });

  it("depends_on 的来源 commit 不在目标 base 时沿用 STALE_HANDOFF 阻断", async () => {
    const repository = new InMemoryDomainRepository();
    await seedSource(repository);
    const runtime = new ContextHandoffRuntime(repository, {
      run: () => Promise.resolve({ exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    });
    await runtime.generateHandoff({
      handoff_id: "handoff-source",
      handoff_version: 1,
      source_task: { task_id: "source-task", task_version: 1 },
      final_run_id: "run-source",
      repository_id: "repository-1",
      completed: [],
      decisions: [],
      contracts: [],
      known_issues: [],
      downstream_notes: [],
      field_sources: {
        completed: "agent",
        decisions: "human",
        contracts: "bridge",
        known_issues: "agent",
        downstream_notes: "agent",
      },
      generated_at: later,
      audit: audit("generate-handoff", "event-handoff", later),
    });
    await seedTarget(repository);

    await expect(
      runtime.prepareContext({
        task: { task_id: "target-task", task_version: 1 },
        run_id: "run-target",
        target_session_id: "session-target",
        scenario: "NEW_TASK",
        context_package_id: "context-target",
        project_baseline: baseline(),
        repository_id: "repository-1",
        repository_path: "/repository",
        selected_handoffs: [{ handoff_id: "handoff-source", handoff_version: 1 }],
        audit: audit("prepare-context", "event-context", later),
      }),
    ).rejects.toMatchObject({ code: "STALE_HANDOFF" });
  });

  it("来源 Run 未成功时拒绝发布 Handoff", async () => {
    const repository = new InMemoryDomainRepository();
    await record(
      repository,
      "task_version",
      sourceVersion(),
      "task_version.recorded",
      "source-version",
    );
    await record(
      repository,
      "agent_run",
      { ...sourceRun(), status: "failed" },
      "agent_run.created",
      "source-run",
    );
    await record(
      repository,
      "task_result",
      sourceResult(),
      "task_result.recorded",
      "source-result",
    );

    await expect(
      new ContextHandoffRuntime(repository, {
        run: () =>
          Promise.resolve({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
      }).generateHandoff({
        handoff_id: "handoff-source",
        handoff_version: 1,
        source_task: { task_id: "source-task", task_version: 1 },
        final_run_id: "run-source",
        repository_id: "repository-1",
        completed: [],
        decisions: [],
        contracts: [],
        known_issues: [],
        downstream_notes: [],
        field_sources: {
          completed: "agent",
          decisions: "human",
          contracts: "bridge",
          known_issues: "agent",
          downstream_notes: "agent",
        },
        generated_at: later,
        audit: audit("generate-handoff", "event-handoff", later),
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_CONTEXT_INVALID",
      details: { reason: "HANDOFF_SOURCE_FACTS_INVALID" },
    });
  });
});

async function seedSource(repository: DomainRepository): Promise<void> {
  await record(
    repository,
    "task_version",
    sourceVersion(),
    "task_version.recorded",
    "source-version",
  );
  await record(repository, "agent_run", sourceRun(), "agent_run.created", "source-run");
  await record(repository, "task_result", sourceResult(), "task_result.recorded", "source-result");
}

async function seedTarget(repository: DomainRepository): Promise<void> {
  await record(
    repository,
    "task_version",
    targetVersion(),
    "task_version.recorded",
    "target-version",
  );
  await record(repository, "task_relation", relation(), "task_relation.recorded", "relation");
}

async function record(
  repository: DomainRepository,
  kind: DomainRecordWrite["kind"],
  value: DomainRecordWrite["value"],
  eventType: AuthoritativeDomainEventType,
  suffix: string,
): Promise<void> {
  const write = { kind, expected_revision: 0, value } as DomainRecordWrite;
  const recordId =
    kind === "task_version"
      ? `${(value as TaskVersion).task_id}:v${(value as TaskVersion).task_version}`
      : kind === "task_result"
        ? (value as TaskResult).run_id
        : kind === "agent_run"
          ? (value as AgentRunRecord).run_id
          : (value as TaskRelation).relation_id;
  const requestId = `request-${suffix}`;
  await repository.commit({
    change_id: requestId,
    idempotency: {
      operation: "seed",
      key: `key-${suffix}`,
      request_hash: computeContentHash({ suffix }),
    },
    records: [write],
    events: [
      {
        event_id: `event-${suffix}`,
        event_version: 1,
        event_type: eventType,
        aggregate: { kind, id: recordId, revision: 1 },
        occurred_at: timestamp,
        audit: {
          actor: { kind: "bridge", id: "bridge-test" },
          operation: "seed",
          request_id: requestId,
          correlation_id: "correlation-seed",
          idempotency_key: `key-${suffix}`,
        },
        payload: { seeded: kind },
      },
    ],
  });
}

function sourceVersion(): TaskVersion {
  return version({
    task_id: "source-task",
    base_commit: "aaaaaaa",
    selected_handoff_ids: undefined,
    relations: undefined,
  });
}

function targetVersion(): TaskVersion {
  return version({
    task_id: "target-task",
    base_commit: "ddddddd",
    selected_handoff_ids: ["handoff-source"],
    relations: [
      {
        relation_id: "relation-target-source",
        type: "depends_on",
        target: { task_id: "source-task", task_version: 1 },
      },
    ],
  });
}

function version(input: {
  readonly task_id: string;
  readonly base_commit: string;
  readonly selected_handoff_ids?: readonly string[];
  readonly relations?: TaskVersion["relations"];
}): TaskVersion {
  const withoutHash = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: input.task_id,
    task_version: 1,
    project_id: "project-1",
    base_commit: input.base_commit,
    policy_version: "1.0",
    objective: `执行 ${input.task_id}`,
    role: "developer" as const,
    business_rules: [],
    scope: { read: ["src/**"], write: ["src/**"], deny: [] },
    acceptance_commands: ["verify"],
    git: { branch: `agent/${input.task_id}` },
    ...(input.relations === undefined ? {} : { relations: input.relations }),
    ...(input.selected_handoff_ids === undefined
      ? {}
      : { selected_handoff_ids: input.selected_handoff_ids }),
    context_policy: {
      project_baseline_version: 1,
      rollover_ratio: 0.7,
      inherit_full_transcript: false as const,
    },
    limits: { timeout_seconds: 3600, max_review_cycles: 3, max_agent_count: 4 },
    required_output: ["commit_sha"],
    created_at: timestamp,
  };
  return {
    ...withoutHash,
    content_hash: computeContentHash(withoutHash as unknown as DomainJsonValue),
  };
}

function sourceRun(): AgentRunRecord {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    run_id: "run-source",
    task_id: "source-task",
    task_version: 1,
    project_id: "project-1",
    driver_id: "opencode",
    role: "developer",
    status: "succeeded",
    created_at: timestamp,
    updated_at: later,
    started_at: timestamp,
    finished_at: later,
  };
}

function sourceResult(): TaskResult {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "source-task",
    task_version: 1,
    run_id: "run-source",
    session_ids: ["session-source"],
    status: "submitted",
    base_commit: "aaaaaaa",
    commit_sha: "ccccccc",
    changed_files: ["src/source.ts"],
    acceptance_results: [
      {
        command: "verify",
        exit_code: 0,
        duration_ms: 10,
        log_artifact_id: "verification-log",
      },
    ],
    review_findings: [],
    known_risks: [],
    unresolved_items: [],
    artifacts: [{ artifact_id: "verification-report", kind: "verification.report" }],
    started_at: timestamp,
    finished_at: later,
  };
}

function relation(): TaskRelation {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    relation_id: "relation-target-source",
    type: "depends_on",
    source: { task_id: "target-task", task_version: 1 },
    target: { task_id: "source-task", task_version: 1 },
    created_at: timestamp,
  };
}

function baseline() {
  const content = { conventions: ["保持公开契约"] };
  return {
    component_id: "baseline-1",
    project_id: "project-1",
    baseline_version: 1,
    content,
    content_hash: computeContentHash({
      project_id: "project-1",
      baseline_version: 1,
      baseline: content,
    }),
  };
}

function audit(operation: string, eventId: string, occurredAt: string): RuntimeAuditInput {
  return {
    actor: { kind: "bridge", id: "bridge-test" },
    operation,
    request_id: `request-${operation}`,
    correlation_id: "correlation-runtime",
    idempotency_key: `key-${operation}`,
    event_id: eventId,
    occurred_at: occurredAt,
  };
}
