import type { AgentSessionBindingStatus } from "@agent-bridge/schemas";

import { CoreDomainError } from "./errors.js";

export const AGENT_SESSION_STATUSES = [
  "CREATED",
  "ACTIVE",
  "ROLLOVER_PENDING",
  "SUPERSEDED",
  "CLOSED",
  "FAILED",
] as const satisfies readonly AgentSessionBindingStatus[];

export const AGENT_SESSION_TRANSITION_EVENTS = [
  "ACTIVATE",
  "REQUEST_ROLLOVER",
  "SUPERSEDE",
  "CLOSE",
  "FAIL",
] as const;

export type AgentSessionTransitionEvent = (typeof AGENT_SESSION_TRANSITION_EVENTS)[number];

const AGENT_SESSION_TRANSITIONS: Readonly<
  Record<
    AgentSessionBindingStatus,
    Partial<Record<AgentSessionTransitionEvent, AgentSessionBindingStatus>>
  >
> = {
  CREATED: {
    ACTIVATE: "ACTIVE",
    FAIL: "FAILED",
  },
  ACTIVE: {
    REQUEST_ROLLOVER: "ROLLOVER_PENDING",
    CLOSE: "CLOSED",
    FAIL: "FAILED",
  },
  ROLLOVER_PENDING: {
    SUPERSEDE: "SUPERSEDED",
    FAIL: "FAILED",
  },
  SUPERSEDED: {},
  CLOSED: {},
  FAILED: {},
};

export const AGENT_SESSION_TERMINAL_STATUSES = [
  "SUPERSEDED",
  "CLOSED",
  "FAILED",
] as const satisfies readonly AgentSessionBindingStatus[];

export function transitionAgentSessionStatus(
  currentStatus: unknown,
  event: unknown,
): AgentSessionBindingStatus {
  if (!isAgentSessionStatus(currentStatus) || !isAgentSessionTransitionEvent(event)) {
    throw invalidTransition(currentStatus, event);
  }

  const nextStatus: AgentSessionBindingStatus | undefined =
    AGENT_SESSION_TRANSITIONS[currentStatus][event];
  if (nextStatus === undefined) {
    throw invalidTransition(currentStatus, event);
  }
  return nextStatus;
}

export function getAllowedAgentSessionTransitionEvents(
  currentStatus: unknown,
): readonly AgentSessionTransitionEvent[] {
  if (!isAgentSessionStatus(currentStatus)) {
    throw invalidTransition(currentStatus, "UNKNOWN");
  }
  return Object.freeze(
    Object.keys(AGENT_SESSION_TRANSITIONS[currentStatus]) as AgentSessionTransitionEvent[],
  );
}

export function isAgentSessionTerminalStatus(
  value: unknown,
): value is (typeof AGENT_SESSION_TERMINAL_STATUSES)[number] {
  return AGENT_SESSION_TERMINAL_STATUSES.some((status) => status === value);
}

export function canAgentSessionAcceptInput(status: unknown): boolean {
  if (!isAgentSessionStatus(status)) {
    throw invalidTransition(status, "UNKNOWN");
  }
  return status === "ACTIVE";
}

function isAgentSessionStatus(value: unknown): value is AgentSessionBindingStatus {
  return AGENT_SESSION_STATUSES.some((status) => status === value);
}

function isAgentSessionTransitionEvent(value: unknown): value is AgentSessionTransitionEvent {
  return AGENT_SESSION_TRANSITION_EVENTS.some((event) => event === value);
}

function invalidTransition(currentStatus: unknown, event: unknown): CoreDomainError {
  return new CoreDomainError("SESSION_STATE_TRANSITION_INVALID", {
    entity: "agent_session",
    current_status: isAgentSessionStatus(currentStatus) ? currentStatus : "UNKNOWN",
    transition_event: isAgentSessionTransitionEvent(event) ? event : "UNKNOWN",
  });
}
