import type { AgentRole, DomainJsonValue, DomainMetadata } from "@agent-bridge/schemas";

import { isDomainJsonValue, scanSensitiveContent } from "./content-integrity.js";
import { CoreDomainError } from "./errors.js";

export const AUTHORITATIVE_DOMAIN_EVENT_VERSION = 1 as const;

export const DOMAIN_AGGREGATE_KINDS = [
  "task",
  "task_version",
  "task_result",
  "task_relation",
  "agent_run",
  "agent_session_binding",
  "context_package",
  "handoff_package",
  "continuation_snapshot",
  "project_baseline",
  "approval_request",
  "review_cycle",
  "control_invocation",
] as const;

export type DomainAggregateKind = (typeof DOMAIN_AGGREGATE_KINDS)[number];

export const AUTHORITATIVE_DOMAIN_EVENT_TYPES = [
  "task.created",
  "task.status_changed",
  "task.updated",
  "task_version.recorded",
  "task_result.recorded",
  "task_relation.recorded",
  "agent_run.created",
  "agent_run.status_changed",
  "agent_session_binding.recorded",
  "agent_session_binding.status_changed",
  "context_package.recorded",
  "handoff_package.recorded",
  "continuation_snapshot.recorded",
  "project_baseline.recorded",
  "approval_request.recorded",
  "approval_request.status_changed",
  "review_cycle.recorded",
  "review_cycle.status_changed",
  "control_invocation.recorded",
] as const;

export type AuthoritativeDomainEventType = (typeof AUTHORITATIVE_DOMAIN_EVENT_TYPES)[number];

export const AUDIT_ACTOR_KINDS = ["human", "codex", "bridge", "driver", "system"] as const;

export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export interface AuditActor {
  readonly kind: AuditActorKind;
  readonly id: string;
}

export interface AuditVerificationReference {
  readonly status: "passed" | "failed" | "not_run";
  readonly artifact_ids: readonly string[];
}

export interface AuditEnvelope {
  readonly actor: AuditActor;
  readonly operation: string;
  readonly request_id: string;
  readonly correlation_id: string;
  readonly causation_id?: string;
  readonly idempotency_key: string;
  readonly task_id?: string;
  readonly task_version?: number;
  readonly run_id?: string;
  readonly session_id?: string;
  readonly predecessor_session_id?: string;
  readonly context_package_id?: string;
  readonly context_package_hash?: string;
  readonly handoff_id?: string;
  readonly handoff_version?: number;
  readonly handoff_hash?: string;
  readonly role?: AgentRole;
  readonly provider_id?: string;
  readonly model_id?: string;
  readonly commit_sha?: string;
  readonly verification?: AuditVerificationReference;
  readonly metadata?: DomainMetadata;
}

export interface DomainEventAggregate {
  readonly kind: DomainAggregateKind;
  readonly id: string;
  readonly revision: number;
}

export interface AuthoritativeDomainEvent {
  readonly event_id: string;
  readonly event_version: typeof AUTHORITATIVE_DOMAIN_EVENT_VERSION;
  readonly event_type: AuthoritativeDomainEventType;
  readonly aggregate: DomainEventAggregate;
  readonly occurred_at: string;
  readonly audit: AuditEnvelope;
  readonly payload: DomainMetadata;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RECORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{7,64}$/u;
const AGENT_ROLES = [
  "coordinator",
  "developer",
  "tester",
  "reviewer",
  "docs",
  "research",
] as const satisfies readonly AgentRole[];

const EVENT_AGGREGATE_KIND = {
  "task.created": "task",
  "task.status_changed": "task",
  "task.updated": "task",
  "task_version.recorded": "task_version",
  "task_result.recorded": "task_result",
  "task_relation.recorded": "task_relation",
  "agent_run.created": "agent_run",
  "agent_run.status_changed": "agent_run",
  "agent_session_binding.recorded": "agent_session_binding",
  "agent_session_binding.status_changed": "agent_session_binding",
  "context_package.recorded": "context_package",
  "handoff_package.recorded": "handoff_package",
  "continuation_snapshot.recorded": "continuation_snapshot",
  "project_baseline.recorded": "project_baseline",
  "approval_request.recorded": "approval_request",
  "approval_request.status_changed": "approval_request",
  "review_cycle.recorded": "review_cycle",
  "review_cycle.status_changed": "review_cycle",
  "control_invocation.recorded": "control_invocation",
} as const satisfies Readonly<Record<AuthoritativeDomainEventType, DomainAggregateKind>>;

export function readAuditEnvelope(value: unknown): AuditEnvelope {
  const allowedKeys = new Set([
    "actor",
    "operation",
    "request_id",
    "correlation_id",
    "causation_id",
    "idempotency_key",
    "task_id",
    "task_version",
    "run_id",
    "session_id",
    "predecessor_session_id",
    "context_package_id",
    "context_package_hash",
    "handoff_id",
    "handoff_version",
    "handoff_hash",
    "role",
    "provider_id",
    "model_id",
    "commit_sha",
    "verification",
    "metadata",
  ]);
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw invalidAudit("ENVELOPE_SHAPE_INVALID");
  }

  const actor = readAuditActor(value.actor);
  if (
    !isIdentifier(value.operation) ||
    !isIdentifier(value.request_id) ||
    !isIdentifier(value.correlation_id) ||
    !isIdentifier(value.idempotency_key)
  ) {
    throw invalidAudit("REQUIRED_FIELD_INVALID");
  }

  const optionalIdentifiers = [
    "causation_id",
    "task_id",
    "run_id",
    "session_id",
    "predecessor_session_id",
    "context_package_id",
    "handoff_id",
  ] as const;
  if (
    optionalIdentifiers.some((field) => value[field] !== undefined && !isIdentifier(value[field]))
  ) {
    throw invalidAudit("OPTIONAL_IDENTIFIER_INVALID");
  }
  if (
    value.task_version !== undefined &&
    (!isPositiveInteger(value.task_version) || value.task_id === undefined)
  ) {
    throw invalidAudit("TASK_SCOPE_INVALID");
  }
  if (value.predecessor_session_id !== undefined && value.session_id === undefined) {
    throw invalidAudit("SESSION_CHAIN_INVALID");
  }

  const hasContextId = value.context_package_id !== undefined;
  const hasContextHash = value.context_package_hash !== undefined;
  if (
    hasContextId !== hasContextHash ||
    (hasContextHash && !isContentHash(value.context_package_hash))
  ) {
    throw invalidAudit("CONTEXT_REFERENCE_INVALID");
  }

  const handoffParts = [value.handoff_id, value.handoff_version, value.handoff_hash];
  const presentHandoffParts = handoffParts.filter((item) => item !== undefined).length;
  if (
    (presentHandoffParts !== 0 && presentHandoffParts !== handoffParts.length) ||
    (value.handoff_version !== undefined && !isPositiveInteger(value.handoff_version)) ||
    (value.handoff_hash !== undefined && !isContentHash(value.handoff_hash))
  ) {
    throw invalidAudit("HANDOFF_REFERENCE_INVALID");
  }

  if (value.role !== undefined && !AGENT_ROLES.some((role) => role === value.role)) {
    throw invalidAudit("ROLE_INVALID");
  }
  if (
    (value.provider_id !== undefined && !isBoundedText(value.provider_id)) ||
    (value.model_id !== undefined && !isBoundedText(value.model_id)) ||
    (value.commit_sha !== undefined && !isGitCommit(value.commit_sha))
  ) {
    throw invalidAudit("EXECUTION_REFERENCE_INVALID");
  }

  const verification =
    value.verification === undefined ? undefined : readVerificationReference(value.verification);
  if (
    value.metadata !== undefined &&
    (!isPlainRecord(value.metadata) || !isDomainJsonValue(value.metadata))
  ) {
    throw invalidAudit("METADATA_INVALID");
  }

  const envelope = {
    actor,
    operation: value.operation,
    request_id: value.request_id,
    correlation_id: value.correlation_id,
    idempotency_key: value.idempotency_key,
    ...copyOptional(value, optionalIdentifiers),
    ...(value.task_version === undefined ? {} : { task_version: value.task_version }),
    ...(value.context_package_hash === undefined
      ? {}
      : { context_package_hash: value.context_package_hash }),
    ...(value.handoff_version === undefined ? {} : { handoff_version: value.handoff_version }),
    ...(value.handoff_hash === undefined ? {} : { handoff_hash: value.handoff_hash }),
    ...(value.role === undefined ? {} : { role: value.role }),
    ...(value.provider_id === undefined ? {} : { provider_id: value.provider_id }),
    ...(value.model_id === undefined ? {} : { model_id: value.model_id }),
    ...(value.commit_sha === undefined ? {} : { commit_sha: value.commit_sha }),
    ...(verification === undefined ? {} : { verification }),
    ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
  } as AuditEnvelope;

  return cloneAndFreeze(envelope);
}

export function readAuthoritativeDomainEvent(value: unknown): AuthoritativeDomainEvent {
  const allowedKeys = new Set([
    "event_id",
    "event_version",
    "event_type",
    "aggregate",
    "occurred_at",
    "audit",
    "payload",
  ]);
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw invalidEvent("EVENT_SHAPE_INVALID");
  }
  if (
    !isIdentifier(value.event_id) ||
    value.event_version !== AUTHORITATIVE_DOMAIN_EVENT_VERSION ||
    !isEventType(value.event_type) ||
    !isTimestamp(value.occurred_at)
  ) {
    throw invalidEvent("EVENT_HEADER_INVALID");
  }

  const aggregate = readAggregate(value.aggregate);
  if (EVENT_AGGREGATE_KIND[value.event_type] !== aggregate.kind) {
    throw invalidEvent("EVENT_AGGREGATE_KIND_MISMATCH");
  }
  const audit = readAuditEnvelope(value.audit);
  if (!isPlainRecord(value.payload) || !isDomainJsonValue(value.payload)) {
    throw invalidEvent("EVENT_PAYLOAD_INVALID");
  }

  const auditableContent = {
    audit,
    payload: value.payload,
  } as unknown as DomainJsonValue;
  const sensitiveFindings = scanSensitiveContent(auditableContent);
  if (sensitiveFindings.length > 0) {
    throw new CoreDomainError("DOMAIN_EVENT_INVALID", {
      entity: "domain_event",
      reason: "SENSITIVE_CONTENT",
      finding_paths: [...new Set(sensitiveFindings.map((finding) => finding.path))].sort(),
      finding_rules: [...new Set(sensitiveFindings.map((finding) => finding.rule))].sort(),
    });
  }

  return cloneAndFreeze({
    event_id: value.event_id,
    event_version: value.event_version,
    event_type: value.event_type,
    aggregate,
    occurred_at: value.occurred_at,
    audit,
    payload: value.payload,
  });
}

function readAuditActor(value: unknown): AuditActor {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some((key) => key !== "kind" && key !== "id") ||
    !AUDIT_ACTOR_KINDS.some((kind) => kind === value.kind) ||
    !isIdentifier(value.id)
  ) {
    throw invalidAudit("ACTOR_INVALID");
  }
  return Object.freeze({ kind: value.kind, id: value.id }) as AuditActor;
}

function readVerificationReference(value: unknown): AuditVerificationReference {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some((key) => key !== "status" && key !== "artifact_ids") ||
    (value.status !== "passed" && value.status !== "failed" && value.status !== "not_run") ||
    !Array.isArray(value.artifact_ids) ||
    !value.artifact_ids.every((item) => isIdentifier(item)) ||
    new Set(value.artifact_ids).size !== value.artifact_ids.length
  ) {
    throw invalidAudit("VERIFICATION_REFERENCE_INVALID");
  }
  return Object.freeze({
    status: value.status,
    artifact_ids: Object.freeze([...value.artifact_ids]),
  });
}

function readAggregate(value: unknown): DomainEventAggregate {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some((key) => key !== "kind" && key !== "id" && key !== "revision") ||
    !DOMAIN_AGGREGATE_KINDS.some((kind) => kind === value.kind) ||
    !isRecordId(value.id) ||
    !isPositiveInteger(value.revision)
  ) {
    throw invalidEvent("EVENT_AGGREGATE_INVALID");
  }
  return Object.freeze({
    kind: value.kind,
    id: value.id,
    revision: value.revision,
  }) as DomainEventAggregate;
}

function copyOptional(
  value: Record<string, unknown>,
  fields: readonly string[],
): Readonly<Record<string, string>> {
  const entries = fields.flatMap((field) =>
    value[field] === undefined ? [] : [[field, value[field] as string] as const],
  );
  return Object.fromEntries(entries);
}

function cloneAndFreeze<T>(value: T): T {
  return freezeValue(cloneValue(value)) as T;
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}

function freezeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    value.forEach((item) => freezeValue(item));
    return Object.freeze(value);
  }
  if (isPlainRecord(value)) {
    Object.values(value).forEach((item) => freezeValue(item));
    return Object.freeze(value);
  }
  return value;
}

function isEventType(value: unknown): value is AuthoritativeDomainEventType {
  return AUTHORITATIVE_DOMAIN_EVENT_TYPES.some((eventType) => eventType === value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isRecordId(value: unknown): value is string {
  return typeof value === "string" && RECORD_ID_PATTERN.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isContentHash(value: unknown): value is string {
  return typeof value === "string" && CONTENT_HASH_PATTERN.test(value);
}

function isGitCommit(value: unknown): value is string {
  return typeof value === "string" && GIT_COMMIT_PATTERN.test(value);
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match =
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(
      value,
    );
  if (match?.groups === undefined || Number.isNaN(Date.parse(value))) {
    return false;
  }
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return (
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function invalidAudit(reason: string): CoreDomainError {
  return new CoreDomainError("AUDIT_ENVELOPE_INVALID", {
    entity: "audit_envelope",
    reason,
  });
}

function invalidEvent(reason: string): CoreDomainError {
  return new CoreDomainError("DOMAIN_EVENT_INVALID", {
    entity: "domain_event",
    reason,
  });
}
