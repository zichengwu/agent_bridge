import {
  AUTHORITATIVE_DOMAIN_EVENT_VERSION,
  type AgentRunRecord,
  type AuthoritativeDomainEvent,
  type AuthoritativeDomainEventType,
  type DomainRecordWrite,
  type DomainWriteRequest,
} from "@agent-bridge/core";
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

export const timestamp = "2026-07-31T10:00:00.000Z";
export const laterTimestamp = "2026-07-31T10:10:00.000Z";
export const hashA = `sha256:${"a".repeat(64)}`;
export const hashB = `sha256:${"b".repeat(64)}`;

export function requestFor(
  suffix: string,
  write: DomainRecordWrite,
  eventType: AuthoritativeDomainEventType,
): DomainWriteRequest {
  const changeId = `change-${suffix}`;
  return {
    change_id: changeId,
    idempotency: {
      operation: "sqlite_contract",
      key: `key-${suffix}`,
      request_hash: hashA,
    },
    records: [write],
    events: [eventFor(`event-${suffix}`, changeId, write, eventType)],
  };
}

export function eventFor(
  eventId: string,
  changeId: string,
  write: DomainRecordWrite,
  eventType: AuthoritativeDomainEventType,
): AuthoritativeDomainEvent {
  const recordId = recordIdFor(write);
  return {
    event_id: eventId,
    event_version: AUTHORITATIVE_DOMAIN_EVENT_VERSION,
    event_type: eventType,
    aggregate: {
      kind: write.kind,
      id: recordId,
      revision: write.expected_revision + 1,
    },
    occurred_at: timestamp,
    audit: {
      actor: { kind: "bridge", id: "bridge-core" },
      operation: "sqlite_contract",
      request_id: changeId,
      correlation_id: `correlation-${eventId}`,
      idempotency_key: changeId.replace("change-", "key-"),
      task_id: "task-1",
      run_id: "run-1",
    },
    payload: { action: eventType },
  };
}

export function taskValue(taskId = "task-1"): Task {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: taskId,
    project_id: "project-1",
    status: "DRAFT",
    latest_version: 1,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function taskVersionValue(): TaskVersion {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "task-1",
    task_version: 1,
    project_id: "project-1",
    base_commit: "abcdef1",
    policy_version: "1.0",
    objective: "persist domain state",
    role: "developer",
    business_rules: [],
    scope: { read: ["**"], write: ["src/**"], deny: [] },
    acceptance_commands: ["pnpm test"],
    git: { branch: "codex/task-1" },
    context_policy: {
      project_baseline_version: 1,
      rollover_ratio: 0.7,
      inherit_full_transcript: false,
    },
    limits: { timeout_seconds: 60, max_review_cycles: 1, max_agent_count: 1 },
    required_output: ["test_results"],
    content_hash: hashA,
    created_at: timestamp,
  };
}

export function taskResultValue(): TaskResult {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "task-1",
    task_version: 1,
    run_id: "run-1",
    session_ids: ["session-1"],
    status: "submitted",
    base_commit: "abcdef1",
    changed_files: [],
    acceptance_results: [
      {
        command: "pnpm test",
        exit_code: 0,
        duration_ms: 10,
        log_artifact_id: "artifact-log",
      },
    ],
    review_findings: [],
    known_risks: [],
    unresolved_items: [],
    artifacts: [{ artifact_id: "artifact-report", kind: "report", content_hash: hashB }],
    started_at: timestamp,
    finished_at: laterTimestamp,
  };
}

export function taskRelationValue(): TaskRelation {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    relation_id: "relation-1",
    type: "depends_on",
    source: { task_id: "task-1", task_version: 1 },
    target: { task_id: "task-0", task_version: 1 },
    created_at: timestamp,
  };
}

export function runValue(
  runId = "run-1",
  status: AgentRunRecord["status"] = "created",
): AgentRunRecord {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    run_id: runId,
    task_id: "task-1",
    task_version: 1,
    project_id: "project-1",
    driver_id: "fixture",
    role: "developer",
    status,
    created_at: timestamp,
    updated_at: timestamp,
    ...(status === "created" ? {} : { started_at: timestamp }),
  };
}

export function bindingValue(overrides: Partial<AgentSessionBinding> = {}): AgentSessionBinding {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    binding_id: "binding-1",
    session_id: "session-1",
    external_session_id: "external-1",
    task_id: "task-1",
    task_version: 1,
    run_id: "run-1",
    driver_id: "fixture",
    role: "developer",
    status: "CREATED",
    context_package_id: "context-1",
    context_package_hash: hashA,
    created_at: timestamp,
    ...overrides,
  };
}

export function contextValue(): ContextPackage {
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

export function handoffValue(): HandoffPackage {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    handoff_id: "handoff-1",
    handoff_version: 1,
    source_task: { task_id: "task-0", task_version: 1, final_run_id: "run-0" },
    code_state: {
      repository_id: "project-1",
      base_commit: "abcdef1",
      head_commit: "abcdef2",
    },
    completed: [],
    decisions: [],
    contracts: [],
    changed_files: [],
    verification: { status: "passed", artifact_ids: ["artifact-handoff"] },
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

export function snapshotValue(version = 1): ContinuationSnapshot {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    snapshot_id: "snapshot-1",
    snapshot_version: version,
    task_id: "task-1",
    task_version: 1,
    run_id: "run-1",
    session_id: "session-1",
    source_context_package_id: "context-1",
    source_context_package_hash: hashA,
    current_step: "persist",
    completed: [],
    remaining_plan: [],
    git_state: {
      repository_id: "project-1",
      base_commit: "abcdef1",
      head_commit: "abcdef2",
      changed_files: [],
    },
    recent_verification: [
      {
        command: "pnpm test",
        status: "passed",
        artifact_ids: ["artifact-verification"],
      },
    ],
    blockers: [],
    next_actions: [],
    artifact_ids: ["artifact-snapshot"],
    content_hash: hashB,
    created_at: version === 1 ? timestamp : laterTimestamp,
  };
}

export function recordIdFor(write: DomainRecordWrite): string {
  switch (write.kind) {
    case "task":
      return write.value.task_id;
    case "task_version":
      return `${write.value.task_id}:v${write.value.task_version}`;
    case "task_result":
      return write.value.run_id;
    case "task_relation":
      return write.value.relation_id;
    case "agent_run":
      return write.value.run_id;
    case "agent_session_binding":
      return write.value.binding_id;
    case "context_package":
      return write.value.context_package_id;
    case "handoff_package":
      return `${write.value.handoff_id}:v${write.value.handoff_version}`;
    case "continuation_snapshot":
      return `${write.value.snapshot_id}:v${write.value.snapshot_version}`;
  }
}
