import { describe, expect, it } from "vitest";

import {
  AUTHORITATIVE_DOMAIN_EVENT_TYPES,
  AUTHORITATIVE_DOMAIN_EVENT_VERSION,
  CoreDomainError,
  readAuditEnvelope,
  readAuthoritativeDomainEvent,
  type AuthoritativeDomainEvent,
  type AuthoritativeDomainEventType,
  type CoreDomainErrorCode,
  type DomainAggregateKind,
} from "../src/index.js";

const timestamp = "2026-07-27T10:00:00+08:00";
const hash = `sha256:${"a".repeat(64)}`;

const eventCases = [
  ["task.created", "task"],
  ["task.status_changed", "task"],
  ["task.updated", "task"],
  ["task_version.recorded", "task_version"],
  ["task_result.recorded", "task_result"],
  ["task_relation.recorded", "task_relation"],
  ["agent_run.created", "agent_run"],
  ["agent_run.status_changed", "agent_run"],
  ["agent_session_binding.recorded", "agent_session_binding"],
  ["agent_session_binding.status_changed", "agent_session_binding"],
  ["context_package.recorded", "context_package"],
  ["handoff_package.recorded", "handoff_package"],
  ["continuation_snapshot.recorded", "continuation_snapshot"],
  ["project_baseline.recorded", "project_baseline"],
  ["approval_request.recorded", "approval_request"],
  ["approval_request.status_changed", "approval_request"],
  ["review_cycle.recorded", "review_cycle"],
  ["review_cycle.status_changed", "review_cycle"],
  ["control_invocation.recorded", "control_invocation"],
] as const satisfies readonly (readonly [AuthoritativeDomainEventType, DomainAggregateKind])[];

describe("权威领域事件与审计信封", () => {
  it.each(eventCases)("%s 只能关联 %s 聚合", (eventType, aggregateKind) => {
    const event = readAuthoritativeDomainEvent(eventValue(eventType, aggregateKind));

    expect(event.event_version).toBe(AUTHORITATIVE_DOMAIN_EVENT_VERSION);
    expect(event.event_type).toBe(eventType);
    expect(event.aggregate.kind).toBe(aggregateKind);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.audit)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
  });

  it("事件类型清单稳定且不混入 Driver 事件", () => {
    expect(AUTHORITATIVE_DOMAIN_EVENT_TYPES).toEqual(eventCases.map(([eventType]) => eventType));
    expect(AUTHORITATIVE_DOMAIN_EVENT_TYPES).not.toContain("run.completed");
    expect(AUTHORITATIVE_DOMAIN_EVENT_TYPES).not.toContain("permission.requested");
  });

  it("保留完整、供应商无关的可选审计引用", () => {
    const audit = readAuditEnvelope({
      ...auditValue(),
      causation_id: "event-cause-1",
      task_version: 1,
      run_id: "run-1",
      session_id: "session-2",
      predecessor_session_id: "session-1",
      context_package_id: "context-2",
      context_package_hash: hash,
      handoff_id: "handoff-1",
      handoff_version: 2,
      handoff_hash: hash,
      role: "developer",
      provider_id: "configured/provider",
      model_id: "configured/model[extended]",
      commit_sha: "abc1234",
      verification: {
        status: "passed",
        artifact_ids: ["artifact-1"],
      },
      metadata: {
        rollover_reason: "threshold_reached",
      },
    });

    expect(audit).toMatchObject({
      run_id: "run-1",
      session_id: "session-2",
      predecessor_session_id: "session-1",
      context_package_hash: hash,
      handoff_hash: hash,
      provider_id: "configured/provider",
      model_id: "configured/model[extended]",
      verification: {
        status: "passed",
      },
    });
    expect(Object.isFrozen(audit.verification?.artifact_ids)).toBe(true);
  });

  it.each([
    ["task_version without task", { task_id: undefined, task_version: 1 }],
    ["partial context reference", { context_package_id: "context-1" }],
    ["partial handoff reference", { handoff_id: "handoff-1", handoff_version: 1 }],
    ["predecessor without session", { predecessor_session_id: "session-1" }],
  ] as const)("拒绝 %s", (_label, overrides) => {
    expectCoreError(
      () => readAuditEnvelope({ ...auditValue(), ...overrides }),
      "AUDIT_ENVELOPE_INVALID",
    );
  });

  it("拒绝事件类型与聚合不一致、未知字段和非 JSON payload", () => {
    expectCoreError(
      () => readAuthoritativeDomainEvent(eventValue("task.created", "agent_run")),
      "DOMAIN_EVENT_INVALID",
    );
    expectCoreError(
      () => readAuthoritativeDomainEvent({ ...eventValue(), local_sqlite_rowid: 1 }),
      "DOMAIN_EVENT_INVALID",
    );
    expectCoreError(
      () => readAuthoritativeDomainEvent({ ...eventValue(), payload: { observed_at: new Date() } }),
      "DOMAIN_EVENT_INVALID",
    );
    expectCoreError(
      () => readAuthoritativeDomainEvent({ ...eventValue(), occurred_at: "2026-02-30T10:00:00Z" }),
      "DOMAIN_EVENT_INVALID",
    );
  });

  it("敏感内容只报告稳定路径和规则，不回显内容", () => {
    const secret = "sk-this-value-must-never-appear";
    const error = expectCoreError(
      () =>
        readAuthoritativeDomainEvent({
          ...eventValue(),
          payload: {
            api_key: secret,
          },
        }),
      "DOMAIN_EVENT_INVALID",
    );

    expect(error.details.reason).toBe("SENSITIVE_CONTENT");
    expect(error.details.finding_paths).toEqual(["/payload/api_key"]);
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});

function eventValue(
  eventType: AuthoritativeDomainEventType = "task.created",
  aggregateKind: DomainAggregateKind = "task",
): AuthoritativeDomainEvent {
  return {
    event_id: `event-${eventType.replaceAll(".", "-")}`,
    event_version: AUTHORITATIVE_DOMAIN_EVENT_VERSION,
    event_type: eventType,
    aggregate: {
      kind: aggregateKind,
      id: aggregateKind === "task" ? "task-1" : `${aggregateKind}-1`,
      revision: 1,
    },
    occurred_at: timestamp,
    audit: auditValue(),
    payload: {
      action: "recorded",
    },
  };
}

function auditValue(): AuthoritativeDomainEvent["audit"] {
  return {
    actor: {
      kind: "codex",
      id: "codex-coordinator",
    },
    operation: "bridge_create_task",
    request_id: "change-1",
    correlation_id: "correlation-1",
    idempotency_key: "idempotency-1",
    task_id: "task-1",
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
