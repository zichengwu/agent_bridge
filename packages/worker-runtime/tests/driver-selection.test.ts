import {
  DRIVER_PROTOCOL_VERSION,
  type AgentCapabilities,
  type HealthStatus,
} from "@agent-bridge/driver-protocol";
import { describe, expect, it, vi } from "vitest";

import { ExplicitDriverSelector, WorkerRuntimeError, type DriverProbe } from "../src/index.js";

const checkedAt = "2026-07-31T10:00:00+08:00";
const confirmedAt = "2026-07-31T10:01:00+08:00";

describe("显式 Driver 降级决策", () => {
  it("OpenCode 健康时不加载或检查 Claude", async () => {
    const fallback = probe("claude-agent", "healthy");
    const selector = createSelector(probe("opencode", "healthy"), fallback);

    await expect(selector.assessNewRun(scope())).resolves.toMatchObject({
      action: "USE_PRIMARY",
      driver_id: "opencode",
    });
    expect(fallback.inspect).not.toHaveBeenCalled();
  });

  it("OpenCode 不健康时检查 Claude，但必须等待显式确认", async () => {
    const selector = createSelector(
      probe("opencode", "unhealthy"),
      probe("claude-agent", "healthy"),
    );
    const proposal = await selector.assessNewRun(scope());

    expect(proposal).toMatchObject({
      action: "FALLBACK_CONFIRMATION_REQUIRED",
      driver_id: "claude-agent",
      reason: "PRIMARY_UNHEALTHY",
    });
    expect(() =>
      selector.confirmFallback(proposal, {
        decision_id:
          proposal.action === "FALLBACK_CONFIRMATION_REQUIRED" ? proposal.decision_id : "wrong",
        task_id: "task-1",
        task_version: 1,
        planned_run_id: "run-fallback",
        actor: { kind: "codex", id: "codex-1" },
        reason: "确认使用 Claude Driver",
        confirmed_at: confirmedAt,
      }),
    ).not.toThrow();
  });

  it("主 Driver 新 Run 启动失败后只为新的 planned run 生成降级提案", async () => {
    const selector = createSelector(probe("opencode", "healthy"), probe("claude-agent", "healthy"));

    const proposal = await selector.assessAfterPrimaryStartFailure(
      scope("run-claude-new"),
      "PROCESS_START_FAILED",
    );

    expect(proposal).toMatchObject({
      action: "FALLBACK_CONFIRMATION_REQUIRED",
      scope: { planned_run_id: "run-claude-new" },
      reason: "PRIMARY_START_FAILED",
    });
  });

  it("Claude 缺失只使降级不可用，不影响独立的主 Driver 健康路径", async () => {
    const missingInspect = vi.fn<DriverProbe["inspect"]>().mockRejectedValue(new Error("missing"));
    const missingFallback = {
      driver_id: "claude-agent",
      inspect: missingInspect,
    } satisfies DriverProbe;
    const healthy = createSelector(probe("opencode", "healthy"), missingFallback);
    await expect(healthy.assessNewRun(scope())).resolves.toMatchObject({
      action: "USE_PRIMARY",
    });
    expect(missingInspect).not.toHaveBeenCalled();

    const unhealthy = createSelector(probe("opencode", "unhealthy"), missingFallback);
    await expect(unhealthy.assessNewRun(scope())).resolves.toMatchObject({
      action: "NO_DRIVER_AVAILABLE",
      reason: "FALLBACK_UNAVAILABLE",
    });
  });

  it("拒绝对正在运行或等待权限的任务切换 Driver", async () => {
    const selector = createSelector(
      probe("opencode", "unhealthy"),
      probe("claude-agent", "healthy"),
    );

    await expect(
      selector.assessNewRun({
        ...scope(),
        active_run: { run_id: "run-active", status: "running" },
      }),
    ).rejects.toMatchObject({
      code: "DRIVER_SELECTION_INVALID",
      details: { reason: "RUNNING_TASK_DRIVER_SWITCH_FORBIDDEN" },
    } satisfies Partial<WorkerRuntimeError>);
  });

  it("能力不足的 Claude 不允许通过确认绕过", async () => {
    const fallback = probe("claude-agent", "healthy", {
      cancellation: { supported: false, terminalEvent: false },
    });
    const selector = createSelector(probe("opencode", "unhealthy"), fallback);

    await expect(selector.assessNewRun(scope())).resolves.toMatchObject({
      action: "NO_DRIVER_AVAILABLE",
      reason: "FALLBACK_CAPABILITY_MISMATCH",
    });
  });
});

function createSelector(primary: DriverProbe, fallback?: DriverProbe) {
  return new ExplicitDriverSelector({
    primary,
    fallback,
    fallback_enabled: true,
    create_decision_id: () => "decision-1",
    now: () => new Date(checkedAt),
  });
}

function scope(plannedRunId = "run-fallback") {
  return {
    task_id: "task-1",
    task_version: 1,
    planned_run_id: plannedRunId,
  };
}

function probe(
  driverId: "opencode" | "claude-agent",
  status: HealthStatus["status"],
  overrides: Partial<AgentCapabilities> = {},
) {
  const capabilities: AgentCapabilities = {
    protocolVersion: DRIVER_PROTOCOL_VERSION,
    driver: {
      id: driverId,
      displayName: driverId,
      driverVersion: "test",
    },
    sessions: { persistentIds: true, resume: true, successorSessions: true },
    events: { streaming: true, strictOrdering: true },
    permissions: { mode: "interactive", decisions: ["allow", "deny"] },
    cancellation: { supported: true, terminalEvent: true },
    contextUsage: { mode: "estimated" },
    ...overrides,
  };
  const inspect = vi.fn<DriverProbe["inspect"]>().mockResolvedValue({
    health: {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      driverId,
      status,
      checkedAt,
    },
    capabilities,
  });
  return {
    driver_id: driverId,
    inspect,
  } satisfies DriverProbe;
}
