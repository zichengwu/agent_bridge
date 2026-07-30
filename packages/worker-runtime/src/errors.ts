export const WORKER_RUNTIME_ERROR_CODES = [
  "WORKER_CONFIGURATION_INVALID",
  "PROCESS_START_FAILED",
  "PROCESS_TIMEOUT",
  "PROCESS_CANCELLED",
  "PROCESS_EXIT_FAILED",
  "PROCESS_TREE_CLEANUP_FAILED",
  "DRIVER_REQUEST_FAILED",
  "ROLE_TEMPLATE_INVALID",
  "ROLE_POLICY_DENIED",
  "PATH_TRAVERSAL",
  "PATH_SYMLINK_ESCAPE",
  "PATH_POLICY_DENIED",
  "COMMAND_POLICY_DENIED",
  "TOOL_POLICY_DENIED",
  "GIT_REPOSITORY_INVALID",
  "GIT_BASE_MISMATCH",
  "GIT_BRANCH_CONFLICT",
  "GIT_WORKTREE_CONFLICT",
  "GIT_DIFF_POLICY_VIOLATION",
  "LEASE_CONFLICT",
  "LEASE_OWNERSHIP_MISMATCH",
  "RECOVERY_STATE_INVALID",
  "RECOVERY_NOT_ALLOWED",
] as const;

export type WorkerRuntimeErrorCode = (typeof WORKER_RUNTIME_ERROR_CODES)[number];
export type WorkerRuntimeErrorDetails = Readonly<Record<string, unknown>>;

export class WorkerRuntimeError extends Error {
  readonly code: WorkerRuntimeErrorCode;
  readonly details?: WorkerRuntimeErrorDetails;

  constructor(code: WorkerRuntimeErrorCode, message: string, details?: WorkerRuntimeErrorDetails) {
    super(message);
    this.name = "WorkerRuntimeError";
    this.code = code;
    this.details = details === undefined ? undefined : Object.freeze({ ...details });
  }
}
