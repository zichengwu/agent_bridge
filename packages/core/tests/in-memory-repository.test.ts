import {
  DOMAIN_SCHEMA_VERSION,
  type AgentSessionBinding,
  type ContextPackage,
  type ContinuationSnapshot,
  type HandoffPackage,
  type TaskRelation,
} from "@agent-bridge/schemas";
import { describe, expect, it } from "vitest";

import {
  AUTHORITATIVE_DOMAIN_EVENT_VERSION,
  CoreDomainError,
  InMemoryDomainRepository,
  getDomainRecordId,
  type AgentRunRecord,
  type AuthoritativeDomainEvent,
  type AuthoritativeDomainEventType,
  type CoreDomainErrorCode,
  type DomainEventQuery,
  type DomainRecordWrite,
  type DomainWriteRequest,
} from "../src/index.js";

const timestamp = "2026-07-27T10:00:00+08:00";
const laterTimestamp = "2026-07-27T10:10:00+08:00";
const latestTimestamp = "2026-07-27T10:20:00+08:00";
const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;
const baseCommit = "8f34b21";
const headCommit = "abc1234";

describe("内存 Repository 恢复查询与事件游标", () => {
  it("按权威 run 状态返回恢复候选并稳定排序", async () => {
    const repository = new InMemoryDomainRepository();
    await commitRecord(
      repository,
      "run-b",
      { kind: "agent_run", expected_revision: 0, value: runValue("run-b", "running") },
      "agent_run.created",
    );
    await commitRecord(
      repository,
      "run-a",
      {
        kind: "agent_run",
        expected_revision: 0,
        value: runValue("run-a", "waiting_permission"),
      },
      "agent_run.created",
    );
    await commitRecord(
      repository,
      "run-finished",
      {
        kind: "agent_run",
        expected_revision: 0,
        value: runValue("run-finished", "succeeded"),
      },
      "agent_run.created",
    );

    const candidates = await repository.listRecoveryCandidates({ project_id: "project-1" });

    expect(candidates.map((record) => record.value.run_id)).toEqual(["run-a", "run-b"]);
    expect(candidates.every((record) => Object.isFrozen(record.value))).toBe(true);
    expect(await repository.listRecoveryCandidates({ project_id: "project-other" })).toEqual([]);
  });

  it("通过显式 run 恢复 Session 链、Context、最新 Snapshot 和 Handoff", async () => {
    const repository = new InMemoryDomainRepository();
    const firstBinding = sessionBinding({
      binding_id: "binding-1",
      session_id: "session-1",
      external_session_id: "external-1",
      status: "SUPERSEDED",
      context_package_id: "context-1",
      context_package_hash: hashA,
      created_at: timestamp,
      closed_at: laterTimestamp,
    });
    const successorBinding = sessionBinding({
      binding_id: "binding-2",
      session_id: "session-2",
      external_session_id: "external-2",
      predecessor_session_id: "session-1",
      status: "ACTIVE",
      context_package_id: "context-2",
      context_package_hash: hashB,
      created_at: laterTimestamp,
    });
    const context = contextValue("context-2", "session-2", hashB, laterTimestamp);
    const firstSnapshot = snapshotValue("snapshot-rollover", 1, timestamp);
    const latestSnapshot = snapshotValue("snapshot-rollover", 2, latestTimestamp);
    const handoff = handoffValue();

    await commitRecord(
      repository,
      "binding-1",
      { kind: "agent_session_binding", expected_revision: 0, value: firstBinding },
      "agent_session_binding.recorded",
    );
    await commitRecord(
      repository,
      "binding-2",
      { kind: "agent_session_binding", expected_revision: 0, value: successorBinding },
      "agent_session_binding.recorded",
    );
    await commitRecord(
      repository,
      "context-2",
      { kind: "context_package", expected_revision: 0, value: context },
      "context_package.recorded",
    );
    await commitRecord(
      repository,
      "snapshot-2",
      { kind: "continuation_snapshot", expected_revision: 0, value: latestSnapshot },
      "continuation_snapshot.recorded",
    );
    await commitRecord(
      repository,
      "snapshot-1",
      { kind: "continuation_snapshot", expected_revision: 0, value: firstSnapshot },
      "continuation_snapshot.recorded",
    );
    await commitRecord(
      repository,
      "handoff",
      { kind: "handoff_package", expected_revision: 0, value: handoff },
      "handoff_package.recorded",
    );

    const bindings = await repository.listAgentSessionBindings("run-1");
    const snapshots = await repository.listContinuationSnapshots("run-1");

    expect(bindings.map((record) => record.value.session_id)).toEqual(["session-1", "session-2"]);
    expect(bindings[1]?.value.predecessor_session_id).toBe("session-1");
    expect(await repository.getContextPackage("context-2")).toMatchObject({
      value: { target_session_id: "session-2" },
    });
    expect(snapshots.map((record) => record.value.snapshot_version)).toEqual([1, 2]);
    expect((await repository.getLatestContinuationSnapshot("run-1"))?.value).toEqual(
      latestSnapshot,
    );
    expect(
      (await repository.listHandoffPackages({ task_id: "task-0", task_version: 1 })).map(
        (record) => record.value.handoff_id,
      ),
    ).toEqual(["handoff-1"]);
  });

  it("任务关系按明确方向查询，不猜测最近关系", async () => {
    const repository = new InMemoryDomainRepository();
    const relation = relationValue();
    await commitRecord(
      repository,
      "relation",
      { kind: "task_relation", expected_revision: 0, value: relation },
      "task_relation.recorded",
    );

    expect(
      await repository.listTaskRelations({
        task_id: "task-1",
        task_version: 1,
        direction: "source",
      }),
    ).toHaveLength(1);
    expect(
      await repository.listTaskRelations({
        task_id: "task-1",
        task_version: 1,
        direction: "target",
      }),
    ).toEqual([]);
    expect(
      await repository.listTaskRelations({
        task_id: "task-0",
        task_version: 1,
        direction: "target",
      }),
    ).toHaveLength(1);
  });

  it("旧 Session SUPERSEDED 与后继 Session ACTIVE 在同一 write-set 中完成", async () => {
    const repository = new InMemoryDomainRepository();
    const predecessor = sessionBinding({
      binding_id: "binding-rollover-1",
      session_id: "session-rollover-1",
      external_session_id: "external-rollover-1",
      status: "ACTIVE",
      context_package_id: "context-rollover-1",
      created_at: timestamp,
    });
    const successor = sessionBinding({
      binding_id: "binding-rollover-2",
      session_id: "session-rollover-2",
      external_session_id: "external-rollover-2",
      predecessor_session_id: "session-rollover-1",
      status: "CREATED",
      context_package_id: "context-rollover-2",
      created_at: laterTimestamp,
    });
    await commitRecord(
      repository,
      "rollover-predecessor",
      { kind: "agent_session_binding", expected_revision: 0, value: predecessor },
      "agent_session_binding.recorded",
    );
    await commitRecord(
      repository,
      "rollover-successor",
      { kind: "agent_session_binding", expected_revision: 0, value: successor },
      "agent_session_binding.recorded",
    );

    const predecessorUpdate: DomainRecordWrite = {
      kind: "agent_session_binding",
      expected_revision: 1,
      value: { ...predecessor, status: "SUPERSEDED", closed_at: latestTimestamp },
    };
    const successorUpdate: DomainRecordWrite = {
      kind: "agent_session_binding",
      expected_revision: 1,
      value: { ...successor, status: "ACTIVE" },
    };
    const changeId = "change-rollover-complete";
    await repository.commit({
      change_id: changeId,
      idempotency: {
        operation: "recovery_test",
        key: "key-rollover-complete",
        request_hash: hashA,
      },
      records: [predecessorUpdate, successorUpdate],
      events: [
        eventFor(
          "event-rollover-predecessor-complete",
          changeId,
          predecessorUpdate,
          "agent_session_binding.status_changed",
        ),
        eventFor(
          "event-rollover-successor-complete",
          changeId,
          successorUpdate,
          "agent_session_binding.status_changed",
        ),
      ],
    });

    const bindings = await repository.listAgentSessionBindings("run-1");
    expect(bindings.map((record) => [record.value.session_id, record.value.status])).toEqual([
      ["session-rollover-1", "SUPERSEDED"],
      ["session-rollover-2", "ACTIVE"],
    ]);
    expect(bindings.every((record) => record.revision === 2)).toBe(true);
  });

  it("事件按 task/run 和不透明 cursor 分页且不会重复", async () => {
    const repository = new InMemoryDomainRepository();
    await commitRecord(
      repository,
      "run-1",
      { kind: "agent_run", expected_revision: 0, value: runValue("run-1", "running") },
      "agent_run.created",
    );
    await commitRecord(
      repository,
      "run-2",
      { kind: "agent_run", expected_revision: 0, value: runValue("run-2", "running") },
      "agent_run.created",
    );
    const runOne = runValue("run-1", "running");
    await repository.commit({
      change_id: "change-run-1-audit",
      idempotency: {
        operation: "recovery_test",
        key: "key-run-1-audit",
        request_hash: hashA,
      },
      records: [],
      events: [
        eventFor(
          "event-run-1-audit",
          "change-run-1-audit",
          { kind: "agent_run", expected_revision: 0, value: runOne },
          "agent_run.status_changed",
        ),
      ],
    });

    const firstPage = await repository.listDomainEvents({ run_id: "run-1", limit: 1 });
    const secondPage = await repository.listDomainEvents({
      run_id: "run-1",
      after_cursor: firstPage.next_cursor,
      limit: 10,
    });

    expect(firstPage.events.map((event) => event.event_id)).toEqual(["event-run-1"]);
    expect(secondPage.events.map((event) => event.event_id)).toEqual(["event-run-1-audit"]);
    expect(
      new Set([...firstPage.events, ...secondPage.events].map((event) => event.event_id)).size,
    ).toBe(2);
    expect(firstPage.next_cursor).toMatch(/^event-cursor:/u);
    expect(secondPage.next_cursor).toMatch(/^event-cursor:/u);
  });

  it.each([
    ["cursor", { after_cursor: "sqlite-rowid:1" }],
    ["limit", { limit: 0 }],
    ["unknown field", { local_path: "/tmp/repository" }],
  ] as const)("非法 %s 查询返回稳定且供应商无关的错误", async (_label, query) => {
    const repository = new InMemoryDomainRepository();
    const error = await expectCoreRejection(
      repository.listDomainEvents(query as unknown as DomainEventQuery),
      "REPOSITORY_QUERY_INVALID",
    );

    expect(error.message).toBe("Repository query is invalid");
    expect(JSON.stringify(error)).not.toContain("/tmp/repository");
  });

  it("不存在的恢复对象使用 undefined 或空集合表达", async () => {
    const repository = new InMemoryDomainRepository();

    expect(await repository.getAgentRun("run-missing")).toBeUndefined();
    expect(await repository.getLatestContinuationSnapshot("run-missing")).toBeUndefined();
    expect(await repository.listAgentSessionBindings("run-missing")).toEqual([]);
  });
});

async function commitRecord(
  repository: InMemoryDomainRepository,
  suffix: string,
  write: DomainRecordWrite,
  eventType: AuthoritativeDomainEventType,
): Promise<void> {
  await repository.commit(requestFor(suffix, write, eventType));
}

function requestFor(
  suffix: string,
  write: DomainRecordWrite,
  eventType: AuthoritativeDomainEventType,
): DomainWriteRequest {
  const changeId = `change-${suffix}`;
  return {
    change_id: changeId,
    idempotency: {
      operation: "recovery_test",
      key: `key-${suffix}`,
      request_hash: hashA,
    },
    records: [write],
    events: [eventFor(`event-${suffix}`, changeId, write, eventType)],
  };
}

function eventFor(
  eventId: string,
  changeId: string,
  write: DomainRecordWrite,
  eventType: AuthoritativeDomainEventType,
): AuthoritativeDomainEvent {
  return {
    event_id: eventId,
    event_version: AUTHORITATIVE_DOMAIN_EVENT_VERSION,
    event_type: eventType,
    aggregate: {
      kind: write.kind,
      id: getDomainRecordId(write.kind, write.value as never),
      revision: write.expected_revision + 1,
    },
    occurred_at: timestamp,
    audit: {
      actor: { kind: "bridge", id: "bridge-core" },
      operation: "recovery_test",
      request_id: changeId,
      correlation_id: `correlation-${changeId}`,
      idempotency_key: `key-${changeId.replace("change-", "")}`,
      task_id: "task-1",
      task_version: 1,
      run_id: write.kind === "agent_run" ? write.value.run_id : "run-1",
    },
    payload: { action: eventType },
  };
}

function runValue(runId: string, status: AgentRunRecord["status"]): AgentRunRecord {
  const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(status);
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    run_id: runId,
    task_id: "task-1",
    task_version: 1,
    project_id: "project-1",
    driver_id: "driver-primary",
    role: "developer",
    status,
    created_at: timestamp,
    updated_at: terminal ? laterTimestamp : timestamp,
    ...(status === "created" ? {} : { started_at: timestamp }),
    ...(terminal ? { finished_at: laterTimestamp } : {}),
  };
}

function sessionBinding(overrides: Partial<AgentSessionBinding>): AgentSessionBinding {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    binding_id: "binding-default",
    session_id: "session-default",
    external_session_id: "external-default",
    task_id: "task-1",
    task_version: 1,
    run_id: "run-1",
    driver_id: "driver-primary",
    role: "developer",
    status: "ACTIVE",
    context_package_id: "context-default",
    context_package_hash: hashA,
    created_at: timestamp,
    ...overrides,
  };
}

function contextValue(
  contextPackageId: string,
  targetSessionId: string,
  contentHash: string,
  createdAt: string,
): ContextPackage {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    context_package_id: contextPackageId,
    task_id: "task-1",
    task_version: 1,
    run_id: "run-1",
    target_session_id: targetSessionId,
    components: [
      {
        component_id: `baseline-${contextPackageId}`,
        kind: "project_baseline",
        version: 1,
        source: "bridge",
        content_hash: hashA,
        content: { project_id: "project-1" },
      },
    ],
    content_hash: contentHash,
    created_at: createdAt,
  };
}

function snapshotValue(
  snapshotId: string,
  snapshotVersion: number,
  createdAt: string,
): ContinuationSnapshot {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    snapshot_id: snapshotId,
    snapshot_version: snapshotVersion,
    task_id: "task-1",
    task_version: 1,
    run_id: "run-1",
    session_id: "session-1",
    source_context_package_id: "context-1",
    source_context_package_hash: hashA,
    current_step: `恢复检查点 ${snapshotVersion}`,
    completed: [],
    remaining_plan: [],
    git_state: {
      repository_id: "project-1",
      base_commit: baseCommit,
      head_commit: headCommit,
      changed_files: [],
    },
    recent_verification: [],
    blockers: [],
    next_actions: [],
    artifact_ids: [],
    content_hash: snapshotVersion === 1 ? hashA : hashB,
    created_at: createdAt,
  };
}

function handoffValue(): HandoffPackage {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    handoff_id: "handoff-1",
    handoff_version: 1,
    source_task: { task_id: "task-0", task_version: 1, final_run_id: "run-0" },
    code_state: {
      repository_id: "project-1",
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
    content_hash: hashA,
    generated_at: timestamp,
  };
}

function relationValue(): TaskRelation {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    relation_id: "relation-1",
    type: "depends_on",
    source: { task_id: "task-1", task_version: 1 },
    target: { task_id: "task-0", task_version: 1 },
    created_at: timestamp,
  };
}

async function expectCoreRejection(
  operation: Promise<unknown>,
  code: CoreDomainErrorCode,
): Promise<CoreDomainError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(CoreDomainError);
    expect((error as CoreDomainError).code).toBe(code);
    return error as CoreDomainError;
  }
  throw new Error(`Expected CoreDomainError with code ${code}`);
}
