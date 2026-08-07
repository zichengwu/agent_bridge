import { DOMAIN_SCHEMA_VERSION, type Task, type TaskStatus } from "@agent-bridge/schemas";
import { describe, expect, it } from "vitest";

import {
  TASK_FINAL_STATUSES,
  TASK_STATUSES,
  TASK_TRANSITION_EVENTS,
  CoreDomainError,
  getAllowedTaskTransitionEvents,
  isTaskFinalStatus,
  transitionTask,
  transitionTaskStatus,
  type CoreDomainErrorCode,
  type TaskTransitionEvent,
} from "../src/index.js";

const timestamp = "2026-07-24T10:00:00+08:00";
const laterTimestamp = "2026-07-24T10:01:00+08:00";

const legalTransitions = [
  ["DRAFT", "VALIDATE", "VALIDATED"],
  ["VALIDATED", "ENQUEUE", "QUEUED"],
  ["QUEUED", "START_RUN", "RUNNING"],
  ["RUNNING", "REQUEST_APPROVAL", "WAITING_APPROVAL"],
  ["RUNNING", "INTERRUPT", "INTERRUPTED"],
  ["RUNNING", "FAIL", "FAILED"],
  ["RUNNING", "CANCEL", "CANCELLED"],
  ["RUNNING", "SUBMIT", "SUBMITTED"],
  ["SUBMITTED", "START_VERIFICATION", "VERIFYING"],
  ["VERIFYING", "FAIL", "FAILED"],
  ["VERIFYING", "REQUEST_REVIEW", "REVIEW_REQUIRED"],
  ["REVIEW_REQUIRED", "REQUEST_CHANGES", "CHANGES_REQUESTED"],
  ["REVIEW_REQUIRED", "APPROVE_REVIEW", "READY_FOR_MERGE"],
  ["CHANGES_REQUESTED", "RESUME_CHANGES", "RUNNING"],
  ["READY_FOR_MERGE", "COMPLETE", "COMPLETED"],
  ["WAITING_APPROVAL", "APPROVE_ACTION", "RUNNING"],
  ["WAITING_APPROVAL", "DENY_ACTION", "RUNNING"],
  ["WAITING_APPROVAL", "INTERRUPT", "INTERRUPTED"],
  ["WAITING_APPROVAL", "FAIL", "FAILED"],
  ["WAITING_APPROVAL", "CANCEL", "CANCELLED"],
  ["VALIDATED", "START_NEW_VERSION", "DRAFT"],
  ["INTERRUPTED", "START_NEW_VERSION", "DRAFT"],
  ["FAILED", "START_NEW_VERSION", "DRAFT"],
  ["CANCELLED", "START_NEW_VERSION", "DRAFT"],
  ["REVIEW_REQUIRED", "START_NEW_VERSION", "DRAFT"],
  ["READY_FOR_MERGE", "START_NEW_VERSION", "DRAFT"],
  ["COMPLETED", "START_NEW_VERSION", "DRAFT"],
] as const satisfies readonly (readonly [TaskStatus, TaskTransitionEvent, TaskStatus])[];

const legalTransitionKeys = new Set(
  legalTransitions.map(([status, event]) => JSON.stringify([status, event])),
);

describe("权威 Task 状态机", () => {
  it.each(legalTransitions)("%s + %s → %s", (current, event, expected) => {
    expect(transitionTaskStatus(current, event)).toBe(expected);
  });

  it.each(TASK_STATUSES)("%s 仅接受 PRD 12.1 明示事件", (status) => {
    const allowed = new Set(getAllowedTaskTransitionEvents(status));

    for (const event of TASK_TRANSITION_EVENTS) {
      const expectedLegal = legalTransitionKeys.has(JSON.stringify([status, event]));
      expect(allowed.has(event)).toBe(expectedLegal);

      if (!expectedLegal) {
        const error = expectCoreError(
          () => transitionTaskStatus(status, event),
          "TASK_STATE_TRANSITION_INVALID",
        );
        expect(error.details).toEqual({
          entity: "task",
          current_status: status,
          transition_event: event,
        });
      }
    }
  });

  it("终态只允许显式开始新版本，且最终状态集合稳定", () => {
    expect(TASK_FINAL_STATUSES).toEqual(["FAILED", "CANCELLED", "COMPLETED"]);
    for (const status of TASK_FINAL_STATUSES) {
      expect(isTaskFinalStatus(status)).toBe(true);
      expect(getAllowedTaskTransitionEvents(status)).toEqual(["START_NEW_VERSION"]);
    }
    expect(isTaskFinalStatus("INTERRUPTED")).toBe(false);
  });

  it("WAITING_APPROVAL 可显式决策，INTERRUPTED 只能开始新版本", () => {
    expect(getAllowedTaskTransitionEvents("WAITING_APPROVAL")).toEqual([
      "APPROVE_ACTION",
      "DENY_ACTION",
      "INTERRUPT",
      "FAIL",
      "CANCEL",
    ]);
    expect(getAllowedTaskTransitionEvents("INTERRUPTED")).toEqual(["START_NEW_VERSION"]);
  });

  it("未知状态、未知领域事件和 Driver 事件均稳定拒绝", () => {
    expectCoreError(
      () => transitionTaskStatus("UNKNOWN_TASK_STATE", "VALIDATE"),
      "TASK_STATE_TRANSITION_INVALID",
    );
    expectCoreError(
      () => transitionTaskStatus("DRAFT", "UNKNOWN_DOMAIN_EVENT"),
      "TASK_STATE_TRANSITION_INVALID",
    );
    const driverEventError = expectCoreError(
      () => transitionTaskStatus("RUNNING", "run.completed"),
      "TASK_STATE_TRANSITION_INVALID",
    );
    expect(driverEventError.details.transition_event).toBe("UNKNOWN");
  });

  it("以不可变 Task 值执行转换并只更新权威状态与时间", () => {
    const task = taskValue("DRAFT");

    const transitioned = transitionTask(task, "VALIDATE", laterTimestamp);

    expect(transitioned).toEqual({
      ...task,
      status: "VALIDATED",
      updated_at: laterTimestamp,
    });
    expect(Object.isFrozen(transitioned)).toBe(true);
    expect(task.status).toBe("DRAFT");
  });

  it("拒绝非法 Task 或倒退时间，且错误不回显输入内容", () => {
    const secret = "provider-secret-value";
    const malformed = {
      ...taskValue("DRAFT"),
      private_payload: secret,
    };

    const malformedError = expectCoreError(
      () => transitionTask(malformed, "VALIDATE", laterTimestamp),
      "TASK_INVALID",
    );
    const timeError = expectCoreError(
      () => transitionTask(taskValue("DRAFT"), "VALIDATE", "2026-07-24T09:59:00+08:00"),
      "TASK_INVALID",
    );

    expect(JSON.stringify(malformedError)).not.toContain(secret);
    expect(malformedError.message).toBe("Task is invalid");
    expect(timeError.details.reason).toBe("UPDATED_AT_INVALID");
  });
});

function taskValue(status: TaskStatus): Task {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "task-1",
    project_id: "project-1",
    status,
    latest_version: 1,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function expectCoreError(operation: () => unknown, code: CoreDomainErrorCode): CoreDomainError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreDomainError);
    expect((error as CoreDomainError).code).toBe(code);
    return error as CoreDomainError;
  }
  throw new Error(`Expected CoreDomainError with code ${code}`);
}
