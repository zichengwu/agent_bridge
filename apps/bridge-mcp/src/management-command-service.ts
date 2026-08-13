import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  computeContentHash,
  decideApprovalRequest,
  getDomainRecordId,
  redactSensitiveContent,
  selectAgentSession,
  transitionAgentRunStatus,
  transitionAgentSessionBinding,
  transitionTask,
  type AuthoritativeDomainEvent,
  type DomainRecordWrite,
  type DomainRepository,
  type FailureSummaryInput,
} from "@agent-bridge/core";
import {
  type AgentSessionBinding,
  type ApprovalRequest,
  type DomainJsonValue,
  type Task,
} from "@agent-bridge/schemas";
import {
  ActiveRunRegistry,
  ContextHandoffRuntime,
  type RuntimeAuditInput,
} from "@agent-bridge/worker-runtime";

import type {
  BridgeCleanupInspection,
  BridgeCleanupResult,
  BridgeRuntimePort,
} from "./bridge-control-service.js";
import { controlError } from "./errors.js";

const CONFIRMATION_TTL_MS = 60_000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const ACTIVE_RUN_STATUSES = new Set(["running", "waiting_permission"] as const);
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"] as const);
const RETRYABLE_RUN_STATUSES = new Set(["failed", "cancelled", "interrupted"] as const);
const RETRYABLE_TASK_STATUSES = new Set(["FAILED", "CANCELLED", "INTERRUPTED"] as const);

export type ManagementRunAction = "retry" | "cancel" | "cleanup";

export interface ManagementCommandPreconditions {
  readonly session_id: string;
  readonly event_cursor: string;
  readonly target_revision: number;
  readonly idempotency_key: string;
}

export interface ManagementActionPreview {
  readonly action: ManagementRunAction;
  readonly run_id: string;
  readonly target_revision: number;
  readonly etag: string;
  readonly effects: readonly string[];
  readonly warnings: readonly string[];
  readonly cleanup?: BridgeCleanupInspection;
  readonly confirmation_token: string;
  readonly expires_at: string;
  readonly event_cursor: string;
}

export interface ManagementCommandServiceOptions {
  readonly repository: DomainRepository;
  readonly contexts: ContextHandoffRuntime;
  readonly active_runs: ActiveRunRegistry;
  readonly runtime: BridgeRuntimePort;
  readonly project_id: string;
  readonly repository_path: string;
  readonly server_instance_id?: string;
  readonly now?: () => Date;
  readonly create_id?: () => string;
  readonly create_token?: () => string;
}

interface ConfirmationRecord {
  readonly server_instance_id: string;
  readonly session_id: string;
  readonly action: ManagementRunAction;
  readonly run_id: string;
  readonly target_revision: number;
  readonly preview_hash: string;
  readonly expires_at_ms: number;
}

interface IdempotencyEntry {
  readonly request_hash: string;
  readonly expires_at_ms: number;
  readonly result: Promise<unknown>;
}

interface BuiltPreview {
  readonly action: ManagementRunAction;
  readonly run_id: string;
  readonly target_revision: number;
  readonly etag: string;
  readonly effects: readonly string[];
  readonly warnings: readonly string[];
  readonly cleanup?: BridgeCleanupInspection;
}

export class ManagementCommandService {
  readonly server_instance_id: string;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly createToken: () => string;
  private readonly confirmations = new Map<string, ConfirmationRecord>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();

  constructor(private readonly options: ManagementCommandServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.create_id ?? randomUUID;
    this.createToken = options.create_token ?? (() => randomBytes(32).toString("base64url"));
    this.server_instance_id = options.server_instance_id ?? randomUUID();
  }

  async previewRunAction(input: {
    readonly session_id: string;
    readonly action: ManagementRunAction;
    readonly run_id: string;
  }): Promise<ManagementActionPreview> {
    readIdentifier(input.session_id, "session_id");
    readIdentifier(input.run_id, "run_id");
    readAction(input.action);
    this.pruneMemoryState();
    const preview = await this.buildPreview(input.action, input.run_id);
    const eventCursor = await this.options.repository.getEventCursor();
    const previewHash = hashPreview(preview);
    const rawToken = this.createToken();
    const expiresAtMs = this.now().getTime() + CONFIRMATION_TTL_MS;
    this.confirmations.set(hashToken(rawToken), {
      server_instance_id: this.server_instance_id,
      session_id: input.session_id,
      action: input.action,
      run_id: input.run_id,
      target_revision: preview.target_revision,
      preview_hash: previewHash,
      expires_at_ms: expiresAtMs,
    });
    return Object.freeze({
      ...preview,
      confirmation_token: rawToken,
      expires_at: new Date(expiresAtMs).toISOString(),
      event_cursor: eventCursor,
    });
  }

  async confirmRunAction(input: {
    readonly action: ManagementRunAction;
    readonly run_id: string;
    readonly confirmation_token: string;
    readonly preconditions: ManagementCommandPreconditions;
  }): Promise<unknown> {
    const preconditions = readPreconditions(input.preconditions);
    readIdentifier(input.run_id, "run_id");
    readAction(input.action);
    if (typeof input.confirmation_token !== "string" || input.confirmation_token.length < 16) {
      throw controlError("CONFIRMATION_EXPIRED");
    }
    return this.executeIdempotent(
      `${preconditions.session_id}:run:${input.run_id}:action:${input.action}`,
      preconditions.idempotency_key,
      {
        action: input.action,
        run_id: input.run_id,
        confirmation_token_hash: hashToken(input.confirmation_token),
        event_cursor: preconditions.event_cursor,
        target_revision: preconditions.target_revision,
      },
      async () => {
        await this.assertEventCursor(preconditions.event_cursor);
        const confirmation = this.consumeConfirmation(input.confirmation_token, {
          session_id: preconditions.session_id,
          action: input.action,
          run_id: input.run_id,
          target_revision: preconditions.target_revision,
        });
        const preview = await this.buildPreview(input.action, input.run_id);
        if (
          preview.target_revision !== preconditions.target_revision ||
          hashPreview(preview) !== confirmation.preview_hash
        ) {
          throw controlError("CONFIRMATION_EXPIRED");
        }
        switch (input.action) {
          case "retry":
            return this.retryRun(input.run_id, preconditions);
          case "cancel":
            return this.cancelRun(input.run_id, preconditions);
          case "cleanup":
            return this.cleanupRun(input.run_id, preconditions, confirmation.preview_hash);
        }
      },
    );
  }

  async decideApproval(input: {
    readonly approval_id: string;
    readonly decision: "approve" | "reject";
    readonly feedback?: string;
    readonly preconditions: ManagementCommandPreconditions;
  }): Promise<ApprovalRequest> {
    readIdentifier(input.approval_id, "approval_id");
    const preconditions = readPreconditions(input.preconditions);
    const feedback =
      input.decision === "reject" ? readAndRedactFeedback(input.feedback) : undefined;
    if (input.decision === "approve" && input.feedback !== undefined) {
      throw controlError("VALIDATION_ERROR", { field: "feedback" });
    }
    return this.executeIdempotent(
      `${preconditions.session_id}:approval:${input.approval_id}`,
      preconditions.idempotency_key,
      {
        approval_id: input.approval_id,
        decision: input.decision,
        ...(feedback === undefined ? {} : { feedback }),
        event_cursor: preconditions.event_cursor,
        target_revision: preconditions.target_revision,
      },
      async () => {
        await this.assertEventCursor(preconditions.event_cursor);
        const stored = await this.options.repository.getApprovalRequest(input.approval_id);
        if (stored === undefined) throw controlError("RESOURCE_NOT_FOUND");
        assertRevision(stored.revision, preconditions.target_revision);
        if (stored.value.status !== "pending") throw controlError("ACTION_NOT_ALLOWED");
        return stored.value.kind === "driver_permission"
          ? this.decideDriverPermission(stored, input.decision, feedback, preconditions)
          : this.decideControlOperation(stored, input.decision, feedback, preconditions);
      },
    );
  }

  private async buildPreview(action: ManagementRunAction, runId: string): Promise<BuiltPreview> {
    const run = await this.options.repository.getAgentRun(runId);
    if (run === undefined) throw controlError("RESOURCE_NOT_FOUND");
    const task = await this.requireTask(run.value.task_id);
    if (action === "retry") {
      await this.assertRetryAllowed(run.value.run_id, run.value.task_version, task.value);
      return Object.freeze({
        action,
        run_id: runId,
        target_revision: run.revision,
        etag: runEtag(runId, run.revision),
        effects: Object.freeze([
          "保留原 Run、Session、事件、审计、Artifact 与工作树",
          "使用同一冻结 TaskVersion 创建新 Run 与新 Session",
        ]),
        warnings: Object.freeze([]),
      });
    }
    if (action === "cancel") {
      if (!ACTIVE_RUN_STATUSES.has(run.value.status as "running" | "waiting_permission")) {
        throw controlError("ACTION_NOT_ALLOWED");
      }
      if (this.options.active_runs.get(runId) === undefined) {
        throw controlError("RECOVERY_IN_PROGRESS");
      }
      return Object.freeze({
        action,
        run_id: runId,
        target_revision: run.revision,
        etag: runEtag(runId, run.revision),
        effects: Object.freeze([
          "请求停止当前活动执行并等待确定取消落盘",
          "保留工作树、事件、审计和已有 Artifact 引用",
        ]),
        warnings: Object.freeze([]),
      });
    }
    if (
      !TERMINAL_RUN_STATUSES.has(
        run.value.status as "succeeded" | "failed" | "cancelled" | "interrupted",
      )
    ) {
      throw controlError("ACTION_NOT_ALLOWED");
    }
    const inspection = sanitizeCleanupInspection(
      (await this.options.runtime.previewCleanupResources?.(runId)) ?? {
        targets: [],
        warnings: [],
      },
    );
    return Object.freeze({
      action,
      run_id: runId,
      target_revision: run.revision,
      etag: runEtag(runId, run.revision),
      effects: Object.freeze([
        "仅移除所有权可证明属于目标 Run 的残留进程、租约和 runtime 临时目录",
        "不删除领域事实、Artifact 或保留工作树",
      ]),
      warnings: inspection.warnings,
      cleanup: inspection,
    });
  }

  private async decideDriverPermission(
    stored: Awaited<ReturnType<DomainRepository["getApprovalRequest"]>> & {},
    decision: "approve" | "reject",
    feedback: string | undefined,
    preconditions: ManagementCommandPreconditions,
  ): Promise<ApprovalRequest> {
    const approval = stored.value;
    const active = this.options.active_runs.get(approval.run_id);
    if (active === undefined) throw controlError("RECOVERY_IN_PROGRESS");
    const [task, run, bindings] = await Promise.all([
      this.requireTask(approval.task_id),
      this.options.repository.getAgentRun(approval.run_id),
      this.options.repository.listAgentSessionBindings(approval.run_id),
    ]);
    const binding = bindings.find((item) => item.value.status === "ACTIVE");
    if (
      run === undefined ||
      binding === undefined ||
      task.value.status !== "WAITING_APPROVAL" ||
      run.value.status !== "waiting_permission"
    ) {
      throw controlError("ACTION_NOT_ALLOWED");
    }
    const decidedAt = this.now().toISOString();
    const decisionRecord = decideApprovalRequest(
      approval,
      decision === "approve" ? "approved" : "denied",
      "controller",
      feedback ?? "Approved by controller",
      decidedAt,
    );
    const decided: ApprovalRequest = {
      ...decisionRecord,
      metadata: { ...decisionRecord.metadata, delivery_status: "pending" },
    };
    const records: DomainRecordWrite[] = [
      { kind: "approval_request", expected_revision: stored.revision, value: decided },
    ];
    if (decision === "approve") {
      records.push(
        {
          kind: "task",
          expected_revision: task.revision,
          value: transitionTask(task.value, "APPROVE_ACTION", decidedAt),
        },
        {
          kind: "agent_run",
          expected_revision: run.revision,
          value: {
            ...run.value,
            status: transitionAgentRunStatus(run.value.status, "RESUME"),
            updated_at: decidedAt,
          },
        },
      );
    } else {
      records.push(
        {
          kind: "task",
          expected_revision: task.revision,
          value: transitionTask(task.value, "INTERRUPT", decidedAt),
        },
        {
          kind: "agent_run",
          expected_revision: run.revision,
          value: {
            ...run.value,
            status: transitionAgentRunStatus(run.value.status, "INTERRUPT"),
            updated_at: decidedAt,
            finished_at: decidedAt,
            metadata: {
              ...run.value.metadata,
              interrupted_by: "approval_rejected",
              rejected_approval_id: approval.approval_id,
            },
          },
        },
        {
          kind: "agent_session_binding",
          expected_revision: binding.revision,
          value: transitionAgentSessionBinding(binding.value, "FAIL", decidedAt),
        },
      );
    }
    await this.commitRecords(
      "management_decide_approval",
      preconditions.idempotency_key,
      records,
      preconditions.event_cursor,
    );
    try {
      await this.options.active_runs.respondToPermission(
        approval.run_id,
        approval.permission_id ?? "",
        approval.tool_call_id ?? "",
        decision === "approve" ? "allow" : "deny",
        feedback ?? "Approved by controller",
      );
      if (decision === "reject") {
        await this.options.active_runs.cancel(
          approval.run_id,
          "Approval rejected; replan required",
        );
      }
    } finally {
      if (decision === "reject") {
        await this.options.active_runs.close(approval.run_id).catch(() => undefined);
      }
    }
    const delivered = await this.markApprovalDelivered(
      approval.approval_id,
      preconditions.idempotency_key,
    );
    if (decision === "reject") {
      await this.options.runtime
        .cleanupResources?.(approval.run_id, "management.rejected")
        .catch(() => undefined);
    }
    return delivered;
  }

  private async decideControlOperation(
    stored: Awaited<ReturnType<DomainRepository["getApprovalRequest"]>> & {},
    decision: "approve" | "reject",
    feedback: string | undefined,
    preconditions: ManagementCommandPreconditions,
  ): Promise<ApprovalRequest> {
    const approval = stored.value;
    const task = await this.requireTask(approval.task_id);
    if (task.value.status !== "WAITING_APPROVAL") throw controlError("ACTION_NOT_ALLOWED");
    const decidedAt = this.now().toISOString();
    const decided: ApprovalRequest = {
      ...decideApprovalRequest(
        approval,
        decision === "approve" ? "approved" : "denied",
        "controller",
        feedback ?? "Approved by controller",
        decidedAt,
      ),
      metadata: { ...approval.metadata, delivery_status: "not_applicable" },
    };
    const taskValue =
      decision === "approve"
        ? transitionTask(task.value, "APPROVE_ACTION", decidedAt)
        : transitionTask(transitionTask(task.value, "DENY_ACTION", decidedAt), "FAIL", decidedAt);
    await this.commitRecords(
      "management_decide_control_approval",
      preconditions.idempotency_key,
      [
        { kind: "approval_request", expected_revision: stored.revision, value: decided },
        { kind: "task", expected_revision: task.revision, value: taskValue },
      ],
      preconditions.event_cursor,
    );
    return decided;
  }

  private async retryRun(
    sourceRunId: string,
    preconditions: ManagementCommandPreconditions,
  ): Promise<unknown> {
    const sourceRun = await this.options.repository.getAgentRun(sourceRunId);
    if (sourceRun === undefined) throw controlError("RESOURCE_NOT_FOUND");
    assertRevision(sourceRun.revision, preconditions.target_revision);
    const task = await this.requireTask(sourceRun.value.task_id);
    await this.assertRetryAllowed(sourceRunId, sourceRun.value.task_version, task.value);
    const [taskVersion, bindings] = await Promise.all([
      this.options.repository.getTaskVersion({
        task_id: sourceRun.value.task_id,
        task_version: sourceRun.value.task_version,
      }),
      this.options.repository.listAgentSessionBindings(sourceRunId),
    ]);
    if (taskVersion === undefined) throw controlError("TASK_VERSION_REQUIRED");
    const sourceBinding = latestBinding(bindings);
    if (sourceBinding === undefined) throw controlError("ACTION_NOT_ALLOWED");
    const newRunId = stableId("run", `${this.server_instance_id}:${preconditions.idempotency_key}`);
    const newSessionId = stableId(
      "session",
      `${this.server_instance_id}:${preconditions.idempotency_key}`,
    );
    const contextPackageId = stableId(
      "context",
      `${this.server_instance_id}:${preconditions.idempotency_key}`,
    );
    selectAgentSession({
      reason: "MANUAL_RETRY",
      target: {
        task_id: sourceRun.value.task_id,
        task_version: sourceRun.value.task_version,
        run_id: newRunId,
        driver_id: sourceRun.value.driver_id,
        role: sourceRun.value.role,
      },
      bindings: bindings.map((item) => item.value),
      previous_run_id: sourceRunId,
    });
    const baseline = await this.options.repository.getProjectBaseline(
      taskVersion.value.project_id,
      taskVersion.value.context_policy.project_baseline_version,
    );
    if (baseline === undefined) throw controlError("TASK_VERSION_REQUIRED");
    const failureSummary: FailureSummaryInput = {
      component_id: stableId("failure", newRunId),
      version: 1,
      task_id: sourceRun.value.task_id,
      task_version: sourceRun.value.task_version,
      source_run_id: sourceRunId,
      source_session_id: sourceBinding.value.session_id,
      summary: jsonValue({
        run_status: sourceRun.value.status,
        task_status: task.value.status,
        failure_code: safeMetadataString(sourceRun.value.metadata, "failure_code") ?? "UNSPECIFIED",
      }),
    };
    const existingContext = await this.options.repository.getContextPackage(contextPackageId);
    if (existingContext === undefined) {
      try {
        await this.options.contexts.prepareContext({
          task: {
            task_id: taskVersion.value.task_id,
            task_version: taskVersion.value.task_version,
          },
          run_id: newRunId,
          target_session_id: newSessionId,
          scenario: "MANUAL_RETRY",
          context_package_id: contextPackageId,
          project_baseline: {
            component_id: `baseline:${baseline.value.project_id}:v${baseline.value.baseline_version}`,
            project_id: baseline.value.project_id,
            baseline_version: baseline.value.baseline_version,
            content_hash: baseline.value.content_hash,
            content: baseline.value.content,
          },
          repository_id: this.options.project_id,
          repository_path: this.options.repository_path,
          selected_handoffs: (taskVersion.value.selected_handoff_ids ?? []).map((handoffId) => ({
            handoff_id: handoffId,
            handoff_version: 1,
          })),
          failure_summary: failureSummary,
          expected_event_cursor: preconditions.event_cursor,
          audit: this.audit(
            "management_retry_prepare_context",
            `${preconditions.idempotency_key}:context`,
          ),
        });
      } catch (error) {
        throw mapRepositoryError(error);
      }
    }
    const cursorAfterContext = await this.options.repository.getEventCursor();
    const currentTask = await this.requireTask(task.value.task_id);
    const currentSourceRun = await this.options.repository.getAgentRun(sourceRunId);
    if (currentSourceRun === undefined || currentSourceRun.revision !== sourceRun.revision) {
      throw controlError("ETAG_MISMATCH");
    }
    const queuedAt = this.now().toISOString();
    const queued = transitionTask(currentTask.value, "RETRY", queuedAt);
    await this.commitRecords(
      "management_retry_queue",
      `${preconditions.idempotency_key}:queue`,
      [{ kind: "task", expected_revision: currentTask.revision, value: queued }],
      cursorAfterContext,
    );
    const cursorAfterQueue = await this.options.repository.getEventCursor();
    const queuedStored = await this.requireTask(task.value.task_id);
    const running = transitionTask(queuedStored.value, "START_RUN", this.now().toISOString());
    await this.commitRecords(
      "management_retry_start",
      `${preconditions.idempotency_key}:start`,
      [{ kind: "task", expected_revision: queuedStored.revision, value: running }],
      cursorAfterQueue,
    );
    try {
      const result = await this.options.runtime.start({
        task: running,
        task_version: taskVersion.value,
        context_package_id: contextPackageId,
        idempotency_key: `${preconditions.idempotency_key}:runtime`,
        previous_run_id: sourceRunId,
      });
      if (result.status === "APPROVAL_REQUIRED") {
        const current = await this.requireTask(task.value.task_id);
        const waitingAt = this.now().toISOString();
        await this.commitRecords(
          "management_retry_fallback_approval",
          `${preconditions.idempotency_key}:fallback`,
          [
            {
              kind: "task",
              expected_revision: current.revision,
              value: transitionTask(current.value, "REQUEST_APPROVAL", waitingAt),
            },
            { kind: "approval_request", expected_revision: 0, value: result.approval },
          ],
          await this.options.repository.getEventCursor(),
        );
      }
      return Object.freeze({
        action: "retry",
        source_run_id: sourceRunId,
        new_run_id: newRunId,
        new_session_id: newSessionId,
        context_package_id: contextPackageId,
        status: result.status,
        event_cursor: await this.options.repository.getEventCursor(),
      });
    } catch (error) {
      const current = await this.requireTask(task.value.task_id);
      if (current.value.status === "RUNNING") {
        await this.commitRecords(
          "management_retry_failed",
          `${preconditions.idempotency_key}:failed`,
          [
            {
              kind: "task",
              expected_revision: current.revision,
              value: transitionTask(current.value, "FAIL", this.now().toISOString()),
            },
          ],
          await this.options.repository.getEventCursor(),
        );
      }
      throw error;
    }
  }

  private async cancelRun(
    runId: string,
    preconditions: ManagementCommandPreconditions,
  ): Promise<unknown> {
    const run = await this.options.repository.getAgentRun(runId);
    if (run === undefined) throw controlError("RESOURCE_NOT_FOUND");
    assertRevision(run.revision, preconditions.target_revision);
    if (!ACTIVE_RUN_STATUSES.has(run.value.status as "running" | "waiting_permission")) {
      throw controlError("ACTION_NOT_ALLOWED");
    }
    this.options.active_runs.require(runId);
    const task = await this.requireTask(run.value.task_id);
    if (task.value.status !== "RUNNING" && task.value.status !== "WAITING_APPROVAL") {
      throw controlError("ACTION_NOT_ALLOWED");
    }
    const requestedAt = this.now().toISOString();
    await this.commitRecords(
      "management_cancel_run",
      preconditions.idempotency_key,
      [
        {
          kind: "task",
          expected_revision: task.revision,
          value: transitionTask(task.value, "CANCEL", requestedAt),
        },
        {
          kind: "agent_run",
          expected_revision: run.revision,
          value: {
            ...run.value,
            status: transitionAgentRunStatus(run.value.status, "REQUEST_CANCELLATION"),
            updated_at: requestedAt,
          },
        },
      ],
      preconditions.event_cursor,
    );
    await this.options.active_runs.cancel(runId, "Management cancellation confirmed");
    let latestRun = await this.options.repository.getAgentRun(runId);
    if (latestRun === undefined) throw controlError("RESOURCE_NOT_FOUND");
    if (latestRun.value.status !== "cancelled") {
      if (latestRun.value.status !== "cancelling") throw controlError("ACTION_NOT_ALLOWED");
      const bindings = await this.options.repository.listAgentSessionBindings(runId);
      const activeBinding = bindings.find((item) => item.value.status === "ACTIVE");
      const confirmedAt = this.now().toISOString();
      const records: DomainRecordWrite[] = [
        {
          kind: "agent_run",
          expected_revision: latestRun.revision,
          value: {
            ...latestRun.value,
            status: transitionAgentRunStatus(latestRun.value.status, "CONFIRM_CANCELLED"),
            updated_at: confirmedAt,
            finished_at: confirmedAt,
          },
        },
      ];
      if (activeBinding !== undefined) {
        records.push({
          kind: "agent_session_binding",
          expected_revision: activeBinding.revision,
          value: transitionAgentSessionBinding(activeBinding.value, "CLOSE", confirmedAt),
        });
      }
      await this.commitRecords(
        "management_cancel_run_confirm",
        `${preconditions.idempotency_key}:confirm`,
        records,
        await this.options.repository.getEventCursor(),
      );
      latestRun = await this.options.repository.getAgentRun(runId);
    }
    await this.options.runtime.cleanupResources?.(runId, "management.cancelled");
    return Object.freeze({
      action: "cancel",
      run_id: runId,
      status: latestRun?.value.status ?? "cancelled",
      event_cursor: await this.options.repository.getEventCursor(),
    });
  }

  private async cleanupRun(
    runId: string,
    preconditions: ManagementCommandPreconditions,
    previewHash: string,
  ): Promise<unknown> {
    const run = await this.options.repository.getAgentRun(runId);
    if (run === undefined) throw controlError("RESOURCE_NOT_FOUND");
    assertRevision(run.revision, preconditions.target_revision);
    const requestedAt = this.now().toISOString();
    await this.commitRecords(
      "management_cleanup_run",
      preconditions.idempotency_key,
      [
        {
          kind: "agent_run",
          expected_revision: run.revision,
          value: {
            ...run.value,
            updated_at: requestedAt,
            metadata: {
              ...run.value.metadata,
              management_cleanup: {
                status: "confirmed",
                preview_hash: previewHash,
                confirmed_at: requestedAt,
              },
            },
          },
        },
      ],
      preconditions.event_cursor,
    );
    const cleanup =
      (await this.options.runtime.cleanupResources?.(runId, "management.confirmed", previewHash)) ??
      ({ targets: [], warnings: [], removed_targets: [], refused_targets: [] } as const);
    const result = sanitizeCleanupResult(cleanup);
    return Object.freeze({
      action: "cleanup",
      run_id: runId,
      no_op: result.targets.length === 0 && result.removed_targets.length === 0,
      cleanup: result,
      event_cursor: await this.options.repository.getEventCursor(),
    });
  }

  private async assertRetryAllowed(runId: string, taskVersion: number, task: Task): Promise<void> {
    if (task.latest_version !== taskVersion) throw controlError("TASK_VERSION_REQUIRED");
    const runs = await this.options.repository.listAgentRuns({ task_id: task.task_id });
    const latest = [...runs]
      .sort(
        (left, right) =>
          left.value.created_at.localeCompare(right.value.created_at) ||
          left.value.run_id.localeCompare(right.value.run_id),
      )
      .at(-1);
    if (latest?.value.run_id !== runId) throw controlError("ACTION_NOT_ALLOWED");
    if (
      !RETRYABLE_RUN_STATUSES.has(latest.value.status as "failed" | "cancelled" | "interrupted") ||
      !RETRYABLE_TASK_STATUSES.has(task.status as "FAILED" | "CANCELLED" | "INTERRUPTED")
    ) {
      throw controlError("ACTION_NOT_ALLOWED");
    }
  }

  private consumeConfirmation(
    rawToken: string,
    input: {
      readonly session_id: string;
      readonly action: ManagementRunAction;
      readonly run_id: string;
      readonly target_revision: number;
    },
  ): ConfirmationRecord {
    this.pruneMemoryState();
    const key = hashToken(rawToken);
    const record = this.confirmations.get(key);
    this.confirmations.delete(key);
    if (
      record === undefined ||
      record.expires_at_ms <= this.now().getTime() ||
      record.server_instance_id !== this.server_instance_id ||
      record.session_id !== input.session_id ||
      record.action !== input.action ||
      record.run_id !== input.run_id ||
      record.target_revision !== input.target_revision
    ) {
      throw controlError("CONFIRMATION_EXPIRED");
    }
    return record;
  }

  private async markApprovalDelivered(
    approvalId: string,
    idempotencyKey: string,
  ): Promise<ApprovalRequest> {
    const stored = await this.options.repository.getApprovalRequest(approvalId);
    if (stored === undefined) throw controlError("RESOURCE_NOT_FOUND");
    const delivered: ApprovalRequest = {
      ...stored.value,
      metadata: { ...stored.value.metadata, delivery_status: "delivered" },
    };
    await this.commitRecords(
      "management_approval_delivered",
      `${idempotencyKey}:delivered`,
      [{ kind: "approval_request", expected_revision: stored.revision, value: delivered }],
      await this.options.repository.getEventCursor(),
    );
    return delivered;
  }

  private async requireTask(taskId: string) {
    const task = await this.options.repository.getTask(taskId);
    if (task === undefined) throw controlError("RESOURCE_NOT_FOUND");
    return task;
  }

  private async assertEventCursor(expected: string): Promise<void> {
    if (expected !== (await this.options.repository.getEventCursor())) {
      throw controlError("STALE_EVENT_CURSOR");
    }
  }

  private executeIdempotent<T>(
    scope: string,
    key: string,
    request: DomainJsonValue,
    execute: () => Promise<T>,
  ): Promise<T> {
    this.pruneMemoryState();
    readIdentifier(key, "idempotency_key");
    const cacheKey = `${scope}:${key}`;
    const requestHash = computeContentHash(request);
    const existing = this.idempotency.get(cacheKey);
    if (existing !== undefined) {
      if (existing.request_hash !== requestHash) {
        throw controlError("IDEMPOTENCY_KEY_REUSED");
      }
      return existing.result as Promise<T>;
    }
    const result = execute();
    this.idempotency.set(cacheKey, {
      request_hash: requestHash,
      expires_at_ms: this.now().getTime() + IDEMPOTENCY_TTL_MS,
      result,
    });
    void result.catch(() => this.idempotency.delete(cacheKey));
    return result;
  }

  private async commitRecords(
    operation: string,
    idempotencyKey: string,
    records: readonly DomainRecordWrite[],
    expectedEventCursor?: string,
  ): Promise<void> {
    const audit = this.audit(operation, idempotencyKey);
    try {
      await this.options.repository.commit({
        change_id: audit.request_id,
        idempotency: {
          operation,
          key: idempotencyKey,
          request_hash: computeContentHash(jsonValue({ operation, records })),
        },
        ...(expectedEventCursor === undefined
          ? {}
          : { expected_event_cursor: expectedEventCursor }),
        records,
        events: records.map((record, index) =>
          eventForRecord(record, audit, this.createId(), index),
        ),
      });
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  private audit(operation: string, idempotencyKey: string): RuntimeAuditInput {
    return {
      actor: { kind: "bridge", id: "management-command-service" },
      operation,
      request_id: this.createId(),
      correlation_id: this.createId(),
      idempotency_key: idempotencyKey,
      event_id: this.createId(),
      occurred_at: this.now().toISOString(),
    };
  }

  private pruneMemoryState(): void {
    const now = this.now().getTime();
    for (const [key, record] of this.confirmations) {
      if (record.expires_at_ms <= now) this.confirmations.delete(key);
    }
    for (const [key, entry] of this.idempotency) {
      if (entry.expires_at_ms <= now) this.idempotency.delete(key);
    }
  }
}

function eventForRecord(
  record: DomainRecordWrite,
  audit: RuntimeAuditInput,
  eventId: string,
  index: number,
): AuthoritativeDomainEvent {
  const id = getDomainRecordId(record.kind, record.value);
  const eventType =
    record.expected_revision === 0
      ? (
          {
            task: "task.created",
            task_version: "task_version.recorded",
            task_relation: "task_relation.recorded",
            agent_run: "agent_run.created",
            agent_session_binding: "agent_session_binding.recorded",
            context_package: "context_package.recorded",
            handoff_package: "handoff_package.recorded",
            continuation_snapshot: "continuation_snapshot.recorded",
            task_result: "task_result.recorded",
            project_baseline: "project_baseline.recorded",
            approval_request: "approval_request.recorded",
            review_cycle: "review_cycle.recorded",
            control_invocation: "control_invocation.recorded",
          } as const
        )[record.kind]
      : ((
          {
            task: "task.status_changed",
            agent_run: "agent_run.status_changed",
            agent_session_binding: "agent_session_binding.status_changed",
            approval_request: "approval_request.status_changed",
            review_cycle: "review_cycle.status_changed",
          } as const
        )[
          record.kind as
            "task" | "agent_run" | "agent_session_binding" | "approval_request" | "review_cycle"
        ] ?? "agent_run.updated");
  return {
    event_id: `${eventId}:${index}`,
    event_version: 1,
    event_type: eventType,
    aggregate: { kind: record.kind, id, revision: record.expected_revision + 1 },
    occurred_at: audit.occurred_at,
    audit: {
      actor: audit.actor,
      operation: audit.operation,
      request_id: audit.request_id,
      correlation_id: audit.correlation_id,
      idempotency_key: audit.idempotency_key,
      ...taskScope(record.value),
    },
    payload: { kind: record.kind, revision: record.expected_revision + 1 },
  };
}

function taskScope(value: object): { task_id?: string; task_version?: number; run_id?: string } {
  return {
    ...("task_id" in value && typeof value.task_id === "string" ? { task_id: value.task_id } : {}),
    ...("task_version" in value && typeof value.task_version === "number"
      ? { task_version: value.task_version }
      : {}),
    ...("run_id" in value && typeof value.run_id === "string" ? { run_id: value.run_id } : {}),
  };
}

function readPreconditions(value: ManagementCommandPreconditions): ManagementCommandPreconditions {
  readIdentifier(value.session_id, "session_id");
  readIdentifier(value.idempotency_key, "idempotency_key");
  if (!/^event-cursor:(0|[1-9][0-9]*)$/u.test(value.event_cursor)) {
    throw controlError("VALIDATION_ERROR", { field: "event_cursor" });
  }
  if (!Number.isSafeInteger(value.target_revision) || value.target_revision < 1) {
    throw controlError("VALIDATION_ERROR", { field: "target_revision" });
  }
  return Object.freeze({ ...value });
}

function readAndRedactFeedback(value: string | undefined): string {
  if (typeof value !== "string") throw controlError("VALIDATION_ERROR", { field: "feedback" });
  const trimmed = value.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > 2_000) {
    throw controlError("VALIDATION_ERROR", { field: "feedback" });
  }
  const redacted = redactSensitiveContent(trimmed);
  if (typeof redacted !== "string" || [...redacted].length < 1) {
    throw controlError("SENSITIVE_CONTENT_REJECTED", { field: "feedback" });
  }
  return redacted;
}

function readIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw controlError(
      field === "idempotency_key" ? "IDEMPOTENCY_KEY_REQUIRED" : "VALIDATION_ERROR",
      { field },
    );
  }
  return value;
}

function readAction(value: unknown): ManagementRunAction {
  if (value !== "retry" && value !== "cancel" && value !== "cleanup") {
    throw controlError("VALIDATION_ERROR", { field: "action" });
  }
  return value;
}

function assertRevision(actual: number, expected: number): void {
  if (actual !== expected) throw controlError("ETAG_MISMATCH");
}

function runEtag(runId: string, revision: number): string {
  return `"run-${runId}-r${revision}"`;
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashPreview(value: BuiltPreview): string {
  return computeContentHash(
    jsonValue({
      action: value.action,
      run_id: value.run_id,
      target_revision: value.target_revision,
      effects: value.effects,
      warnings: value.warnings,
      cleanup: value.cleanup,
    }),
  );
}

function sanitizeCleanupInspection(value: BridgeCleanupInspection): BridgeCleanupInspection {
  return Object.freeze({
    targets: Object.freeze(
      value.targets.map((target) =>
        Object.freeze({
          kind: target.kind,
          target_id: safeText(target.target_id),
          ownership: target.ownership,
        }),
      ),
    ),
    warnings: Object.freeze(value.warnings.map(safeText)),
  });
}

function sanitizeCleanupResult(value: BridgeCleanupResult): BridgeCleanupResult {
  const inspection = sanitizeCleanupInspection(value);
  return Object.freeze({
    ...inspection,
    removed_targets: Object.freeze(value.removed_targets.map(safeText)),
    refused_targets: Object.freeze(value.refused_targets.map(safeText)),
  });
}

function safeText(value: string): string {
  const redacted = redactSensitiveContent(value);
  return typeof redacted === "string" ? redacted : "[REDACTED]";
}

function safeMetadataString(
  metadata: import("@agent-bridge/schemas").DomainMetadata | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? safeText(value) : undefined;
}

function latestBinding(
  bindings: readonly {
    readonly value: AgentSessionBinding;
    readonly revision: number;
  }[],
) {
  return [...bindings]
    .sort(
      (left, right) =>
        left.value.created_at.localeCompare(right.value.created_at) ||
        left.value.binding_id.localeCompare(right.value.binding_id),
    )
    .at(-1);
}

function stableId(prefix: string, key: string): string {
  return `${prefix}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

function jsonValue(value: unknown): DomainJsonValue {
  return JSON.parse(JSON.stringify(value)) as DomainJsonValue;
}

function mapRepositoryError(error: unknown): unknown {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  const reason =
    typeof error === "object" &&
    error !== null &&
    "details" in error &&
    typeof error.details === "object" &&
    error.details !== null &&
    "reason" in error.details
      ? String(error.details.reason)
      : "";
  if (code === "REPOSITORY_IDEMPOTENCY_CONFLICT") {
    return controlError("IDEMPOTENCY_KEY_REUSED");
  }
  if (code === "REPOSITORY_WRITE_CONFLICT") {
    return controlError(
      reason === "EVENT_CURSOR_MISMATCH" ? "STALE_EVENT_CURSOR" : "ETAG_MISMATCH",
    );
  }
  return error;
}
