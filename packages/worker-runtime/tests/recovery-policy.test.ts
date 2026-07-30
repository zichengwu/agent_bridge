import { describe, expect, it } from "vitest";

import { DRIVER_PROTOCOL_VERSION, type AgentCapabilities } from "@agent-bridge/driver-protocol";
import {
  DOMAIN_SCHEMA_VERSION,
  type AgentSessionBinding,
  type TaskVersion,
} from "@agent-bridge/schemas";
import type { AgentRunRecord, DomainRepository, StoredDomainRecord } from "@agent-bridge/core";

import {
  planInterruptedRunRecovery,
  type RecoveryPolicyDependencies,
  type RecoveryWorktreeFacts,
} from "../src/index.js";

const timestamp = "2026-07-28T00:00:00.000Z";

describe("Bridge 重启后的恢复决策", () => {
  it("全部边界一致时只产出 RESUME_ALLOWED 决策", async () => {
    const decisions = await planInterruptedRunRecovery(dependencies());

    expect(decisions).toMatchObject([
      {
        action: "RESUME_ALLOWED",
        reason: "SAFE_TO_RESUME",
        run: { value: { run_id: "run-1" } },
        session: { session_id: "session-1" },
      },
    ]);
  });

  it.each([
    ["created", {}, true, "RUN_NOT_STARTED"],
    ["cancelling", {}, true, "CANCELLATION_WAS_IN_PROGRESS"],
    ["running", {}, false, "DRIVER_RESUME_UNSUPPORTED"],
    ["running", { exists: false }, true, "WORKTREE_MISSING"],
    ["running", { ownerMatches: false }, true, "WORKTREE_OWNERSHIP_INVALID"],
    ["running", { leaseRecoverable: false }, true, "WORKTREE_OWNERSHIP_INVALID"],
    ["running", { baseMatches: false }, true, "GIT_BASE_MISMATCH"],
    ["waiting_permission", { diffAuthorized: false }, true, "GIT_DIFF_POLICY_VIOLATION"],
  ] as const)("%s 与恢复事实组合返回 %s", async (status, facts, resumeSupported, reason) => {
    const decisions = await planInterruptedRunRecovery(
      dependencies({ status, facts, resumeSupported }),
    );

    expect(decisions).toMatchObject([{ action: "FAIL_REQUIRED", reason }]);
  });

  it("Phase 1 终态 interrupted 不会进入恢复候选执行", async () => {
    const repository = repositoryStub("interrupted");
    const decisions = await planInterruptedRunRecovery({
      repository,
      capabilities: () => Promise.resolve(capabilities(true)),
      inspectWorktree: () => Promise.resolve(safeWorktreeFacts()),
    });

    expect(decisions).toEqual([]);
  });
});

function dependencies(
  options: {
    status?: AgentRunRecord["status"];
    facts?: Partial<RecoveryWorktreeFacts>;
    resumeSupported?: boolean;
  } = {},
): RecoveryPolicyDependencies {
  return {
    repository: repositoryStub(options.status ?? "running"),
    capabilities: () => Promise.resolve(capabilities(options.resumeSupported ?? true)),
    inspectWorktree: () => Promise.resolve({ ...safeWorktreeFacts(), ...options.facts }),
  };
}

function repositoryStub(status: AgentRunRecord["status"]): DomainRepository {
  const candidate = stored("agent_run", "run-1", run(status));
  const taskRecord = stored("task_version", "task-1:v1", taskVersion());
  const binding = stored("agent_session_binding", "binding-1", session());
  return {
    listRecoveryCandidates: () =>
      Promise.resolve(
        ["created", "running", "waiting_permission", "cancelling"].includes(status)
          ? [candidate]
          : [],
      ),
    getTaskVersion: () => Promise.resolve(taskRecord),
    listAgentSessionBindings: () => Promise.resolve([binding]),
  } as unknown as DomainRepository;
}

function stored<K extends "agent_run" | "task_version" | "agent_session_binding">(
  kind: K,
  recordId: string,
  value: K extends "agent_run"
    ? AgentRunRecord
    : K extends "task_version"
      ? TaskVersion
      : AgentSessionBinding,
): StoredDomainRecord<K> {
  return { kind, record_id: recordId, revision: 1, value } as unknown as StoredDomainRecord<K>;
}

function run(status: AgentRunRecord["status"]): AgentRunRecord {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    run_id: "run-1",
    task_id: "task-1",
    task_version: 1,
    project_id: "project-1",
    driver_id: "fixture",
    role: "developer",
    status,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function taskVersion(): TaskVersion {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "task-1",
    task_version: 1,
    project_id: "project-1",
    base_commit: "abcdef1",
    policy_version: "1.0",
    objective: "test recovery decision",
    role: "developer",
    business_rules: [],
    scope: { read: ["**"], write: ["src/**"], deny: [] },
    acceptance_commands: [],
    git: { branch: "codex/task-1" },
    context_policy: {
      project_baseline_version: 1,
      rollover_ratio: 0.8,
      inherit_full_transcript: false,
    },
    limits: { timeout_seconds: 60, max_review_cycles: 1, max_agent_count: 1 },
    required_output: [],
    content_hash: `sha256:${"a".repeat(64)}`,
    created_at: timestamp,
  };
}

function session(): AgentSessionBinding {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    binding_id: "binding-1",
    session_id: "session-1",
    external_session_id: "external-1",
    task_id: "task-1",
    task_version: 1,
    run_id: "run-1",
    driver_id: "fixture",
    role: "developer",
    status: "ACTIVE",
    context_package_id: "context-1",
    context_package_hash: `sha256:${"b".repeat(64)}`,
    created_at: timestamp,
  };
}

function capabilities(resume: boolean): AgentCapabilities {
  return {
    protocolVersion: DRIVER_PROTOCOL_VERSION,
    driver: { id: "fixture", displayName: "Fixture", driverVersion: "1.0.0" },
    sessions: { persistentIds: true, resume, successorSessions: true },
    events: { streaming: true, strictOrdering: true },
    permissions: { mode: "interactive", decisions: ["allow", "deny"] },
    cancellation: { supported: true, terminalEvent: true },
    contextUsage: { mode: "exact" },
  };
}

function safeWorktreeFacts(): RecoveryWorktreeFacts {
  return {
    exists: true,
    ownerMatches: true,
    baseMatches: true,
    diffAuthorized: true,
    leaseRecoverable: true,
  };
}
