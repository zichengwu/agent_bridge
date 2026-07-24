import type { DomainSchemaKind } from "./constants.js";

export const DOMAIN_SCHEMA_ERROR_CODES = [
  "DOMAIN_SCHEMA_INVALID",
  "DOMAIN_SCHEMA_VERSION_UNSUPPORTED",
] as const;

export type DomainSchemaErrorCode = (typeof DOMAIN_SCHEMA_ERROR_CODES)[number];

export interface DomainSchemaIssue {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

export interface DomainSchemaErrorDetails {
  readonly schema_kind: DomainSchemaKind;
  readonly schema_id: string;
  readonly expected_version: string;
  readonly received_version?: unknown;
  readonly issues?: readonly DomainSchemaIssue[];
}

export class DomainSchemaError extends Error {
  readonly code: DomainSchemaErrorCode;
  readonly details: DomainSchemaErrorDetails;

  constructor(code: DomainSchemaErrorCode, message: string, details: DomainSchemaErrorDetails) {
    super(message);
    this.name = "DomainSchemaError";
    this.code = code;
    this.details = details;
  }
}
