import type { DatabaseSync } from "node:sqlite";

import { SqliteStorageError } from "./errors.js";

export const SQLITE_SCHEMA_VERSION = 1 as const;

const MIGRATION_NAME = "phase_2f_initial";
const MIGRATION_CHECKSUM = "phase-2f-v1-2026-07-31";

const RECORD_TABLES_SQL = [
  `CREATE TABLE tasks (
    record_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    value_json TEXT NOT NULL,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE task_versions (
    record_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision = 1),
    value_json TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_version INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (task_id, task_version)
  ) STRICT`,
  `CREATE TABLE task_results (
    record_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision = 1),
    value_json TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_version INTEGER NOT NULL,
    run_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE task_relations (
    record_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision = 1),
    value_json TEXT NOT NULL,
    source_task_id TEXT NOT NULL,
    source_task_version INTEGER NOT NULL,
    target_task_id TEXT NOT NULL,
    target_task_version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE agent_runs (
    record_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    value_json TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_version INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE agent_session_bindings (
    record_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    value_json TEXT NOT NULL,
    binding_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    predecessor_session_id TEXT,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE context_packages (
    record_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision = 1),
    value_json TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_version INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE handoff_packages (
    record_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision = 1),
    value_json TEXT NOT NULL,
    handoff_id TEXT NOT NULL,
    handoff_version INTEGER NOT NULL,
    source_task_id TEXT NOT NULL,
    source_task_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (handoff_id, handoff_version)
  ) STRICT`,
  `CREATE TABLE continuation_snapshots (
    record_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision = 1),
    value_json TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    snapshot_version INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (snapshot_id, snapshot_version)
  ) STRICT`,
] as const;

export function migrateSqliteDatabase(database: DatabaseSync): void {
  const version = readUserVersion(database);
  if (version > SQLITE_SCHEMA_VERSION) {
    throw new SqliteStorageError("MIGRATION_VERSION_UNSUPPORTED", {
      current_version: version,
      supported_version: SQLITE_SCHEMA_VERSION,
    });
  }

  if (version === SQLITE_SCHEMA_VERSION) {
    assertMigrationChecksum(database);
    return;
  }

  try {
    database.exec("BEGIN IMMEDIATE");
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT
    `);
    for (const sql of RECORD_TABLES_SQL) {
      database.exec(sql);
    }
    database.exec(`
      CREATE INDEX task_relations_source_idx
        ON task_relations(source_task_id, source_task_version, record_id);
      CREATE INDEX task_relations_target_idx
        ON task_relations(target_task_id, target_task_version, record_id);
      CREATE INDEX agent_runs_recovery_idx
        ON agent_runs(status, project_id, updated_at, run_id);
      CREATE INDEX session_bindings_run_idx
        ON agent_session_bindings(run_id, created_at, session_id);
      CREATE UNIQUE INDEX session_bindings_active_idx
        ON agent_session_bindings(run_id, role) WHERE status = 'ACTIVE';
      CREATE INDEX handoffs_source_idx
        ON handoff_packages(source_task_id, source_task_version, handoff_id, handoff_version);
      CREATE INDEX snapshots_run_idx
        ON continuation_snapshots(run_id, created_at, snapshot_id, snapshot_version);

      CREATE TABLE idempotency_requests (
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        change_id TEXT NOT NULL,
        write_fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (operation, idempotency_key)
      ) STRICT;

      CREATE TABLE domain_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        task_id TEXT,
        run_id TEXT,
        occurred_at TEXT NOT NULL,
        event_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX domain_events_task_idx ON domain_events(task_id, sequence);
      CREATE INDEX domain_events_run_idx ON domain_events(run_id, sequence);

      CREATE TABLE outbox (
        event_id TEXT PRIMARY KEY REFERENCES domain_events(event_id) ON DELETE RESTRICT,
        event_sequence INTEGER NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'published')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        last_error_code TEXT,
        published_at TEXT
      ) STRICT;
      CREATE INDEX outbox_dispatch_idx
        ON outbox(status, available_at, event_sequence);

      CREATE TABLE artifact_references (
        artifact_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_revision INTEGER NOT NULL CHECK (source_revision > 0),
        field_path TEXT NOT NULL,
        content_hash TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (source_kind, source_id, source_revision, field_path)
      ) STRICT;
      CREATE INDEX artifact_references_artifact_idx
        ON artifact_references(artifact_id, source_kind, source_id);
    `);
    database
      .prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(SQLITE_SCHEMA_VERSION, MIGRATION_NAME, MIGRATION_CHECKSUM, new Date().toISOString());
    database.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(database);
    if (error instanceof SqliteStorageError) {
      throw error;
    }
    throw new SqliteStorageError("MIGRATION_FAILED", { target_version: SQLITE_SCHEMA_VERSION });
  }
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as
    { readonly user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

function assertMigrationChecksum(database: DatabaseSync): void {
  let row: { readonly name?: string; readonly checksum?: string } | undefined;
  try {
    row = database
      .prepare("SELECT name, checksum FROM schema_migrations WHERE version = ?")
      .get(SQLITE_SCHEMA_VERSION);
  } catch {
    throw new SqliteStorageError("MIGRATION_FAILED", {
      current_version: SQLITE_SCHEMA_VERSION,
    });
  }
  if (row?.name !== MIGRATION_NAME || row.checksum !== MIGRATION_CHECKSUM) {
    throw new SqliteStorageError("MIGRATION_FAILED", {
      current_version: SQLITE_SCHEMA_VERSION,
    });
  }
}

function rollbackQuietly(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // The transaction may not have started.
  }
}
