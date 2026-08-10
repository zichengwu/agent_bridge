import type { DatabaseSync } from "node:sqlite";

import { SqliteStorageError } from "./errors.js";

export interface SqliteLeaseAcquireRequest {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly resources: readonly string[];
  readonly ttlMs: number;
}

export interface SqliteLeaseRecord {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly resources: readonly string[];
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface SqliteLeaseManagerOptions {
  readonly now?: () => Date;
}

interface LeaseRow {
  readonly lease_id: string;
  readonly owner_id: string;
  readonly acquired_at: string;
  readonly expires_at: string;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class SqliteLeaseManager {
  private readonly now: () => Date;

  constructor(
    private readonly database: DatabaseSync,
    options: SqliteLeaseManagerOptions = {},
  ) {
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new SqliteStorageError("OUTBOX_REQUEST_INVALID");
    }
    this.now = options.now ?? (() => new Date());
  }

  acquire(value: SqliteLeaseAcquireRequest): SqliteLeaseRecord {
    const request = readAcquireRequest(value);
    const now = this.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.pruneExpired(now);
      const existing = this.readLease(request.leaseId);
      if (existing !== undefined) {
        if (
          existing.ownerId === request.ownerId &&
          sameResources(existing.resources, request.resources)
        ) {
          this.database.exec("COMMIT");
          return existing;
        }
        throw new SqliteStorageError("LEASE_CONFLICT", { reason: "LEASE_ID_CONFLICT" });
      }
      const resourceConflict = this.database
        .prepare(
          `SELECT resource FROM runtime_lease_resources
           WHERE resource IN (${request.resources.map(() => "?").join(", ")})
           ORDER BY resource LIMIT 1`,
        )
        .get(...request.resources) as { readonly resource: string } | undefined;
      if (resourceConflict !== undefined) {
        throw new SqliteStorageError("LEASE_CONFLICT", {
          reason: "RESOURCE_ALREADY_LEASED",
          resource: resourceConflict.resource,
        });
      }
      const acquiredAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + request.ttlMs).toISOString();
      this.database
        .prepare(
          `INSERT INTO runtime_leases(lease_id, owner_id, acquired_at, expires_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(request.leaseId, request.ownerId, acquiredAt, expiresAt);
      const resourceStatement = this.database.prepare(
        `INSERT INTO runtime_lease_resources(resource, lease_id) VALUES (?, ?)`,
      );
      for (const resource of request.resources) {
        resourceStatement.run(resource, request.leaseId);
      }
      this.database.exec("COMMIT");
      return freezeLease({
        leaseId: request.leaseId,
        ownerId: request.ownerId,
        resources: request.resources,
        acquiredAt,
        expiresAt,
      });
    } catch (error) {
      rollbackQuietly(this.database);
      if (error instanceof SqliteStorageError) throw error;
      throw new SqliteStorageError("DATABASE_BUSY");
    }
  }

  renew(leaseId: string, ownerId: string, ttlMs: number): SqliteLeaseRecord {
    assertIdentifier(leaseId);
    assertIdentifier(ownerId);
    assertTtl(ttlMs);
    const now = this.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.pruneExpired(now);
      const current = this.readLease(leaseId);
      if (current === undefined || current.ownerId !== ownerId) {
        throw new SqliteStorageError("LEASE_OWNERSHIP_MISMATCH");
      }
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      this.database
        .prepare("UPDATE runtime_leases SET expires_at = ? WHERE lease_id = ? AND owner_id = ?")
        .run(expiresAt, leaseId, ownerId);
      this.database.exec("COMMIT");
      return freezeLease({ ...current, expiresAt });
    } catch (error) {
      rollbackQuietly(this.database);
      if (error instanceof SqliteStorageError) throw error;
      throw new SqliteStorageError("DATABASE_BUSY");
    }
  }

  release(leaseId: string, ownerId: string): void {
    assertIdentifier(leaseId);
    assertIdentifier(ownerId);
    const now = this.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.pruneExpired(now);
      const current = this.readLease(leaseId);
      if (current === undefined) {
        this.database.exec("COMMIT");
        return;
      }
      if (current.ownerId !== ownerId) {
        throw new SqliteStorageError("LEASE_OWNERSHIP_MISMATCH");
      }
      this.database.prepare("DELETE FROM runtime_leases WHERE lease_id = ?").run(leaseId);
      this.database.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(this.database);
      if (error instanceof SqliteStorageError) throw error;
      throw new SqliteStorageError("DATABASE_BUSY");
    }
  }

  getByResource(resource: string): SqliteLeaseRecord | undefined {
    assertResource(resource);
    const now = this.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.pruneExpired(now);
      const row = this.database
        .prepare(
          `SELECT l.lease_id, l.owner_id, l.acquired_at, l.expires_at
           FROM runtime_lease_resources r
           JOIN runtime_leases l ON l.lease_id = r.lease_id
           WHERE r.resource = ?`,
        )
        .get(resource) as LeaseRow | undefined;
      const result = row === undefined ? undefined : this.decodeLease(row);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackQuietly(this.database);
      if (error instanceof SqliteStorageError) throw error;
      throw new SqliteStorageError("DATABASE_BUSY");
    }
  }

  snapshot(): readonly SqliteLeaseRecord[] {
    const now = this.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.pruneExpired(now);
      const rows = this.database
        .prepare(
          `SELECT lease_id, owner_id, acquired_at, expires_at
           FROM runtime_leases ORDER BY lease_id`,
        )
        .all() as unknown as LeaseRow[];
      const leases = Object.freeze(rows.map((row) => this.decodeLease(row)));
      this.database.exec("COMMIT");
      return leases;
    } catch (error) {
      rollbackQuietly(this.database);
      if (error instanceof SqliteStorageError) throw error;
      throw new SqliteStorageError("DATABASE_BUSY");
    }
  }

  private readLease(leaseId: string): SqliteLeaseRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT lease_id, owner_id, acquired_at, expires_at
         FROM runtime_leases WHERE lease_id = ?`,
      )
      .get(leaseId) as LeaseRow | undefined;
    return row === undefined ? undefined : this.decodeLease(row);
  }

  private decodeLease(row: LeaseRow): SqliteLeaseRecord {
    const resources = this.database
      .prepare(
        `SELECT resource FROM runtime_lease_resources
         WHERE lease_id = ? ORDER BY resource`,
      )
      .all(row.lease_id) as unknown as Array<{ readonly resource: string }>;
    return freezeLease({
      leaseId: row.lease_id,
      ownerId: row.owner_id,
      resources: resources.map((item) => item.resource),
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
    });
  }

  private pruneExpired(now: Date): void {
    this.database
      .prepare("DELETE FROM runtime_leases WHERE expires_at <= ?")
      .run(now.toISOString());
  }
}

function readAcquireRequest(value: SqliteLeaseAcquireRequest): SqliteLeaseAcquireRequest {
  assertIdentifier(value.leaseId);
  assertIdentifier(value.ownerId);
  assertTtl(value.ttlMs);
  if (
    !Array.isArray(value.resources) ||
    value.resources.length === 0 ||
    value.resources.some((resource) => !isResource(resource)) ||
    new Set(value.resources).size !== value.resources.length
  ) {
    throw new SqliteStorageError("OUTBOX_REQUEST_INVALID");
  }
  const resources = value.resources as readonly string[];
  return Object.freeze({
    ...value,
    resources: Object.freeze([...resources].sort()),
  });
}

function freezeLease(value: SqliteLeaseRecord): SqliteLeaseRecord {
  return Object.freeze({ ...value, resources: Object.freeze([...value.resources]) });
}

function sameResources(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new SqliteStorageError("OUTBOX_REQUEST_INVALID");
  }
}

function assertResource(value: unknown): asserts value is string {
  if (!isResource(value)) throw new SqliteStorageError("OUTBOX_REQUEST_INVALID");
}

function isResource(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0")
  );
}

function assertTtl(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new SqliteStorageError("OUTBOX_REQUEST_INVALID");
  }
}

function rollbackQuietly(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
