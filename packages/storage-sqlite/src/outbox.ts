import type { DatabaseSync } from "node:sqlite";

import { readAuthoritativeDomainEvent, type AuthoritativeDomainEvent } from "@agent-bridge/core";

import { SqliteStorageError } from "./errors.js";

export interface OutboxDispatcherOptions {
  readonly dispatcher_id: string;
  readonly lease_duration_ms?: number;
  readonly retry_delay_ms?: number;
  readonly now?: () => Date;
  readonly token?: () => string;
}

export interface OutboxDelivery {
  readonly event_id: string;
  readonly event_cursor: string;
  readonly attempt: number;
  readonly event: AuthoritativeDomainEvent;
}

export type OutboxPublisher = (delivery: OutboxDelivery) => Promise<void>;

export type OutboxDispatchResult =
  | {
      readonly outcome: "IDLE";
      readonly reason: "EMPTY" | "WAITING_RETRY" | "LEASED";
    }
  | {
      readonly outcome: "PUBLISHED";
      readonly event_id: string;
      readonly attempt: number;
    }
  | {
      readonly outcome: "FAILED";
      readonly event_id: string;
      readonly attempt: number;
      readonly retry_at: string;
    };

export interface OutboxEntry {
  readonly event_id: string;
  readonly event_sequence: number;
  readonly status: "pending" | "delivering" | "published";
  readonly attempt_count: number;
  readonly available_at: string;
  readonly lease_owner?: string;
  readonly lease_expires_at?: string;
  readonly last_error_code?: string;
  readonly published_at?: string;
}

interface OutboxCandidateRow {
  readonly event_id: string;
  readonly event_sequence: number;
  readonly status: "pending" | "delivering" | "published";
  readonly attempt_count: number;
  readonly available_at: string;
  readonly lease_owner: string | null;
  readonly lease_token: string | null;
  readonly lease_expires_at: string | null;
  readonly last_error_code: string | null;
  readonly published_at: string | null;
  readonly event_json: string;
}

interface ClaimedOutboxRow extends Omit<
  OutboxCandidateRow,
  "status" | "lease_owner" | "lease_token" | "lease_expires_at"
> {
  readonly status: "delivering";
  readonly lease_owner: string;
  readonly lease_token: string;
  readonly lease_expires_at: string;
}

interface OutboxEntryRow {
  readonly event_id: string;
  readonly event_sequence: number;
  readonly status: OutboxEntry["status"];
  readonly attempt_count: number;
  readonly available_at: string;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly last_error_code: string | null;
  readonly published_at: string | null;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

export class SqliteOutboxDispatcher {
  private readonly dispatcherId: string;
  private readonly leaseDurationMs: number;
  private readonly retryDelayMs: number;
  private readonly now: () => Date;
  private readonly token: () => string;

  constructor(
    private readonly database: DatabaseSync,
    options: OutboxDispatcherOptions,
  ) {
    if (
      typeof options !== "object" ||
      options === null ||
      !IDENTIFIER_PATTERN.test(options.dispatcher_id) ||
      !isPositiveDuration(options.lease_duration_ms, DEFAULT_LEASE_DURATION_MS) ||
      !isPositiveDuration(options.retry_delay_ms, DEFAULT_RETRY_DELAY_MS) ||
      (options.now !== undefined && typeof options.now !== "function") ||
      (options.token !== undefined && typeof options.token !== "function")
    ) {
      throw new SqliteStorageError("OUTBOX_REQUEST_INVALID");
    }
    this.dispatcherId = options.dispatcher_id;
    this.leaseDurationMs = options.lease_duration_ms ?? DEFAULT_LEASE_DURATION_MS;
    this.retryDelayMs = options.retry_delay_ms ?? DEFAULT_RETRY_DELAY_MS;
    this.now = options.now ?? (() => new Date());
    this.token =
      options.token ??
      (() => `${this.dispatcherId}:${Date.now()}:${Math.random().toString(16).slice(2)}`);
  }

  async dispatchNext(publish: OutboxPublisher): Promise<OutboxDispatchResult> {
    if (typeof publish !== "function") {
      throw new SqliteStorageError("OUTBOX_REQUEST_INVALID");
    }
    const claim = this.claimNext();
    if ("reason" in claim) {
      return claim;
    }

    let event: AuthoritativeDomainEvent;
    try {
      event = readAuthoritativeDomainEvent(JSON.parse(claim.event_json));
    } catch {
      const retryAt = this.failClaim(claim, "EVENT_CORRUPT");
      return Object.freeze({
        outcome: "FAILED",
        event_id: claim.event_id,
        attempt: claim.attempt_count,
        retry_at: retryAt,
      });
    }

    try {
      await publish(
        Object.freeze({
          event_id: claim.event_id,
          event_cursor: `event-cursor:${claim.event_sequence}`,
          attempt: claim.attempt_count,
          event,
        }),
      );
    } catch {
      const retryAt = this.failClaim(claim, "CONSUMER_FAILED");
      return Object.freeze({
        outcome: "FAILED",
        event_id: claim.event_id,
        attempt: claim.attempt_count,
        retry_at: retryAt,
      });
    }

    this.completeClaim(claim);
    return Object.freeze({
      outcome: "PUBLISHED",
      event_id: claim.event_id,
      attempt: claim.attempt_count,
    });
  }

  requeuePublished(eventIds: readonly string[]): number {
    if (
      eventIds.length === 0 ||
      new Set(eventIds).size !== eventIds.length ||
      eventIds.some((eventId) => !IDENTIFIER_PATTERN.test(eventId))
    ) {
      throw new SqliteStorageError("OUTBOX_REQUEST_INVALID");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      let changed = 0;
      const statement = this.database.prepare(
        `UPDATE outbox
         SET status = 'pending', available_at = ?, lease_owner = NULL,
             lease_token = NULL, lease_expires_at = NULL,
             last_error_code = NULL, published_at = NULL
         WHERE event_id = ? AND status = 'published'`,
      );
      const now = this.now().toISOString();
      for (const eventId of eventIds) {
        changed += Number(statement.run(now, eventId).changes);
      }
      this.database.exec("COMMIT");
      return changed;
    } catch {
      rollbackQuietly(this.database);
      throw new SqliteStorageError("OUTBOX_DELIVERY_FAILED");
    }
  }

  listEntries(): readonly OutboxEntry[] {
    const rows = this.database
      .prepare(
        `SELECT event_id, event_sequence, status, attempt_count, available_at,
                lease_owner, lease_expires_at, last_error_code, published_at
         FROM outbox ORDER BY event_sequence`,
      )
      .all() as unknown as OutboxEntryRow[];
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          event_id: row.event_id,
          event_sequence: row.event_sequence,
          status: row.status,
          attempt_count: row.attempt_count,
          available_at: row.available_at,
          ...(row.lease_owner === null ? {} : { lease_owner: row.lease_owner }),
          ...(row.lease_expires_at === null ? {} : { lease_expires_at: row.lease_expires_at }),
          ...(row.last_error_code === null ? {} : { last_error_code: row.last_error_code }),
          ...(row.published_at === null ? {} : { published_at: row.published_at }),
        }),
      ),
    );
  }

  private claimNext():
    | ClaimedOutboxRow
    | { readonly outcome: "IDLE"; readonly reason: "EMPTY" | "WAITING_RETRY" | "LEASED" } {
    const now = this.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.database
        .prepare(
          `SELECT o.event_id, o.event_sequence, o.status, o.attempt_count, o.available_at,
                  o.lease_owner, o.lease_token, o.lease_expires_at, o.last_error_code,
                  o.published_at, e.event_json
           FROM outbox o
           JOIN domain_events e ON e.event_id = o.event_id
           WHERE o.status != 'published'
           ORDER BY o.event_sequence LIMIT 1`,
        )
        .get() as OutboxCandidateRow | undefined;
      if (candidate === undefined) {
        this.database.exec("COMMIT");
        return Object.freeze({ outcome: "IDLE", reason: "EMPTY" });
      }
      if (
        candidate.status === "delivering" &&
        candidate.lease_expires_at !== null &&
        Date.parse(candidate.lease_expires_at) > now.getTime()
      ) {
        this.database.exec("COMMIT");
        return Object.freeze({ outcome: "IDLE", reason: "LEASED" });
      }
      if (candidate.status === "pending" && Date.parse(candidate.available_at) > now.getTime()) {
        this.database.exec("COMMIT");
        return Object.freeze({ outcome: "IDLE", reason: "WAITING_RETRY" });
      }

      const leaseToken = this.token();
      if (!IDENTIFIER_PATTERN.test(leaseToken)) {
        throw new SqliteStorageError("OUTBOX_REQUEST_INVALID");
      }
      const attempt = candidate.attempt_count + 1;
      const leaseExpiresAt = new Date(now.getTime() + this.leaseDurationMs).toISOString();
      this.database
        .prepare(
          `UPDATE outbox
           SET status = 'delivering', attempt_count = ?, lease_owner = ?,
               lease_token = ?, lease_expires_at = ?, last_error_code = NULL
           WHERE event_id = ?`,
        )
        .run(attempt, this.dispatcherId, leaseToken, leaseExpiresAt, candidate.event_id);
      this.database.exec("COMMIT");
      return Object.freeze({
        ...candidate,
        status: "delivering",
        attempt_count: attempt,
        lease_owner: this.dispatcherId,
        lease_token: leaseToken,
        lease_expires_at: leaseExpiresAt,
      });
    } catch (error) {
      rollbackQuietly(this.database);
      if (error instanceof SqliteStorageError) {
        throw error;
      }
      throw new SqliteStorageError("OUTBOX_DELIVERY_FAILED");
    }
  }

  private completeClaim(claim: ClaimedOutboxRow): void {
    const result = this.database
      .prepare(
        `UPDATE outbox
         SET status = 'published', published_at = ?, lease_owner = NULL,
             lease_token = NULL, lease_expires_at = NULL, last_error_code = NULL
         WHERE event_id = ? AND status = 'delivering'
           AND lease_owner = ? AND lease_token = ?`,
      )
      .run(this.now().toISOString(), claim.event_id, this.dispatcherId, claim.lease_token);
    if (Number(result.changes) !== 1) {
      throw new SqliteStorageError("OUTBOX_LEASE_CONFLICT");
    }
  }

  private failClaim(claim: ClaimedOutboxRow, errorCode: string): string {
    const retryAt = new Date(this.now().getTime() + this.retryDelayMs).toISOString();
    const result = this.database
      .prepare(
        `UPDATE outbox
         SET status = 'pending', available_at = ?, lease_owner = NULL,
             lease_token = NULL, lease_expires_at = NULL, last_error_code = ?
         WHERE event_id = ? AND status = 'delivering'
           AND lease_owner = ? AND lease_token = ?`,
      )
      .run(retryAt, errorCode, claim.event_id, this.dispatcherId, claim.lease_token);
    if (Number(result.changes) !== 1) {
      throw new SqliteStorageError("OUTBOX_LEASE_CONFLICT");
    }
    return retryAt;
  }
}

function isPositiveDuration(value: unknown, fallback: number): boolean {
  const candidate = value ?? fallback;
  return (
    typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate > 0 &&
    candidate <= 86_400_000
  );
}

function rollbackQuietly(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
