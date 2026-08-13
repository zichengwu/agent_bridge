import type {
  AgentSessionBinding,
  TaskRelation,
  TaskVersionReference,
} from "@agent-bridge/schemas";

import type { AuthoritativeDomainEvent } from "./domain-events.js";
import { CoreDomainError } from "./errors.js";
import {
  RECOVERABLE_AGENT_RUN_STATUSES,
  computeDomainWriteFingerprint,
  getDomainRecordId,
  isImmutableDomainRecordKind,
  readDomainWriteRequest,
  type AnyStoredDomainRecord,
  type DomainEventPage,
  type DomainEventQuery,
  type DomainRecordKind,
  type DomainRecordWrite,
  type DomainRepository,
  type DomainWriteRequest,
  type DomainWriteResult,
  type RecoveryCandidateQuery,
  type RepositoryRecordVersion,
  type StoredDomainRecord,
  type TaskRelationQuery,
  type TaskQuery,
  type AgentRunQuery,
  type ApprovalRequestQuery,
  type ReviewCycleQuery,
} from "./repository.js";
import { readAgentSessionBindingSet } from "./session-binding.js";

interface IdempotencyEntry {
  readonly request_hash: string;
  readonly change_id: string;
  readonly write_fingerprint: string;
  readonly result: DomainWriteResult;
}

interface PreparedRecord {
  readonly write: DomainRecordWrite;
  readonly record_id: string;
  readonly revision: number;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_CURSOR_PATTERN = /^event-cursor:(0|[1-9][0-9]*)$/u;
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 1_000;

export class InMemoryDomainRepository implements DomainRepository {
  private readonly records = new Map<string, AnyStoredDomainRecord>();
  private readonly events: AuthoritativeDomainEvent[] = [];
  private readonly eventIds = new Set<string>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();

  async commit(value: DomainWriteRequest): Promise<DomainWriteResult> {
    await Promise.resolve();
    const request = readDomainWriteRequest(value);
    const idempotencyKey = encodeIdempotencyKey(
      request.idempotency.operation,
      request.idempotency.key,
    );
    const writeFingerprint = computeDomainWriteFingerprint(request);
    const existingIdempotency = this.idempotency.get(idempotencyKey);
    if (existingIdempotency !== undefined) {
      if (
        existingIdempotency.request_hash !== request.idempotency.request_hash ||
        existingIdempotency.change_id !== request.change_id ||
        existingIdempotency.write_fingerprint !== writeFingerprint
      ) {
        throw idempotencyConflict("IDEMPOTENCY_PAYLOAD_MISMATCH");
      }
      return replayResult(existingIdempotency.result);
    }

    if (
      request.expected_event_cursor !== undefined &&
      request.expected_event_cursor !== encodeEventCursor(this.events.length)
    ) {
      throw writeConflict("EVENT_CURSOR_MISMATCH");
    }

    const preparedRecords: readonly PreparedRecord[] = request.records.map((write) => {
      const recordId = getDomainRecordId(write.kind, write.value);
      const current = this.records.get(encodeRecordKey(write.kind, recordId));
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== write.expected_revision) {
        throw writeConflict("RECORD_REVISION_MISMATCH", write.kind, recordId);
      }
      if (current !== undefined && isImmutableDomainRecordKind(write.kind)) {
        throw writeConflict("IMMUTABLE_RECORD_EXISTS", write.kind, recordId);
      }
      return Object.freeze({
        write,
        record_id: recordId,
        revision: write.expected_revision + 1,
      });
    });
    this.validateProspectiveSessionBindings(preparedRecords);

    for (const event of request.events) {
      if (this.eventIds.has(event.event_id)) {
        throw writeConflict("EVENT_ID_ALREADY_EXISTS");
      }

      const pendingRecord = preparedRecords.find(
        (candidate) =>
          candidate.write.kind === event.aggregate.kind &&
          candidate.record_id === event.aggregate.id,
      );
      if (pendingRecord !== undefined) {
        if (pendingRecord.revision !== event.aggregate.revision) {
          throw writeConflict(
            "EVENT_AGGREGATE_REVISION_MISMATCH",
            event.aggregate.kind,
            event.aggregate.id,
          );
        }
        continue;
      }

      const current = this.records.get(encodeRecordKey(event.aggregate.kind, event.aggregate.id));
      if (current === undefined || current.revision !== event.aggregate.revision) {
        throw writeConflict("EVENT_AGGREGATE_NOT_FOUND", event.aggregate.kind, event.aggregate.id);
      }
    }

    const recordVersions: RepositoryRecordVersion[] = [];
    for (const prepared of preparedRecords) {
      const stored = Object.freeze({
        kind: prepared.write.kind,
        record_id: prepared.record_id,
        revision: prepared.revision,
        value: prepared.write.value,
      }) as AnyStoredDomainRecord;
      this.records.set(encodeRecordKey(stored.kind, stored.record_id), stored);
      recordVersions.push(
        Object.freeze({
          kind: stored.kind,
          record_id: stored.record_id,
          revision: stored.revision,
        }),
      );
    }

    for (const event of request.events) {
      this.events.push(event);
      this.eventIds.add(event.event_id);
    }

    recordVersions.sort(compareRecordVersions);
    const result = Object.freeze({
      outcome: "APPLIED",
      change_id: request.change_id,
      idempotency: request.idempotency,
      records: Object.freeze(recordVersions),
      event_ids: Object.freeze(request.events.map((event) => event.event_id)),
      event_cursor: encodeEventCursor(this.events.length),
    }) as DomainWriteResult;
    this.idempotency.set(
      idempotencyKey,
      Object.freeze({
        request_hash: request.idempotency.request_hash,
        change_id: request.change_id,
        write_fingerprint: writeFingerprint,
        result,
      }),
    );
    return result;
  }

  async getTask(taskId: string): Promise<StoredDomainRecord<"task"> | undefined> {
    await Promise.resolve();
    return this.getRecord("task", readIdentifier(taskId, "TASK_ID_INVALID"));
  }

  async getEventCursor(): Promise<string> {
    await Promise.resolve();
    return encodeEventCursor(this.events.length);
  }

  async listTasks(value: TaskQuery = {}): Promise<readonly StoredDomainRecord<"task">[]> {
    await Promise.resolve();
    const query = readTaskQuery(value);
    return Object.freeze(
      this.listRecords("task")
        .filter(
          (record) =>
            (query.project_id === undefined || record.value.project_id === query.project_id) &&
            (query.status === undefined || record.value.status === query.status) &&
            (query.after_task_id === undefined || record.value.task_id > query.after_task_id),
        )
        .sort((left, right) => compareText(left.record_id, right.record_id))
        .slice(0, query.limit),
    );
  }

  async getTaskVersion(
    reference: TaskVersionReference,
  ): Promise<StoredDomainRecord<"task_version"> | undefined> {
    await Promise.resolve();
    const scope = readTaskVersionReference(reference);
    return this.getRecord("task_version", `${scope.task_id}:v${scope.task_version}`);
  }

  async listTaskVersions(taskId: string): Promise<readonly StoredDomainRecord<"task_version">[]> {
    await Promise.resolve();
    const id = readIdentifier(taskId, "TASK_ID_INVALID");
    return Object.freeze(
      this.listRecords("task_version")
        .filter((record) => record.value.task_id === id)
        .sort((left, right) => left.value.task_version - right.value.task_version),
    );
  }

  async getTaskResult(runId: string): Promise<StoredDomainRecord<"task_result"> | undefined> {
    await Promise.resolve();
    return this.getRecord("task_result", readIdentifier(runId, "RUN_ID_INVALID"));
  }

  async listTaskResults(taskId: string): Promise<readonly StoredDomainRecord<"task_result">[]> {
    await Promise.resolve();
    const id = readIdentifier(taskId, "TASK_ID_INVALID");
    return Object.freeze(
      this.listRecords("task_result")
        .filter((record) => record.value.task_id === id)
        .sort((left, right) => compareText(left.value.finished_at, right.value.finished_at)),
    );
  }

  async getTaskRelation(
    relationId: string,
  ): Promise<StoredDomainRecord<"task_relation"> | undefined> {
    await Promise.resolve();
    return this.getRecord("task_relation", readIdentifier(relationId, "RELATION_ID_INVALID"));
  }

  async listTaskRelations(
    value: TaskRelationQuery,
  ): Promise<readonly StoredDomainRecord<"task_relation">[]> {
    await Promise.resolve();
    const query = readTaskRelationQuery(value);
    return Object.freeze(
      this.listRecords("task_relation")
        .filter((record) => relationMatches(record.value, query))
        .sort((left, right) => compareText(left.record_id, right.record_id)),
    );
  }

  async getAgentRun(runId: string): Promise<StoredDomainRecord<"agent_run"> | undefined> {
    await Promise.resolve();
    return this.getRecord("agent_run", readIdentifier(runId, "RUN_ID_INVALID"));
  }

  async listAgentRuns(
    value: AgentRunQuery = {},
  ): Promise<readonly StoredDomainRecord<"agent_run">[]> {
    await Promise.resolve();
    const query = readAgentRunQuery(value);
    return Object.freeze(
      this.listRecords("agent_run")
        .filter(
          (record) =>
            (query.task_id === undefined || record.value.task_id === query.task_id) &&
            (query.task_version === undefined ||
              record.value.task_version === query.task_version) &&
            (query.status === undefined || record.value.status === query.status),
        )
        .sort((left, right) => compareText(left.value.created_at, right.value.created_at))
        .slice(0, query.limit),
    );
  }

  async listRecoveryCandidates(
    value: RecoveryCandidateQuery = {},
  ): Promise<readonly StoredDomainRecord<"agent_run">[]> {
    await Promise.resolve();
    const query = readRecoveryQuery(value);
    const recoverable = this.listRecords("agent_run")
      .filter(
        (record) =>
          RECOVERABLE_AGENT_RUN_STATUSES.some((status) => status === record.value.status) &&
          (query.project_id === undefined || record.value.project_id === query.project_id),
      )
      .sort((left, right) => {
        const timeOrder = compareText(left.value.updated_at, right.value.updated_at);
        return timeOrder === 0 ? compareText(left.value.run_id, right.value.run_id) : timeOrder;
      })
      .slice(0, query.limit);
    return Object.freeze(recoverable);
  }

  async getAgentSessionBinding(
    bindingId: string,
  ): Promise<StoredDomainRecord<"agent_session_binding"> | undefined> {
    await Promise.resolve();
    return this.getRecord("agent_session_binding", readIdentifier(bindingId, "BINDING_ID_INVALID"));
  }

  async listAgentSessionBindings(
    runId: string,
  ): Promise<readonly StoredDomainRecord<"agent_session_binding">[]> {
    await Promise.resolve();
    const normalizedRunId = readIdentifier(runId, "RUN_ID_INVALID");
    return Object.freeze(
      this.listRecords("agent_session_binding")
        .filter((record) => record.value.run_id === normalizedRunId)
        .sort(compareSessionBindings),
    );
  }

  async getContextPackage(
    contextPackageId: string,
  ): Promise<StoredDomainRecord<"context_package"> | undefined> {
    await Promise.resolve();
    return this.getRecord(
      "context_package",
      readIdentifier(contextPackageId, "CONTEXT_PACKAGE_ID_INVALID"),
    );
  }

  async getHandoffPackage(
    handoffId: string,
    handoffVersion: number,
  ): Promise<StoredDomainRecord<"handoff_package"> | undefined> {
    await Promise.resolve();
    const normalizedId = readIdentifier(handoffId, "HANDOFF_ID_INVALID");
    const normalizedVersion = readPositiveInteger(handoffVersion, "HANDOFF_VERSION_INVALID");
    return this.getRecord("handoff_package", `${normalizedId}:v${normalizedVersion}`);
  }

  async listHandoffPackages(
    reference: TaskVersionReference,
  ): Promise<readonly StoredDomainRecord<"handoff_package">[]> {
    await Promise.resolve();
    const scope = readTaskVersionReference(reference);
    return Object.freeze(
      this.listRecords("handoff_package")
        .filter(
          (record) =>
            record.value.source_task.task_id === scope.task_id &&
            record.value.source_task.task_version === scope.task_version,
        )
        .sort(compareHandoffs),
    );
  }

  async getContinuationSnapshot(
    snapshotId: string,
    snapshotVersion: number,
  ): Promise<StoredDomainRecord<"continuation_snapshot"> | undefined> {
    await Promise.resolve();
    const normalizedId = readIdentifier(snapshotId, "SNAPSHOT_ID_INVALID");
    const normalizedVersion = readPositiveInteger(snapshotVersion, "SNAPSHOT_VERSION_INVALID");
    return this.getRecord("continuation_snapshot", `${normalizedId}:v${normalizedVersion}`);
  }

  async listContinuationSnapshots(
    runId: string,
  ): Promise<readonly StoredDomainRecord<"continuation_snapshot">[]> {
    await Promise.resolve();
    const normalizedRunId = readIdentifier(runId, "RUN_ID_INVALID");
    return Object.freeze(
      this.listRecords("continuation_snapshot")
        .filter((record) => record.value.run_id === normalizedRunId)
        .sort(compareSnapshots),
    );
  }

  async getLatestContinuationSnapshot(
    runId: string,
  ): Promise<StoredDomainRecord<"continuation_snapshot"> | undefined> {
    const snapshots = await this.listContinuationSnapshots(runId);
    return snapshots.at(-1);
  }

  async getProjectBaseline(projectId: string, baselineVersion: number) {
    await Promise.resolve();
    const id = readIdentifier(projectId, "PROJECT_ID_INVALID");
    const version = readPositiveInteger(baselineVersion, "BASELINE_VERSION_INVALID");
    return this.getRecord("project_baseline", `${id}:v${version}`);
  }

  async listProjectBaselines(projectId: string) {
    await Promise.resolve();
    const id = readIdentifier(projectId, "PROJECT_ID_INVALID");
    return Object.freeze(
      this.listRecords("project_baseline")
        .filter((record) => record.value.project_id === id)
        .sort((left, right) => left.value.baseline_version - right.value.baseline_version),
    );
  }

  async getApprovalRequest(approvalId: string) {
    await Promise.resolve();
    return this.getRecord("approval_request", readIdentifier(approvalId, "APPROVAL_ID_INVALID"));
  }

  async listApprovalRequests(value: ApprovalRequestQuery = {}) {
    await Promise.resolve();
    const query = readApprovalQuery(value);
    return Object.freeze(
      this.listRecords("approval_request")
        .filter(
          (record) =>
            (query.task_id === undefined || record.value.task_id === query.task_id) &&
            (query.run_id === undefined || record.value.run_id === query.run_id) &&
            (query.status === undefined || record.value.status === query.status),
        )
        .sort((left, right) => compareText(left.value.requested_at, right.value.requested_at))
        .slice(0, query.limit),
    );
  }

  async getReviewCycle(reviewId: string) {
    await Promise.resolve();
    return this.getRecord("review_cycle", readIdentifier(reviewId, "REVIEW_ID_INVALID"));
  }

  async listReviewCycles(value: ReviewCycleQuery) {
    await Promise.resolve();
    const query = readReviewQuery(value);
    return Object.freeze(
      this.listRecords("review_cycle")
        .filter(
          (record) =>
            record.value.task_id === query.task_id &&
            (query.task_version === undefined ||
              record.value.task_version === query.task_version) &&
            (query.run_id === undefined || record.value.run_id === query.run_id),
        )
        .sort((left, right) => left.value.cycle_number - right.value.cycle_number)
        .slice(0, query.limit),
    );
  }

  async getControlInvocation(invocationId: string) {
    await Promise.resolve();
    return this.getRecord(
      "control_invocation",
      readIdentifier(invocationId, "INVOCATION_ID_INVALID"),
    );
  }

  async listDomainEvents(value: DomainEventQuery = {}): Promise<DomainEventPage> {
    await Promise.resolve();
    const query = readEventQuery(value, this.events.length);
    const selected: AuthoritativeDomainEvent[] = [];
    let scanIndex = query.after_index;
    while (scanIndex < this.events.length && selected.length < query.limit) {
      const event = this.events[scanIndex];
      scanIndex += 1;
      if (
        event !== undefined &&
        (query.task_id === undefined || event.audit.task_id === query.task_id) &&
        (query.run_id === undefined || event.audit.run_id === query.run_id)
      ) {
        selected.push(event);
      }
    }

    if (selected.length < query.limit) {
      scanIndex = this.events.length;
    }
    return Object.freeze({
      events: Object.freeze(selected),
      next_cursor: encodeEventCursor(scanIndex),
    });
  }

  private getRecord<K extends DomainRecordKind>(
    kind: K,
    recordId: string,
  ): StoredDomainRecord<K> | undefined {
    return this.records.get(encodeRecordKey(kind, recordId)) as StoredDomainRecord<K> | undefined;
  }

  private listRecords<K extends DomainRecordKind>(kind: K): StoredDomainRecord<K>[] {
    return [...this.records.values()].filter(
      (record) => record.kind === kind,
    ) as StoredDomainRecord<K>[];
  }

  private validateProspectiveSessionBindings(preparedRecords: readonly PreparedRecord[]): void {
    const pendingBindingIds = new Set(
      preparedRecords
        .filter((record) => record.write.kind === "agent_session_binding")
        .map((record) => record.record_id),
    );
    if (pendingBindingIds.size === 0) {
      return;
    }

    const prospective: AgentSessionBinding[] = this.listRecords("agent_session_binding")
      .filter((record) => !pendingBindingIds.has(record.record_id))
      .map((record) => record.value);
    for (const record of preparedRecords) {
      if (record.write.kind === "agent_session_binding") {
        prospective.push(record.write.value);
      }
    }

    let bindings: readonly AgentSessionBinding[];
    try {
      bindings = readAgentSessionBindingSet(prospective);
    } catch {
      throw writeConflict("SESSION_BINDING_SET_INVALID", "agent_session_binding");
    }

    const bySessionId = new Map(bindings.map((binding) => [binding.session_id, binding]));
    for (const binding of bindings) {
      if (binding.predecessor_session_id === undefined) {
        continue;
      }
      const predecessor = bySessionId.get(binding.predecessor_session_id);
      if (
        predecessor === undefined ||
        predecessor.task_id !== binding.task_id ||
        predecessor.task_version !== binding.task_version ||
        predecessor.run_id !== binding.run_id ||
        predecessor.driver_id !== binding.driver_id ||
        predecessor.role !== binding.role
      ) {
        throw writeConflict("SESSION_PREDECESSOR_INVALID", "agent_session_binding");
      }
    }
  }
}

function readTaskVersionReference(value: unknown): TaskVersionReference {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["task_id", "task_version"]) ||
    !isIdentifier(value.task_id) ||
    !isPositiveInteger(value.task_version)
  ) {
    throw invalidQuery("TASK_VERSION_REFERENCE_INVALID");
  }
  return Object.freeze({ task_id: value.task_id, task_version: value.task_version });
}

function readTaskRelationQuery(value: unknown): TaskRelationQuery {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["task_id", "task_version", "direction"]) ||
    (value.direction !== "source" && value.direction !== "target" && value.direction !== "either")
  ) {
    throw invalidQuery("TASK_RELATION_QUERY_INVALID");
  }
  const scope = readTaskVersionReference({
    task_id: value.task_id,
    task_version: value.task_version,
  });
  return Object.freeze({ ...scope, direction: value.direction });
}

function readRecoveryQuery(
  value: unknown,
): Required<Pick<RecoveryCandidateQuery, "limit">> & Omit<RecoveryCandidateQuery, "limit"> {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["project_id", "limit"]) ||
    (value.project_id !== undefined && !isIdentifier(value.project_id))
  ) {
    throw invalidQuery("RECOVERY_QUERY_INVALID");
  }
  return Object.freeze({
    ...(value.project_id === undefined ? {} : { project_id: value.project_id }),
    limit: readLimit(value.limit),
  });
}

function readTaskQuery(value: unknown) {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["project_id", "status", "after_task_id", "order_by", "limit"]) ||
    (value.project_id !== undefined && !isIdentifier(value.project_id)) ||
    (value.after_task_id !== undefined && !isIdentifier(value.after_task_id)) ||
    (value.order_by !== undefined && value.order_by !== "record_id") ||
    (value.status !== undefined && typeof value.status !== "string")
  ) {
    throw invalidQuery("TASK_QUERY_INVALID");
  }
  return Object.freeze({ ...value, limit: readLimit(value.limit) }) as Required<
    Pick<TaskQuery, "limit">
  > &
    Omit<TaskQuery, "limit">;
}

function readAgentRunQuery(value: unknown) {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["task_id", "task_version", "status", "limit"]) ||
    (value.task_id !== undefined && !isIdentifier(value.task_id)) ||
    (value.task_version !== undefined && !isPositiveInteger(value.task_version)) ||
    (value.status !== undefined && typeof value.status !== "string")
  ) {
    throw invalidQuery("AGENT_RUN_QUERY_INVALID");
  }
  return Object.freeze({ ...value, limit: readLimit(value.limit) }) as Required<
    Pick<AgentRunQuery, "limit">
  > &
    Omit<AgentRunQuery, "limit">;
}

function readApprovalQuery(value: unknown) {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["task_id", "run_id", "status", "limit"]) ||
    (value.task_id !== undefined && !isIdentifier(value.task_id)) ||
    (value.run_id !== undefined && !isIdentifier(value.run_id)) ||
    (value.status !== undefined &&
      (typeof value.status !== "string" ||
        !["pending", "approved", "denied", "cancelled"].includes(value.status)))
  ) {
    throw invalidQuery("APPROVAL_QUERY_INVALID");
  }
  return Object.freeze({ ...value, limit: readLimit(value.limit) }) as Required<
    Pick<ApprovalRequestQuery, "limit">
  > &
    Omit<ApprovalRequestQuery, "limit">;
}

function readReviewQuery(value: unknown) {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["task_id", "task_version", "run_id", "limit"]) ||
    !isIdentifier(value.task_id) ||
    (value.task_version !== undefined && !isPositiveInteger(value.task_version)) ||
    (value.run_id !== undefined && !isIdentifier(value.run_id))
  ) {
    throw invalidQuery("REVIEW_QUERY_INVALID");
  }
  return Object.freeze({ ...value, limit: readLimit(value.limit) }) as Required<
    Pick<ReviewCycleQuery, "limit">
  > &
    Omit<ReviewCycleQuery, "limit">;
}

function readEventQuery(
  value: unknown,
  eventCount: number,
): {
  readonly task_id?: string;
  readonly run_id?: string;
  readonly after_index: number;
  readonly limit: number;
} {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["task_id", "run_id", "after_cursor", "limit"]) ||
    (value.task_id !== undefined && !isIdentifier(value.task_id)) ||
    (value.run_id !== undefined && !isIdentifier(value.run_id))
  ) {
    throw invalidQuery("EVENT_QUERY_INVALID");
  }
  return Object.freeze({
    ...(value.task_id === undefined ? {} : { task_id: value.task_id }),
    ...(value.run_id === undefined ? {} : { run_id: value.run_id }),
    after_index: readEventCursor(value.after_cursor, eventCount),
    limit: readLimit(value.limit),
  });
}

function readEventCursor(value: unknown, eventCount: number): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "string") {
    throw invalidQuery("EVENT_CURSOR_INVALID");
  }
  const match = EVENT_CURSOR_PATTERN.exec(value);
  const index = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(index) || index < 0 || index > eventCount) {
    throw invalidQuery("EVENT_CURSOR_INVALID");
  }
  return index;
}

function readLimit(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_QUERY_LIMIT;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_QUERY_LIMIT
  ) {
    throw invalidQuery("QUERY_LIMIT_INVALID");
  }
  return value;
}

function relationMatches(relation: TaskRelation, query: TaskRelationQuery): boolean {
  const sourceMatches = sameTaskVersion(relation.source, query);
  const targetMatches = sameTaskVersion(relation.target, query);
  return (
    (query.direction === "source" && sourceMatches) ||
    (query.direction === "target" && targetMatches) ||
    (query.direction === "either" && (sourceMatches || targetMatches))
  );
}

function sameTaskVersion(left: TaskVersionReference, right: TaskVersionReference): boolean {
  return left.task_id === right.task_id && left.task_version === right.task_version;
}

function compareSessionBindings(
  left: StoredDomainRecord<"agent_session_binding">,
  right: StoredDomainRecord<"agent_session_binding">,
): number {
  const timeOrder = compareText(left.value.created_at, right.value.created_at);
  return timeOrder === 0 ? compareText(left.value.session_id, right.value.session_id) : timeOrder;
}

function compareHandoffs(
  left: StoredDomainRecord<"handoff_package">,
  right: StoredDomainRecord<"handoff_package">,
): number {
  const idOrder = compareText(left.value.handoff_id, right.value.handoff_id);
  return idOrder === 0 ? left.value.handoff_version - right.value.handoff_version : idOrder;
}

function compareSnapshots(
  left: StoredDomainRecord<"continuation_snapshot">,
  right: StoredDomainRecord<"continuation_snapshot">,
): number {
  const timeOrder = compareText(left.value.created_at, right.value.created_at);
  if (timeOrder !== 0) {
    return timeOrder;
  }
  const idOrder = compareText(left.value.snapshot_id, right.value.snapshot_id);
  return idOrder === 0 ? left.value.snapshot_version - right.value.snapshot_version : idOrder;
}

function compareRecordVersions(
  left: RepositoryRecordVersion,
  right: RepositoryRecordVersion,
): number {
  const kindOrder = compareText(left.kind, right.kind);
  return kindOrder === 0 ? compareText(left.record_id, right.record_id) : kindOrder;
}

function replayResult(result: DomainWriteResult): DomainWriteResult {
  return Object.freeze({
    ...result,
    outcome: "REPLAYED",
  });
}

function encodeRecordKey(kind: DomainRecordKind, recordId: string): string {
  return JSON.stringify([kind, recordId]);
}

function encodeIdempotencyKey(operation: string, key: string): string {
  return JSON.stringify([operation, key]);
}

function encodeEventCursor(index: number): string {
  return `event-cursor:${index}`;
}

function readIdentifier(value: unknown, reason: string): string {
  if (!isIdentifier(value)) {
    throw invalidQuery(reason);
  }
  return value;
}

function readPositiveInteger(value: unknown, reason: string): number {
  if (!isPositiveInteger(value)) {
    throw invalidQuery(reason);
  }
  return value;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidQuery(reason: string): CoreDomainError {
  return new CoreDomainError("REPOSITORY_QUERY_INVALID", {
    entity: "domain_repository",
    reason,
  });
}

function writeConflict(
  reason: string,
  kind?: DomainRecordKind,
  recordId?: string,
): CoreDomainError {
  return new CoreDomainError("REPOSITORY_WRITE_CONFLICT", {
    entity: "domain_repository",
    reason,
    ...(kind === undefined ? {} : { record_kind: kind }),
    ...(recordId === undefined ? {} : { record_id: recordId }),
  });
}

function idempotencyConflict(reason: string): CoreDomainError {
  return new CoreDomainError("REPOSITORY_IDEMPOTENCY_CONFLICT", {
    entity: "domain_repository",
    reason,
  });
}
