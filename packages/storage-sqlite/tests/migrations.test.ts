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
        "domain_events",
        "outbox",
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
