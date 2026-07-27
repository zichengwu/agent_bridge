import { CoreDomainError } from "./errors.js";

export const AGENT_RUN_STATUSES = [
  "created",
  "running",
  "waiting_permission",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const AGENT_RUN_TRANSITION_EVENTS = [
  "START",
  "WAIT_FOR_PERMISSION",
  "RESUME",
  "REQUEST_CANCELLATION",
  "SUCCEED",
  "FAIL",
  "CONFIRM_CANCELLED",
  "INTERRUPT",
] as const;

export type AgentRunTransitionEvent = (typeof AGENT_RUN_TRANSITION_EVENTS)[number];

const AGENT_RUN_TRANSITIONS: Readonly<
  Record<AgentRunStatus, Partial<Record<AgentRunTransitionEvent, AgentRunStatus>>>
> = {
  created: {
    START: "running",
    FAIL: "failed",
  },
  running: {
    WAIT_FOR_PERMISSION: "waiting_permission",
    REQUEST_CANCELLATION: "cancelling",
    SUCCEED: "succeeded",
    FAIL: "failed",
    INTERRUPT: "interrupted",
  },
  waiting_permission: {
    RESUME: "running",
    REQUEST_CANCELLATION: "cancelling",
    FAIL: "failed",
    INTERRUPT: "interrupted",
  },
  cancelling: {
    CONFIRM_CANCELLED: "cancelled",
    FAIL: "failed",
    INTERRUPT: "interrupted",
  },
  succeeded: {},
  failed: {},
  cancelled: {},
  interrupted: {},
};

export const AGENT_RUN_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const satisfies readonly AgentRunStatus[];

export function transitionAgentRunStatus(currentStatus: unknown, event: unknown): AgentRunStatus {
  if (!isAgentRunStatus(currentStatus) || !isAgentRunTransitionEvent(event)) {
    throw invalidTransition(currentStatus, event);
  }

  const nextStatus: AgentRunStatus | undefined = AGENT_RUN_TRANSITIONS[currentStatus][event];
  if (nextStatus === undefined) {
    throw invalidTransition(currentStatus, event);
  }
  return nextStatus;
}

export function getAllowedAgentRunTransitionEvents(
  currentStatus: unknown,
): readonly AgentRunTransitionEvent[] {
  if (!isAgentRunStatus(currentStatus)) {
    throw invalidTransition(currentStatus, "UNKNOWN");
  }
  return Object.freeze(
    Object.keys(AGENT_RUN_TRANSITIONS[currentStatus]) as AgentRunTransitionEvent[],
  );
}

export function isAgentRunTerminalStatus(
  value: unknown,
): value is (typeof AGENT_RUN_TERMINAL_STATUSES)[number] {
  return AGENT_RUN_TERMINAL_STATUSES.some((status) => status === value);
}

function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return AGENT_RUN_STATUSES.some((status) => status === value);
}

function isAgentRunTransitionEvent(value: unknown): value is AgentRunTransitionEvent {
  return AGENT_RUN_TRANSITION_EVENTS.some((event) => event === value);
}

function invalidTransition(currentStatus: unknown, event: unknown): CoreDomainError {
  return new CoreDomainError("AGENT_RUN_STATE_TRANSITION_INVALID", {
    entity: "agent_run",
    current_status: isAgentRunStatus(currentStatus) ? currentStatus : "UNKNOWN",
    transition_event: isAgentRunTransitionEvent(event) ? event : "UNKNOWN",
  });
}
