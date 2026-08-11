import {
  DOMAIN_SCHEMA_VERSION,
  parseContextPackage,
  parseContinuationSnapshot,
  parseHandoffPackage,
  parseTask,
  parseTaskRelation,
  parseTaskResult,
  parseTaskVersion,
  parseProjectBaseline,
  parseApprovalRequest,
  parseReviewCycle,
  parseControlInvocation,
  type AgentRole,
  type AgentSessionBinding,
  type ContextPackage,
  type ContinuationSnapshot,
  type DomainJsonValue,
  type DomainMetadata,
  type HandoffPackage,
  type Task,
  type TaskRelation,
  type TaskResult,
  type TaskVersion,
  type TaskVersionReference,
  type ProjectBaseline,
  type ApprovalRequest,
  type ReviewCycle,
  type ControlInvocation,
  type TaskStatus,
} from "@agent-bridge/schemas";

import {
  AGENT_RUN_STATUSES,
  AGENT_RUN_TERMINAL_STATUSES,
  type AgentRunStatus,
} from "./agent-run-lifecycle.js";
import { computeContentHash, isDomainJsonValue } from "./content-integrity.js";
import {
  DOMAIN_AGGREGATE_KINDS,
  readAuthoritativeDomainEvent,
  type AuthoritativeDomainEvent,
  type AuthoritativeDomainEventType,
  type DomainAggregateKind,
} from "./domain-events.js";
import { CoreDomainError } from "./errors.js";
import { readAgentSessionBinding } from "./session-binding.js";

export const DOMAIN_RECORD_KINDS = DOMAIN_AGGREGATE_KINDS;

export type DomainRecordKind = DomainAggregateKind;

export const IMMUTABLE_DOMAIN_RECORD_KINDS = [
  "task_version",
  "task_result",
  "task_relation",
  "context_package",
  "handoff_package",
  "continuation_snapshot",
  "project_baseline",
  "control_invocation",
] as const satisfies readonly DomainRecordKind[];

export const RECOVERABLE_AGENT_RUN_STATUSES = [
  "created",
  "running",
  "waiting_permission",
  "cancelling",
] as const satisfies readonly AgentRunStatus[];

export interface AgentRunRecord {
  readonly schema_version: typeof DOMAIN_SCHEMA_VERSION;
  readonly run_id: string;
  readonly task_id: string;
  readonly task_version: number;
  readonly project_id: string;
  readonly driver_id: string;
  readonly role: AgentRole;
  readonly status: AgentRunStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at?: string;
  readonly finished_at?: string;
  readonly metadata?: DomainMetadata;
}

export interface DomainRecordValueMap {
  readonly task: Task;
  readonly task_version: TaskVersion;
  readonly task_result: TaskResult;
  readonly task_relation: TaskRelation;
  readonly agent_run: AgentRunRecord;
  readonly agent_session_binding: AgentSessionBinding;
  readonly context_package: ContextPackage;
  readonly handoff_package: HandoffPackage;
  readonly continuation_snapshot: ContinuationSnapshot;
  readonly project_baseline: ProjectBaseline;
  readonly approval_request: ApprovalRequest;
  readonly review_cycle: ReviewCycle;
  readonly control_invocation: ControlInvocation;
}

export type DomainRecordWrite = {
  readonly [K in DomainRecordKind]: {
    readonly kind: K;
    readonly expected_revision: number;
    readonly value: DomainRecordValueMap[K];
  };
}[DomainRecordKind];

export interface StoredDomainRecord<K extends DomainRecordKind> {
  readonly kind: K;
  readonly record_id: string;
  readonly revision: number;
  readonly value: DomainRecordValueMap[K];
}

export type AnyStoredDomainRecord = {
  readonly [K in DomainRecordKind]: StoredDomainRecord<K>;
}[DomainRecordKind];

export interface IdempotencyDescriptor {
  readonly operation: string;
  readonly key: string;
  readonly request_hash: string;
}

export interface DomainWriteRequest {
  readonly change_id: string;
  readonly idempotency: IdempotencyDescriptor;
  readonly records: readonly DomainRecordWrite[];
  readonly events: readonly AuthoritativeDomainEvent[];
}

export interface RepositoryRecordVersion {
  readonly kind: DomainRecordKind;
  readonly record_id: string;
  readonly revision: number;
}

export interface DomainWriteResult {
  readonly outcome: "APPLIED" | "REPLAYED";
  readonly change_id: string;
  readonly idempotency: IdempotencyDescriptor;
  readonly records: readonly RepositoryRecordVersion[];
  readonly event_ids: readonly string[];
  readonly event_cursor: string;
}

export interface TaskRelationQuery extends TaskVersionReference {
  readonly direction: "source" | "target" | "either";
}

export interface DomainEventQuery {
  readonly task_id?: string;
  readonly run_id?: string;
  readonly after_cursor?: string;
  readonly limit?: number;
}

export interface DomainEventPage {
  readonly events: readonly AuthoritativeDomainEvent[];
  readonly next_cursor: string;
}

export interface RecoveryCandidateQuery {
  readonly project_id?: string;
  readonly limit?: number;
}

export interface TaskQuery {
  readonly project_id?: string;
  readonly status?: TaskStatus;
  readonly after_task_id?: string;
  readonly order_by?: "record_id";
  readonly limit?: number;
}

export interface AgentRunQuery {
  readonly task_id?: string;
  readonly task_version?: number;
  readonly status?: AgentRunStatus;
  readonly limit?: number;
}

export interface ApprovalRequestQuery {
  readonly task_id?: string;
  readonly run_id?: string;
  readonly status?: ApprovalRequest["status"];
  readonly limit?: number;
}

export interface ReviewCycleQuery {
  readonly task_id: string;
  readonly task_version?: number;
  readonly run_id?: string;
  readonly limit?: number;
}

export interface DomainRepository {
  commit(request: DomainWriteRequest): Promise<DomainWriteResult>;
  getEventCursor(): Promise<string>;
  getTask(taskId: string): Promise<StoredDomainRecord<"task"> | undefined>;
  listTasks(query?: TaskQuery): Promise<readonly StoredDomainRecord<"task">[]>;
  getTaskVersion(
    reference: TaskVersionReference,
  ): Promise<StoredDomainRecord<"task_version"> | undefined>;
  listTaskVersions(taskId: string): Promise<readonly StoredDomainRecord<"task_version">[]>;
  getTaskResult(runId: string): Promise<StoredDomainRecord<"task_result"> | undefined>;
  listTaskResults(taskId: string): Promise<readonly StoredDomainRecord<"task_result">[]>;
  getTaskRelation(relationId: string): Promise<StoredDomainRecord<"task_relation"> | undefined>;
  listTaskRelations(
    query: TaskRelationQuery,
  ): Promise<readonly StoredDomainRecord<"task_relation">[]>;
  getAgentRun(runId: string): Promise<StoredDomainRecord<"agent_run"> | undefined>;
  listAgentRuns(query?: AgentRunQuery): Promise<readonly StoredDomainRecord<"agent_run">[]>;
  listRecoveryCandidates(
    query?: RecoveryCandidateQuery,
  ): Promise<readonly StoredDomainRecord<"agent_run">[]>;
  getAgentSessionBinding(
    bindingId: string,
  ): Promise<StoredDomainRecord<"agent_session_binding"> | undefined>;
  listAgentSessionBindings(
    runId: string,
  ): Promise<readonly StoredDomainRecord<"agent_session_binding">[]>;
  getContextPackage(
    contextPackageId: string,
  ): Promise<StoredDomainRecord<"context_package"> | undefined>;
  getHandoffPackage(
    handoffId: string,
    handoffVersion: number,
  ): Promise<StoredDomainRecord<"handoff_package"> | undefined>;
  listHandoffPackages(
    reference: TaskVersionReference,
  ): Promise<readonly StoredDomainRecord<"handoff_package">[]>;
  getContinuationSnapshot(
    snapshotId: string,
    snapshotVersion: number,
  ): Promise<StoredDomainRecord<"continuation_snapshot"> | undefined>;
  listContinuationSnapshots(
    runId: string,
  ): Promise<readonly StoredDomainRecord<"continuation_snapshot">[]>;
  getLatestContinuationSnapshot(
    runId: string,
  ): Promise<StoredDomainRecord<"continuation_snapshot"> | undefined>;
  getProjectBaseline(
    projectId: string,
    baselineVersion: number,
  ): Promise<StoredDomainRecord<"project_baseline"> | undefined>;
  listProjectBaselines(
    projectId: string,
  ): Promise<readonly StoredDomainRecord<"project_baseline">[]>;
  getApprovalRequest(
    approvalId: string,
  ): Promise<StoredDomainRecord<"approval_request"> | undefined>;
  listApprovalRequests(
    query?: ApprovalRequestQuery,
  ): Promise<readonly StoredDomainRecord<"approval_request">[]>;
  getReviewCycle(reviewId: string): Promise<StoredDomainRecord<"review_cycle"> | undefined>;
  listReviewCycles(query: ReviewCycleQuery): Promise<readonly StoredDomainRecord<"review_cycle">[]>;
  getControlInvocation(
    invocationId: string,
  ): Promise<StoredDomainRecord<"control_invocation"> | undefined>;
  listDomainEvents(query?: DomainEventQuery): Promise<DomainEventPage>;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const AGENT_ROLES = [
  "coordinator",
  "developer",
  "tester",
  "reviewer",
  "docs",
  "research",
] as const satisfies readonly AgentRole[];

export function readDomainWriteRequest(value: unknown): DomainWriteRequest {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["change_id", "idempotency", "records", "events"]) ||
    !isIdentifier(value.change_id) ||
    !Array.isArray(value.records) ||
    !Array.isArray(value.events) ||
    value.events.length === 0
  ) {
    throw invalidWrite("WRITE_REQUEST_INVALID");
  }

  const idempotency = readIdempotencyDescriptor(value.idempotency);
  const records = value.records.map((record) => readDomainRecordWrite(record));
  const events = value.events.map((event) => readAuthoritativeDomainEvent(event));

  const recordKeys = records.map((record) =>
    JSON.stringify([record.kind, getDomainRecordId(record.kind, record.value)]),
  );
  if (new Set(recordKeys).size !== recordKeys.length) {
    throw invalidWrite("DUPLICATE_RECORD_WRITE");
  }
  if (new Set(events.map((event) => event.event_id)).size !== events.length) {
    throw invalidWrite("DUPLICATE_EVENT_ID");
  }

  for (const event of events) {
    if (
      event.audit.operation !== idempotency.operation ||
      event.audit.idempotency_key !== idempotency.key ||
      event.audit.request_id !== value.change_id
    ) {
      throw invalidWrite("EVENT_AUDIT_SCOPE_MISMATCH");
    }
  }

  for (const record of records) {
    const recordId = getDomainRecordId(record.kind, record.value);
    const recordEvents = events.filter(
      (event) =>
        event.aggregate.kind === record.kind &&
        event.aggregate.id === recordId &&
        event.aggregate.revision === record.expected_revision + 1,
    );
    if (recordEvents.length === 0) {
      throw invalidWrite("RECORD_EVENT_MISSING");
    }
    if (
      record.expected_revision === 0 &&
      !recordEvents.some((event) => event.event_type === creationEventType(record.kind))
    ) {
      throw invalidWrite("RECORD_CREATION_EVENT_INVALID");
    }
    const updateTypes = updateEventTypes(record.kind);
    if (
      record.expected_revision > 0 &&
      updateTypes.length > 0 &&
      !recordEvents.some((event) => updateTypes.includes(event.event_type))
    ) {
      throw invalidWrite("RECORD_UPDATE_EVENT_INVALID");
    }
  }

  return Object.freeze({
    change_id: value.change_id,
    idempotency,
    records: Object.freeze(records),
    events: Object.freeze(events),
  });
}

export function readDomainRecordWrite(value: unknown): DomainRecordWrite {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["kind", "expected_revision", "value"]) ||
    !isDomainRecordKind(value.kind) ||
    !isNonNegativeInteger(value.expected_revision)
  ) {
    throw invalidWrite("RECORD_WRITE_INVALID");
  }

  const parsedValue = readDomainRecordValue(value.kind, value.value);
  return Object.freeze({
    kind: value.kind,
    expected_revision: value.expected_revision,
    value: parsedValue,
  }) as DomainRecordWrite;
}

export function readAgentRunRecord(value: unknown): AgentRunRecord {
  const allowedKeys = [
    "schema_version",
    "run_id",
    "task_id",
    "task_version",
    "project_id",
    "driver_id",
    "role",
    "status",
    "created_at",
    "updated_at",
    "started_at",
    "finished_at",
    "metadata",
  ];
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, allowedKeys) ||
    value.schema_version !== DOMAIN_SCHEMA_VERSION ||
    !isIdentifier(value.run_id) ||
    !isIdentifier(value.task_id) ||
    !isPositiveInteger(value.task_version) ||
    !isIdentifier(value.project_id) ||
    !isIdentifier(value.driver_id) ||
    !AGENT_ROLES.some((role) => role === value.role) ||
    !AGENT_RUN_STATUSES.some((status) => status === value.status) ||
    !isTimestamp(value.created_at) ||
    !isTimestamp(value.updated_at) ||
    Date.parse(value.updated_at) < Date.parse(value.created_at)
  ) {
    throw invalidWrite("AGENT_RUN_INVALID");
  }

  if (
    (value.started_at !== undefined && !isTimestamp(value.started_at)) ||
    (value.finished_at !== undefined && !isTimestamp(value.finished_at)) ||
    (value.metadata !== undefined &&
      (!isPlainRecord(value.metadata) || !isDomainJsonValue(value.metadata)))
  ) {
    throw invalidWrite("AGENT_RUN_INVALID");
  }

  const terminal = AGENT_RUN_TERMINAL_STATUSES.some((status) => status === value.status);
  if (
    (value.status === "created" && value.started_at !== undefined) ||
    (value.status !== "created" && value.started_at === undefined) ||
    (terminal && value.finished_at === undefined) ||
    (!terminal && value.finished_at !== undefined) ||
    (value.started_at !== undefined &&
      (Date.parse(value.started_at) < Date.parse(value.created_at) ||
        Date.parse(value.started_at) > Date.parse(value.updated_at))) ||
    (value.finished_at !== undefined &&
      value.started_at !== undefined &&
      (Date.parse(value.finished_at) < Date.parse(value.started_at) ||
        Date.parse(value.finished_at) > Date.parse(value.updated_at)))
  ) {
    throw invalidWrite("AGENT_RUN_LIFECYCLE_INVALID");
  }

  return cloneAndFreeze({
    schema_version: value.schema_version,
    run_id: value.run_id,
    task_id: value.task_id,
    task_version: value.task_version,
    project_id: value.project_id,
    driver_id: value.driver_id,
    role: value.role,
    status: value.status,
    created_at: value.created_at,
    updated_at: value.updated_at,
    ...(value.started_at === undefined ? {} : { started_at: value.started_at }),
    ...(value.finished_at === undefined ? {} : { finished_at: value.finished_at }),
    ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
  }) as AgentRunRecord;
}

export function getDomainRecordId<K extends DomainRecordKind>(
  kind: K,
  value: DomainRecordValueMap[K],
): string {
  switch (kind) {
    case "task":
      return (value as Task).task_id;
    case "task_version": {
      const taskVersion = value as TaskVersion;
      return `${taskVersion.task_id}:v${taskVersion.task_version}`;
    }
    case "task_result":
      return (value as TaskResult).run_id;
    case "task_relation":
      return (value as TaskRelation).relation_id;
    case "agent_run":
      return (value as AgentRunRecord).run_id;
    case "agent_session_binding":
      return (value as AgentSessionBinding).binding_id;
    case "context_package":
      return (value as ContextPackage).context_package_id;
    case "handoff_package": {
      const handoff = value as HandoffPackage;
      return `${handoff.handoff_id}:v${handoff.handoff_version}`;
    }
    case "continuation_snapshot": {
      const snapshot = value as ContinuationSnapshot;
      return `${snapshot.snapshot_id}:v${snapshot.snapshot_version}`;
    }
    case "project_baseline": {
      const baseline = value as ProjectBaseline;
      return `${baseline.project_id}:v${baseline.baseline_version}`;
    }
    case "approval_request":
      return (value as ApprovalRequest).approval_id;
    case "review_cycle":
      return (value as ReviewCycle).review_id;
    case "control_invocation":
      return (value as ControlInvocation).invocation_id;
  }
}

export function isImmutableDomainRecordKind(
  kind: DomainRecordKind,
): kind is (typeof IMMUTABLE_DOMAIN_RECORD_KINDS)[number] {
  return IMMUTABLE_DOMAIN_RECORD_KINDS.some((immutableKind) => immutableKind === kind);
}

export function computeDomainWriteFingerprint(request: DomainWriteRequest): string {
  return computeContentHash(request as unknown as DomainJsonValue);
}

function creationEventType(kind: DomainRecordKind): AuthoritativeDomainEventType {
  switch (kind) {
    case "task":
      return "task.created";
    case "task_version":
      return "task_version.recorded";
    case "task_result":
      return "task_result.recorded";
    case "task_relation":
      return "task_relation.recorded";
    case "agent_run":
      return "agent_run.created";
    case "agent_session_binding":
      return "agent_session_binding.recorded";
    case "context_package":
      return "context_package.recorded";
    case "handoff_package":
      return "handoff_package.recorded";
    case "continuation_snapshot":
      return "continuation_snapshot.recorded";
    case "project_baseline":
      return "project_baseline.recorded";
    case "approval_request":
      return "approval_request.recorded";
    case "review_cycle":
      return "review_cycle.recorded";
    case "control_invocation":
      return "control_invocation.recorded";
  }
}

function updateEventTypes(kind: DomainRecordKind): readonly AuthoritativeDomainEventType[] {
  switch (kind) {
    case "task":
      return ["task.status_changed", "task.updated"];
    case "agent_run":
      return ["agent_run.status_changed", "agent_run.updated"];
    case "agent_session_binding":
      return ["agent_session_binding.status_changed"];
    case "approval_request":
      return ["approval_request.status_changed"];
    case "review_cycle":
      return ["review_cycle.status_changed"];
    default:
      return [];
  }
}

function readIdempotencyDescriptor(value: unknown): IdempotencyDescriptor {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["operation", "key", "request_hash"]) ||
    !isIdentifier(value.operation) ||
    !isIdentifier(value.key) ||
    typeof value.request_hash !== "string" ||
    !CONTENT_HASH_PATTERN.test(value.request_hash)
  ) {
    throw invalidWrite("IDEMPOTENCY_DESCRIPTOR_INVALID");
  }
  return Object.freeze({
    operation: value.operation,
    key: value.key,
    request_hash: value.request_hash,
  });
}

function readDomainRecordValue<K extends DomainRecordKind>(
  kind: K,
  value: unknown,
): DomainRecordValueMap[K] {
  try {
    switch (kind) {
      case "task":
        return parseTask(value) as DomainRecordValueMap[K];
      case "task_version":
        return parseTaskVersion(value) as DomainRecordValueMap[K];
      case "task_result":
        return parseTaskResult(value) as DomainRecordValueMap[K];
      case "task_relation":
        return parseTaskRelation(value) as DomainRecordValueMap[K];
      case "agent_run":
        return readAgentRunRecord(value) as DomainRecordValueMap[K];
      case "agent_session_binding":
        return readAgentSessionBinding(value) as DomainRecordValueMap[K];
      case "context_package":
        return parseContextPackage(value) as DomainRecordValueMap[K];
      case "handoff_package":
        return parseHandoffPackage(value) as DomainRecordValueMap[K];
      case "continuation_snapshot":
        return parseContinuationSnapshot(value) as DomainRecordValueMap[K];
      case "project_baseline":
        return parseProjectBaseline(value) as DomainRecordValueMap[K];
      case "approval_request":
        return parseApprovalRequest(value) as DomainRecordValueMap[K];
      case "review_cycle":
        return parseReviewCycle(value) as DomainRecordValueMap[K];
      case "control_invocation":
        return parseControlInvocation(value) as DomainRecordValueMap[K];
    }
  } catch (error) {
    if (error instanceof CoreDomainError && error.code === "REPOSITORY_WRITE_INVALID") {
      throw error;
    }
    throw invalidWrite("RECORD_SCHEMA_INVALID");
  }
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

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isDomainRecordKind(value: unknown): value is DomainRecordKind {
  return DOMAIN_RECORD_KINDS.some((kind) => kind === value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
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

function invalidWrite(reason: string): CoreDomainError {
  return new CoreDomainError("REPOSITORY_WRITE_INVALID", {
    entity: "domain_repository",
    reason,
  });
}
