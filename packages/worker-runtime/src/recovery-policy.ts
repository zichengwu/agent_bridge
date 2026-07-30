import {
  canAgentSessionAcceptInput,
  type AgentRunRecord,
  type DomainRepository,
  type StoredDomainRecord,
} from "@agent-bridge/core";
import type { AgentCapabilities } from "@agent-bridge/driver-protocol";
import type { AgentSessionBinding, TaskVersion } from "@agent-bridge/schemas";

export interface RecoveryWorktreeFacts {
  readonly exists: boolean;
  readonly ownerMatches: boolean;
  readonly baseMatches: boolean;
  readonly diffAuthorized: boolean;
  readonly leaseRecoverable: boolean;
}

export interface RecoveryPolicyDependencies {
  readonly repository: DomainRepository;
  capabilities(driverId: string): Promise<AgentCapabilities>;
  inspectWorktree(run: AgentRunRecord, taskVersion: TaskVersion): Promise<RecoveryWorktreeFacts>;
}

export const INTERRUPTED_RUN_RECOVERY_FAILURE_REASONS = [
  "RUN_NOT_STARTED",
  "CANCELLATION_WAS_IN_PROGRESS",
  "TASK_VERSION_MISSING",
  "ACTIVE_SESSION_NOT_UNIQUE",
  "SESSION_SCOPE_CONFLICT",
  "RECOVERY_DEPENDENCY_UNAVAILABLE",
  "DRIVER_RESUME_UNSUPPORTED",
  "WORKTREE_MISSING",
  "WORKTREE_OWNERSHIP_INVALID",
  "GIT_BASE_MISMATCH",
  "GIT_DIFF_POLICY_VIOLATION",
] as const;

export type InterruptedRunRecoveryFailureReason =
  (typeof INTERRUPTED_RUN_RECOVERY_FAILURE_REASONS)[number];

export type InterruptedRunRecoveryDecision =
  | {
      readonly action: "RESUME_ALLOWED";
      readonly run: StoredDomainRecord<"agent_run">;
      readonly session: AgentSessionBinding;
      readonly reason: "SAFE_TO_RESUME";
    }
  | {
      readonly action: "FAIL_REQUIRED";
      readonly run: StoredDomainRecord<"agent_run">;
      readonly reason: InterruptedRunRecoveryFailureReason;
    };

export async function planInterruptedRunRecovery(
  dependencies: RecoveryPolicyDependencies,
  projectId?: string,
): Promise<readonly InterruptedRunRecoveryDecision[]> {
  const candidates = await dependencies.repository.listRecoveryCandidates({
    ...(projectId === undefined ? {} : { project_id: projectId }),
  });
  const decisions = await Promise.all(
    candidates.map((candidate) => evaluateCandidate(candidate, dependencies)),
  );
  return Object.freeze(decisions);
}

async function evaluateCandidate(
  run: StoredDomainRecord<"agent_run">,
  dependencies: RecoveryPolicyDependencies,
): Promise<InterruptedRunRecoveryDecision> {
  if (run.value.status === "created") {
    return failed(run, "RUN_NOT_STARTED");
  }
  if (run.value.status === "cancelling") {
    return failed(run, "CANCELLATION_WAS_IN_PROGRESS");
  }

  const taskVersion = await dependencies.repository.getTaskVersion({
    task_id: run.value.task_id,
    task_version: run.value.task_version,
  });
  if (taskVersion === undefined || taskVersion.value.project_id !== run.value.project_id) {
    return failed(run, "TASK_VERSION_MISSING");
  }
  const bindings = await dependencies.repository.listAgentSessionBindings(run.value.run_id);
  const active = bindings.filter((binding) => binding.value.status === "ACTIVE");
  if (active.length !== 1) {
    return failed(run, "ACTIVE_SESSION_NOT_UNIQUE");
  }
  const session = active[0]!.value;
  if (
    session.task_id !== run.value.task_id ||
    session.task_version !== run.value.task_version ||
    session.run_id !== run.value.run_id ||
    session.driver_id !== run.value.driver_id ||
    session.role !== run.value.role ||
    !canAgentSessionAcceptInput(session.status)
  ) {
    return failed(run, "SESSION_SCOPE_CONFLICT");
  }

  let capabilities: AgentCapabilities;
  let worktree: RecoveryWorktreeFacts;
  try {
    [capabilities, worktree] = await Promise.all([
      dependencies.capabilities(run.value.driver_id),
      dependencies.inspectWorktree(run.value, taskVersion.value),
    ]);
  } catch {
    return failed(run, "RECOVERY_DEPENDENCY_UNAVAILABLE");
  }
  if (capabilities.driver.id !== run.value.driver_id || !capabilities.sessions.resume) {
    return failed(run, "DRIVER_RESUME_UNSUPPORTED");
  }
  if (!worktree.exists) {
    return failed(run, "WORKTREE_MISSING");
  }
  if (!worktree.ownerMatches || !worktree.leaseRecoverable) {
    return failed(run, "WORKTREE_OWNERSHIP_INVALID");
  }
  if (!worktree.baseMatches) {
    return failed(run, "GIT_BASE_MISMATCH");
  }
  if (!worktree.diffAuthorized) {
    return failed(run, "GIT_DIFF_POLICY_VIOLATION");
  }
  return Object.freeze({ action: "RESUME_ALLOWED", run, session, reason: "SAFE_TO_RESUME" });
}

function failed(
  run: StoredDomainRecord<"agent_run">,
  reason: InterruptedRunRecoveryFailureReason,
): InterruptedRunRecoveryDecision {
  return Object.freeze({ action: "FAIL_REQUIRED", run, reason });
}
