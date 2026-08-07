import { describe, expect, it } from "vitest";

import { DOMAIN_SCHEMA_VERSION } from "@agent-bridge/schemas";

import { decideApprovalRequest, readReviewCycle } from "../src/index.js";

describe("Phase 3 approval and limited rework policies", () => {
  it("accepts one scoped pending permission decision and rejects a stale repeat", () => {
    const pending = {
      schema_version: DOMAIN_SCHEMA_VERSION,
      approval_id: "approval-1",
      task_id: "task-1",
      task_version: 1,
      run_id: "run-1",
      session_id: "session-1",
      kind: "driver_permission",
      operation: "process.execute",
      request_hash: `sha256:${"a".repeat(64)}`,
      status: "pending",
      permission_id: "permission-1",
      tool_call_id: "tool-1",
      requested_at: "2026-07-31T00:00:00.000Z",
    } as const;
    const approved = decideApprovalRequest(
      pending,
      "approved",
      "controller",
      "approved for this scoped call",
      "2026-07-31T00:00:01.000Z",
    );
    expect(approved.status).toBe("approved");
    expect(() =>
      decideApprovalRequest(
        approved,
        "denied",
        "controller",
        "second response",
        "2026-07-31T00:00:02.000Z",
      ),
    ).toThrowError(expect.objectContaining({ code: "APPROVAL_STALE" }));
  });

  it("enforces cycle numbers within the hard MVP ceiling", () => {
    const base = {
      schema_version: DOMAIN_SCHEMA_VERSION,
      review_id: "review-1",
      task_id: "task-1",
      task_version: 1,
      run_id: "run-1",
      session_id: "session-1",
      target_commit: "abcdef1",
      findings: [{ finding_id: "finding-1", severity: "error", summary: "fix it" }],
      feedback_id: "feedback-1",
      status: "requested",
      verification_results: [],
      created_at: "2026-07-31T00:00:00.000Z",
      updated_at: "2026-07-31T00:00:00.000Z",
    } as const;
    expect(readReviewCycle({ ...base, cycle_number: 3 }).cycle_number).toBe(3);
    expect(() => readReviewCycle({ ...base, cycle_number: 4 })).toThrowError(
      expect.objectContaining({ code: "REVIEW_CYCLE_INVALID" }),
    );
  });
});
