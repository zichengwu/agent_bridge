import type { DomainJsonValue } from "@agent-bridge/schemas";

export const CORE_DOMAIN_ERROR_CODES = [
  "TASK_INVALID",
  "TASK_STATE_TRANSITION_INVALID",
  "AGENT_RUN_STATE_TRANSITION_INVALID",
  "SESSION_STATE_TRANSITION_INVALID",
  "SESSION_SCOPE_CONFLICT",
  "SESSION_BINDING_INVALID",
  "SESSION_ACTIVE_CONFLICT",
  "SESSION_CURRENT_MISSING",
  "SESSION_NOT_RESUMABLE",
  "SESSION_SELECTION_INVALID",
  "CONTEXT_PACKAGE_INVALID",
  "CONTEXT_CONTENT_FORBIDDEN",
  "HANDOFF_INTEGRITY_ERROR",
  "STALE_HANDOFF",
  "ROLLOVER_NOT_REQUIRED",
  "ROLLOVER_UNSAFE_BOUNDARY",
  "ROLLOVER_PLAN_INVALID",
  "ROLLOVER_FAILED",
  "AUDIT_ENVELOPE_INVALID",
  "DOMAIN_EVENT_INVALID",
  "REPOSITORY_WRITE_INVALID",
  "REPOSITORY_WRITE_CONFLICT",
  "REPOSITORY_IDEMPOTENCY_CONFLICT",
  "REPOSITORY_QUERY_INVALID",
  "APPROVAL_INVALID",
  "APPROVAL_STALE",
  "REVIEW_CYCLE_INVALID",
  "REVIEW_LIMIT_REACHED",
  "REVIEW_SCOPE_CONFLICT",
] as const;

export type CoreDomainErrorCode = (typeof CORE_DOMAIN_ERROR_CODES)[number];
export type CoreDomainErrorDetails = Readonly<Record<string, DomainJsonValue>>;

const ERROR_MESSAGES = {
  TASK_INVALID: "Task is invalid",
  TASK_STATE_TRANSITION_INVALID: "Task state transition is not allowed",
  AGENT_RUN_STATE_TRANSITION_INVALID: "Agent run state transition is not allowed",
  SESSION_STATE_TRANSITION_INVALID: "Session state transition is not allowed",
  SESSION_SCOPE_CONFLICT: "Session scope does not match the requested scope",
  SESSION_BINDING_INVALID: "Session binding is invalid",
  SESSION_ACTIVE_CONFLICT: "More than one active session exists for the run and role",
  SESSION_CURRENT_MISSING: "The authoritative current session is missing",
  SESSION_NOT_RESUMABLE: "The current session cannot receive input",
  SESSION_SELECTION_INVALID: "Session selection request is invalid",
  CONTEXT_PACKAGE_INVALID: "Context package is invalid",
  CONTEXT_CONTENT_FORBIDDEN: "Context content is forbidden",
  HANDOFF_INTEGRITY_ERROR: "Handoff integrity validation failed",
  STALE_HANDOFF: "Required handoff is stale for the target base commit",
  ROLLOVER_NOT_REQUIRED: "Session rollover is not required",
  ROLLOVER_UNSAFE_BOUNDARY: "Session rollover requires a safe boundary",
  ROLLOVER_PLAN_INVALID: "Session rollover plan is invalid",
  ROLLOVER_FAILED: "Session rollover failed",
  AUDIT_ENVELOPE_INVALID: "Audit envelope is invalid",
  DOMAIN_EVENT_INVALID: "Authoritative domain event is invalid",
  REPOSITORY_WRITE_INVALID: "Repository write request is invalid",
  REPOSITORY_WRITE_CONFLICT: "Repository write conflicts with authoritative state",
  REPOSITORY_IDEMPOTENCY_CONFLICT: "Repository idempotency key conflicts with an earlier request",
  REPOSITORY_QUERY_INVALID: "Repository query is invalid",
  APPROVAL_INVALID: "Approval request is invalid",
  APPROVAL_STALE: "Approval request is stale or already decided",
  REVIEW_CYCLE_INVALID: "Review cycle is invalid",
  REVIEW_LIMIT_REACHED: "Review cycle limit has been reached",
  REVIEW_SCOPE_CONFLICT: "Review feedback does not match the current task scope",
} as const satisfies Readonly<Record<CoreDomainErrorCode, string>>;

export class CoreDomainError extends Error {
  readonly code: CoreDomainErrorCode;
  readonly details: CoreDomainErrorDetails;

  constructor(code: CoreDomainErrorCode, details: CoreDomainErrorDetails) {
    super(ERROR_MESSAGES[code]);
    this.name = "CoreDomainError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
