import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assembleContextPackage,
  computeContentHash,
  computeDocumentContentHash,
  transitionAgentSessionBinding,
  type DomainRepository,
} from "@agent-bridge/core";
import { LocalArtifactRepository } from "@agent-bridge/artifacts-local";
import { DRIVER_PROTOCOL_VERSION, asJsonObject } from "@agent-bridge/driver-protocol";
import {
  DOMAIN_SCHEMA_VERSION,
  parseContinuationSnapshot,
  parseHandoffPackage,
  type AgentSessionBinding,
  type ApprovalRequest,
  type ContinuationSnapshot,
  type ProjectBaseline,
} from "@agent-bridge/schemas";
import {
  ActiveRunRegistry,
  DefaultGitClient,
  GitWorktreeManager,
  InMemoryLeaseManager,
  IndependentVerificationRunner,
  ProcessSupervisor,
  RunOrchestrator,
  StdioAgentDriverClient,
  hasRequiredCapabilities,
  type AgentBridgeRuntimeConfiguration,
  type RuntimeDriverConfiguration,
  type RuntimeAuditInput,
  type RuntimeDriverHandle,
} from "@agent-bridge/worker-runtime";

import type {
  BridgeRunOutcome,
  BridgeRuntimePort,
  BridgeStartRequest,
  BridgeStartResult,
} from "./bridge-control-service.js";
import { controlError } from "./errors.js";

type EventListener = (event: import("@agent-bridge/driver-protocol").AgentEvent) => Promise<void>;

export class LocalBridgeRuntime implements BridgeRuntimePort {
  private readonly git = new DefaultGitClient({ executable: "/usr/bin/git" });
  private readonly worktrees = new GitWorktreeManager(this.git, new InMemoryLeaseManager());
  private listener?: EventListener;
  private readonly runWorktrees = new Map<
    string,
    { readonly path: string; readonly task_version: import("@agent-bridge/schemas").TaskVersion }
  >();

  constructor(
    private readonly repository: DomainRepository,
    private readonly activeRuns: ActiveRunRegistry,
    private readonly configuration: AgentBridgeRuntimeConfiguration,
  ) {}

  setEventListener(listener: EventListener): void {
    this.listener = listener;
  }

  async start(request: BridgeStartRequest): Promise<BridgeStartResult> {
    const context = await this.repository.getContextPackage(request.context_package_id);
    if (context === undefined || context.value.target_session_id === undefined) {
      throw controlError("CONTEXT_PACKAGE_SCOPE_INVALID");
    }
    const existing = await this.repository.getAgentRun(context.value.run_id);
    if (existing?.value.status === "running") {
      const bindings = await this.repository.listAgentSessionBindings(existing.value.run_id);
      const binding = bindings.find((item) => item.value.status === "ACTIVE");
      if (binding === undefined) throw controlError("SESSION_BINDING_INVALID");
      return {
        run_id: existing.value.run_id,
        session_id: binding.value.session_id,
        binding_id: binding.value.binding_id,
        status: "RUNNING",
      };
    }
    const worktreesRoot = resolve(this.configuration.project.runtime_root, "worktrees");
    await mkdir(worktreesRoot, { recursive: true });
    const runId = context.value.run_id;
    const pending = this.runWorktrees.get(runId);
    const existingOwnership =
      pending === undefined ? undefined : this.worktrees.getOwnership(pending.path);
    const ownership =
      existingOwnership ??
      (await this.worktrees.create({
        repositoryPath: this.configuration.project.workspace_root,
        worktreesRoot,
        worktreeName: `${request.task_version.task_id}-v${request.task_version.task_version}-${runId.slice(0, 8)}`,
        branch: request.task_version.git.branch,
        sourceRef: "HEAD",
        baseCommit: request.task_version.base_commit,
        taskId: request.task_version.task_id,
        taskVersion: request.task_version.task_version,
        runId,
        leaseTtlMs: request.task_version.limits.timeout_seconds * 1_000,
      }));
    if (pending === undefined) {
      this.runWorktrees.set(runId, {
        path: ownership.worktreePath,
        task_version: request.task_version,
      });
    }
    let inspected: StdioAgentDriverClient | undefined;
    try {
      let primaryHealth: import("@agent-bridge/driver-protocol").HealthStatus | undefined;
      let primaryCapabilities:
        import("@agent-bridge/driver-protocol").AgentCapabilities | undefined;
      try {
        inspected = await this.createDriver(
          ownership.worktreePath,
          this.configuration.drivers.primary,
        );
        [primaryHealth, primaryCapabilities] = await Promise.all([
          inspected.healthCheck(),
          inspected.describeCapabilities(),
        ]);
      } catch {
        await inspected?.close().catch(() => undefined);
        inspected = undefined;
      }
      const scope = {
        task_id: request.task_version.task_id,
        task_version: request.task_version.task_version,
        planned_run_id: runId,
      };
      let selection: import("@agent-bridge/worker-runtime").StartSelectedRunRequest["selection"];
      let selectedDriverId: "opencode" | "claude-agent";
      if (
        primaryHealth?.status === "healthy" &&
        primaryCapabilities !== undefined &&
        hasRequiredCapabilities(primaryCapabilities)
      ) {
        selectedDriverId = "opencode";
        selection = {
          action: "USE_PRIMARY",
          driver_id: "opencode",
          scope,
          health: primaryHealth,
          capabilities: primaryCapabilities,
        };
      } else {
        await inspected?.close().catch(() => undefined);
        inspected = undefined;
        const fallbackConfig = this.configuration.drivers.fallback;
        if (!fallbackConfig.enabled || fallbackConfig.executable === undefined) {
          throw controlError("NO_DRIVER_AVAILABLE");
        }
        inspected = await this.createDriver(ownership.worktreePath, fallbackConfig);
        const [fallbackHealth, fallbackCapabilities] = await Promise.all([
          inspected.healthCheck(),
          inspected.describeCapabilities(),
        ]);
        if (fallbackHealth.status !== "healthy" || !hasRequiredCapabilities(fallbackCapabilities)) {
          throw controlError("NO_DRIVER_AVAILABLE");
        }
        const approvals = await this.repository.listApprovalRequests({
          run_id: runId,
          status: "approved",
        });
        const approved = approvals.find(
          (item) => item.value.operation === "driver.fallback",
        )?.value;
        if (approved === undefined) {
          await inspected.close().catch(() => undefined);
          inspected = undefined;
          const requestedAt = new Date().toISOString();
          const approval: ApprovalRequest = {
            schema_version: DOMAIN_SCHEMA_VERSION,
            approval_id: stableId("approval", runId),
            task_id: request.task_version.task_id,
            task_version: request.task_version.task_version,
            run_id: runId,
            session_id: context.value.target_session_id,
            kind: "control_operation",
            operation: "driver.fallback",
            request_hash: computeContentHash({
              run_id: runId,
              primary_health: primaryHealth?.status ?? "inspection_failed",
              fallback_health: fallbackHealth.status,
            }),
            status: "pending",
            requested_at: requestedAt,
            metadata: {
              primary_health: primaryHealth?.status ?? "inspection_failed",
              fallback_driver_id: "claude-agent",
            },
          };
          return { status: "APPROVAL_REQUIRED", approval };
        }
        selectedDriverId = "claude-agent";
        selection = {
          action: "USE_FALLBACK",
          driver_id: "claude-agent",
          scope,
          reason: "PRIMARY_UNHEALTHY",
          decision_id: approved.approval_id,
          confirmation: {
            decision_id: approved.approval_id,
            task_id: approved.task_id,
            task_version: approved.task_version,
            planned_run_id: approved.run_id,
            actor: { kind: "codex", id: "bridge-mcp" },
            reason: approved.reason ?? "Approved fallback",
            confirmed_at: approved.decided_at!,
          },
          fallback_health: fallbackHealth,
          fallback_capabilities: fallbackCapabilities,
        };
      }
      const factory = {
        driver_id: selectedDriverId,
        create: async (): Promise<RuntimeDriverHandle> => {
          if (inspected !== undefined) return inspected;
          const configuration =
            selectedDriverId === "opencode"
              ? this.configuration.drivers.primary
              : this.configuration.drivers.fallback;
          inspected = await this.createDriver(ownership.worktreePath, configuration);
          return inspected;
        },
      };
      const orchestrator = new RunOrchestrator(this.repository, [factory]);
      const now = new Date().toISOString();
      const result = await orchestrator.start({
        run_id: runId,
        session_id: context.value.target_session_id,
        binding_id: randomUUID(),
        task_version: request.task_version,
        context_package: context.value,
        role: request.task_version.role,
        selection,
        prepare_idempotency_key: `${request.idempotency_key}:prepare`,
        create_audit: audit("bridge_start_task_create", `${request.idempotency_key}:create`, now),
        outcome_audit: audit(
          "bridge_start_task_outcome",
          `${request.idempotency_key}:outcome`,
          new Date().toISOString(),
        ),
        session_event_id: randomUUID(),
      });
      if (result.status !== "RUNNING") throw controlError(result.failure_code);
      this.activeRuns.register(
        {
          run_id: runId,
          binding: result.binding,
          external_run_id: result.external.runId,
          external_session_id: result.external.session.externalSessionId,
          driver: result.driver,
        },
        this.listener === undefined ? undefined : async (_run, event) => this.listener?.(event),
      );
      return {
        run_id: runId,
        session_id: result.binding.session_id,
        binding_id: result.binding.binding_id,
        status: "RUNNING",
      };
    } catch (error) {
      await inspected?.close().catch(() => undefined);
      this.worktrees.release(ownership.worktreePath, runId);
      this.runWorktrees.delete(runId);
      throw error;
    }
  }

  async rollover(
    runId: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    const active = this.activeRuns.require(runId);
    const [run, taskVersion, sourceContext, snapshots] = await Promise.all([
      this.repository.getAgentRun(runId),
      this.repository.getTaskVersion({
        task_id: active.binding.task_id,
        task_version: active.binding.task_version,
      }),
      this.repository.getContextPackage(active.binding.context_package_id),
      this.repository.listContinuationSnapshots(runId),
    ]);
    if (run === undefined || taskVersion === undefined || sourceContext === undefined) {
      throw controlError("ROLLOVER_STATE_INVALID");
    }
    const replay = snapshots.find(
      (item) => item.value.metadata?.idempotency_key === idempotencyKey,
    );
    if (replay !== undefined) {
      const bindings = await this.repository.listAgentSessionBindings(runId);
      const successor = bindings.find(
        (item) =>
          item.value.status === "ACTIVE" &&
          item.value.predecessor_session_id === replay.value.session_id,
      );
      if (successor === undefined) throw controlError("ROLLOVER_STATE_INVALID");
      return {
        run_id: runId,
        predecessor_session_id: replay.value.session_id,
        successor_session_id: successor.value.session_id,
        context_package_id: successor.value.context_package_id,
      };
    }
    const projectBaseline = await this.repository.getProjectBaseline(
      taskVersion.value.project_id,
      taskVersion.value.context_policy.project_baseline_version,
    );
    if (projectBaseline === undefined) throw controlError("PROJECT_BASELINE_NOT_FOUND");
    const now = new Date().toISOString();
    const snapshotBase = {
      schema_version: DOMAIN_SCHEMA_VERSION,
      snapshot_id: randomUUID(),
      snapshot_version: snapshots.length + 1,
      task_id: taskVersion.value.task_id,
      task_version: taskVersion.value.task_version,
      run_id: runId,
      session_id: active.binding.session_id,
      source_context_package_id: sourceContext.value.context_package_id,
      source_context_package_hash: sourceContext.value.content_hash,
      current_step: reason,
      completed: [],
      remaining_plan: ["Continue the current task in the successor session."],
      git_state: {
        repository_id: this.configuration.project.id,
        base_commit: taskVersion.value.base_commit,
        head_commit: taskVersion.value.base_commit,
        changed_files: [],
      },
      recent_verification: [],
      blockers: [],
      next_actions: [reason],
      artifact_ids: [],
      created_at: now,
      metadata: { idempotency_key: idempotencyKey },
    };
    const snapshot: ContinuationSnapshot = parseContinuationSnapshot({
      ...snapshotBase,
      content_hash: computeDocumentContentHash(snapshotBase),
    });
    const successorSessionId = stableId("session", idempotencyKey);
    const handoffSelection = await this.rebuildHandoffSelection(
      taskVersion.value,
      sourceContext.value,
    );
    const assembled = assembleContextPackage({
      scenario: "SESSION_ROLLOVER",
      context_package_id: stableId("context", idempotencyKey),
      task_version: taskVersion.value,
      run_id: runId,
      target_session_id: successorSessionId,
      created_at: now,
      project_baseline: baselineInput(projectBaseline.value),
      ...(handoffSelection === undefined ? {} : { handoff_selection: handoffSelection }),
      continuation_snapshot: snapshot,
      predecessor_session_id: active.binding.session_id,
    });
    const external = await active.driver.createSuccessorSession({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: active.external_run_id,
      predecessorSessionId: active.external_session_id,
      reason,
      context: asJsonObject(assembled.context_package),
    });
    const oldBinding = transitionAgentSessionBinding(active.binding, "REQUEST_ROLLOVER", now);
    const superseded = transitionAgentSessionBinding(oldBinding, "SUPERSEDE", now);
    const successor: AgentSessionBinding = {
      ...active.binding,
      binding_id: stableId("binding", idempotencyKey),
      session_id: successorSessionId,
      external_session_id: external.externalSessionId,
      predecessor_session_id: active.binding.session_id,
      status: "ACTIVE",
      context_package_id: assembled.context_package.context_package_id,
      context_package_hash: assembled.context_package.content_hash,
      created_at: now,
    };
    await this.repository.commit({
      change_id: stableId("change", idempotencyKey),
      idempotency: {
        operation: "bridge_rollover_session",
        key: idempotencyKey,
        request_hash: computeContentHash({
          run_id: runId,
          reason,
          successor_session_id: successorSessionId,
        }),
      },
      records: [
        { kind: "agent_session_binding", expected_revision: 1, value: superseded },
        { kind: "agent_session_binding", expected_revision: 0, value: successor },
        { kind: "continuation_snapshot", expected_revision: 0, value: snapshot },
        { kind: "context_package", expected_revision: 0, value: assembled.context_package },
      ],
      events: [
        event(
          "agent_session_binding.status_changed",
          "agent_session_binding",
          superseded.binding_id,
          2,
          now,
          runId,
        ),
        event(
          "agent_session_binding.recorded",
          "agent_session_binding",
          successor.binding_id,
          1,
          now,
          runId,
        ),
        event(
          "continuation_snapshot.recorded",
          "continuation_snapshot",
          `${snapshot.snapshot_id}:v${snapshot.snapshot_version}`,
          1,
          now,
          runId,
        ),
        event(
          "context_package.recorded",
          "context_package",
          assembled.context_package.context_package_id,
          1,
          now,
          runId,
        ),
      ],
    });
    this.activeRuns.replaceBinding(runId, successor, external.externalSessionId);
    return {
      run_id: runId,
      predecessor_session_id: active.binding.session_id,
      successor_session_id: successor.session_id,
      context_package_id: successor.context_package_id,
    };
  }

  async collectOutcome(runId: string): Promise<BridgeRunOutcome> {
    const managed = this.runWorktrees.get(runId);
    if (managed === undefined) throw controlError("ACTIVE_RUN_NOT_FOUND");
    const [result, diff, head] = await Promise.all([
      this.activeRuns.collectResult(runId),
      this.worktrees.validateDiff({
        worktreePath: managed.path,
        baseCommit: managed.task_version.base_commit,
        ownerId: runId,
        role: managed.task_version.role,
        scope: managed.task_version.scope,
      }),
      this.git.run(managed.path, ["rev-parse", "--verify", "HEAD"]),
    ]);
    if (result.status !== "succeeded") throw controlError("DRIVER_RESULT_INVALID");
    const artifacts = await LocalArtifactRepository.open({
      root_path: resolve(this.configuration.project.runtime_root, "artifacts"),
    });
    const verification = await new IndependentVerificationRunner(
      new ProcessSupervisor(),
      artifacts,
    ).start({
      verification_id: stableId("verification", runId),
      run_id: runId,
      worktree_path: managed.path,
      acceptance_commands: managed.task_version.acceptance_commands,
      command_catalog: this.configuration.verification.commands,
      initiator: { kind: "bridge", id: "bridge-mcp" },
      environment: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: process.env.LANG ?? "C.UTF-8",
      },
      max_output_bytes: this.configuration.verification.max_output_bytes,
      termination_grace_ms: this.configuration.verification.termination_grace_ms,
    }).result;
    return {
      commit_sha: head.stdout.toString("utf8").trim(),
      changed_files: diff.changedFiles,
      result,
      verification,
    };
  }

  private async rebuildHandoffSelection(
    taskVersion: import("@agent-bridge/schemas").TaskVersion,
    context: import("@agent-bridge/schemas").ContextPackage,
  ) {
    const selectedIds = taskVersion.selected_handoff_ids ?? [];
    if (selectedIds.length === 0) return undefined;
    const handoffs = await Promise.all(
      selectedIds.map(async (handoffId) => {
        const component = context.components.find(
          (item) => item.kind === "handoff" && item.component_id === handoffId,
        );
        if (component === undefined) throw controlError("HANDOFF_INTEGRITY_ERROR");
        const handoff = parseHandoffPackage(component.content);
        const reference = taskVersion.relations?.find(
          (item) =>
            item.target.task_id === handoff.source_task.task_id &&
            item.target.task_version === handoff.source_task.task_version,
        );
        if (reference === undefined) throw controlError("HANDOFF_RELATION_MISSING");
        const relation = await this.repository.getTaskRelation(reference.relation_id);
        if (relation === undefined) throw controlError("HANDOFF_RELATION_MISSING");
        return { handoff, relation: relation.value };
      }),
    );
    return { handoffs, warnings: [] } as const;
  }

  private async createDriver(
    workDirectory: string,
    config: RuntimeDriverConfiguration,
  ): Promise<StdioAgentDriverClient> {
    const isolationRoot = resolve(
      this.configuration.project.runtime_root,
      "isolation",
      config.id,
      stableId("worker", workDirectory),
    );
    const isolation = {
      homeDirectory: resolve(isolationRoot, "home"),
      tempDirectory: resolve(isolationRoot, "tmp"),
      configDirectory: resolve(isolationRoot, "xdg-config"),
      dataDirectory: resolve(isolationRoot, "xdg-data"),
      cacheDirectory: resolve(isolationRoot, "xdg-cache"),
      claudeConfigDirectory: resolve(isolationRoot, "claude-config"),
    };
    await Promise.all(Object.values(isolation).map((path) => mkdir(path, { recursive: true })));
    const path = process.env.PATH ?? "/usr/bin:/bin";
    const lang = process.env.LANG ?? "C.UTF-8";
    return StdioAgentDriverClient.start({
      supervisor: new ProcessSupervisor(),
      process: {
        processId: randomUUID(),
        command: config.executable!,
        args: config.args,
        cwd: workDirectory,
        environment: {
          HOME: isolation.homeDirectory,
          TMPDIR: isolation.tempDirectory,
          XDG_CONFIG_HOME: isolation.configDirectory,
          XDG_DATA_HOME: isolation.dataDirectory,
          XDG_CACHE_HOME: isolation.cacheDirectory,
          CLAUDE_CONFIG_DIR: isolation.claudeConfigDirectory,
          PATH: path,
          LANG: lang,
        },
        timeoutMs: this.configuration.limits.timeout_seconds * 1_000,
        terminationGraceMs: this.configuration.verification.termination_grace_ms,
      },
      initialization: {
        workDirectory,
        configuration:
          config.id === "claude-agent" ? { isolation: { ...isolation, path, lang } } : {},
      },
      requestTimeoutMs: config.request_timeout_ms,
    });
  }
}

function audit(operation: string, key: string, occurredAt: string): RuntimeAuditInput {
  return {
    actor: { kind: "bridge", id: "bridge-mcp" },
    operation,
    request_id: randomUUID(),
    correlation_id: randomUUID(),
    idempotency_key: key,
    event_id: randomUUID(),
    occurred_at: occurredAt,
  };
}

function baselineInput(value: ProjectBaseline) {
  return {
    component_id: `baseline:${value.project_id}:v${value.baseline_version}`,
    project_id: value.project_id,
    baseline_version: value.baseline_version,
    content: value.content,
    content_hash: value.content_hash,
  };
}

function event(
  type: import("@agent-bridge/core").AuthoritativeDomainEventType,
  kind: import("@agent-bridge/core").DomainAggregateKind,
  id: string,
  revision: number,
  occurredAt: string,
  runId: string,
): import("@agent-bridge/core").AuthoritativeDomainEvent {
  const requestId = randomUUID();
  return {
    event_id: randomUUID(),
    event_version: 1,
    event_type: type,
    aggregate: { kind, id, revision },
    occurred_at: occurredAt,
    audit: {
      actor: { kind: "bridge", id: "bridge-mcp" },
      operation: "bridge_rollover_session",
      request_id: requestId,
      correlation_id: requestId,
      idempotency_key: requestId,
      run_id: runId,
    },
    payload: { status: "recorded" },
  };
}

function stableId(prefix: string, key: string): string {
  return `${prefix}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}
