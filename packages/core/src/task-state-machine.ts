import { parseTask, type Task, type TaskStatus } from "@agent-bridge/schemas";

import { CoreDomainError } from "./errors.js";

export const TASK_STATUSES = [
  "DRAFT",
  "VALIDATED",
  "QUEUED",
  "RUNNING",
  "WAITING_APPROVAL",
  "INTERRUPTED",
  "FAILED",
  "CANCELLED",
  "SUBMITTED",
  "VERIFYING",
  "REVIEW_REQUIRED",
  "CHANGES_REQUESTED",
  "READY_FOR_MERGE",
  "COMPLETED",
] as const satisfies readonly TaskStatus[];

export const TASK_TRANSITION_EVENTS = [
  "VALIDATE",
  "ENQUEUE",
  "START_RUN",
  "REQUEST_APPROVAL",
  "INTERRUPT",
  "FAIL",
  "CANCEL",
  "SUBMIT",
  "START_VERIFICATION",
  "REQUEST_REVIEW",
  "REQUEST_CHANGES",
  "RESUME_CHANGES",
  "APPROVE_REVIEW",
  "COMPLETE",
  "APPROVE_ACTION",
  "DENY_ACTION",
  "START_NEW_VERSION",
] as const;

export type TaskTransitionEvent = (typeof TASK_TRANSITION_EVENTS)[number];

const TASK_TRANSITIONS: Readonly<
  Record<TaskStatus, Partial<Record<TaskTransitionEvent, TaskStatus>>>
> = {
  DRAFT: {
    VALIDATE: "VALIDATED",
  },
  VALIDATED: {
    ENQUEUE: "QUEUED",
    START_NEW_VERSION: "DRAFT",
  },
  QUEUED: {
    START_RUN: "RUNNING",
  },
  RUNNING: {
    REQUEST_APPROVAL: "WAITING_APPROVAL",
    INTERRUPT: "INTERRUPTED",
    FAIL: "FAILED",
    CANCEL: "CANCELLED",
    SUBMIT: "SUBMITTED",
  },
  WAITING_APPROVAL: {
    APPROVE_ACTION: "RUNNING",
    DENY_ACTION: "RUNNING",
    INTERRUPT: "INTERRUPTED",
    FAIL: "FAILED",
    CANCEL: "CANCELLED",
  },
  INTERRUPTED: {
    START_NEW_VERSION: "DRAFT",
  },
  FAILED: {
    START_NEW_VERSION: "DRAFT",
  },
  CANCELLED: {
    START_NEW_VERSION: "DRAFT",
  },
  SUBMITTED: {
    START_VERIFICATION: "VERIFYING",
  },
  VERIFYING: {
    FAIL: "FAILED",
    REQUEST_REVIEW: "REVIEW_REQUIRED",
  },
  REVIEW_REQUIRED: {
    REQUEST_CHANGES: "CHANGES_REQUESTED",
    APPROVE_REVIEW: "READY_FOR_MERGE",
    START_NEW_VERSION: "DRAFT",
  },
  CHANGES_REQUESTED: {
    RESUME_CHANGES: "RUNNING",
  },
  READY_FOR_MERGE: {
    COMPLETE: "COMPLETED",
    START_NEW_VERSION: "DRAFT",
  },
  COMPLETED: {
    START_NEW_VERSION: "DRAFT",
  },
};

export const TASK_FINAL_STATUSES = [
  "FAILED",
  "CANCELLED",
  "COMPLETED",
] as const satisfies readonly TaskStatus[];

export function transitionTaskStatus(currentStatus: unknown, event: unknown): TaskStatus {
  if (!isTaskStatus(currentStatus) || !isTaskTransitionEvent(event)) {
    throw invalidTransition(currentStatus, event);
  }

  const nextStatus: TaskStatus | undefined = TASK_TRANSITIONS[currentStatus][event];
  if (nextStatus === undefined) {
    throw invalidTransition(currentStatus, event);
  }
  return nextStatus;
}

export function transitionTask(value: unknown, event: unknown, occurredAt: unknown): Task {
  const task = readTask(value);
  const nextStatus = transitionTaskStatus(task.status, event);

  if (typeof occurredAt !== "string" || Date.parse(occurredAt) < Date.parse(task.updated_at)) {
    throw new CoreDomainError("TASK_INVALID", {
      entity: "task",
      reason: "UPDATED_AT_INVALID",
    });
  }

  try {
    return parseTask({
      ...task,
      status: nextStatus,
      updated_at: occurredAt,
    });
  } catch {
    throw new CoreDomainError("TASK_INVALID", {
      entity: "task",
      reason: "SCHEMA_INVALID",
    });
  }
}

export function getAllowedTaskTransitionEvents(
  currentStatus: unknown,
): readonly TaskTransitionEvent[] {
  if (!isTaskStatus(currentStatus)) {
    throw invalidTransition(currentStatus, "UNKNOWN");
  }
  return Object.freeze(Object.keys(TASK_TRANSITIONS[currentStatus]) as TaskTransitionEvent[]);
}

export function isTaskFinalStatus(value: unknown): value is (typeof TASK_FINAL_STATUSES)[number] {
  return TASK_FINAL_STATUSES.some((status) => status === value);
}

function readTask(value: unknown): Task {
  try {
    return parseTask(value);
  } catch {
    throw new CoreDomainError("TASK_INVALID", {
      entity: "task",
      reason: "SCHEMA_INVALID",
    });
  }
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return TASK_STATUSES.some((status) => status === value);
}

function isTaskTransitionEvent(value: unknown): value is TaskTransitionEvent {
  return TASK_TRANSITION_EVENTS.some((event) => event === value);
}

function invalidTransition(currentStatus: unknown, event: unknown): CoreDomainError {
  return new CoreDomainError("TASK_STATE_TRANSITION_INVALID", {
    entity: "task",
    current_status: isTaskStatus(currentStatus) ? currentStatus : "UNKNOWN",
    transition_event: isTaskTransitionEvent(event) ? event : "UNKNOWN",
  });
}
