import { parseAgentSessionBinding, type AgentSessionBinding } from "@agent-bridge/schemas";

import { CoreDomainError } from "./errors.js";
import { isAgentSessionTerminalStatus, transitionAgentSessionStatus } from "./session-lifecycle.js";

export function readAgentSessionBinding(value: unknown): AgentSessionBinding {
  let binding: AgentSessionBinding;
  try {
    binding = parseAgentSessionBinding(value);
  } catch {
    throw invalidBinding("SCHEMA_INVALID");
  }

  if (binding.predecessor_session_id === binding.session_id) {
    throw invalidBinding("SELF_PREDECESSOR");
  }

  const terminal = isAgentSessionTerminalStatus(binding.status);
  if (terminal && binding.closed_at === undefined) {
    throw invalidBinding("CLOSED_AT_REQUIRED");
  }
  if (!terminal && binding.closed_at !== undefined) {
    throw invalidBinding("CLOSED_AT_NOT_ALLOWED");
  }
  if (
    binding.closed_at !== undefined &&
    Date.parse(binding.closed_at) < Date.parse(binding.created_at)
  ) {
    throw invalidBinding("CLOSED_AT_BEFORE_CREATED");
  }

  return binding;
}

export function readAgentSessionBindingSet(value: unknown): readonly AgentSessionBinding[] {
  if (!Array.isArray(value)) {
    throw invalidBinding("BINDING_SET_INVALID");
  }

  const bindings = value.map((binding) => readAgentSessionBinding(binding));
  const bindingIds = new Set<string>();
  const sessionIds = new Set<string>();
  const externalSessionIds = new Set<string>();
  const activeRunRoles = new Set<string>();

  for (const binding of bindings) {
    if (bindingIds.has(binding.binding_id)) {
      throw invalidBinding("DUPLICATE_BINDING_ID");
    }
    if (sessionIds.has(binding.session_id)) {
      throw invalidBinding("DUPLICATE_SESSION_ID");
    }
    if (externalSessionIds.has(binding.external_session_id)) {
      throw invalidBinding("DUPLICATE_EXTERNAL_SESSION_ID");
    }

    bindingIds.add(binding.binding_id);
    sessionIds.add(binding.session_id);
    externalSessionIds.add(binding.external_session_id);

    if (binding.status === "ACTIVE") {
      const runRole = JSON.stringify([binding.run_id, binding.role]);
      if (activeRunRoles.has(runRole)) {
        throw new CoreDomainError("SESSION_ACTIVE_CONFLICT", {
          entity: "agent_session",
          reason: "MULTIPLE_ACTIVE_FOR_RUN_ROLE",
          conflict_fields: ["run_id", "role"],
        });
      }
      activeRunRoles.add(runRole);
    }
  }

  return Object.freeze(bindings);
}

export function transitionAgentSessionBinding(
  value: unknown,
  event: unknown,
  occurredAt: unknown,
  otherBindings: unknown = [],
): AgentSessionBinding {
  const binding = readAgentSessionBinding(value);
  const nextStatus = transitionAgentSessionStatus(binding.status, event);

  if (typeof occurredAt !== "string" || Date.parse(occurredAt) < Date.parse(binding.created_at)) {
    throw invalidBinding("TRANSITION_TIME_INVALID");
  }

  const peers = readAgentSessionBindingSet(otherBindings);
  if (nextStatus === "ACTIVE") {
    const conflict = peers.some(
      (peer) =>
        peer.status === "ACTIVE" && peer.run_id === binding.run_id && peer.role === binding.role,
    );
    if (conflict) {
      throw new CoreDomainError("SESSION_ACTIVE_CONFLICT", {
        entity: "agent_session",
        reason: "MULTIPLE_ACTIVE_FOR_RUN_ROLE",
        conflict_fields: ["run_id", "role"],
      });
    }
  }

  const nextBinding = {
    ...binding,
    status: nextStatus,
    ...(isAgentSessionTerminalStatus(nextStatus) ? { closed_at: occurredAt } : {}),
  };
  return readAgentSessionBinding(nextBinding);
}

export function assertAgentSessionCanAcceptInput(value: unknown): AgentSessionBinding {
  const binding = readAgentSessionBinding(value);
  if (binding.status !== "ACTIVE") {
    throw new CoreDomainError("SESSION_NOT_RESUMABLE", {
      entity: "agent_session",
      reason: "SESSION_NOT_ACTIVE",
      current_status: binding.status,
    });
  }
  return binding;
}

function invalidBinding(reason: string): CoreDomainError {
  return new CoreDomainError("SESSION_BINDING_INVALID", {
    entity: "agent_session",
    reason,
  });
}
