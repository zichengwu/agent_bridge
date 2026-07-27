import {
  DOMAIN_SCHEMA_VERSION,
  type AgentSessionBinding,
  type ContextPackage,
  type ContinuationSnapshot,
  type HandoffPackage,
  type Task,
  type TaskRelation,
  type TaskResult,
  type TaskVersion,
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
  type DomainRecordKind,
  type DomainRecordWrite,
  type DomainRepository,
  type DomainWriteRequest,
} from "../src/index.js";

const timestamp = "2026-07-27T10:00:00+08:00";
const laterTimestamp = "2026-07-27T10:10:00+08:00";
const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;
const baseCommit = "8f34b21";
const headCommit = "abc1234";

interface RecordCase {
  readonly label: string;
  readonly write: DomainRecordWrite;
  readonly event_type: AuthoritativeDomainEventType;
  readonly load: (repository: DomainRepository) => Promise<unknown>;
}

const task = taskValue();
const taskVersion = taskVersionValue();
const taskResult = taskResultValue();
const taskRelation = taskRelationValue();
const agentRun = agentRunValue();
const sessionBinding = sessionBindingValue();
const contextPackage = contextPackageValue();
const handoff = handoffValue();
const snapshot = snapshotValue();

const recordCases: readonly RecordCase[] = [
  {
    label: "Task",
    write: { kind: "task", expected_revision: 0, value: task },
    event_type: "task.created",
    load: (repository) => repository.getTask(task.task_id),
  },
  {
    label: "TaskVersion",
    write: { kind: "task_version", expected_revision: 0, value: taskVersion },
    event_type: "task_version.recorded",
    load: (repository) =>
      repository.getTaskVersion({ task_id: taskVersion.task_id, task_version: 1 }),
  },
  {
    label: "TaskResult",
    write: { kind: "task_result", expected_revision: 0, value: taskResult },
    event_type: "task_result.recorded",
    load: (repository) => repository.getTaskResult(taskResult.run_id),
  },
  {
    label: "TaskRelation",
    write: { kind: "task_relation", expected_revision: 0, value: taskRelation },
    event_type: "task_relation.recorded",
    load: (repository) => repository.getTaskRelation(taskRelation.relation_id),
  },
  {
    label: "AgentRun",
    write: { kind: "agent_run", expected_revision: 0, value: agentRun },
    event_type: "agent_run.created",
    load: (repository) => repository.getAgentRun(agentRun.run_id),
  },
  {
    label: "AgentSessionBinding",
    write: { kind: "agent_session_binding", expected_revision: 0, value: sessionBinding },
    event_type: "agent_session_binding.recorded",
    load: (repository) => repository.getAgentSessionBinding(sessionBinding.binding_id),
  },
  {
    label: "ContextPackage",
    write: { kind: "context_package", expected_revision: 0, value: contextPackage },
    event_type: "context_package.recorded",
    load: (repository) => repository.getContextPackage(contextPackage.context_package_id),
  },
  {
    label: "HandoffPackage",
    write: { kind: "handoff_package", expected_revision: 0, value: handoff },
    event_type: "handoff_package.recorded",
    load: (repository) => repository.getHandoffPackage(handoff.handoff_id, 1),
  },
  {
    label: "ContinuationSnapshot",
    write: { kind: "continuation_snapshot", expected_revision: 0, value: snapshot },
    event_type: "continuation_snapshot.recorded",
    load: (repository) => repository.getContinuationSnapshot(snapshot.snapshot_id, 1),
  },
];

const repositoryFactories = [
  ["内存实现", () => new InMemoryDomainRepository()],
] as const satisfies readonly (readonly [string, () => DomainRepository])[];

describe.each(repositoryFactories)("Repository 合约：%s", (_label, createRepository) => {
  it.each(recordCases)("一致写入并读取 $label", async ({ write, event_type: eventType, load }) => {
    const repository = createRepository();
    const request = requestFor("record-case", write, eventType);

    const result = await repository.commit(request);
    const stored = await load(repository);
    const events = await repository.listDomainEvents();

    expect(result).toMatchObject({
      outcome: "APPLIED",
      change_id: "change-record-case",
      records: [
        {
          kind: write.kind,
          record_id: getRecordId(write),
          revision: 1,
        },
      ],
      event_ids: ["event-record-case"],
    });
    expect(stored).toMatchObject({
      kind: write.kind,
      record_id: getRecordId(write),
      revision: 1,
      value: write.value,
    });
    expect(Object.isFrozen(stored)).toBe(true);
    expect(events.events).toHaveLength(1);
    expect(events.events[0]?.aggregate).toEqual({
      kind: write.kind,
      id: getRecordId(write),
      revision: 1,
    });
  });

  it.each([
    {
      label: "Task",
      seed: recordCases[0]!,
      update: {
        kind: "task",
        expected_revision: 1,
        value: { ...task, status: "VALIDATED", updated_at: laterTimestamp },
      } satisfies DomainRecordWrite,
      event_type: "task.status_changed" as const,
      load: (repository: DomainRepository) => repository.getTask(task.task_id),
      expected_status: "VALIDATED",
    },
    {
      label: "AgentRun",
      seed: recordCases[4]!,
      update: {
        kind: "agent_run",
        expected_revision: 1,
        value: {
          ...agentRun,
          status: "running",
          updated_at: laterTimestamp,
          started_at: timestamp,
        },
      } satisfies DomainRecordWrite,
      event_type: "agent_run.status_changed" as const,
      load: (repository: DomainRepository) => repository.getAgentRun(agentRun.run_id),
      expected_status: "running",
    },
    {
      label: "AgentSessionBinding",
      seed: recordCases[5]!,
      update: {
        kind: "agent_session_binding",
        expected_revision: 1,
        value: { ...sessionBinding, status: "ACTIVE" },
      } satisfies DomainRecordWrite,
      event_type: "agent_session_binding.status_changed" as const,
      load: (repository: DomainRepository) =>
        repository.getAgentSessionBinding(sessionBinding.binding_id),
      expected_status: "ACTIVE",
    },
  ])("$label 状态变化与 revision 2 事件一致写入", async (scenario) => {
    const repository = createRepository();
    await repository.commit(
      requestFor(`mutable-${scenario.label}-seed`, scenario.seed.write, scenario.seed.event_type),
    );

    await repository.commit(
      requestFor(`mutable-${scenario.label}-update`, scenario.update, scenario.event_type),
    );

    expect(await scenario.load(repository)).toMatchObject({
      revision: 2,
      value: { status: scenario.expected_status },
    });
    expect((await repository.listDomainEvents()).events.at(-1)).toMatchObject({
      event_type: scenario.event_type,
      aggregate: { revision: 2 },
    });
  });

  it("同一幂等请求精确重放，不重复记录或事件", async () => {
    const repository = createRepository();
    const request = requestFor("idempotent", recordCases[0]!.write, "task.created");

    const first = await repository.commit(request);
    const replay = await repository.commit(request);
    const stored = await repository.getTask(task.task_id);
    const events = await repository.listDomainEvents();

    expect(first.outcome).toBe("APPLIED");
    expect(replay).toEqual({ ...first, outcome: "REPLAYED" });
    expect(stored?.revision).toBe(1);
    expect(events.events.map((event) => event.event_id)).toEqual(["event-idempotent"]);
  });

  it.each([
    ["different request hash", { request_hash: hashB }],
    ["different change id", { change_id: "change-idempotent-other" }],
  ] as const)("同 key 的 %s 返回稳定幂等冲突", async (_label, mutation) => {
    const repository = createRepository();
    const request = requestFor("idempotent", recordCases[0]!.write, "task.created");
    await repository.commit(request);
    const conflicting = {
      ...request,
      ...("change_id" in mutation ? { change_id: mutation.change_id } : {}),
      idempotency: {
        ...request.idempotency,
        ...("request_hash" in mutation ? { request_hash: mutation.request_hash } : {}),
      },
      events:
        "change_id" in mutation
          ? request.events.map((event) => ({
              ...event,
              audit: { ...event.audit, request_id: mutation.change_id },
            }))
          : request.events,
    };

    const error = await expectCoreRejection(
      repository.commit(conflicting),
      "REPOSITORY_IDEMPOTENCY_CONFLICT",
    );
    expect(error.details.reason).toBe("IDEMPOTENCY_PAYLOAD_MISMATCH");
  });

  it("同 key/hash 但 write-set 改变时拒绝伪重放", async () => {
    const repository = createRepository();
    const request = requestFor("fingerprint", recordCases[0]!.write, "task.created");
    await repository.commit(request);
    const changed = {
      ...request,
      events: [
        {
          ...request.events[0]!,
          payload: { action: "different" },
        },
      ],
    };

    await expectCoreRejection(repository.commit(changed), "REPOSITORY_IDEMPOTENCY_CONFLICT");
  });

  it("批次内任一 revision 冲突时对象和事件均不部分写入", async () => {
    const repository = createRepository();
    await repository.commit(requestFor("seed", recordCases[0]!.write, "task.created"));

    const updatedTask: Task = {
      ...task,
      status: "VALIDATED",
      updated_at: laterTimestamp,
    };
    const invalidRunExpectation: DomainRecordWrite = {
      kind: "agent_run",
      expected_revision: 1,
      value: agentRun,
    };
    const request = batchRequest("atomic", [
      { kind: "task", expected_revision: 1, value: updatedTask },
      invalidRunExpectation,
    ]);

    await expectCoreRejection(repository.commit(request), "REPOSITORY_WRITE_CONFLICT");
    expect(await repository.getTask(task.task_id)).toMatchObject({
      revision: 1,
      value: { status: "DRAFT" },
    });
    expect(await repository.getAgentRun(agentRun.run_id)).toBeUndefined();
    expect((await repository.listDomainEvents()).events).toHaveLength(1);
  });

  it("多个 Binding 不能在同一 run + role 下同时 ACTIVE", async () => {
    const repository = createRepository();
    const firstCreated = recordCases[5]!;
    const secondCreated: AgentSessionBinding = {
      ...sessionBinding,
      binding_id: "binding-2",
      session_id: "session-2",
      external_session_id: "external-session-2",
    };
    await repository.commit(
      requestFor("binding-first-create", firstCreated.write, firstCreated.event_type),
    );
    await repository.commit(
      requestFor(
        "binding-second-create",
        {
          kind: "agent_session_binding",
          expected_revision: 0,
          value: secondCreated,
        },
        "agent_session_binding.recorded",
      ),
    );
    await repository.commit(
      requestFor(
        "binding-first-active",
        {
          kind: "agent_session_binding",
          expected_revision: 1,
          value: { ...sessionBinding, status: "ACTIVE" },
        },
        "agent_session_binding.status_changed",
      ),
    );

    const error = await expectCoreRejection(
      repository.commit(
        requestFor(
          "binding-second-active",
          {
            kind: "agent_session_binding",
            expected_revision: 1,
            value: { ...secondCreated, status: "ACTIVE" },
          },
          "agent_session_binding.status_changed",
        ),
      ),
      "REPOSITORY_WRITE_CONFLICT",
    );

    expect(error.details.reason).toBe("SESSION_BINDING_SET_INVALID");
    expect(await repository.getAgentSessionBinding("binding-2")).toMatchObject({
      revision: 1,
      value: { status: "CREATED" },
    });
  });

  it("不可变对象不能以新 revision 原地覆盖", async () => {
    const repository = createRepository();
    const immutableCase = recordCases.find((item) => item.write.kind === "task_version")!;
    await repository.commit(
      requestFor("immutable-seed", immutableCase.write, immutableCase.event_type),
    );
    const update: DomainRecordWrite = {
      ...immutableCase.write,
      expected_revision: 1,
    };

    const error = await expectCoreRejection(
      repository.commit(requestFor("immutable-update", update, immutableCase.event_type)),
      "REPOSITORY_WRITE_CONFLICT",
    );
    expect(error.details.reason).toBe("IMMUTABLE_RECORD_EXISTS");
  });

  it("每条记录必须有匹配新 revision 的权威事件", async () => {
    const repository = createRepository();
    const request = requestFor("missing-event", recordCases[0]!.write, "task.created");
    const mismatched = {
      ...request,
      events: [
        {
          ...request.events[0]!,
          aggregate: { ...request.events[0]!.aggregate, revision: 2 },
        },
      ],
    };

    const error = await expectCoreRejection(
      repository.commit(mismatched),
      "REPOSITORY_WRITE_INVALID",
    );
    expect(error.details.reason).toBe("RECORD_EVENT_MISSING");
    expect(await repository.getTask(task.task_id)).toBeUndefined();
  });

  it("event_id 追加后不可复用", async () => {
    const repository = createRepository();
    const request = requestFor("event-id", recordCases[0]!.write, "task.created");
    await repository.commit(request);
    const eventOnly = eventOnlyRequest("event-id-reuse", {
      ...request.events[0]!,
      audit: auditFor("change-event-id-reuse"),
    });

    const error = await expectCoreRejection(
      repository.commit(eventOnly),
      "REPOSITORY_WRITE_CONFLICT",
    );
    expect(error.details.reason).toBe("EVENT_ID_ALREADY_EXISTS");
  });

  it("非法记录错误不回显输入内容", async () => {
    const repository = createRepository();
    const secret = "provider-secret-value";
    const invalid = {
      ...requestFor("secret", recordCases[0]!.write, "task.created"),
      records: [
        {
          ...recordCases[0]!.write,
          value: {
            ...task,
            private_payload: secret,
          },
        },
      ],
    };

    const error = await expectCoreRejection(
      repository.commit(invalid as unknown as DomainWriteRequest),
      "REPOSITORY_WRITE_INVALID",
    );
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});

function requestFor(
  suffix: string,
  write: DomainRecordWrite,
  eventType: AuthoritativeDomainEventType,
): DomainWriteRequest {
  const changeId = `change-${suffix}`;
  return {
    change_id: changeId,
    idempotency: {
      operation: "repository_contract",
      key: `key-${suffix}`,
      request_hash: hashA,
    },
    records: [write],
    events: [eventFor(`event-${suffix}`, changeId, write, eventType)],
  };
}

function batchRequest(suffix: string, writes: readonly DomainRecordWrite[]): DomainWriteRequest {
  const changeId = `change-${suffix}`;
  return {
    change_id: changeId,
    idempotency: {
      operation: "repository_contract",
      key: `key-${suffix}`,
      request_hash: hashA,
    },
    records: writes,
    events: writes.map((write, index) =>
      eventFor(
        `event-${suffix}-${index + 1}`,
        changeId,
        write,
        eventTypeFor(write.kind, write.expected_revision === 0),
      ),
    ),
  };
}

function eventOnlyRequest(suffix: string, event: AuthoritativeDomainEvent): DomainWriteRequest {
  return {
    change_id: `change-${suffix}`,
    idempotency: {
      operation: "repository_contract",
      key: `key-${suffix}`,
      request_hash: hashA,
    },
    records: [],
    events: [event],
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
      id: getRecordId(write),
      revision: write.expected_revision + 1,
    },
    occurred_at: timestamp,
    audit: auditFor(changeId),
    payload: {
      action: eventType,
    },
  };
}

function auditFor(changeId: string): AuthoritativeDomainEvent["audit"] {
  const suffix = changeId.replace("change-", "");
  return {
    actor: { kind: "bridge", id: "bridge-core" },
    operation: "repository_contract",
    request_id: changeId,
    correlation_id: `correlation-${suffix}`,
    idempotency_key: `key-${suffix}`,
    task_id: "task-1",
    run_id: "run-1",
  };
}

function eventTypeFor(kind: DomainRecordKind, created: boolean): AuthoritativeDomainEventType {
  switch (kind) {
    case "task":
      return created ? "task.created" : "task.status_changed";
    case "task_version":
      return "task_version.recorded";
    case "task_result":
      return "task_result.recorded";
    case "task_relation":
      return "task_relation.recorded";
    case "agent_run":
      return created ? "agent_run.created" : "agent_run.status_changed";
    case "agent_session_binding":
      return created ? "agent_session_binding.recorded" : "agent_session_binding.status_changed";
    case "context_package":
      return "context_package.recorded";
    case "handoff_package":
      return "handoff_package.recorded";
    case "continuation_snapshot":
      return "continuation_snapshot.recorded";
  }
}

function getRecordId(write: DomainRecordWrite): string {
  return getDomainRecordId(write.kind, write.value as never);
}

function taskValue(): Task {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "task-1",
    project_id: "project-1",
    status: "DRAFT",
    latest_version: 1,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function taskVersionValue(): TaskVersion {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "task-1",
    task_version: 1,
    project_id: "project-1",
    base_commit: baseCommit,
    policy_version: "1.0",
    objective: "实现 Repository 合约",
    role: "developer",
    business_rules: [],
    scope: { read: ["packages/core/**"], write: ["packages/core/**"], deny: [] },
    acceptance_commands: ["pnpm test"],
    git: { branch: "codex/phase-1d" },
    context_policy: {
      project_baseline_version: 1,
      rollover_ratio: 0.7,
      inherit_full_transcript: false,
    },
    limits: { timeout_seconds: 3600, max_review_cycles: 3, max_agent_count: 4 },
    required_output: ["test_results"],
    content_hash: hashA,
    created_at: timestamp,
  };
}

function taskResultValue(): TaskResult {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "task-1",
    task_version: 1,
    run_id: "run-1",
    session_ids: ["session-1"],
    status: "submitted",
    base_commit: baseCommit,
    changed_files: [],
    acceptance_results: [],
    review_findings: [],
    known_risks: [],
    unresolved_items: [],
    started_at: timestamp,
    finished_at: laterTimestamp,
  };
}

function taskRelationValue(): TaskRelation {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    relation_id: "relation-1",
    type: "depends_on",
    source: { task_id: "task-1", task_version: 1 },
    target: { task_id: "task-0", task_version: 1 },
    created_at: timestamp,
  };
}

function agentRunValue(): AgentRunRecord {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    run_id: "run-1",
    task_id: "task-1",
    task_version: 1,
    project_id: "project-1",
    driver_id: "driver-primary",
    role: "developer",
    status: "created",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function sessionBindingValue(): AgentSessionBinding {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    binding_id: "binding-1",
    session_id: "session-1",
    external_session_id: "external-session-1",
    task_id: "task-1",
    task_version: 1,
    run_id: "run-1",
    driver_id: "driver-primary",
    role: "developer",
    status: "CREATED",
    context_package_id: "context-1",
    context_package_hash: hashA,
    created_at: timestamp,
  };
}

function contextPackageValue(): ContextPackage {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    context_package_id: "context-1",
    task_id: "task-1",
    task_version: 1,
    run_id: "run-1",
    target_session_id: "session-1",
    components: [
      {
        component_id: "baseline-1",
        kind: "project_baseline",
        version: 1,
        source: "bridge",
        content_hash: hashA,
        content: { project_id: "project-1" },
      },
    ],
    content_hash: hashB,
    created_at: timestamp,
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

function snapshotValue(): ContinuationSnapshot {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    snapshot_id: "snapshot-1",
    snapshot_version: 1,
    task_id: "task-1",
    task_version: 1,
    run_id: "run-1",
    session_id: "session-1",
    source_context_package_id: "context-1",
    source_context_package_hash: hashA,
    current_step: "持久化领域状态",
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
    content_hash: hashB,
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
