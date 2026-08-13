import {
  InMemoryDomainRepository,
  computeContentHash,
  type AgentRunRecord,
  type AuthoritativeDomainEvent,
  type DomainRecordWrite,
} from "@agent-bridge/core";
import type { JsonObject } from "@agent-bridge/driver-protocol";
import {
  DOMAIN_SCHEMA_VERSION,
  type AgentSessionBinding,
  type ApprovalRequest,
  type ProjectBaseline,
  type Task,
  type TaskVersion,
} from "@agent-bridge/schemas";
import {
  ActiveRunRegistry,
  ContextHandoffRuntime,
  type GitClient,
  type RuntimeDriverHandle,
} from "@agent-bridge/worker-runtime";
import { describe, expect, it } from "vitest";

import type {
  BridgeCleanupInspection,
  BridgeCleanupResult,
  BridgeRuntimePort,
  BridgeStartRequest,
} from "../../../src/bridge-control-service.js";
import {
  ManagementCommandService,
  type ManagementCommandPreconditions,
} from "../../../src/management-command-service.js";
import { ManagementProjectionService } from "../../../src/management-projection.js";
import { classifyBridgeError } from "../../../src/errors.js";
import { safeErrorDetails, stableErrorCode } from "../../../src/server.js";

const STARTED_AT = "2026-08-13T01:00:00.000Z";
const NOW = "2026-08-13T02:00:00.000Z";

describe("Phase 4.2 Slice B Management Command Service", () => {
  it("ARCH-006 活动 Run 缺少安全进程内所有权时保持只读并返回恢复中", async () => {
    const fixture = await createFixture({ active_owner: false });
    await expect(
      fixture.commands.previewRunAction({
        session_id: "session-mcp",
        action: "cancel",
        run_id: "run-1",
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_IN_PROGRESS" });
    expect(await fixture.repository.getAgentRun("run-1")).toMatchObject({
      value: { status: "waiting_permission" },
      revision: 1,
    });
  });

  it("WRITE-001/WRITE-004/WRITE-005 缺幂等键、陈旧事件游标或 revision 均在副作用前拒绝", async () => {
    const fixture = await createFixture();
    const cursor = await fixture.repository.getEventCursor();

    await expect(
      fixture.commands.decideApproval({
        approval_id: "approval-1",
        decision: "approve",
        preconditions: { ...preconditions(cursor), idempotency_key: "" },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    await expect(
      fixture.commands.decideApproval({
        approval_id: "approval-1",
        decision: "approve",
        preconditions: preconditions("event-cursor:0"),
      }),
    ).rejects.toMatchObject({ code: "STALE_EVENT_CURSOR" });
    await expect(
      fixture.commands.decideApproval({
        approval_id: "approval-1",
        decision: "approve",
        preconditions: { ...preconditions(cursor), target_revision: 99 },
      }),
    ).rejects.toMatchObject({ code: "ETAG_MISMATCH" });
    expect(fixture.driver.permission_decisions).toEqual([]);
  });

  it("WRITE-002/WRITE-003/WRITE-011 同 key 同规范请求安全重放，不同请求稳定冲突", async () => {
    const fixture = await createFixture();
    const cursor = await fixture.repository.getEventCursor();
    const request = {
      approval_id: "approval-1",
      decision: "approve" as const,
      preconditions: preconditions(cursor, "idem-replay"),
    };

    const first = await fixture.commands.decideApproval(request);
    const replay = await fixture.commands.decideApproval(request);

    expect(replay).toEqual(first);
    expect(fixture.driver.permission_decisions).toHaveLength(1);
    await expect(
      fixture.commands.decideApproval({ ...request, decision: "reject", feedback: "重试" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("WRITE-006/ACT-016 并发审批与取消只有一个权威决定成功", async () => {
    const fixture = await createFixture();
    const cancelPreview = await fixture.commands.previewRunAction({
      session_id: "session-mcp",
      action: "cancel",
      run_id: "run-1",
    });
    const cursor = await fixture.repository.getEventCursor();
    const [approval, cancel] = await Promise.allSettled([
      fixture.commands.decideApproval({
        approval_id: "approval-1",
        decision: "approve",
        preconditions: preconditions(cursor, "concurrent-approve"),
      }),
      fixture.commands.confirmRunAction({
        action: "cancel",
        run_id: "run-1",
        confirmation_token: cancelPreview.confirmation_token,
        preconditions: preconditions(cursor, "concurrent-cancel"),
      }),
    ]);

    expect(
      [approval.status, cancel.status].filter((status) => status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = [approval, cancel].find((result) => result.status === "rejected");
    const rejectedCode =
      rejected?.status === "rejected" ? stableErrorCode(rejected.reason) : undefined;
    expect(["STALE_EVENT_CURSOR", "ETAG_MISMATCH"]).toContain(rejectedCode);
  });

  it("WRITE-007/WRITE-008/WRITE-009 Token 缺失、伪造、过期、重放、跨会话/action/instance 或目标变化均 fail closed", async () => {
    let now = new Date(NOW);
    const fixture = await createFixture({ now: () => now });
    const preview = await fixture.commands.previewRunAction({
      session_id: "session-mcp",
      action: "cancel",
      run_id: "run-1",
    });
    const cursor = await fixture.repository.getEventCursor();
    await expect(
      fixture.commands.confirmRunAction({
        action: "cancel",
        run_id: "run-1",
        confirmation_token: "",
        preconditions: preconditions(cursor, "missing"),
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    await expect(
      fixture.commands.confirmRunAction({
        action: "cancel",
        run_id: "run-1",
        confirmation_token: "forged-token-value",
        preconditions: preconditions(cursor, "forged"),
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    await expect(
      fixture.commands.confirmRunAction({
        action: "cleanup",
        run_id: "run-1",
        confirmation_token: preview.confirmation_token,
        preconditions: preconditions(cursor, "wrong-action"),
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });

    const crossSession = await fixture.commands.previewRunAction({
      session_id: "session-mcp",
      action: "cancel",
      run_id: "run-1",
    });
    await expect(
      fixture.commands.confirmRunAction({
        action: "cancel",
        run_id: "run-1",
        confirmation_token: crossSession.confirmation_token,
        preconditions: {
          ...preconditions(cursor, "cross-session"),
          session_id: "session-other",
        },
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });

    const crossInstance = await fixture.commands.previewRunAction({
      session_id: "session-mcp",
      action: "cancel",
      run_id: "run-1",
    });
    await expect(
      fixture.otherInstance.confirmRunAction({
        action: "cancel",
        run_id: "run-1",
        confirmation_token: crossInstance.confirmation_token,
        preconditions: preconditions(cursor, "cross-instance"),
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });

    const expiring = await fixture.commands.previewRunAction({
      session_id: "session-mcp",
      action: "cancel",
      run_id: "run-1",
    });
    now = new Date(now.getTime() + 60_001);
    await expect(
      fixture.commands.confirmRunAction({
        action: "cancel",
        run_id: "run-1",
        confirmation_token: expiring.confirmation_token,
        preconditions: preconditions(cursor, "expired"),
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });

    const changed = await fixture.commands.previewRunAction({
      session_id: "session-mcp",
      action: "cancel",
      run_id: "run-1",
    });
    fixture.runtime.inspection = {
      targets: [{ kind: "lease", target_id: "lease:run-1", ownership: "owned" }],
      warnings: [],
    };
    await updateRun(fixture.repository, "run-1", "target-changed");
    await expect(
      fixture.commands.confirmRunAction({
        action: "cancel",
        run_id: "run-1",
        confirmation_token: changed.confirmation_token,
        preconditions: preconditions(await fixture.repository.getEventCursor(), "changed", 2),
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });
  });

  it("WRITE-010 preview 只读并返回完整影响、警告、ETag 与 60 秒 Token", async () => {
    const fixture = await createFixture();
    const before = await fixture.repository.getEventCursor();
    const preview = await fixture.commands.previewRunAction({
      session_id: "session-mcp",
      action: "cancel",
      run_id: "run-1",
    });

    expect(preview).toMatchObject({
      action: "cancel",
      run_id: "run-1",
      target_revision: 1,
      etag: '"run-run-1-r1"',
      event_cursor: before,
      warnings: [],
    });
    expect(Array.isArray(preview.effects)).toBe(true);
    expect(Date.parse(preview.expires_at) - Date.parse(NOW)).toBe(60_000);
    expect(await fixture.repository.getEventCursor()).toBe(before);
    expect((await fixture.repository.getAgentRun("run-1"))?.revision).toBe(1);
  });

  it("WRITE-012 公开稳定错误不泄漏内部异常", () => {
    const internal = new Error("SQL /Users/alice/private api_key=sk-secret");
    expect(stableErrorCode(internal)).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(safeErrorDetails(internal))).not.toMatch(/SQL|Users|sk-secret/u);
    expect(classifyBridgeError("STALE_EVENT_CURSOR")).toEqual({
      category: "CONFLICT",
      retryable: true,
    });
    expect(classifyBridgeError("ACTION_NOT_ALLOWED")).toEqual({
      category: "CONFLICT",
      retryable: false,
    });
  });

  it("ACT-001 approve 通过共享服务恢复既有权限路径并记录审计", async () => {
    const fixture = await createFixture();
    const result = await fixture.commands.decideApproval({
      approval_id: "approval-1",
      decision: "approve",
      preconditions: preconditions(await fixture.repository.getEventCursor(), "approve"),
    });

    expect(result).toMatchObject({
      status: "approved",
      metadata: { delivery_status: "delivered" },
    });
    expect(fixture.driver.permission_decisions).toEqual(["allow"]);
    expect(await fixture.repository.getTask("task-1")).toMatchObject({
      value: { status: "RUNNING" },
    });
    expect(await fixture.repository.getAgentRun("run-1")).toMatchObject({
      value: { status: "running" },
    });
    expect((await fixture.repository.listDomainEvents()).events.at(-1)?.audit.operation).toBe(
      "management_approval_delivered",
    );
  });

  it("ACT-002/ACT-003 reject feedback trim 后必须为 1～2000 Unicode code point", async () => {
    const fixture = await createFixture();
    const cursor = await fixture.repository.getEventCursor();
    await expect(
      fixture.commands.decideApproval({
        approval_id: "approval-1",
        decision: "reject",
        feedback: "   ",
        preconditions: preconditions(cursor, "blank"),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      fixture.commands.decideApproval({
        approval_id: "approval-1",
        decision: "reject",
        feedback: "😀".repeat(2_001),
        preconditions: preconditions(cursor, "too-long"),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("ACT-004/ACT-005/ACT-006 reject 持久化脱敏反馈、deny 并中断旧方案，投影由既有事实派生等待重新规划", async () => {
    const fixture = await createFixture();
    await fixture.commands.decideApproval({
      approval_id: "approval-1",
      decision: "reject",
      feedback: "  不要使用 api_key=sk-abcdefghijklmnop，请重新规划  ",
      preconditions: preconditions(await fixture.repository.getEventCursor(), "reject"),
    });

    const denied = await fixture.repository.getApprovalRequest("approval-1");
    expect(denied?.value.status).toBe("denied");
    expect(denied?.value.reason).not.toContain("sk-abcdefghijklmnop");
    expect(await fixture.repository.getTask("task-1")).toMatchObject({
      value: { status: "INTERRUPTED" },
    });
    expect(await fixture.repository.getAgentRun("run-1")).toMatchObject({
      value: { status: "interrupted" },
    });
    expect(fixture.driver.permission_decisions).toEqual(["deny"]);
    expect(fixture.driver.cancel_reasons).toHaveLength(1);
    expect(fixture.activeRuns.get("run-1")).toBeUndefined();
    const detail = await new ManagementProjectionService({
      repository: fixture.repository,
      server_started_at: STARTED_AT,
      timezone: "UTC",
      now: () => new Date(NOW),
    }).getTaskDetail("task-1");
    expect(detail.data.task.wait_reason).toBe("等待 Codex 重新规划");
  });

  it("ACT-007 retry 保留旧 Run，并以冻结版本创建新 run_id 与新 Session", async () => {
    const fixture = await createFixture({ task_status: "FAILED", run_status: "failed" });
    const preview = await fixture.commands.previewRunAction({
      session_id: "session-mcp",
      action: "retry",
      run_id: "run-1",
    });
    const result = (await fixture.commands.confirmRunAction({
      action: "retry",
      run_id: "run-1",
      confirmation_token: preview.confirmation_token,
      preconditions: preconditions(preview.event_cursor, "retry"),
    })) as Record<string, unknown>;

    expect(result).toMatchObject({
      action: "retry",
      source_run_id: "run-1",
      status: "RUNNING",
    });
    expect(result.new_run_id).not.toBe("run-1");
    expect(await fixture.repository.getAgentRun("run-1")).toMatchObject({
      value: { status: "failed" },
    });
    expect(await fixture.repository.getAgentRun(String(result.new_run_id))).toMatchObject({
      value: { task_version: 1, status: "running" },
    });
    const newBindings = await fixture.repository.listAgentSessionBindings(
      String(result.new_run_id),
    );
    expect(newBindings).toHaveLength(1);
    expect(newBindings[0]?.value.session_id).not.toBe("session-1");
  });

  it("ACT-008/ACT-009 retry 对版本变化、非最新或不可重跑 Run 返回稳定错误", async () => {
    const changed = await createFixture({
      task_status: "FAILED",
      run_status: "failed",
      latest_version: 2,
    });
    await expect(
      changed.commands.previewRunAction({
        session_id: "session-mcp",
        action: "retry",
        run_id: "run-1",
      }),
    ).rejects.toMatchObject({ code: "TASK_VERSION_REQUIRED" });

    const succeeded = await createFixture({ task_status: "COMPLETED", run_status: "succeeded" });
    await expect(
      succeeded.commands.previewRunAction({
        session_id: "session-mcp",
        action: "retry",
        run_id: "run-1",
      }),
    ).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });

    const nonLatest = await createFixture({ task_status: "FAILED", run_status: "failed" });
    await addLaterFailedRun(nonLatest.repository);
    await expect(
      nonLatest.commands.previewRunAction({
        session_id: "session-mcp",
        action: "retry",
        run_id: "run-1",
      }),
    ).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });
  });

  it("ACT-010/ACT-011 cancel 只接受活动 Run，确定落盘且重复确认不产生第二终态", async () => {
    const fixture = await createFixture({ task_status: "RUNNING", run_status: "running" });
    const preview = await fixture.commands.previewRunAction({
      session_id: "session-mcp",
      action: "cancel",
      run_id: "run-1",
    });
    const request = {
      action: "cancel" as const,
      run_id: "run-1",
      confirmation_token: preview.confirmation_token,
      preconditions: preconditions(preview.event_cursor, "cancel"),
    };
    const first = await fixture.commands.confirmRunAction(request);
    const replay = await fixture.commands.confirmRunAction(request);

    expect(replay).toEqual(first);
    expect(await fixture.repository.getTask("task-1")).toMatchObject({
      value: { status: "CANCELLED" },
    });
    expect(await fixture.repository.getAgentRun("run-1")).toMatchObject({
      value: {
        status: "cancelled",
        metadata: { worktree_path: "/retained/worktree", artifact_id: "artifact-1" },
      },
    });
    expect(fixture.driver.cancel_reasons).toHaveLength(1);
    await expect(
      fixture.commands.previewRunAction({
        session_id: "session-mcp",
        action: "cancel",
        run_id: "run-1",
      }),
    ).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });
  });

  it("ACT-012/ACT-013/ACT-014/ACT-015 cleanup 只移除 owned 残留，无残留成功 no-op 且持久事实保留", async () => {
    const fixture = await createFixture({ task_status: "FAILED", run_status: "failed" });
    fixture.runtime.inspection = {
      targets: [
        { kind: "lease", target_id: "lease:run-1", ownership: "owned" },
        { kind: "runtime_directory", target_id: "runtime:foreign", ownership: "unverified" },
      ],
      warnings: ["无法证明 foreign 目录所有权"],
    };
    const preview = await fixture.commands.previewRunAction({
      session_id: "session-mcp",
      action: "cleanup",
      run_id: "run-1",
    });
    expect(preview.cleanup?.targets).toEqual(fixture.runtime.inspection.targets);
    const result = (await fixture.commands.confirmRunAction({
      action: "cleanup",
      run_id: "run-1",
      confirmation_token: preview.confirmation_token,
      preconditions: preconditions(preview.event_cursor, "cleanup"),
    })) as Record<string, unknown>;
    expect(result).toMatchObject({
      no_op: false,
      cleanup: {
        removed_targets: ["lease:run-1"],
        refused_targets: ["runtime:foreign"],
      },
    });
    expect(await fixture.repository.getTask("task-1")).toBeDefined();
    expect(
      await fixture.repository.getTaskVersion({ task_id: "task-1", task_version: 1 }),
    ).toBeDefined();
    expect(await fixture.repository.getAgentRun("run-1")).toBeDefined();
    expect(await fixture.repository.getApprovalRequest("approval-1")).toBeDefined();
    expect((await fixture.repository.listDomainEvents()).events.length).toBeGreaterThan(0);

    fixture.runtime.inspection = { targets: [], warnings: [] };
    const noOpPreview = await fixture.commands.previewRunAction({
      session_id: "session-mcp",
      action: "cleanup",
      run_id: "run-1",
    });
    const noOp = await fixture.commands.confirmRunAction({
      action: "cleanup",
      run_id: "run-1",
      confirmation_token: noOpPreview.confirmation_token,
      preconditions: preconditions(noOpPreview.event_cursor, "cleanup-no-op", 2),
    });
    expect(noOp).toMatchObject({ no_op: true });
  });
});

interface FixtureOptions {
  readonly task_status?: Task["status"];
  readonly run_status?: AgentRunRecord["status"];
  readonly latest_version?: number;
  readonly now?: () => Date;
  readonly active_owner?: boolean;
}

async function createFixture(options: FixtureOptions = {}) {
  const repository = new InMemoryDomainRepository();
  const taskStatus = options.task_status ?? "WAITING_APPROVAL";
  const runStatus = options.run_status ?? "waiting_permission";
  await seed(repository, taskStatus, runStatus, options.latest_version ?? 1);
  const activeRuns = new ActiveRunRegistry();
  const driver = new RecordingDriver();
  if (
    options.active_owner !== false &&
    (runStatus === "running" || runStatus === "waiting_permission")
  ) {
    activeRuns.register({
      run_id: "run-1",
      binding: bindingValue(runStatus === "waiting_permission" ? "ACTIVE" : "ACTIVE"),
      external_run_id: "external-run-1",
      external_session_id: "external-session-1",
      driver: driver as unknown as RuntimeDriverHandle,
    });
  }
  const runtime = new FakeRuntime(repository);
  const git: GitClient = {
    run: () => Promise.resolve({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
  };
  const commandOptions = {
    repository,
    contexts: new ContextHandoffRuntime(repository, git),
    active_runs: activeRuns,
    runtime,
    project_id: "project-1",
    repository_path: "/repository",
    server_instance_id: "instance-1",
    now: options.now ?? (() => new Date(NOW)),
    create_id: incrementalId(),
    create_token: incrementalToken(),
  } as const;
  const commands = new ManagementCommandService(commandOptions);
  const otherInstance = new ManagementCommandService({
    ...commandOptions,
    server_instance_id: "instance-2",
  });
  return { repository, activeRuns, driver, runtime, commands, otherInstance };
}

class RecordingDriver {
  readonly permission_decisions: string[] = [];
  readonly cancel_reasons: string[] = [];

  respondToPermission(request: { decision: string }): Promise<void> {
    this.permission_decisions.push(request.decision);
    return Promise.resolve();
  }

  cancelTask(request: { reason: string }): Promise<void> {
    this.cancel_reasons.push(request.reason);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeRuntime implements BridgeRuntimePort {
  inspection: BridgeCleanupInspection = { targets: [], warnings: [] };

  constructor(private readonly repository: InMemoryDomainRepository) {}

  async start(request: BridgeStartRequest) {
    const context = await this.repository.getContextPackage(request.context_package_id);
    if (context === undefined || context.value.target_session_id === undefined) {
      throw new Error("context missing");
    }
    const now = NOW;
    const run: AgentRunRecord = {
      schema_version: DOMAIN_SCHEMA_VERSION,
      run_id: context.value.run_id,
      task_id: request.task_version.task_id,
      task_version: request.task_version.task_version,
      project_id: request.task_version.project_id,
      driver_id: "driver-fake",
      role: request.task_version.role,
      status: "running",
      created_at: now,
      updated_at: now,
      started_at: now,
      metadata: {
        worktree_path: "/retained/worktree",
        retry_source_run_id: request.previous_run_id ?? "",
      },
    };
    const binding: AgentSessionBinding = {
      schema_version: DOMAIN_SCHEMA_VERSION,
      binding_id: `binding-${context.value.run_id}`,
      session_id: context.value.target_session_id,
      external_session_id: `external-${context.value.target_session_id}`,
      task_id: run.task_id,
      task_version: run.task_version,
      run_id: run.run_id,
      driver_id: run.driver_id,
      role: run.role,
      status: "ACTIVE",
      context_package_id: context.value.context_package_id,
      context_package_hash: context.value.content_hash,
      created_at: now,
    };
    await commitRecords(this.repository, "fake-runtime-start", [
      { kind: "agent_run", expected_revision: 0, value: run },
      { kind: "agent_session_binding", expected_revision: 0, value: binding },
    ]);
    return {
      run_id: run.run_id,
      session_id: binding.session_id,
      binding_id: binding.binding_id,
      status: "RUNNING" as const,
    };
  }

  rollover(): Promise<Readonly<Record<string, unknown>>> {
    return Promise.reject(new Error("not used"));
  }

  collectOutcome(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }

  previewCleanupResources(): Promise<BridgeCleanupInspection> {
    return Promise.resolve(this.inspection);
  }

  cleanupResources(): Promise<BridgeCleanupResult> {
    return Promise.resolve({
      ...this.inspection,
      removed_targets: this.inspection.targets
        .filter((target) => target.ownership === "owned")
        .map((target) => target.target_id),
      refused_targets: this.inspection.targets
        .filter((target) => target.ownership === "unverified")
        .map((target) => target.target_id),
    });
  }
}

async function seed(
  repository: InMemoryDomainRepository,
  taskStatus: Task["status"],
  runStatus: AgentRunRecord["status"],
  latestVersion: number,
): Promise<void> {
  const task: Task = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "task-1",
    project_id: "project-1",
    status: taskStatus,
    latest_version: latestVersion,
    created_at: STARTED_AT,
    updated_at: STARTED_AT,
  };
  const versionWithoutHash: Omit<TaskVersion, "content_hash"> = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "task-1",
    task_version: 1,
    project_id: "project-1",
    base_commit: "abcdef1",
    policy_version: "1.0",
    objective: "共享管理命令测试",
    role: "developer",
    business_rules: [],
    scope: { read: ["src/**"], write: ["src/**"], deny: [] },
    acceptance_commands: ["pnpm test"],
    git: { branch: "codex/task-1" },
    context_policy: {
      project_baseline_version: 1,
      rollover_ratio: 0.7,
      inherit_full_transcript: false,
    },
    limits: { timeout_seconds: 3600, max_review_cycles: 3, max_agent_count: 4 },
    required_output: ["test_results"],
    created_at: STARTED_AT,
  };
  const version: TaskVersion = {
    ...versionWithoutHash,
    content_hash: computeContentHash(versionWithoutHash as unknown as JsonObject),
  };
  const baselineContent = { rules: ["safe"] } as const;
  const baseline: ProjectBaseline = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    project_id: "project-1",
    baseline_version: 1,
    content: baselineContent,
    content_hash: computeContentHash({
      project_id: "project-1",
      baseline_version: 1,
      baseline: baselineContent,
    }),
    created_at: STARTED_AT,
  };
  const run: AgentRunRecord = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    run_id: "run-1",
    task_id: "task-1",
    task_version: 1,
    project_id: "project-1",
    driver_id: "driver-fake",
    role: "developer",
    status: runStatus,
    created_at: STARTED_AT,
    updated_at: STARTED_AT,
    started_at: STARTED_AT,
    ...(["failed", "cancelled", "interrupted", "succeeded"].includes(runStatus)
      ? { finished_at: STARTED_AT }
      : {}),
    metadata: { worktree_path: "/retained/worktree", artifact_id: "artifact-1" },
  };
  const binding = bindingValue(
    runStatus === "running" || runStatus === "waiting_permission" ? "ACTIVE" : "FAILED",
  );
  const approval: ApprovalRequest = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    approval_id: "approval-1",
    task_id: "task-1",
    task_version: 1,
    run_id: "run-1",
    session_id: "session-1",
    kind: "driver_permission",
    operation: "write",
    request_hash: `sha256:${"c".repeat(64)}`,
    status: "pending",
    permission_id: "permission-1",
    tool_call_id: "tool-1",
    requested_at: STARTED_AT,
  };
  await commitRecords(repository, "seed", [
    { kind: "task", expected_revision: 0, value: task },
    { kind: "task_version", expected_revision: 0, value: version },
    { kind: "project_baseline", expected_revision: 0, value: baseline },
    { kind: "agent_run", expected_revision: 0, value: run },
    { kind: "agent_session_binding", expected_revision: 0, value: binding },
    { kind: "approval_request", expected_revision: 0, value: approval },
  ]);
}

function bindingValue(status: AgentSessionBinding["status"]): AgentSessionBinding {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    binding_id: "binding-1",
    session_id: "session-1",
    external_session_id: "external-session-1",
    task_id: "task-1",
    task_version: 1,
    run_id: "run-1",
    driver_id: "driver-fake",
    role: "developer",
    status,
    context_package_id: "context-1",
    context_package_hash: `sha256:${"d".repeat(64)}`,
    created_at: STARTED_AT,
    ...(status === "FAILED" ? { closed_at: STARTED_AT } : {}),
  };
}

async function updateRun(
  repository: InMemoryDomainRepository,
  runId: string,
  key: string,
): Promise<void> {
  const run = await repository.getAgentRun(runId);
  if (run === undefined) throw new Error("run missing");
  await commitRecords(repository, key, [
    {
      kind: "agent_run",
      expected_revision: run.revision,
      value: { ...run.value, updated_at: NOW, metadata: { ...run.value.metadata, changed: true } },
    },
  ]);
}

async function addLaterFailedRun(repository: InMemoryDomainRepository): Promise<void> {
  const source = await repository.getAgentRun("run-1");
  if (source === undefined) throw new Error("run missing");
  await commitRecords(repository, "later_run", [
    {
      kind: "agent_run",
      expected_revision: 0,
      value: {
        ...source.value,
        run_id: "run-2",
        created_at: "2026-08-13T01:30:00.000Z",
        updated_at: "2026-08-13T01:30:00.000Z",
        started_at: "2026-08-13T01:30:00.000Z",
        finished_at: "2026-08-13T01:30:00.000Z",
      },
    },
  ]);
}

async function commitRecords(
  repository: InMemoryDomainRepository,
  key: string,
  records: readonly DomainRecordWrite[],
): Promise<void> {
  const operation = `test_${key}`;
  const changeId = `change-${key}`;
  await repository.commit({
    change_id: changeId,
    idempotency: {
      operation,
      key,
      request_hash: computeContentHash(records as unknown as JsonObject),
    },
    records,
    events: records.map((record, index) => eventFor(record, operation, changeId, key, index)),
  });
}

function eventFor(
  record: DomainRecordWrite,
  operation: string,
  changeId: string,
  key: string,
  index: number,
): AuthoritativeDomainEvent {
  const id =
    record.kind === "task"
      ? record.value.task_id
      : record.kind === "task_version"
        ? `${record.value.task_id}:v${record.value.task_version}`
        : record.kind === "project_baseline"
          ? `${record.value.project_id}:v${record.value.baseline_version}`
          : record.kind === "agent_run"
            ? record.value.run_id
            : record.kind === "agent_session_binding"
              ? record.value.binding_id
              : record.kind === "approval_request"
                ? record.value.approval_id
                : "unused";
  const eventType =
    record.expected_revision === 0
      ? (
          {
            task: "task.created",
            task_version: "task_version.recorded",
            project_baseline: "project_baseline.recorded",
            agent_run: "agent_run.created",
            agent_session_binding: "agent_session_binding.recorded",
            approval_request: "approval_request.recorded",
          } as const
        )[
          record.kind as
            | "task"
            | "task_version"
            | "project_baseline"
            | "agent_run"
            | "agent_session_binding"
            | "approval_request"
        ]
      : record.kind === "agent_run"
        ? "agent_run.updated"
        : "task.status_changed";
  return {
    event_id: `event-${key}-${index}`,
    event_version: 1,
    event_type: eventType,
    aggregate: { kind: record.kind, id, revision: record.expected_revision + 1 },
    occurred_at:
      "updated_at" in record.value && typeof record.value.updated_at === "string"
        ? record.value.updated_at
        : STARTED_AT,
    audit: {
      actor: { kind: "system", id: "test" },
      operation,
      request_id: changeId,
      correlation_id: changeId,
      idempotency_key: key,
      ...("task_id" in record.value ? { task_id: record.value.task_id } : {}),
      ...("task_version" in record.value ? { task_version: record.value.task_version } : {}),
      ...("run_id" in record.value ? { run_id: record.value.run_id } : {}),
    },
    payload: { kind: record.kind },
  };
}

function preconditions(
  eventCursor: string,
  idempotencyKey = "idempotency-1",
  targetRevision = 1,
): ManagementCommandPreconditions {
  return {
    session_id: "session-mcp",
    event_cursor: eventCursor,
    target_revision: targetRevision,
    idempotency_key: idempotencyKey,
  };
}

function incrementalId(): () => string {
  let value = 0;
  return () => `management-id-${++value}`;
}

function incrementalToken(): () => string {
  let value = 0;
  return () => `confirmation-token-${++value}`;
}
