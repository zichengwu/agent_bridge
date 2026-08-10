import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { SQLITE_SCHEMA_VERSION, SqliteDomainRepository, SqliteStorageError } from "../src/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("SQLite migration", () => {
  it("upgrades an existing verified v1 database through v3 without rewriting old metadata", async () => {
    const path = await databasePath();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations(version, name, checksum, applied_at)
      VALUES (1, 'phase_2f_initial', 'phase-2f-v1-2026-07-31', '2026-07-31T00:00:00.000Z');
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const repository = new SqliteDomainRepository({ database_path: path });
    repository.close();
    const upgraded = new DatabaseSync(path);
    expect(
      (upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(3);
    expect(
      upgraded.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    ).toEqual([
      { version: 1, name: "phase_2f_initial" },
      { version: 2, name: "phase_3_control_records" },
      { version: 3, name: "phase_4_runtime_leases" },
    ]);
    expect(
      upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_cycles'")
        .get(),
    ).toEqual({ name: "review_cycles" });
    upgraded.close();
  });

  it("creates versioned schema once and reopens without rewriting it", async () => {
    const path = await databasePath();
    const first = new SqliteDomainRepository({ database_path: path });
    first.close();
    const second = new SqliteDomainRepository({ database_path: path });
    second.close();

    const database = new DatabaseSync(path);
    const version = database.prepare("PRAGMA user_version").get() as { user_version: number };
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    database.close();

    expect(version.user_version).toBe(SQLITE_SCHEMA_VERSION);
    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "agent_runs",
        "artifact_references",
        "approval_requests",
        "control_invocations",
        "domain_events",
        "outbox",
        "project_baselines",
        "review_cycles",
        "runtime_leases",
        "runtime_lease_resources",
        "schema_migrations",
        "tasks",
      ]),
    );
  });

  it("rejects a future schema version without changing the database", async () => {
    const path = await databasePath();
    const database = new DatabaseSync(path);
    database.exec("PRAGMA user_version = 99");
    database.close();

    expect(() => new SqliteDomainRepository({ database_path: path })).toThrowError(
      expect.objectContaining<Partial<SqliteStorageError>>({
        code: "MIGRATION_VERSION_UNSUPPORTED",
      }),
    );

    const check = new DatabaseSync(path);
    expect(
      (check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(99);
    check.close();
  });

  it("fails closed when migration metadata is missing or drifted", async () => {
    const path = await databasePath();
    const repository = new SqliteDomainRepository({ database_path: path });
    repository.close();
    const database = new DatabaseSync(path);
    database.exec("UPDATE schema_migrations SET checksum = 'changed'");
    database.close();

    expect(() => new SqliteDomainRepository({ database_path: path })).toThrowError(
      expect.objectContaining<Partial<SqliteStorageError>>({ code: "MIGRATION_FAILED" }),
    );
  });
});

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-sqlite-migration-"));
  temporaryRoots.push(root);
  return join(root, "bridge.sqlite");
}
