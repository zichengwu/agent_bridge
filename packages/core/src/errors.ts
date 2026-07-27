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
