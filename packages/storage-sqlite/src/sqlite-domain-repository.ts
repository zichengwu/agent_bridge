import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  CoreDomainError,
  RECOVERABLE_AGENT_RUN_STATUSES,
  computeDomainWriteFingerprint,
  getDomainRecordId,
  isImmutableDomainRecordKind,
  readAuthoritativeDomainEvent,
  readAgentSessionBindingSet,
  readDomainRecordWrite,
  readDomainWriteRequest,
  type ArtifactDomainReference,
  type ArtifactReferenceQuery,
  type ArtifactReferenceRepository,
  type AgentRunRecord,
  type AuthoritativeDomainEvent,
  type DomainEventPage,
  type DomainEventQuery,
  type DomainRecordKind,
  type DomainRecordValueMap,
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
} from "@agent-bridge/core";
import type {
  AgentSessionBinding,
  ContinuationSnapshot,
  HandoffPackage,
  TaskResult,
  TaskVersionReference,
} from "@agent-bridge/schemas";

import { SqliteStorageError } from "./errors.js";
import { migrateSqliteDatabase } from "./migrations.js";
import { SqliteOutboxDispatcher, type OutboxDispatcherOptions } from "./outbox.js";
import { SqliteLeaseManager, type SqliteLeaseManagerOptions } from "./sqlite-lease-manager.js";

export interface SqliteDomainRepositoryOptions {
  readonly database_path: string;
}

interface RecordTable {
  readonly name: string;
}

interface StoredRow {
  readonly record_id: string;
  readonly revision: number;
  readonly value_json: string;
}

interface IdempotencyRow {
  readonly request_hash: string;
  readonly change_id: string;
  readonly write_fingerprint: string;
  readonly result_json: string;
}

interface PreparedRecord {
  readonly write: DomainRecordWrite;
  readonly record_id: string;
  readonly revision: number;
}

interface ArtifactReferenceRow {
  readonly artifact_id: string;
  readonly source_kind: ArtifactDomainReference["source_kind"];
  readonly source_id: string;
  readonly source_revision: number;
  readonly field_path: string;
  readonly content_hash: string | null;
  readonly created_at: string;
}

const TABLES = {
  task: { name: "tasks" },
  task_version: { name: "task_versions" },
  task_result: { name: "task_results" },
  task_relation: { name: "task_relations" },
  agent_run: { name: "agent_runs" },
  agent_session_binding: { name: "agent_session_bindings" },
  context_package: { name: "context_packages" },
  handoff_package: { name: "handoff_packages" },
  continuation_snapshot: { name: "continuation_snapshots" },
  project_baseline: { name: "project_baselines" },
  approval_request: { name: "approval_requests" },
  review_cycle: { name: "review_cycles" },
  control_invocation: { name: "control_invocations" },
} as const satisfies Readonly<Record<DomainRecordKind, RecordTable>>;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_CURSOR_PATTERN = /^event-cursor:(0|[1-9][0-9]*)$/u;
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 1_000;

export class SqliteDomainRepository implements DomainRepository, ArtifactReferenceRepository {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(options: SqliteDomainRepositoryOptions) {
    const databasePath = readDatabasePath(options);
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    try {
      this.database = new DatabaseSync(databasePath);
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA busy_timeout = 5000");
      this.database.exec("PRAGMA synchronous = FULL");
      if (databasePath !== ":memory:") {
        this.database.exec("PRAGMA journal_mode = WAL");
      }
      migrateSqliteDatabase(this.database);
    } catch (error) {
      if (error instanceof SqliteStorageError) {
        throw error;
      }
      throw mapSqliteError(error, "DATABASE_OPEN_FAILED");
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.database.close();
    this.closed = true;
  }

  createOutboxDispatcher(options: OutboxDispatcherOptions): SqliteOutboxDispatcher {
    this.assertOpen();
    return new SqliteOutboxDispatcher(this.database, options);
  }

  createLeaseManager(options: SqliteLeaseManagerOptions = {}): SqliteLeaseManager {
    this.assertOpen();
    return new SqliteLeaseManager(this.database, options);
  }

  async commit(value: DomainWriteRequest): Promise<DomainWriteResult> {
    await Promise.resolve();
    this.assertOpen();
    const request = readDomainWriteRequest(value);
    const fingerprint = computeDomainWriteFingerprint(request);

    this.begin();
    try {
      const replay = this.readIdempotentReplay(request, fingerprint);
      if (replay !== undefined) {
        this.database.exec("COMMIT");
        return replay;
      }

      const prepared = this.prepareRecords(request.records);
      this.validateProspectiveSessionBindings(prepared);
      this.validateEvents(request.events, prepared);

      for (const record of prepared) {
        this.writeRecord(record);
      }
      for (const event of request.events) {
        this.appendEventAndOutbox(event);
      }
      for (const reference of extractArtifactReferences(prepared, request.events)) {
        this.insertArtifactReference(reference);
      }

      const records = prepared
        .map((record): RepositoryRecordVersion =>
          Object.freeze({
            kind: record.write.kind,
            record_id: record.record_id,
            revision: record.revision,
          }),
        )
        .sort(compareRecordVersions);
      const eventCursor = encodeEventCursor(this.readMaximumEventSequence());
      const result: DomainWriteResult = Object.freeze({
        outcome: "APPLIED",
        change_id: request.change_id,
        idempotency: request.idempotency,
        records: Object.freeze(records),
        event_ids: Object.freeze(request.events.map((event) => event.event_id)),
        event_cursor: eventCursor,
      });
      this.database
        .prepare(
          `INSERT INTO idempotency_requests(
             operation, idempotency_key, request_hash, change_id,
             write_fingerprint, result_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.idempotency.operation,
          request.idempotency.key,
          request.idempotency.request_hash,
          request.change_id,
          fingerprint,
          JSON.stringify(result),
          request.events[0]!.occurred_at,
        );
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.rollback();
      if (error instanceof CoreDomainError || error instanceof SqliteStorageError) {
        throw error;
      }
      throw mapSqliteError(error);
    }
  }

  async getTask(taskId: string): Promise<StoredDomainRecord<"task"> | undefined> {
    await Promise.resolve();
    return this.getRecord("task", readIdentifier(taskId, "TASK_ID_INVALID"));
  }

  async listTasks(value: TaskQuery = {}): Promise<readonly StoredDomainRecord<"task">[]> {
    await Promise.resolve();
    const query = readSimpleQuery(value, ["project_id", "status", "limit"]);
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    addOptionalCondition(conditions, parameters, "project_id", query.project_id);
    addOptionalCondition(conditions, parameters, "status", query.status);
    parameters.push(readLimit(query.limit));
    return this.queryRecords("task", conditions, parameters, "updated_at DESC, record_id");
  }

  async getTaskVersion(
    reference: TaskVersionReference,
  ): Promise<StoredDomainRecord<"task_version"> | undefined> {
    await Promise.resolve();
    const scope = readTaskVersionReference(reference);
    return this.getRecord("task_version", `${scope.task_id}:v${scope.task_version}`);
  }

  async listTaskVersions(taskId: string) {
    await Promise.resolve();
    return this.queryRecords(
      "task_version",
      ["task_id = ?"],
      [readIdentifier(taskId, "TASK_ID_INVALID"), MAX_QUERY_LIMIT],
      "task_version, record_id",
    );
  }

  async getTaskResult(runId: string): Promise<StoredDomainRecord<"task_result"> | undefined> {
    await Promise.resolve();
    return this.getRecord("task_result", readIdentifier(runId, "RUN_ID_INVALID"));
  }

  async listTaskResults(taskId: string) {
    await Promise.resolve();
    return this.queryRecords(
      "task_result",
      ["task_id = ?"],
      [readIdentifier(taskId, "TASK_ID_INVALID"), MAX_QUERY_LIMIT],
      "created_at, record_id",
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
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    const source = "(source_task_id = ? AND source_task_version = ?)";
    const target = "(target_task_id = ? AND target_task_version = ?)";
    if (query.direction === "source" || query.direction === "either") {
      conditions.push(source);
      parameters.push(query.task_id, query.task_version);
    }
    if (query.direction === "target" || query.direction === "either") {
      conditions.push(target);
      parameters.push(query.task_id, query.task_version);
    }
    const rows = this.database
      .prepare(
        `SELECT record_id, revision, value_json FROM task_relations
         WHERE ${conditions.join(" OR ")} ORDER BY record_id`,
      )
      .all(...parameters) as unknown as StoredRow[];
    return Object.freeze(rows.map((row) => decodeStoredRow("task_relation", row)));
  }

  async getAgentRun(runId: string): Promise<StoredDomainRecord<"agent_run"> | undefined> {
    await Promise.resolve();
    return this.getRecord("agent_run", readIdentifier(runId, "RUN_ID_INVALID"));
  }

  async listAgentRuns(value: AgentRunQuery = {}) {
    await Promise.resolve();
    const query = readSimpleQuery(value, ["task_id", "task_version", "status", "limit"]);
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    addOptionalCondition(conditions, parameters, "task_id", query.task_id);
    addOptionalCondition(conditions, parameters, "task_version", query.task_version);
    addOptionalCondition(conditions, parameters, "status", query.status);
    parameters.push(readLimit(query.limit));
    return this.queryRecords("agent_run", conditions, parameters, "updated_at, record_id");
  }

  async listRecoveryCandidates(
    value: RecoveryCandidateQuery = {},
  ): Promise<readonly StoredDomainRecord<"agent_run">[]> {
    await Promise.resolve();
    const query = readRecoveryQuery(value);
    const statuses = RECOVERABLE_AGENT_RUN_STATUSES;
    const rows = this.database
      .prepare(
        `SELECT record_id, revision, value_json FROM agent_runs
         WHERE status IN (${statuses.map(() => "?").join(", ")})
           ${query.project_id === undefined ? "" : "AND project_id = ?"}
         ORDER BY updated_at, run_id LIMIT ?`,
      )
      .all(
        ...statuses,
        ...(query.project_id === undefined ? [] : [query.project_id]),
        query.limit,
      ) as unknown as StoredRow[];
    return Object.freeze(rows.map((row) => decodeStoredRow("agent_run", row)));
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
    const rows = this.database
      .prepare(
        `SELECT record_id, revision, value_json FROM agent_session_bindings
         WHERE run_id = ? ORDER BY created_at, session_id`,
      )
      .all(readIdentifier(runId, "RUN_ID_INVALID")) as unknown as StoredRow[];
    return Object.freeze(rows.map((row) => decodeStoredRow("agent_session_binding", row)));
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
    const id = readIdentifier(handoffId, "HANDOFF_ID_INVALID");
    const version = readPositiveInteger(handoffVersion, "HANDOFF_VERSION_INVALID");
    return this.getRecord("handoff_package", `${id}:v${version}`);
  }

  async listHandoffPackages(
    reference: TaskVersionReference,
  ): Promise<readonly StoredDomainRecord<"handoff_package">[]> {
    await Promise.resolve();
    const scope = readTaskVersionReference(reference);
    const rows = this.database
      .prepare(
        `SELECT record_id, revision, value_json FROM handoff_packages
         WHERE source_task_id = ? AND source_task_version = ?
         ORDER BY handoff_id, handoff_version`,
      )
      .all(scope.task_id, scope.task_version) as unknown as StoredRow[];
    return Object.freeze(rows.map((row) => decodeStoredRow("handoff_package", row)));
  }

  async getContinuationSnapshot(
    snapshotId: string,
    snapshotVersion: number,
  ): Promise<StoredDomainRecord<"continuation_snapshot"> | undefined> {
    await Promise.resolve();
    const id = readIdentifier(snapshotId, "SNAPSHOT_ID_INVALID");
    const version = readPositiveInteger(snapshotVersion, "SNAPSHOT_VERSION_INVALID");
    return this.getRecord("continuation_snapshot", `${id}:v${version}`);
  }

  async listContinuationSnapshots(
    runId: string,
  ): Promise<readonly StoredDomainRecord<"continuation_snapshot">[]> {
    await Promise.resolve();
    const rows = this.database
      .prepare(
        `SELECT record_id, revision, value_json FROM continuation_snapshots
         WHERE run_id = ? ORDER BY created_at, snapshot_id, snapshot_version`,
      )
      .all(readIdentifier(runId, "RUN_ID_INVALID")) as unknown as StoredRow[];
    return Object.freeze(rows.map((row) => decodeStoredRow("continuation_snapshot", row)));
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
    return this.queryRecords(
      "project_baseline",
      ["project_id = ?"],
      [readIdentifier(projectId, "PROJECT_ID_INVALID"), MAX_QUERY_LIMIT],
      "baseline_version, record_id",
    );
  }

  async getApprovalRequest(approvalId: string) {
    await Promise.resolve();
    return this.getRecord("approval_request", readIdentifier(approvalId, "APPROVAL_ID_INVALID"));
  }

  async listApprovalRequests(value: ApprovalRequestQuery = {}) {
    await Promise.resolve();
    const query = readSimpleQuery(value, ["task_id", "run_id", "status", "limit"]);
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    addOptionalCondition(conditions, parameters, "task_id", query.task_id);
    addOptionalCondition(conditions, parameters, "run_id", query.run_id);
    addOptionalCondition(conditions, parameters, "status", query.status);
    parameters.push(readLimit(query.limit));
    return this.queryRecords("approval_request", conditions, parameters, "requested_at, record_id");
  }

  async getReviewCycle(reviewId: string) {
    await Promise.resolve();
    return this.getRecord("review_cycle", readIdentifier(reviewId, "REVIEW_ID_INVALID"));
  }

  async listReviewCycles(value: ReviewCycleQuery) {
    await Promise.resolve();
    const query = readSimpleQuery(value, ["task_id", "task_version", "run_id", "limit"]);
    if (typeof query.task_id !== "string") {
      throw invalidQuery("REVIEW_QUERY_INVALID");
    }
    const conditions = ["task_id = ?"];
    const parameters: Array<string | number> = [readIdentifier(query.task_id, "TASK_ID_INVALID")];
    addOptionalCondition(conditions, parameters, "task_version", query.task_version);
    addOptionalCondition(conditions, parameters, "run_id", query.run_id);
    parameters.push(readLimit(query.limit));
    return this.queryRecords("review_cycle", conditions, parameters, "cycle_number, record_id");
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
    this.assertOpen();
    const maximum = this.readMaximumEventSequence();
    const query = readEventQuery(value, maximum);
    const conditions = ["sequence > ?"];
    const parameters: Array<string | number> = [query.after_sequence];
    if (query.task_id !== undefined) {
      conditions.push("task_id = ?");
      parameters.push(query.task_id);
    }
    if (query.run_id !== undefined) {
      conditions.push("run_id = ?");
      parameters.push(query.run_id);
    }
    parameters.push(query.limit);
    const rows = this.database
      .prepare(
        `SELECT sequence, event_json FROM domain_events
         WHERE ${conditions.join(" AND ")}
         ORDER BY sequence LIMIT ?`,
      )
      .all(...parameters) as unknown as Array<{
      readonly sequence: number;
      readonly event_json: string;
    }>;
    const events = rows.map((row) => decodeEvent(row.event_json));
    const nextSequence =
      rows.length === query.limit ? rows.at(-1)!.sequence : this.readMaximumEventSequence();
    return Object.freeze({
      events: Object.freeze(events),
      next_cursor: encodeEventCursor(nextSequence),
    });
  }

  async listArtifactReferences(
    value: ArtifactReferenceQuery = {},
  ): Promise<readonly ArtifactDomainReference[]> {
    await Promise.resolve();
    this.assertOpen();
    const query = readArtifactReferenceQuery(value);
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.artifact_id !== undefined) {
      conditions.push("artifact_id = ?");
      parameters.push(query.artifact_id);
    }
    if (query.source_kind !== undefined) {
      conditions.push("source_kind = ?");
      parameters.push(query.source_kind);
    }
    parameters.push(query.limit);
    const rows = this.database
      .prepare(
        `SELECT artifact_id, source_kind, source_id, source_revision,
                field_path, content_hash, created_at
         FROM artifact_references
         ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
         ORDER BY artifact_id, source_kind, source_id, source_revision, field_path
         LIMIT ?`,
      )
      .all(...parameters) as unknown as ArtifactReferenceRow[];
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          artifact_id: row.artifact_id,
          source_kind: row.source_kind,
          source_id: row.source_id,
          source_revision: row.source_revision,
          field_path: row.field_path,
          ...(row.content_hash === null ? {} : { content_hash: row.content_hash }),
          created_at: row.created_at,
        }),
      ),
    );
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SqliteStorageError("DATABASE_CLOSED");
    }
  }

  private begin(): void {
    this.assertOpen();
    try {
      this.database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  private rollback(): void {
    try {
      this.database.exec("ROLLBACK");
    } catch {
      // Preserve the original error when no transaction remains.
    }
  }

  private readIdempotentReplay(
    request: DomainWriteRequest,
    fingerprint: string,
  ): DomainWriteResult | undefined {
    const row = this.database
      .prepare(
        `SELECT request_hash, change_id, write_fingerprint, result_json
         FROM idempotency_requests WHERE operation = ? AND idempotency_key = ?`,
      )
      .get(request.idempotency.operation, request.idempotency.key) as IdempotencyRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    if (
      row.request_hash !== request.idempotency.request_hash ||
      row.change_id !== request.change_id ||
      row.write_fingerprint !== fingerprint
    ) {
      throw idempotencyConflict("IDEMPOTENCY_PAYLOAD_MISMATCH");
    }
    const result = JSON.parse(row.result_json) as DomainWriteResult;
    return Object.freeze({ ...result, outcome: "REPLAYED" });
  }

  private prepareRecords(writes: readonly DomainRecordWrite[]): readonly PreparedRecord[] {
    return writes.map((write) => {
      const recordId = getDomainRecordId(write.kind, write.value as never);
      const current = this.readRow(write.kind, recordId);
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
  }

  private validateProspectiveSessionBindings(prepared: readonly PreparedRecord[]): void {
    const pending = prepared.filter(
      (record) => record.write.kind === "agent_session_binding",
    ) as readonly (PreparedRecord & {
      readonly write: DomainRecordWrite & {
        readonly kind: "agent_session_binding";
        readonly value: AgentSessionBinding;
      };
    })[];
    if (pending.length === 0) {
      return;
    }
    const pendingIds = new Set(pending.map((record) => record.record_id));
    const existing = this.readAllRows("agent_session_binding")
      .filter((row) => !pendingIds.has(row.record_id))
      .map((row) => decodeStoredRow("agent_session_binding", row).value);
    const prospective = [...existing, ...pending.map((record) => record.write.value)];
    let bindings: readonly AgentSessionBinding[];
    try {
      bindings = readAgentSessionBindingSet(prospective);
    } catch {
      throw writeConflict("SESSION_BINDING_SET_INVALID", "agent_session_binding");
    }
    const bySession = new Map(bindings.map((binding) => [binding.session_id, binding]));
    for (const binding of bindings) {
      if (binding.predecessor_session_id === undefined) {
        continue;
      }
      const predecessor = bySession.get(binding.predecessor_session_id);
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

  private validateEvents(
    events: readonly AuthoritativeDomainEvent[],
    prepared: readonly PreparedRecord[],
  ): void {
    for (const event of events) {
      const duplicate = this.database
        .prepare("SELECT 1 AS found FROM domain_events WHERE event_id = ?")
        .get(event.event_id);
      if (duplicate !== undefined) {
        throw writeConflict("EVENT_ID_ALREADY_EXISTS");
      }
      const pending = prepared.find(
        (record) =>
          record.write.kind === event.aggregate.kind && record.record_id === event.aggregate.id,
      );
      if (pending !== undefined) {
        if (pending.revision !== event.aggregate.revision) {
          throw writeConflict(
            "EVENT_AGGREGATE_REVISION_MISMATCH",
            event.aggregate.kind,
            event.aggregate.id,
          );
        }
        continue;
      }
      const current = this.readRow(event.aggregate.kind, event.aggregate.id);
      if (current === undefined || current.revision !== event.aggregate.revision) {
        throw writeConflict("EVENT_AGGREGATE_NOT_FOUND", event.aggregate.kind, event.aggregate.id);
      }
    }
  }

  private writeRecord(record: PreparedRecord): void {
    const table = TABLES[record.write.kind].name;
    const projection = projectRecord(record.write.kind, record.write.value);
    const projectionKeys = Object.keys(projection);
    const projectionValues = projectionKeys.map((key) => projection[key]!);
    if (record.write.expected_revision === 0) {
      const columns = ["record_id", "revision", "value_json", ...projectionKeys];
      this.database
        .prepare(
          `INSERT INTO ${table}(${columns.join(", ")})
           VALUES (${columns.map(() => "?").join(", ")})`,
        )
        .run(
          record.record_id,
          record.revision,
          JSON.stringify(record.write.value),
          ...projectionValues,
        );
      return;
    }
    const assignments = [
      "revision = ?",
      "value_json = ?",
      ...projectionKeys.map((key) => `${key} = ?`),
    ];
    const result = this.database
      .prepare(
        `UPDATE ${table} SET ${assignments.join(", ")}
         WHERE record_id = ? AND revision = ?`,
      )
      .run(
        record.revision,
        JSON.stringify(record.write.value),
        ...projectionValues,
        record.record_id,
        record.write.expected_revision,
      );
    if (Number(result.changes) !== 1) {
      throw writeConflict("RECORD_REVISION_MISMATCH", record.write.kind, record.record_id);
    }
  }

  private appendEventAndOutbox(event: AuthoritativeDomainEvent): void {
    const result = this.database
      .prepare(
        `INSERT INTO domain_events(
           event_id, event_type, task_id, run_id, occurred_at, event_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.event_id,
        event.event_type,
        event.audit.task_id ?? null,
        event.audit.run_id ?? null,
        event.occurred_at,
        JSON.stringify(event),
      );
    this.database
      .prepare(
        `INSERT INTO outbox(
           event_id, event_sequence, status, attempt_count, available_at
         ) VALUES (?, ?, 'pending', 0, ?)`,
      )
      .run(event.event_id, Number(result.lastInsertRowid), event.occurred_at);
  }

  private insertArtifactReference(reference: ArtifactDomainReference): void {
    this.database
      .prepare(
        `INSERT INTO artifact_references(
           artifact_id, source_kind, source_id, source_revision,
           field_path, content_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reference.artifact_id,
        reference.source_kind,
        reference.source_id,
        reference.source_revision,
        reference.field_path,
        reference.content_hash ?? null,
        reference.created_at,
      );
  }

  private getRecord<K extends DomainRecordKind>(
    kind: K,
    recordId: string,
  ): StoredDomainRecord<K> | undefined {
    this.assertOpen();
    const row = this.readRow(kind, recordId);
    return row === undefined ? undefined : decodeStoredRow(kind, row);
  }

  private readRow(kind: DomainRecordKind, recordId: string): StoredRow | undefined {
    return this.database
      .prepare(
        `SELECT record_id, revision, value_json FROM ${TABLES[kind].name}
         WHERE record_id = ?`,
      )
      .get(recordId) as StoredRow | undefined;
  }

  private readAllRows(kind: DomainRecordKind): readonly StoredRow[] {
    return this.database
      .prepare(`SELECT record_id, revision, value_json FROM ${TABLES[kind].name}`)
      .all() as unknown as StoredRow[];
  }

  private queryRecords<K extends DomainRecordKind>(
    kind: K,
    conditions: readonly string[],
    parameters: readonly (string | number)[],
    orderBy: string,
  ): readonly StoredDomainRecord<K>[] {
    this.assertOpen();
    const rows = this.database
      .prepare(
        `SELECT record_id, revision, value_json FROM ${TABLES[kind].name}
         ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
         ORDER BY ${orderBy} LIMIT ?`,
      )
      .all(...parameters) as unknown as StoredRow[];
    return Object.freeze(rows.map((row) => decodeStoredRow(kind, row)));
  }

  private readMaximumEventSequence(): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS maximum FROM domain_events")
      .get() as { readonly maximum: number };
    return Number(row.maximum);
  }
}

function readDatabasePath(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "database_path") ||
    typeof (value as { database_path?: unknown }).database_path !== "string" ||
    (value as { database_path: string }).database_path.length === 0
  ) {
    throw new SqliteStorageError("DATABASE_OPEN_FAILED");
  }
  const path = (value as { database_path: string }).database_path;
  return path === ":memory:" ? path : resolve(path);
}

function decodeStoredRow<K extends DomainRecordKind>(
  kind: K,
  row: StoredRow,
): StoredDomainRecord<K> {
  let raw: unknown;
  try {
    raw = JSON.parse(row.value_json);
  } catch {
    throw new SqliteStorageError("DATABASE_CORRUPT", { record_kind: kind });
  }
  let value: DomainRecordValueMap[K];
  try {
    value = readDomainRecordWrite({ kind, expected_revision: 0, value: raw })
      .value as DomainRecordValueMap[K];
  } catch {
    throw new SqliteStorageError("DATABASE_CORRUPT", { record_kind: kind });
  }
  return Object.freeze({
    kind,
    record_id: row.record_id,
    revision: row.revision,
    value,
  });
}

function decodeEvent(value: string): AuthoritativeDomainEvent {
  try {
    return readAuthoritativeDomainEvent(JSON.parse(value));
  } catch {
    throw new SqliteStorageError("DATABASE_CORRUPT", { entity: "domain_event" });
  }
}

function projectRecord(
  kind: DomainRecordKind,
  value: DomainRecordValueMap[DomainRecordKind],
): Readonly<Record<string, string | number | null>> {
  switch (kind) {
    case "task": {
      const record = value as DomainRecordValueMap["task"];
      return {
        project_id: record.project_id,
        status: record.status,
        updated_at: record.updated_at,
      };
    }
    case "task_version": {
      const record = value as DomainRecordValueMap["task_version"];
      return {
        task_id: record.task_id,
        task_version: record.task_version,
        project_id: record.project_id,
        created_at: record.created_at,
      };
    }
    case "task_result": {
      const record = value as DomainRecordValueMap["task_result"];
      return {
        task_id: record.task_id,
        task_version: record.task_version,
        run_id: record.run_id,
        created_at: record.finished_at,
      };
    }
    case "task_relation": {
      const record = value as DomainRecordValueMap["task_relation"];
      return {
        source_task_id: record.source.task_id,
        source_task_version: record.source.task_version,
        target_task_id: record.target.task_id,
        target_task_version: record.target.task_version,
        created_at: record.created_at,
      };
    }
    case "agent_run": {
      const record = value as DomainRecordValueMap["agent_run"];
      return {
        task_id: record.task_id,
        task_version: record.task_version,
        project_id: record.project_id,
        run_id: record.run_id,
        role: record.role,
        status: record.status,
        updated_at: record.updated_at,
      };
    }
    case "agent_session_binding": {
      const record = value as DomainRecordValueMap["agent_session_binding"];
      return {
        binding_id: record.binding_id,
        session_id: record.session_id,
        run_id: record.run_id,
        role: record.role,
        status: record.status,
        predecessor_session_id: record.predecessor_session_id ?? null,
        created_at: record.created_at,
      };
    }
    case "context_package": {
      const record = value as DomainRecordValueMap["context_package"];
      return {
        task_id: record.task_id,
        task_version: record.task_version,
        run_id: record.run_id,
        created_at: record.created_at,
      };
    }
    case "handoff_package": {
      const record = value as DomainRecordValueMap["handoff_package"];
      return {
        handoff_id: record.handoff_id,
        handoff_version: record.handoff_version,
        source_task_id: record.source_task.task_id,
        source_task_version: record.source_task.task_version,
        created_at: record.generated_at,
      };
    }
    case "continuation_snapshot": {
      const record = value as DomainRecordValueMap["continuation_snapshot"];
      return {
        snapshot_id: record.snapshot_id,
        snapshot_version: record.snapshot_version,
        run_id: record.run_id,
        created_at: record.created_at,
      };
    }
    case "project_baseline": {
      const record = value as DomainRecordValueMap["project_baseline"];
      return {
        project_id: record.project_id,
        baseline_version: record.baseline_version,
        created_at: record.created_at,
      };
    }
    case "approval_request": {
      const record = value as DomainRecordValueMap["approval_request"];
      return {
        task_id: record.task_id,
        task_version: record.task_version,
        run_id: record.run_id,
        status: record.status,
        requested_at: record.requested_at,
      };
    }
    case "review_cycle": {
      const record = value as DomainRecordValueMap["review_cycle"];
      return {
        task_id: record.task_id,
        task_version: record.task_version,
        run_id: record.run_id,
        cycle_number: record.cycle_number,
        status: record.status,
        updated_at: record.updated_at,
      };
    }
    case "control_invocation": {
      const record = value as DomainRecordValueMap["control_invocation"];
      return {
        tool_name: record.tool_name,
        task_id: record.task_id ?? null,
        run_id: record.run_id ?? null,
        occurred_at: record.occurred_at,
      };
    }
  }
}

function extractArtifactReferences(
  prepared: readonly PreparedRecord[],
  events: readonly AuthoritativeDomainEvent[],
): readonly ArtifactDomainReference[] {
  const references: ArtifactDomainReference[] = [];
  for (const record of prepared) {
    const createdAt =
      events.find(
        (event) =>
          event.aggregate.kind === record.write.kind &&
          event.aggregate.id === record.record_id &&
          event.aggregate.revision === record.revision,
      )?.occurred_at ?? new Date(0).toISOString();
    if (record.write.kind === "task_result") {
      collectTaskResultReferences(references, record, record.write.value, createdAt);
    } else if (record.write.kind === "agent_run") {
      collectAgentRunReferences(references, record, record.write.value, createdAt);
    } else if (record.write.kind === "handoff_package") {
      collectHandoffReferences(references, record, record.write.value, createdAt);
    } else if (record.write.kind === "continuation_snapshot") {
      collectSnapshotReferences(references, record, record.write.value, createdAt);
    }
  }
  return Object.freeze(references);
}

function collectAgentRunReferences(
  target: ArtifactDomainReference[],
  record: PreparedRecord,
  value: AgentRunRecord,
  createdAt: string,
): void {
  const checkpoint = value.metadata?.recovery_checkpoint;
  if (typeof checkpoint !== "object" || checkpoint === null || Array.isArray(checkpoint)) {
    return;
  }
  const reference = checkpoint as {
    readonly [key: string]: import("@agent-bridge/schemas").DomainJsonValue;
  };
  if (typeof reference.artifact_id !== "string") return;
  target.push(
    artifactReference(
      record,
      reference.artifact_id,
      "/metadata/recovery_checkpoint/artifact_id",
      createdAt,
      typeof reference.content_hash === "string" ? reference.content_hash : undefined,
    ),
  );
}

function collectTaskResultReferences(
  target: ArtifactDomainReference[],
  record: PreparedRecord,
  value: TaskResult,
  createdAt: string,
): void {
  value.artifacts?.forEach((artifact, index) => {
    target.push(
      artifactReference(
        record,
        artifact.artifact_id,
        `/artifacts/${index}`,
        createdAt,
        artifact.content_hash,
      ),
    );
  });
  value.acceptance_results.forEach((result, index) => {
    if (result.log_artifact_id !== undefined) {
      target.push(
        artifactReference(
          record,
          result.log_artifact_id,
          `/acceptance_results/${index}/log_artifact_id`,
          createdAt,
        ),
      );
    }
  });
}

function collectHandoffReferences(
  target: ArtifactDomainReference[],
  record: PreparedRecord,
  value: HandoffPackage,
  createdAt: string,
): void {
  value.verification.artifact_ids.forEach((artifactId, index) => {
    target.push(
      artifactReference(record, artifactId, `/verification/artifact_ids/${index}`, createdAt),
    );
  });
}

function collectSnapshotReferences(
  target: ArtifactDomainReference[],
  record: PreparedRecord,
  value: ContinuationSnapshot,
  createdAt: string,
): void {
  value.artifact_ids.forEach((artifactId, index) => {
    target.push(artifactReference(record, artifactId, `/artifact_ids/${index}`, createdAt));
  });
  value.recent_verification.forEach((verification, verificationIndex) => {
    verification.artifact_ids.forEach((artifactId, artifactIndex) => {
      target.push(
        artifactReference(
          record,
          artifactId,
          `/recent_verification/${verificationIndex}/artifact_ids/${artifactIndex}`,
          createdAt,
        ),
      );
    });
  });
}

function artifactReference(
  record: PreparedRecord,
  artifactId: string,
  fieldPath: string,
  createdAt: string,
  contentHash?: string,
): ArtifactDomainReference {
  return Object.freeze({
    artifact_id: artifactId,
    source_kind: record.write.kind as ArtifactDomainReference["source_kind"],
    source_id: record.record_id,
    source_revision: record.revision,
    field_path: fieldPath,
    ...(contentHash === undefined ? {} : { content_hash: contentHash }),
    created_at: createdAt,
  });
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
    !isIdentifier(value.task_id) ||
    !isPositiveInteger(value.task_version) ||
    !["source", "target", "either"].includes(String(value.direction))
  ) {
    throw invalidQuery("TASK_RELATION_QUERY_INVALID");
  }
  return Object.freeze({
    task_id: value.task_id,
    task_version: value.task_version,
    direction: value.direction as TaskRelationQuery["direction"],
  });
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

function readEventQuery(
  value: unknown,
  maximum: number,
): {
  readonly task_id?: string;
  readonly run_id?: string;
  readonly after_sequence: number;
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
    after_sequence: readEventCursor(value.after_cursor, maximum),
    limit: readLimit(value.limit),
  });
}

function readArtifactReferenceQuery(
  value: unknown,
): Required<Pick<ArtifactReferenceQuery, "limit">> & Omit<ArtifactReferenceQuery, "limit"> {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["artifact_id", "source_kind", "limit"]) ||
    (value.artifact_id !== undefined && !isIdentifier(value.artifact_id)) ||
    (value.source_kind !== undefined && !isArtifactReferenceSourceKind(value.source_kind))
  ) {
    throw invalidQuery("ARTIFACT_REFERENCE_QUERY_INVALID");
  }
  return Object.freeze({
    ...(value.artifact_id === undefined ? {} : { artifact_id: value.artifact_id }),
    ...(value.source_kind === undefined ? {} : { source_kind: value.source_kind }),
    limit: readLimit(value.limit),
  });
}

function readSimpleQuery(
  value: unknown,
  allowed: readonly string[],
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, allowed)) {
    throw invalidQuery("QUERY_INVALID");
  }
  for (const field of ["project_id", "task_id", "run_id", "status"] as const) {
    if (value[field] !== undefined && !isIdentifier(value[field])) {
      throw invalidQuery("QUERY_INVALID");
    }
  }
  if (value.task_version !== undefined && !isPositiveInteger(value.task_version)) {
    throw invalidQuery("QUERY_INVALID");
  }
  return value;
}

function addOptionalCondition(
  conditions: string[],
  parameters: Array<string | number>,
  column: string,
  value: unknown,
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw invalidQuery("QUERY_INVALID");
  }
  conditions.push(`${column} = ?`);
  parameters.push(value);
}

function readEventCursor(value: unknown, maximum: number): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "string") {
    throw invalidQuery("EVENT_CURSOR_INVALID");
  }
  const match = EVENT_CURSOR_PATTERN.exec(value);
  const sequence = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > maximum) {
    throw invalidQuery("EVENT_CURSOR_INVALID");
  }
  return sequence;
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

function isArtifactReferenceSourceKind(
  value: unknown,
): value is ArtifactDomainReference["source_kind"] {
  return (
    value === "task_result" || value === "handoff_package" || value === "continuation_snapshot"
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

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function compareRecordVersions(
  left: RepositoryRecordVersion,
  right: RepositoryRecordVersion,
): number {
  const kind = compareText(left.kind, right.kind);
  return kind === 0 ? compareText(left.record_id, right.record_id) : kind;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encodeEventCursor(sequence: number): string {
  return `event-cursor:${sequence}`;
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

function mapSqliteError(
  error: unknown,
  fallback: "DATABASE_OPEN_FAILED" | "DATABASE_CORRUPT" = "DATABASE_CORRUPT",
): SqliteStorageError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const errcode =
    typeof error === "object" && error !== null && "errcode" in error
      ? Number((error as { errcode?: unknown }).errcode)
      : 0;
  if (code.includes("BUSY") || code.includes("LOCKED") || errcode === 5 || errcode === 6) {
    return new SqliteStorageError("DATABASE_BUSY");
  }
  return new SqliteStorageError(fallback);
}
