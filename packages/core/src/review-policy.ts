import { parseReviewCycle, type ReviewCycle, type ReviewCycleStatus } from "@agent-bridge/schemas";

import { CoreDomainError } from "./errors.js";

const REVIEW_TRANSITIONS: Readonly<Record<ReviewCycleStatus, readonly ReviewCycleStatus[]>> = {
  requested: ["feedback_dispatched", "exhausted"],
  feedback_dispatched: ["resubmitted", "exhausted"],
  resubmitted: ["verified", "exhausted"],
  verified: ["resolved", "exhausted"],
  resolved: [],
  exhausted: [],
};

export function readReviewCycle(value: unknown): ReviewCycle {
  let cycle: ReviewCycle;
  try {
    cycle = parseReviewCycle(value);
  } catch {
    throw invalidReview("SCHEMA_INVALID");
  }
  if (
    cycle.cycle_number > 3 ||
    Date.parse(cycle.updated_at) < Date.parse(cycle.created_at) ||
    new Set(cycle.findings.map((finding) => finding.finding_id)).size !== cycle.findings.length ||
    ((cycle.status === "resubmitted" ||
      cycle.status === "verified" ||
      cycle.status === "resolved") &&
      cycle.candidate_commit === undefined)
  ) {
    throw invalidReview("LIFECYCLE_INVALID");
  }
  return cycle;
}

export function assertReviewCycleAllowed(cycleNumber: number, configuredMaximum: number): void {
  const effectiveMaximum = Math.min(configuredMaximum, 3);
  if (
    !Number.isInteger(cycleNumber) ||
    cycleNumber <= 0 ||
    !Number.isInteger(configuredMaximum) ||
    configuredMaximum <= 0
  ) {
    throw invalidReview("LIMIT_INVALID");
  }
  if (cycleNumber > effectiveMaximum) {
    throw new CoreDomainError("REVIEW_LIMIT_REACHED", {
      entity: "review_cycle",
      cycle_number: cycleNumber,
      effective_maximum: effectiveMaximum,
    });
  }
}

export function transitionReviewCycle(
  value: unknown,
  status: ReviewCycleStatus,
  updatedAt: string,
  patch: Pick<Partial<ReviewCycle>, "candidate_commit" | "verification_results" | "metadata"> = {},
): ReviewCycle {
  const cycle = readReviewCycle(value);
  if (!REVIEW_TRANSITIONS[cycle.status].includes(status)) {
    throw invalidReview("TRANSITION_INVALID");
  }
  return readReviewCycle({ ...cycle, ...patch, status, updated_at: updatedAt });
}

export function assertReviewScope(
  cycle: ReviewCycle,
  scope: {
    readonly task_id: string;
    readonly task_version: number;
    readonly run_id: string;
    readonly session_id: string;
    readonly commit_sha: string;
  },
): void {
  if (
    cycle.task_id !== scope.task_id ||
    cycle.task_version !== scope.task_version ||
    cycle.run_id !== scope.run_id ||
    cycle.session_id !== scope.session_id ||
    cycle.target_commit !== scope.commit_sha
  ) {
    throw new CoreDomainError("REVIEW_SCOPE_CONFLICT", {
      entity: "review_cycle",
      review_id: cycle.review_id,
    });
  }
}

function invalidReview(reason: string): CoreDomainError {
  return new CoreDomainError("REVIEW_CYCLE_INVALID", { entity: "review_cycle", reason });
}
