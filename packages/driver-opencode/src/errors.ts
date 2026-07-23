export const OPENCODE_DRIVER_ERROR_CODES = [
  "OPENCODE_RUNTIME_ERROR",
  "OPENCODE_PREPARED_TASK_NOT_FOUND",
  "OPENCODE_RUN_NOT_FOUND",
  "OPENCODE_SESSION_MISMATCH",
  "OPENCODE_SESSION_NOT_FOUND",
  "OPENCODE_PERMISSION_MISMATCH",
  "OPENCODE_SUCCESSOR_NOT_SAFE",
  "OPENCODE_RUN_TERMINAL",
  "OPENCODE_RESULT_NOT_READY",
] as const;

export type OpenCodeDriverErrorCode = (typeof OPENCODE_DRIVER_ERROR_CODES)[number];

export class OpenCodeDriverError extends Error {
  readonly code: OpenCodeDriverErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: OpenCodeDriverErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "OpenCodeDriverError";
    this.code = code;
    this.details = details;
  }
}
