import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  assembleContextPackage,
  computeContentHash,
  computeDocumentContentHash,
  redactSensitiveContent,
  transitionAgentRunStatus,
  transitionAgentSessionBinding,
  transitionTask,
  type ArtifactRepository,
  type DomainRepository,
} from "@agent-bridge/core";
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
  IndependentVerificationRunner,
  type LeaseManager,
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

type AgentEvent = import("@agent-bridge/driver-protocol").AgentEvent;
type EventListener = (runId: string, event: AgentEvent) => Promise<void>;

export class LocalBridgeRuntime implements BridgeRuntimePort {
  private readonly git = new DefaultGitClient({ executable: "/usr/bin/git" });
  private readonly worktrees: GitWorktreeManager;
  private listener?: EventListener;
  private readonly runWorktrees = new Map<
    string,
    { readonly path: string; readonly task_version: import("@agent-bridge/schemas").TaskVersion }
  >();

  constructor(
    private readonly repository: DomainRepository,
    private readonly activeRuns: ActiveRunRegistry,
    private readonly configuration: AgentBridgeRuntimeConfiguration,
    leases: LeaseManager,
    private readonly artifacts: ArtifactRepository,
  ) {
    this.worktrees = new GitWorktreeManager(this.git, leases);
  }

  setEventListener(listener: EventListener): void {
    this.listener = listener;
  }

  async recoverPersistedRuns(): Promise<void> {
    const candidates = await this.repository.listRecoveryCandidates({
      project_id: this.configuration.project.id,
    });
    for (const candidate of candidates) {
      try {
        await this.recoverPersistedRun(candidate.value.run_id);
      } catch (error) {
        await this.interruptRecoveryCandidate(
          candidate.value.run_id,
          recoveryFailureCode(error),
          recoveryFailureStage(error),
        );
      }
    }
  }

  async cleanupResources(runId: string, reason: string): Promise<void> {
    await this.cleanupTerminalResources(runId, reason);
  }

  async start(request: BridgeStartRequest): Promise<BridgeStartResult> {
    const context = await this.repository.getContextPackage(request.context_package_id);
    if (context === undefined || context.value.target_session_id === undefined) {
      throw controlError("CONTEXT_PACKAGE_SCOPE_INVALID");
    }
    const existing = await this.repository.getAgentRun(context.value.run_id);
    if (existing?.value.status === "running" && this.activeRuns.get(existing.value.run_id)) {
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
      (await this.worktrees.ensure({
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
        runtime_metadata: {
          worktree_path: ownership.worktreePath,
          worktree_branch: ownership.branch,
          worktree_base_commit: ownership.baseCommit,
          lease_id: ownership.lease.leaseId,
          lease_expires_at: ownership.lease.expiresAt,
        },
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
        this.listener === undefined
          ? undefined
          : async (active, driverEvent) => {
              try {
                await this.handleAgentEvent(active, driverEvent);
              } catch (error) {
                await this.interruptRecoveryCandidate(active.run_id, recoveryFailureCode(error));
                throw error;
              }
            },
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
    const verification = await new IndependentVerificationRunner(
      new ProcessSupervisor(),
      this.artifacts,
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
    recoveryStates?: readonly import("@agent-bridge/driver-protocol").JsonObject[],
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
        ...(recoveryStates === undefined ? {} : { recoveryStates }),
      },
      requestTimeoutMs: config.request_timeout_ms,
    });
  }

  private async recoverPersistedRun(runId: string): Promise<void> {
    const run = await this.repository.getAgentRun(runId);
    if (run === undefined || run.value.status !== "running") {
      throw recoveryDenied("RUN_NOT_RUNNING");
    }
    const [taskVersion, bindings] = await Promise.all([
      this.repository.getTaskVersion({
        task_id: run.value.task_id,
        task_version: run.value.task_version,
      }),
      this.repository.listAgentSessionBindings(runId),
    ]);
    const activeBindings = bindings.filter((item) => item.value.status === "ACTIVE");
    const binding = activeBindings[0];
    if (
      taskVersion === undefined ||
      taskVersion.value.project_id !== run.value.project_id ||
      activeBindings.length !== 1 ||
      binding === undefined ||
      binding.value.task_id !== run.value.task_id ||
      binding.value.task_version !== run.value.task_version ||
      binding.value.run_id !== runId ||
      binding.value.driver_id !== run.value.driver_id ||
      binding.value.role !== run.value.role
    )
      throw recoveryDenied("PERSISTED_SCOPE_MISMATCH");

    const worktreePath = metadataString(run.value.metadata, "worktree_path");
    const checkpoint = metadataRecord(run.value.metadata, "recovery_checkpoint");
    const artifactId = metadataString(checkpoint, "artifact_id");
    const contentHash = metadataString(checkpoint, "content_hash");
    const externalRunId =
      metadataString(checkpoint, "external_run_id") ??
      metadataString(run.value.metadata, "external_driver_run_id");
    const externalSessionId =
      metadataString(binding.value.metadata, "external_driver_session_id") ??
      binding.value.external_session_id;
    if (
      worktreePath === undefined ||
      artifactId === undefined ||
      contentHash === undefined ||
      externalRunId === undefined
    ) {
      throw recoveryDenied("CHECKPOINT_POINTER_MISSING");
    }
    const artifactMetadata = await this.artifacts.getMetadata(artifactId);
    if (
      artifactMetadata?.content_hash !== contentHash ||
      artifactMetadata.kind !== "driver.recovery-checkpoint" ||
      artifactMetadata.media_type !== "application/json"
    )
      throw recoveryDenied("CHECKPOINT_METADATA_INVALID");
    const recoveryState = await readJsonArtifact(this.artifacts, artifactId);
    if (metadataString(recoveryState, "runId") !== externalRunId) {
      throw recoveryDenied("CHECKPOINT_RUN_MISMATCH");
    }

    const worktreesRoot = resolve(this.configuration.project.runtime_root, "worktrees");
    const [canonicalWorktreePath, canonicalWorktreesRoot] = await Promise.all([
      realpath(worktreePath),
      realpath(worktreesRoot),
    ]);
    if (canonicalWorktreePath !== resolve(canonicalWorktreesRoot, basename(worktreePath))) {
      throw recoveryDenied("WORKTREE_PATH_INVALID");
    }
    const ownership = await this.worktrees.adopt({
      repositoryPath: this.configuration.project.workspace_root,
      worktreesRoot,
      worktreeName: basename(worktreePath),
      branch: taskVersion.value.git.branch,
      sourceRef: "HEAD",
      baseCommit: taskVersion.value.base_commit,
      taskId: taskVersion.value.task_id,
      taskVersion: taskVersion.value.task_version,
      runId,
      leaseTtlMs: taskVersion.value.limits.timeout_seconds * 1_000,
    });
    try {
      await this.worktrees.validateDiff({
        worktreePath: ownership.worktreePath,
        baseCommit: taskVersion.value.base_commit,
        ownerId: runId,
        role: taskVersion.value.role,
        scope: taskVersion.value.scope,
      });
      const driverConfig =
        run.value.driver_id === this.configuration.drivers.primary.id
          ? this.configuration.drivers.primary
          : this.configuration.drivers.fallback;
      if (
        driverConfig.id !== run.value.driver_id ||
        (driverConfig.id === "claude-agent" && !driverConfig.enabled) ||
        driverConfig.executable === undefined
      ) {
        throw recoveryDenied("DRIVER_CONFIGURATION_MISMATCH");
      }
      const driver = await this.createDriver(ownership.worktreePath, driverConfig, [recoveryState]);
      try {
        const [health, capabilities] = await Promise.all([
          driver.healthCheck(),
          driver.describeCapabilities(),
        ]);
        if (
          health.status !== "healthy" ||
          capabilities.driver.id !== run.value.driver_id ||
          !hasRequiredCapabilities(capabilities) ||
          !capabilities.sessions.resume
        ) {
          throw recoveryDenied("DRIVER_CAPABILITY_MISMATCH");
        }
        const resumed = await driver.resumeTask({
          protocolVersion: DRIVER_PROTOCOL_VERSION,
          runId: externalRunId,
          sessionId: externalSessionId,
          reason: "Bridge process restart recovery",
        });
        if (resumed.runId !== externalRunId || resumed.state !== "running") {
          throw recoveryDenied("DRIVER_RESUME_RESULT_INVALID");
        }
        await this.recordRecoverySucceeded(
          runId,
          ownership.lease.leaseId,
          ownership.lease.expiresAt,
        );
        this.runWorktrees.set(runId, {
          path: ownership.worktreePath,
          task_version: taskVersion.value,
        });
        this.activeRuns.register(
          {
            run_id: runId,
            binding: binding.value,
            external_run_id: externalRunId,
            external_session_id: resumed.session.externalSessionId,
            driver,
          },
          this.listener === undefined
            ? undefined
            : async (active, driverEvent) => {
                try {
                  await this.handleAgentEvent(active, driverEvent);
                } catch (error) {
                  await this.interruptRecoveryCandidate(active.run_id, recoveryFailureCode(error));
                  throw error;
                }
              },
        );
      } catch (error) {
        await driver.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      this.worktrees.release(ownership.worktreePath, runId);
      throw error;
    }
  }

  private async interruptRecoveryCandidate(
    runId: string,
    failureCode: string,
    failureStage?: string,
  ): Promise<void> {
    const run = await this.repository.getAgentRun(runId);
    if (
      run === undefined ||
      !["created", "running", "waiting_permission", "cancelling"].includes(run.value.status)
    ) {
      return;
    }
    const [task, bindings] = await Promise.all([
      this.repository.getTask(run.value.task_id),
      this.repository.listAgentSessionBindings(runId),
    ]);
    const activeBinding = bindings.find((item) => item.value.status === "ACTIVE");
    const now = new Date().toISOString();
    const terminalStatus =
      run.value.status === "created"
        ? transitionAgentRunStatus(run.value.status, "FAIL")
        : transitionAgentRunStatus(run.value.status, "INTERRUPT");
    const records: import("@agent-bridge/core").DomainRecordWrite[] = [
      {
        kind: "agent_run",
        expected_revision: run.revision,
        value: {
          ...run.value,
          status: terminalStatus,
          updated_at: now,
          started_at: run.value.started_at ?? run.value.created_at,
          finished_at: now,
          metadata: {
            ...run.value.metadata,
            recovery_status: "unsafe_to_resume",
            recovery_failure_code: failureCode,
            ...(failureStage === undefined ? {} : { recovery_failure_stage: failureStage }),
            partial_worktree_retained: true,
          },
        },
      },
    ];
    if (activeBinding !== undefined) {
      records.push({
        kind: "agent_session_binding",
        expected_revision: activeBinding.revision,
        value: transitionAgentSessionBinding(activeBinding.value, "FAIL", now),
      });
    }
    if (task !== undefined && ["RUNNING", "WAITING_APPROVAL"].includes(task.value.status)) {
      records.push({
        kind: "task",
        expected_revision: task.revision,
        value: transitionTask(task.value, "INTERRUPT", now),
      });
    }
    const requestId = stableId("request", `recovery-failed:${runId}`);
    await this.repository.commit({
      change_id: requestId,
      idempotency: {
        operation: "bridge_interrupt_unrecoverable_run",
        key: `recovery-failed:${runId}`,
        request_hash: computeContentHash({ run_id: runId, failure_code: failureCode }),
      },
      records,
      events: records.map((record, index) => ({
        event_id: stableId("event", `recovery-failed:${runId}:${index}`),
        event_version: 1,
        event_type:
          record.kind === "task"
            ? "task.status_changed"
            : record.kind === "agent_session_binding"
              ? "agent_session_binding.status_changed"
              : "agent_run.status_changed",
        aggregate: {
          kind: record.kind,
          id:
            record.kind === "task"
              ? record.value.task_id
              : record.kind === "agent_session_binding"
                ? record.value.binding_id
                : (record.value as import("@agent-bridge/core").AgentRunRecord).run_id,
          revision: record.expected_revision + 1,
        },
        occurred_at: now,
        audit: {
          actor: { kind: "system", id: "bridge-recovery" },
          operation: "bridge_interrupt_unrecoverable_run",
          request_id: requestId,
          correlation_id: runId,
          idempotency_key: `recovery-failed:${runId}`,
          task_id: run.value.task_id,
          task_version: run.value.task_version,
          run_id: runId,
        },
        payload: {
          recovery_status: "unsafe_to_resume",
          failure_code: failureCode,
          ...(failureStage === undefined ? {} : { failure_stage: failureStage }),
        },
      })),
    });
  }

  private async checkpointAgentEvent(
    runId: string,
    externalRunId: string,
    driverEvent: AgentEvent,
  ): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (active?.driver.exportRecoveryState === undefined) return;
    const run = await this.repository.getAgentRun(runId);
    if (
      run === undefined ||
      !["running", "waiting_permission", "cancelling"].includes(run.value.status)
    ) {
      return;
    }
    const priorCheckpoint = metadataRecord(run.value.metadata, "recovery_checkpoint");
    if (metadataString(priorCheckpoint, "driver_event_id") === driverEvent.eventId) return;
    if (await this.hasPersistedCheckpointEvent(runId, driverEvent.eventId)) return;

    let recovery: import("@agent-bridge/schemas").DomainJsonValue;
    try {
      recovery = redactSensitiveContent(
        asJsonObject(await active.driver.exportRecoveryState(externalRunId)),
      );
    } catch {
      // A terminal Driver may close recovery export before its buffered terminal event is consumed.
      // Keep the last durable checkpoint and continue consuming the authoritative event stream.
      return;
    }
    const safeEvent = redactSensitiveContent(asJsonObject(driverEvent));

    const artifactId = stableId("recovery", `${runId}:${driverEvent.eventId}`);
    const existingArtifact = await this.artifacts.getMetadata(artifactId);
    const artifact =
      existingArtifact ??
      (
        await this.artifacts.put({
          artifact_id: artifactId,
          kind: "driver.recovery-checkpoint",
          content: new TextEncoder().encode(JSON.stringify(recovery)),
          media_type: "application/json",
          retention_class: "audit",
          created_at: driverEvent.occurredAt,
          metadata: {
            run_id: runId,
            driver_event_id: driverEvent.eventId,
            agent_run_revision: run.revision + 1,
          },
        })
      ).artifact;
    const updated = {
      ...run.value,
      updated_at: driverEvent.occurredAt,
      metadata: {
        ...run.value.metadata,
        recovery_checkpoint: {
          artifact_id: artifact.artifact_id,
          content_hash: artifact.content_hash,
          driver_event_id: driverEvent.eventId,
          external_run_id: externalRunId,
          created_at: artifact.created_at,
        },
      },
    };
    const requestId = stableId("request", `checkpoint:${runId}:${driverEvent.eventId}`);
    await this.repository.commit({
      change_id: requestId,
      idempotency: {
        operation: "bridge_checkpoint_agent_event",
        key: `checkpoint:${runId}:${driverEvent.eventId}`,
        request_hash: computeContentHash({
          run_id: runId,
          driver_event_id: driverEvent.eventId,
          content_hash: artifact.content_hash,
        }),
      },
      records: [{ kind: "agent_run", expected_revision: run.revision, value: updated }],
      events: [
        {
          event_id: stableId("event", `checkpoint:${runId}:${driverEvent.eventId}`),
          event_version: 1,
          event_type: "agent_run.updated",
          aggregate: { kind: "agent_run", id: runId, revision: run.revision + 1 },
          occurred_at: driverEvent.occurredAt,
          audit: {
            actor: { kind: "driver", id: run.value.driver_id },
            operation: "bridge_checkpoint_agent_event",
            request_id: requestId,
            correlation_id: runId,
            causation_id: driverEvent.eventId,
            idempotency_key: `checkpoint:${runId}:${driverEvent.eventId}`,
            task_id: run.value.task_id,
            task_version: run.value.task_version,
            run_id: runId,
          },
          payload: { driver_event: safeEvent, checkpoint_artifact_id: artifactId },
        },
      ],
    });
  }

  private async hasPersistedCheckpointEvent(
    runId: string,
    driverEventId: string,
  ): Promise<boolean> {
    let afterCursor: string | undefined;
    while (true) {
      const page = await this.repository.listDomainEvents({
        run_id: runId,
        ...(afterCursor === undefined ? {} : { after_cursor: afterCursor }),
        limit: 200,
      });
      if (
        page.events.some(
          (event) =>
            event.audit.operation === "bridge_checkpoint_agent_event" &&
            event.audit.causation_id === driverEventId,
        )
      ) {
        return true;
      }
      if (page.events.length < 200) return false;
      afterCursor = page.next_cursor;
    }
  }

  private async recordRecoverySucceeded(
    runId: string,
    leaseId: string,
    leaseExpiresAt: string,
  ): Promise<void> {
    const run = await this.repository.getAgentRun(runId);
    if (run === undefined) throw controlError("RECOVERY_NOT_ALLOWED");
    const now = new Date().toISOString();
    const attempt = metadataPositiveInteger(run.value.metadata, "recovery_attempt") + 1;
    const idempotencyKey = `recovery-succeeded:${runId}:${attempt}`;
    const requestId = stableId("request", idempotencyKey);
    await this.repository.commit({
      change_id: requestId,
      idempotency: {
        operation: "bridge_resume_persisted_run",
        key: idempotencyKey,
        request_hash: computeContentHash({ run_id: runId, lease_id: leaseId, attempt }),
      },
      records: [
        {
          kind: "agent_run",
          expected_revision: run.revision,
          value: {
            ...run.value,
            updated_at: now,
            metadata: {
              ...run.value.metadata,
              recovery_status: "resumed",
              recovery_attempt: attempt,
              recovery_resumed_at: now,
              lease_id: leaseId,
              lease_expires_at: leaseExpiresAt,
            },
          },
        },
      ],
      events: [
        {
          event_id: stableId("event", idempotencyKey),
          event_version: 1,
          event_type: "agent_run.updated",
          aggregate: { kind: "agent_run", id: runId, revision: run.revision + 1 },
          occurred_at: now,
          audit: {
            actor: { kind: "system", id: "bridge-recovery" },
            operation: "bridge_resume_persisted_run",
            request_id: requestId,
            correlation_id: runId,
            idempotency_key: idempotencyKey,
            task_id: run.value.task_id,
            task_version: run.value.task_version,
            run_id: runId,
          },
          payload: { recovery_status: "resumed", recovery_attempt: attempt, lease_id: leaseId },
        },
      ],
    });
  }

  private async handleAgentEvent(
    active: import("@agent-bridge/worker-runtime").ActiveRunHandle,
    driverEvent: AgentEvent,
  ): Promise<void> {
    if (["run.completed", "run.failed", "run.cancelled"].includes(driverEvent.type)) {
      try {
        await this.listener?.(active.run_id, driverEvent);
      } finally {
        void this.cleanupTerminalResources(active.run_id, driverEvent.type).catch(() => undefined);
      }
      return;
    }
    await this.checkpointAgentEvent(active.run_id, active.external_run_id, driverEvent);
    await this.listener?.(active.run_id, driverEvent);
  }

  private async cleanupTerminalResources(runId: string, reason: string): Promise<void> {
    const managed = this.runWorktrees.get(runId);
    await this.activeRuns.close(runId);
    let leaseReleased = false;
    if (managed !== undefined) {
      this.worktrees.release(managed.path, runId);
      leaseReleased = true;
    }
    const run = await this.repository.getAgentRun(runId);
    if (run === undefined) {
      this.runWorktrees.delete(runId);
      return;
    }
    const priorCleanup = metadataRecord(run.value.metadata, "resource_cleanup");
    if (priorCleanup?.driver_closed === true) {
      this.runWorktrees.delete(runId);
      return;
    }
    const now = new Date().toISOString();
    const requestId = stableId("request", `cleanup:${runId}:${reason}`);
    await this.repository.commit({
      change_id: requestId,
      idempotency: {
        operation: "bridge_cleanup_terminal_resources",
        key: `cleanup:${runId}:${reason}`,
        request_hash: computeContentHash({ run_id: runId, reason, lease_released: leaseReleased }),
      },
      records: [
        {
          kind: "agent_run",
          expected_revision: run.revision,
          value: {
            ...run.value,
            updated_at: now,
            metadata: {
              ...run.value.metadata,
              resource_cleanup: {
                driver_closed: true,
                lease_released: leaseReleased,
                worktree_retained: managed !== undefined,
                isolation_retained: true,
                reason,
                audited_at: now,
              },
            },
          },
        },
      ],
      events: [
        {
          event_id: stableId("event", `cleanup:${runId}:${reason}`),
          event_version: 1,
          event_type: "agent_run.updated",
          aggregate: { kind: "agent_run", id: runId, revision: run.revision + 1 },
          occurred_at: now,
          audit: {
            actor: { kind: "system", id: "bridge-cleanup" },
            operation: "bridge_cleanup_terminal_resources",
            request_id: requestId,
            correlation_id: runId,
            idempotency_key: `cleanup:${runId}:${reason}`,
            task_id: run.value.task_id,
            task_version: run.value.task_version,
            run_id: runId,
          },
          payload: {
            driver_closed: true,
            lease_released: leaseReleased,
            worktree_retained: managed !== undefined,
          },
        },
      ],
    });
    this.runWorktrees.delete(runId);
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

function metadataRecord(
  metadata: import("@agent-bridge/schemas").DomainMetadata | undefined,
  key: string,
): import("@agent-bridge/driver-protocol").JsonObject | undefined {
  const value = metadata?.[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? asJsonObject(value)
    : undefined;
}

function metadataString(
  metadata:
    | import("@agent-bridge/schemas").DomainMetadata
    | import("@agent-bridge/driver-protocol").JsonObject
    | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function metadataPositiveInteger(
  metadata: import("@agent-bridge/schemas").DomainMetadata | undefined,
  key: string,
): number {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

async function readJsonArtifact(
  artifacts: ArtifactRepository,
  artifactId: string,
): Promise<import("@agent-bridge/driver-protocol").JsonObject> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of await artifacts.read(artifactId)) chunks.push(chunk);
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return asJsonObject(JSON.parse(new TextDecoder().decode(merged)));
}

function recoveryFailureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "RECOVERY_DEPENDENCY_UNAVAILABLE";
}

function recoveryFailureStage(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "details" in error &&
    typeof error.details === "object" &&
    error.details !== null &&
    "recovery_stage" in error.details &&
    typeof error.details.recovery_stage === "string" &&
    /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.details.recovery_stage)
  ) {
    return error.details.recovery_stage;
  }
  return undefined;
}

function recoveryDenied(stage: string): ReturnType<typeof controlError> {
  return controlError("RECOVERY_NOT_ALLOWED", { recovery_stage: stage });
}
