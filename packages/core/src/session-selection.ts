import type { AgentRole, AgentSessionBinding } from "@agent-bridge/schemas";

import { CoreDomainError } from "./errors.js";
import { assertAgentSessionCanAcceptInput, readAgentSessionBindingSet } from "./session-binding.js";

export const SESSION_SELECTION_REASONS = [
  "NEW_TASK",
  "NEW_TASK_VERSION",
  "SAME_VERSION_REWORK",
  "MANUAL_RETRY",
] as const;

export type SessionSelectionReason = (typeof SESSION_SELECTION_REASONS)[number];

export interface SessionScope {
  readonly task_id: string;
  readonly task_version: number;
  readonly run_id: string;
  readonly driver_id: string;
  readonly role: AgentRole;
}

export interface SessionSelectionRequest {
  readonly reason: SessionSelectionReason;
  readonly target: SessionScope;
  readonly bindings: readonly AgentSessionBinding[];
  readonly current_session_id?: string;
  readonly previous_run_id?: string;
}

export type SessionSelectionDecision =
  | {
      readonly action: "CREATE_NEW";
      readonly reason: "NEW_TASK" | "NEW_TASK_VERSION" | "MANUAL_RETRY";
    }
  | {
      readonly action: "REUSE_CURRENT";
      readonly reason: "SAME_VERSION_REWORK";
      readonly binding: AgentSessionBinding;
    };

const AGENT_ROLES = [
  "coordinator",
  "developer",
  "tester",
  "reviewer",
  "docs",
  "research",
] as const satisfies readonly AgentRole[];

const SCOPE_FIELDS = [
  "task_id",
  "task_version",
  "run_id",
  "driver_id",
  "role",
] as const satisfies readonly (keyof SessionScope)[];

export function selectAgentSession(value: unknown): SessionSelectionDecision {
  const request = readSelectionRequest(value);
  const bindings = readAgentSessionBindingSet(request.bindings);

  switch (request.reason) {
    case "NEW_TASK":
    case "NEW_TASK_VERSION":
      rejectRequestedReuse(request.current_session_id);
      return Object.freeze({
        action: "CREATE_NEW",
        reason: request.reason,
      });

    case "MANUAL_RETRY":
      rejectRequestedReuse(request.current_session_id);
      if (request.previous_run_id === undefined || request.previous_run_id.length === 0) {
        throw invalidSelection("PREVIOUS_RUN_REQUIRED");
      }
      if (request.previous_run_id === request.target.run_id) {
        throw invalidSelection("MANUAL_RETRY_REQUIRES_NEW_RUN");
      }
      return Object.freeze({
        action: "CREATE_NEW",
        reason: "MANUAL_RETRY",
      });

    case "SAME_VERSION_REWORK": {
      if (request.current_session_id === undefined || request.current_session_id.length === 0) {
        throw new CoreDomainError("SESSION_CURRENT_MISSING", {
          entity: "agent_session",
          reason: "CURRENT_SESSION_ID_REQUIRED",
        });
      }

      const current = bindings.find((binding) => binding.session_id === request.current_session_id);
      if (current === undefined) {
        throw new CoreDomainError("SESSION_CURRENT_MISSING", {
          entity: "agent_session",
          reason: "CURRENT_SESSION_BINDING_NOT_FOUND",
        });
      }

      const conflictFields = SCOPE_FIELDS.filter(
        (field) => current[field] !== request.target[field],
      );
      if (conflictFields.length > 0) {
        throw new CoreDomainError("SESSION_SCOPE_CONFLICT", {
          entity: "agent_session",
          reason: "BOUND_SCOPE_MISMATCH",
          conflict_fields: conflictFields,
        });
      }

      return Object.freeze({
        action: "REUSE_CURRENT",
        reason: "SAME_VERSION_REWORK",
        binding: assertAgentSessionCanAcceptInput(current),
      });
    }
  }
}

function readSelectionRequest(value: unknown): SessionSelectionRequest {
  if (!isPlainRecord(value) || !isSelectionReason(value.reason)) {
    throw invalidSelection("SELECTION_REASON_INVALID");
  }
  if (!isSessionScope(value.target)) {
    throw invalidSelection("TARGET_SCOPE_INVALID");
  }
  if (!Array.isArray(value.bindings)) {
    throw invalidSelection("BINDINGS_INVALID");
  }
  if (
    value.current_session_id !== undefined &&
    (typeof value.current_session_id !== "string" || value.current_session_id.length === 0)
  ) {
    throw invalidSelection("CURRENT_SESSION_ID_INVALID");
  }
  if (
    value.previous_run_id !== undefined &&
    (typeof value.previous_run_id !== "string" || value.previous_run_id.length === 0)
  ) {
    throw invalidSelection("PREVIOUS_RUN_ID_INVALID");
  }

  return {
    reason: value.reason,
    target: value.target,
    bindings: value.bindings,
    ...(value.current_session_id === undefined
      ? {}
      : { current_session_id: value.current_session_id }),
    ...(value.previous_run_id === undefined ? {} : { previous_run_id: value.previous_run_id }),
  };
}

function isSessionScope(value: unknown): value is SessionScope {
  return (
    isPlainRecord(value) &&
    typeof value.task_id === "string" &&
    value.task_id.length > 0 &&
    Number.isInteger(value.task_version) &&
    typeof value.task_version === "number" &&
    value.task_version > 0 &&
    typeof value.run_id === "string" &&
    value.run_id.length > 0 &&
    typeof value.driver_id === "string" &&
    value.driver_id.length > 0 &&
    AGENT_ROLES.some((role) => role === value.role)
  );
}

function isSelectionReason(value: unknown): value is SessionSelectionReason {
  return SESSION_SELECTION_REASONS.some((reason) => reason === value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectRequestedReuse(currentSessionId: string | undefined): void {
  if (currentSessionId !== undefined) {
    throw new CoreDomainError("SESSION_SCOPE_CONFLICT", {
      entity: "agent_session",
      reason: "NEW_SESSION_REQUIRED",
    });
  }
}

function invalidSelection(reason: string): CoreDomainError {
  return new CoreDomainError("SESSION_SELECTION_INVALID", {
    entity: "agent_session",
    reason,
  });
}
