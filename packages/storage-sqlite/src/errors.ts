export const SQLITE_STORAGE_ERROR_CODES = [
  "SQLITE_UNAVAILABLE",
  "DATABASE_OPEN_FAILED",
  "DATABASE_CLOSED",
  "DATABASE_BUSY",
  "DATABASE_CORRUPT",
  "MIGRATION_FAILED",
  "MIGRATION_VERSION_UNSUPPORTED",
  "OUTBOX_REQUEST_INVALID",
  "OUTBOX_LEASE_CONFLICT",
  "OUTBOX_DELIVERY_FAILED",
  "LEASE_CONFLICT",
  "LEASE_OWNERSHIP_MISMATCH",
] as const;

export type SqliteStorageErrorCode = (typeof SQLITE_STORAGE_ERROR_CODES)[number];

export class SqliteStorageError extends Error {
  readonly code: SqliteStorageErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: SqliteStorageErrorCode,
    details: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(messageFor(code));
    this.name = "SqliteStorageError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function messageFor(code: SqliteStorageErrorCode): string {
  switch (code) {
    case "SQLITE_UNAVAILABLE":
      return "The current Node.js runtime does not provide the required SQLite capability";
    case "DATABASE_OPEN_FAILED":
      return "The SQLite database could not be opened";
    case "DATABASE_CLOSED":
      return "The SQLite database is closed";
    case "DATABASE_BUSY":
      return "The SQLite database is busy";
    case "DATABASE_CORRUPT":
      return "The SQLite database is corrupt";
    case "MIGRATION_FAILED":
      return "The SQLite schema migration failed";
    case "MIGRATION_VERSION_UNSUPPORTED":
      return "The SQLite schema version is not supported";
    case "OUTBOX_REQUEST_INVALID":
      return "The Outbox request is invalid";
    case "OUTBOX_LEASE_CONFLICT":
      return "The Outbox lease is not owned by this dispatcher";
    case "OUTBOX_DELIVERY_FAILED":
      return "The Outbox delivery failed";
    case "LEASE_CONFLICT":
      return "The runtime write lease conflicts with an active owner";
    case "LEASE_OWNERSHIP_MISMATCH":
      return "The runtime write lease is not owned by the requested owner";
  }
}
