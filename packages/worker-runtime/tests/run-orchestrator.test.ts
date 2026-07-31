import {
  InMemoryDomainRepository,
  assembleContextPackage,
  computeContentHash,
  type ProjectBaselineInput,
} from "@agent-bridge/core";
import {
  DRIVER_PROTOCOL_VERSION,
  type AgentCapabilities,
  type AgentDriver,
} from "@agent-bridge/driver-protocol";
import { DOMAIN_SCHEMA_VERSION, type TaskVersion } from "@agent-bridge/schemas";
import { describe, expect, it, vi } from "vitest";

import { RunOrchestrator, type RuntimeAuditInput, type RuntimeDriverHandle } from "../src/index.js";

const createdAt = "2026-07-31T10:00:00+08:00";
const startedAt = "2026-07-31T10:01:00+08:00";

describe("选定 Driver 的新 Run 启动与审计", () => {
  it("持久化 Bridge Run、外部 Driver Run 映射和 Session Binding", async () => {
    const repository = new InMemoryDomainRepository();
    const driver = fakeDriver();
    const request = startRequest();
    const result = await new RunOrchestrator(repository, [
      { driver_id: "opencode", create: () => Promise.resolve(driver) },
    ]).start(request);

    expect(result.status).toBe("RUNNING");
    expect(await repository.getAgentRun("run-bridge")).toMatchObject({
      revision: 2,
      value: {
        status: "running",
        driver_id: "opencode",
        metadata: { external_driver_run_id: "run-external" },
      },
    });
    expect(await repository.getAgentSessionBinding("binding-1")).toMatchObject({
      value: {
        session_id: "session-bridge",
        external_session_id: "session-external",
        status: "ACTIVE",
      },
    });
    expect((await repository.listDomainEvents({ run_id: "run-bridge" })).events).toHaveLength(3);
  });

  it("新 Run 启动失败时清理 Driver、记录失败且不自动创建 Claude Run", async () => {
    const repository = new InMemoryDomainRepository();
    const close = vi.fn().mockResolvedValue(undefined);
    const driver = fakeDriver({
      startTask: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("do not persist"), { code: "PROCESS_START_FAILED" }),
        ),
      close,
    });
    const result = await new RunOrchestrator(repository, [
      { driver_id: "opencode", create: () => Promise.resolve(driver) },
    ]).start(startRequest());

    expect(result).toMatchObject({
      status: "START_FAILED",
      failure_code: "PROCESS_START_FAILED",
      run: { run_id: "run-bridge", status: "failed", driver_id: "opencode" },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(await repository.getAgentSessionBinding("binding-1")).toBeUndefined();
    expect(await repository.getAgentRun("run-bridge")).toMatchObject({ revision: 2 });
  });

  it("降级 Run 的显式确认原因进入持久审计元数据", async () => {
    const repository = new InMemoryDomainRepository();
    const request = startRequest();
    const result = await new RunOrchestrator(repository, [
      {
        driver_id: "claude-agent",
        create: () => Promise.resolve(fakeDriver({}, "claude-agent")),
      },
    ]).start({
      ...request,
      selection: {
        action: "USE_FALLBACK",
        driver_id: "claude-agent",
        scope: request.selection.scope,
        reason: "PRIMARY_START_FAILED",
        decision_id: "decision-1",
        confirmation: {
          decision_id: "decision-1",
          task_id: "task-1",
          task_version: 1,
          planned_run_id: "run-bridge",
          actor: { kind: "codex", id: "codex-1" },
          reason: "主 Driver 新 Run 启动失败，确认创建 Claude 新 Run",
          confirmed_at: startedAt,
        },
        fallback_health: {
          protocolVersion: DRIVER_PROTOCOL_VERSION,
          driverId: "claude-agent",
          status: "healthy",
          checkedAt: createdAt,
        },
        fallback_capabilities: capabilitiesValue("claude-agent"),
      },
    });

    expect(result.status).toBe("RUNNING");
    expect(await repository.getAgentRun("run-bridge")).toMatchObject({
      value: {
        driver_id: "claude-agent",
        metadata: {
          driver_selection: {
            decision_id: "decision-1",
            confirmation_reason: "主 Driver 新 Run 启动失败，确认创建 Claude 新 Run",
          },
        },
      },
    });
  });
});

function startRequest() {
  const taskVersion = taskVersionValue();
  const context = assembleContextPackage({
    scenario: "NEW_TASK",
    context_package_id: "context-1",
    task_version: taskVersion,
    run_id: "run-bridge",
    target_session_id: "session-bridge",
    created_at: createdAt,
    project_baseline: baseline(),
  }).context_package;
  const capabilities = capabilitiesValue();
  return {
    run_id: "run-bridge",
    session_id: "session-bridge",
    binding_id: "binding-1",
    task_version: taskVersion,
    context_package: context,
    role: "developer" as const,
    selection: {
      action: "USE_PRIMARY" as const,
      driver_id: "opencode" as const,
      scope: {
        task_id: "task-1",
        task_version: 1,
        planned_run_id: "run-bridge",
      },
      health: {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        driverId: "opencode",
        status: "healthy" as const,
        checkedAt: createdAt,
      },
      capabilities,
    },
    prepare_idempotency_key: "prepare-1",
    create_audit: audit("create-run", "event-run-created", createdAt),
    outcome_audit: audit("start-run", "event-run-running", startedAt),
    session_event_id: "event-session-created",
  };
}

function audit(operation: string, eventId: string, occurredAt: string): RuntimeAuditInput {
  return {
    actor: { kind: "bridge", id: "bridge-1" },
    operation,
    request_id: `request-${operation}`,
    correlation_id: "correlation-1",
    idempotency_key: `idempotency-${operation}`,
    event_id: eventId,
    occurred_at: occurredAt,
  };
}

function taskVersionValue(): TaskVersion {
  const withoutHash = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "task-1",
    task_version: 1,
    project_id: "project-1",
    base_commit: "aaaaaaa",
    policy_version: "1.0",
    objective: "实现功能",
    role: "developer" as const,
    business_rules: [],
    scope: { read: ["src/**"], write: ["src/**"], deny: [] },
    acceptance_commands: ["verify"],
    git: { branch: "agent/task-1" },
    context_policy: {
      project_baseline_version: 1,
      rollover_ratio: 0.7,
      inherit_full_transcript: false as const,
    },
    limits: { timeout_seconds: 3600, max_review_cycles: 3, max_agent_count: 4 },
    required_output: ["commit_sha"],
    created_at: createdAt,
  };
  return {
    ...withoutHash,
    content_hash: computeContentHash(withoutHash),
  };
}

function baseline(): ProjectBaselineInput {
  const content = { conventions: ["保持 Driver 中立"] };
  const payload = { project_id: "project-1", baseline_version: 1, baseline: content };
  return {
    component_id: "baseline-1",
    project_id: "project-1",
    baseline_version: 1,
    content,
    content_hash: computeContentHash(payload),
  };
}

function capabilitiesValue(driverId = "opencode"): AgentCapabilities {
  return {
    protocolVersion: DRIVER_PROTOCOL_VERSION,
    driver: { id: driverId, displayName: driverId, driverVersion: "test" },
    sessions: { persistentIds: true, resume: true, successorSessions: true },
    events: { streaming: true, strictOrdering: true },
    permissions: { mode: "interactive", decisions: ["allow", "deny"] },
    cancellation: { supported: true, terminalEvent: true },
    contextUsage: { mode: "estimated" },
  };
}

function fakeDriver(
  overrides: Partial<RuntimeDriverHandle> = {},
  driverId = "opencode",
): RuntimeDriverHandle {
  const unsupported = () => Promise.reject(new Error("unused"));
  const base: AgentDriver = {
    describeCapabilities: () => Promise.resolve(capabilitiesValue(driverId)),
    prepareTask: (request) =>
      Promise.resolve({
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        preparedTaskId: "prepared-1",
        taskId: request.taskId,
        taskVersion: request.taskVersion,
        driverId,
        preparedAt: createdAt,
      }),
    startTask: () =>
      Promise.resolve({
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        runId: "run-external",
        state: "running",
        session: {
          protocolVersion: DRIVER_PROTOCOL_VERSION,
          sessionId: "session-external",
          externalSessionId: "session-external",
          runId: "run-external",
          state: "active",
          createdAt: startedAt,
        },
        startedAt,
      }),
    resumeTask: unsupported,
    streamEvents: async function* () {},
    getContextUsage: unsupported,
    createSuccessorSession: unsupported,
    sendFeedback: unsupported,
    respondToPermission: unsupported,
    cancelTask: unsupported,
    collectResult: unsupported,
    healthCheck: unsupported,
  };
  return Object.assign(base, overrides);
}
