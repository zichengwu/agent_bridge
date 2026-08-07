import {
  parseApprovalRequest,
  type ApprovalRequest,
  type ApprovalRequestStatus,
} from "@agent-bridge/schemas";

import { CoreDomainError } from "./errors.js";

export function readApprovalRequest(value: unknown): ApprovalRequest {
  let request: ApprovalRequest;
  try {
    request = parseApprovalRequest(value);
  } catch {
    throw invalidApproval("SCHEMA_INVALID");
  }
  const hasPermission = request.permission_id !== undefined || request.tool_call_id !== undefined;
  if (
    (request.kind === "driver_permission" &&
      (request.permission_id === undefined || request.tool_call_id === undefined)) ||
    (request.kind === "control_operation" && hasPermission) ||
    (request.status === "pending" &&
      (request.decided_at !== undefined || request.decided_by !== undefined)) ||
    (request.status !== "pending" &&
      (request.decided_at === undefined || request.decided_by === undefined)) ||
    (request.decided_at !== undefined &&
      Date.parse(request.decided_at) < Date.parse(request.requested_at))
  ) {
    throw invalidApproval("LIFECYCLE_INVALID");
  }
  return request;
}

export function decideApprovalRequest(
  value: unknown,
  decision: "approved" | "denied",
  actor: "human" | "controller",
  reason: string,
  decidedAt: string,
): ApprovalRequest {
  const request = readApprovalRequest(value);
  if (request.status !== "pending") {
    throw new CoreDomainError("APPROVAL_STALE", {
      entity: "approval_request",
      approval_id: request.approval_id,
      current_status: request.status,
    });
  }
  if (
    (decision !== "approved" && decision !== "denied") ||
    (actor !== "human" && actor !== "controller") ||
    typeof reason !== "string" ||
    reason.length === 0 ||
    !Number.isFinite(Date.parse(decidedAt))
  ) {
    throw invalidApproval("DECISION_INVALID");
  }
  return readApprovalRequest({
    ...request,
    status: decision satisfies ApprovalRequestStatus,
    reason,
    decided_at: decidedAt,
    decided_by: actor,
  });
}

function invalidApproval(reason: string): CoreDomainError {
  return new CoreDomainError("APPROVAL_INVALID", { entity: "approval_request", reason });
}
