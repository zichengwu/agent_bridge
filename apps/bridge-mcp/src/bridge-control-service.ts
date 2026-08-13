import { createHash, randomUUID } from "node:crypto";

import {
  computeContentHash,
  getDomainRecordId,
  readReviewCycle,
  transitionAgentRunStatus,
  transitionAgentSessionBinding,
  transitionTask,
  type AuditActor,
  type AuthoritativeDomainEvent,
  type DomainRecordWrite,
  type DomainRepository,
} from "@agent-bridge/core";
import type { AgentEvent, JsonObject } from "@agent-bridge/driver-protocol";
import {
  DOMAIN_SCHEMA_VERSION,
  parseTaskRelation,
  parseTaskVersion,
  type ApprovalRequest,
  type ControlInvocation,
  type ProjectBaseline,
  type ReviewCycle,
  type Task,
  type TaskResult,
  type TaskVersion,
} from "@agent-bridge/schemas";
import {
  ActiveRunRegistry,
  ContextHandoffRuntime,
  type RuntimeAuditInput,
} from "@agent-bridge/worker-runtime";

import { controlError } from "./errors.js";
import { ManagementCommandService } from "./management-command-service.js";
import { taskResultUsageFromAgentResult } from "./usage-facts.js";

const ACTOR: AuditActor = Object.freeze({ kind: "bridge", id: "bridge-mcp" });

export interface BridgeStartRequest {
  readonly task: Task;
  readonly task_version: TaskVersion;
  readonly context_package_id: string;
  readonly idempotency_key: string;
  readonly previous_run_id?: string;
}

export interface BridgeCleanupTarget {
  readonly kind: "child_process" | "lease" | "runtime_directory";
  readonly target_id: string;
  readonly ownership: "owned" | "unverified";
}

export interface BridgeCleanupInspection {
  readonly targets: readonly BridgeCleanupTarget[];
  readonly warnings: readonly string[];
}

export interface BridgeCleanupResult extends BridgeCleanupInspection {
  readonly removed_targets: readonly string[];
  readonly refused_targets: readonly string[];
}

export type BridgeStartResult =
  | {
      readonly run_id: string;
      readonly session_id: string;
      readonly binding_id: string;
      readonly status: "RUNNING";
    }
  | {
      readonly status: "APPROVAL_REQUIRED";
      readonly approval: ApprovalRequest;
    };

export interface BridgeRuntimePort {
  start(request: BridgeStartRequest): Promise<BridgeStartResult>;
  rollover(
    runId: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<Readonly<Record<string, unknown>>>;
  collectOutcome(runId: string): Promise<BridgeRunOutcome>;
  previewCleanupResources?(runId: string): Promise<BridgeCleanupInspection>;
  cleanupResources?(
    runId: string,
    reason: string,
    expectedPreviewHash?: string,
  ): Promise<BridgeCleanupResult | void>;
}

export interface BridgeRunOutcome {
  readonly commit_sha: string;
  readonly changed_files: readonly string[];
  readonly result: import("@agent-bridge/driver-protocol").AgentResult;
  readonly verification: import("@agent-bridge/worker-runtime").IndependentVerificationResult;
}

export interface BridgeControlServiceOptions {
  readonly repository: DomainRepository;
  readonly contexts: ContextHandoffRuntime;
  readonly active_runs: ActiveRunRegistry;
  readonly runtime: BridgeRuntimePort;
  readonly project_id: string;
  readonly repository_path: string;
  readonly max_review_cycles: number;
  readonly timeout_seconds: number;
  readonly max_agent_count: number;
  readonly now?: () => Date;
  readonly create_id?: () => string;
  readonly management_commands?: ManagementCommandService;
}

export class BridgeControlService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  readonly management_commands: ManagementCommandService;

  constructor(private readonly options: BridgeControlServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.create_id ?? randomUUID;
    this.management_commands =
      options.management_commands ??
      new ManagementCommandService({
        repository: options.repository,
        contexts: options.contexts,
        active_runs: options.active_runs,
        runtime: options.runtime,
        project_id: options.project_id,
        repository_path: options.repository_path,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.create_id === undefined ? {} : { create_id: options.create_id }),
      });
  }

  async createTask(args: JsonObject): Promise<unknown> {
    const version = parseTaskVersion(required(args, "contract"));
    if (version.task_version !== 1 || version.project_id !== this.options.project_id) {
      throw controlError("TASK_CONTRACT_INVALID");
    }
    const existingTask = await this.options.repository.getTask(version.task_id);
    const existingVersion = await this.options.repository.getTaskVersion({
      task_id: version.task_id,
      task_version: 1,
    });
    if (
      existingTask !== undefined &&
      existingVersion?.value.content_hash === version.content_hash
    ) {
      return { task: existingTask.value, task_version: existingVersion.value };
    }
    const occurredAt = version.created_at;
    const task: Task = {
      schema_version: DOMAIN_SCHEMA_VERSION,
      task_id: version.task_id,
      project_id: version.project_id,
      status: "DRAFT",
      latest_version: 1,
      created_at: occurredAt,
      updated_at: occurredAt,
    };
    await this.commitRecords("bridge_create_task", stringArg(args, "idempotency_key"), [
      { kind: "task", expected_revision: 0, value: task },
      { kind: "task_version", expected_revision: 0, value: version },
    ]);
    return { task, task_version: version };
  }

  async createTaskVersion(args: JsonObject): Promise<unknown> {
    const taskId = stringArg(args, "task_id");
    const current = await this.requireTask(taskId);
    const version = parseTaskVersion(required(args, "contract"));
    const existing = await this.options.repository.getTaskVersion({
      task_id: taskId,
      task_version: version.task_version,
    });
    if (existing?.value.content_hash === version.content_hash) {
      return { task: current.value, task_version: existing.value };
    }
    if (
      version.task_id !== taskId ||
      version.project_id !== current.value.project_id ||
      version.task_version !== current.value.latest_version + 1
    ) {
      throw controlError("TASK_VERSION_SCOPE_INVALID");
    }
    const updated = {
      ...transitionTask(current.value, "START_NEW_VERSION", this.now().toISOString()),
      latest_version: version.task_version,
    };
    await this.commitRecords("bridge_create_task_version", stringArg(args, "idempotency_key"), [
      { kind: "task", expected_revision: current.revision, value: updated },
      { kind: "task_version", expected_revision: 0, value: version },
    ]);
    return { task: updated, task_version: version };
  }

  async linkTaskVersions(args: JsonObject): Promise<unknown> {
    const idempotencyKey = stringArg(args, "idempotency_key");
    const relationId = optionalString(args, "relation_id") ?? stableId("relation", idempotencyKey);
    const existing = await this.options.repository.getTaskRelation(relationId);
    if (existing !== undefined) {
      if (
        computeContentHash(jsonValue(existing.value.source)) !==
          computeContentHash(jsonValue(required(args, "source"))) ||
        computeContentHash(jsonValue(existing.value.target)) !==
          computeContentHash(jsonValue(required(args, "target"))) ||
        existing.value.type !== stringArg(args, "relation_type")
      ) {
        throw controlError("IDEMPOTENCY_CONFLICT");
      }
      return existing.value;
    }
    const relation = parseTaskRelation({
      schema_version: DOMAIN_SCHEMA_VERSION,
      relation_id: relationId,
      type: stringArg(args, "relation_type"),
      source: required(args, "source"),
      target: required(args, "target"),
      created_at: this.now().toISOString(),
    });
    const [source, target] = await Promise.all([
      this.options.repository.getTaskVersion(relation.source),
      this.options.repository.getTaskVersion(relation.target),
    ]);
    if (source === undefined || target === undefined) {
      throw controlError("TASK_VERSION_NOT_FOUND");
    }
    const declared = source.value.relations?.find(
      (item) =>
        item.relation_id === relation.relation_id &&
        item.type === relation.type &&
        item.target.task_id === relation.target.task_id &&
        item.target.task_version === relation.target.task_version,
    );
    if (declared === undefined) throw controlError("TASK_RELATION_CONTRACT_MISMATCH");
    await this.commitRecords("bridge_link_task_versions", idempotencyKey, [
      { kind: "task_relation", expected_revision: 0, value: relation },
    ]);
    return relation;
  }

  async validateTask(args: JsonObject): Promise<unknown> {
    const taskId = stringArg(args, "task_id");
    const taskVersion = integerArg(args, "task_version");
    const [task, version] = await Promise.all([
      this.requireTask(taskId),
      this.options.repository.getTaskVersion({ task_id: taskId, task_version: taskVersion }),
    ]);
    if (version === undefined || task.value.latest_version !== taskVersion) {
      throw controlError("TASK_VERSION_NOT_FOUND");
    }
    if (
      version.value.limits.max_review_cycles > this.options.max_review_cycles ||
      version.value.limits.timeout_seconds > this.options.timeout_seconds ||
      version.value.limits.max_agent_count > this.options.max_agent_count
    ) {
      throw controlError("TASK_LIMIT_APPROVAL_REQUIRED");
    }
    const baseline = await this.options.repository.getProjectBaseline(
      version.value.project_id,
      version.value.context_policy.project_baseline_version,
    );
    if (baseline === undefined) {
      throw controlError("PROJECT_BASELINE_NOT_FOUND");
    }
    const updated = transitionTask(task.value, "VALIDATE", this.now().toISOString());
    await this.commitRecords("bridge_validate_task", stringArg(args, "idempotency_key"), [
      { kind: "task", expected_revision: task.revision, value: updated },
    ]);
    return { task: updated, task_version: version.value, baseline: baseline.value };
  }

  async prepareContext(args: JsonObject): Promise<unknown> {
    const taskId = stringArg(args, "task_id");
    const taskVersion = integerArg(args, "task_version");
    const version = await this.options.repository.getTaskVersion({
      task_id: taskId,
      task_version: taskVersion,
    });
    if (version === undefined) throw controlError("TASK_VERSION_NOT_FOUND");
    const baseline = await this.requireBaseline(version.value);
    const idempotencyKey = stringArg(args, "idempotency_key");
    const runId = optionalString(args, "run_id") ?? stableId("run", idempotencyKey);
    const sessionId = stableId("session", idempotencyKey);
    const contextPackageId = stableId("context", idempotencyKey);
    const existing = await this.options.repository.getContextPackage(contextPackageId);
    if (existing !== undefined) {
      const handoffIds = existing.value.components
        .filter((component) => component.kind === "handoff")
        .map((component) => component.component_id)
        .sort();
      if (
        existing.value.task_id !== taskId ||
        existing.value.task_version !== taskVersion ||
        computeContentHash(jsonValue(handoffIds)) !==
          computeContentHash(jsonValue([...stringArray(args, "selected_handoff_ids")].sort()))
      ) {
        throw controlError("IDEMPOTENCY_CONFLICT");
      }
      return { context_package: existing.value, warnings: [] };
    }
    const selected = stringArray(args, "selected_handoff_ids").map((handoffId) => ({
      handoff_id: handoffId,
      handoff_version: 1,
    }));
    return this.options.contexts.prepareContext({
      task: { task_id: taskId, task_version: taskVersion },
      run_id: runId,
      target_session_id: sessionId,
      scenario: taskVersion === 1 ? "NEW_TASK" : "NEW_TASK_VERSION",
      context_package_id: contextPackageId,
      project_baseline: {
        component_id: `baseline:${baseline.project_id}:v${baseline.baseline_version}`,
        project_id: baseline.project_id,
        baseline_version: baseline.baseline_version,
        content_hash: baseline.content_hash,
        content: baseline.content,
      },
      repository_id: this.options.project_id,
      repository_path: this.options.repository_path,
      selected_handoffs: selected,
      audit: this.audit("bridge_prepare_context", idempotencyKey),
    });
  }

  async startTask(args: JsonObject): Promise<unknown> {
    const taskId = stringArg(args, "task_id");
    const taskVersion = integerArg(args, "task_version");
    const [task, version] = await Promise.all([
      this.requireTask(taskId),
      this.options.repository.getTaskVersion({ task_id: taskId, task_version: taskVersion }),
    ]);
    if (version === undefined) throw controlError("TASK_NOT_STARTABLE");
    const contextId = stringArg(args, "context_package_id");
    const context = await this.options.repository.getContextPackage(contextId);
    if (
      context === undefined ||
      context.value.task_id !== taskId ||
      context.value.task_version !== taskVersion
    ) {
      throw controlError("CONTEXT_PACKAGE_SCOPE_INVALID");
    }
    if (task.value.status === "RUNNING") {
      const run = await this.options.repository.getAgentRun(context.value.run_id);
      const bindings = await this.options.repository.listAgentSessionBindings(context.value.run_id);
      const binding = bindings.find((item) => item.value.status === "ACTIVE");
      if (run?.value.status === "running" && binding !== undefined) {
        return {
          run_id: run.value.run_id,
          session_id: binding.value.session_id,
          binding_id: binding.value.binding_id,
          status: "RUNNING",
        };
      }
      const approved = await this.options.repository.listApprovalRequests({
        run_id: context.value.run_id,
        status: "approved",
      });
      if (approved.some((item) => item.value.operation === "driver.fallback")) {
        return this.launchRuntime(
          task,
          version.value,
          contextId,
          stringArg(args, "idempotency_key"),
        );
      }
    }
    if (task.value.status === "WAITING_APPROVAL") {
      const pending = await this.options.repository.listApprovalRequests({
        run_id: context.value.run_id,
        status: "pending",
      });
      const fallback = pending.find((item) => item.value.operation === "driver.fallback");
      if (fallback !== undefined) {
        return { status: "APPROVAL_REQUIRED", approval: fallback.value };
      }
    }
    if (task.value.status !== "VALIDATED") throw controlError("TASK_NOT_STARTABLE");
    const key = stringArg(args, "idempotency_key");
    const queued = transitionTask(task.value, "ENQUEUE", this.now().toISOString());
    await this.commitRecords("bridge_start_task_queue", `${key}:queue`, [
      { kind: "task", expected_revision: task.revision, value: queued },
    ]);
    const queuedStored = await this.requireTask(taskId);
    const running = transitionTask(queuedStored.value, "START_RUN", this.now().toISOString());
    await this.commitRecords("bridge_start_task_running", `${key}:running`, [
      { kind: "task", expected_revision: queuedStored.revision, value: running },
    ]);
    try {
      const runningStored = await this.requireTask(taskId);
      return await this.launchRuntime(runningStored, version.value, contextId, key);
    } catch (error) {
      const current = await this.requireTask(taskId);
      if (current.value.status === "RUNNING") {
        const failed = transitionTask(current.value, "FAIL", this.now().toISOString());
        await this.commitRecords("bridge_start_task_failed", `${key}:failed`, [
          { kind: "task", expected_revision: current.revision, value: failed },
        ]);
      }
      throw error;
    }
  }

  async getTask(args: JsonObject): Promise<unknown> {
    const task = await this.requireTask(stringArg(args, "task_id"));
    const [versions, runs, results] = await Promise.all([
      this.options.repository.listTaskVersions(task.value.task_id),
      this.options.repository.listAgentRuns({ task_id: task.value.task_id }),
      this.options.repository.listTaskResults(task.value.task_id),
    ]);
    return { task: task.value, versions, runs, results };
  }

  async listTasks(args: JsonObject): Promise<unknown> {
    return this.options.repository.listTasks({
      ...(optionalString(args, "project_id") === undefined
        ? {}
        : { project_id: optionalString(args, "project_id") }),
      ...(optionalString(args, "status") === undefined
        ? {}
        : { status: optionalString(args, "status") as Task["status"] }),
      ...(args.limit === undefined ? {} : { limit: integerArg(args, "limit") }),
    });
  }

  async getEvents(args: JsonObject): Promise<unknown> {
    return this.options.repository.listDomainEvents({
      task_id: stringArg(args, "task_id"),
      ...(optionalString(args, "cursor") === undefined
        ? {}
        : { after_cursor: optionalString(args, "cursor") }),
      ...(args.limit === undefined ? {} : { limit: integerArg(args, "limit") }),
    });
  }

  async getResult(args: JsonObject): Promise<unknown> {
    const results = await this.options.repository.listTaskResults(stringArg(args, "task_id"));
    return results.at(-1) ?? null;
  }

  async listHandoffs(args: JsonObject): Promise<unknown> {
    return this.options.repository.listHandoffPackages({
      task_id: stringArg(args, "task_id"),
      task_version: integerArg(args, "task_version"),
    });
  }

  async getContextPackage(args: JsonObject): Promise<unknown> {
    return (
      (await this.options.repository.getContextPackage(stringArg(args, "context_package_id"))) ??
      null
    );
  }

  async rolloverSession(args: JsonObject): Promise<unknown> {
    const runId = stringArg(args, "run_id");
    await this.assertCurrentRun(args, runId);
    return this.options.runtime.rollover(
      runId,
      stringArg(args, "reason"),
      stringArg(args, "idempotency_key"),
    );
  }

  async sendFeedback(args: JsonObject): Promise<unknown> {
    const taskId = stringArg(args, "task_id");
    const idempotencyKey = stringArg(args, "idempotency_key");
    const priorCycles = await this.options.repository.listReviewCycles({ task_id: taskId });
    const replay = priorCycles.find(
      (item) => item.value.metadata?.idempotency_key === idempotencyKey,
    );
    if (replay !== undefined) {
      if (
        replay.value.target_commit !== stringArg(args, "target_commit") ||
        computeContentHash(jsonValue(replay.value.findings)) !==
          computeContentHash(jsonValue(required(args, "findings")))
      ) {
        throw controlError("IDEMPOTENCY_CONFLICT");
      }
      return replay.value;
    }
    const task = await this.requireTask(taskId);
    if (task.value.status !== "REVIEW_REQUIRED") throw controlError("REVIEW_STATE_INVALID");
    const run = await this.latestRun(taskId);
    const result = await this.options.repository.getTaskResult(run.value.run_id);
    const bindings = await this.options.repository.listAgentSessionBindings(run.value.run_id);
    const binding = bindings.find((item) => item.value.status === "ACTIVE");
    if (result === undefined || binding === undefined || result.value.commit_sha === undefined) {
      throw controlError("REVIEW_SCOPE_INVALID");
    }
    const previous = await this.options.repository.listReviewCycles({
      task_id: taskId,
      task_version: run.value.task_version,
      run_id: run.value.run_id,
    });
    const currentCommit = previous.at(-1)?.value.candidate_commit ?? result.value.commit_sha;
    const targetCommit = stringArg(args, "target_commit");
    if (targetCommit !== currentCommit) throw controlError("REVIEW_SCOPE_CONFLICT");
    this.options.active_runs.require(run.value.run_id);
    const cycleNumber = previous.length + 1;
    if (cycleNumber > Math.min(this.options.max_review_cycles, 3)) {
      throw controlError("REVIEW_LIMIT_REACHED");
    }
    const now = this.now().toISOString();
    const review: ReviewCycle = readReviewCycle({
      schema_version: DOMAIN_SCHEMA_VERSION,
      review_id: this.createId(),
      task_id: taskId,
      task_version: run.value.task_version,
      run_id: run.value.run_id,
      session_id: binding.value.session_id,
      cycle_number: cycleNumber,
      target_commit: targetCommit,
      findings: required(args, "findings"),
      feedback_id: this.createId(),
      status: "requested",
      verification_results: [],
      created_at: now,
      updated_at: now,
      metadata: { idempotency_key: idempotencyKey },
    });
    const changesRequested = transitionTask(task.value, "REQUEST_CHANGES", now);
    await this.commitRecords("bridge_send_feedback", idempotencyKey, [
      { kind: "task", expected_revision: task.revision, value: changesRequested },
      { kind: "review_cycle", expected_revision: 0, value: review },
    ]);
    await this.options.active_runs.sendFeedback(run.value.run_id, review.feedback_id, {
      review_id: review.review_id,
      cycle_number: review.cycle_number,
      target_commit: review.target_commit,
      findings: jsonValue(review.findings),
    });
    const stored = await this.options.repository.getReviewCycle(review.review_id);
    const currentTask = await this.requireTask(taskId);
    const dispatched: ReviewCycle = {
      ...review,
      status: "feedback_dispatched",
      updated_at: this.now().toISOString(),
    };
    const running = transitionTask(currentTask.value, "RESUME_CHANGES", dispatched.updated_at);
    await this.commitRecords(`${"bridge_send_feedback"}_dispatch`, `${idempotencyKey}:dispatch`, [
      { kind: "task", expected_revision: currentTask.revision, value: running },
      { kind: "review_cycle", expected_revision: stored?.revision ?? 1, value: dispatched },
    ]);
    return dispatched;
  }

  async respondToApproval(args: JsonObject): Promise<unknown> {
    const decision = stringArg(args, "decision");
    if (decision !== "approve" && decision !== "deny" && decision !== "reject") {
      throw controlError("APPROVAL_INVALID");
    }
    return this.management_commands.decideApproval({
      approval_id: stringArg(args, "approval_id"),
      decision: decision === "approve" ? "approve" : "reject",
      ...(decision === "approve"
        ? {}
        : { feedback: optionalString(args, "feedback") ?? optionalString(args, "reason") }),
      preconditions: {
        session_id: "mcp-stdio",
        event_cursor: stringArg(args, "event_cursor"),
        target_revision: integerArg(args, "target_revision"),
        idempotency_key: stringArg(args, "idempotency_key"),
      },
    });
  }

  async cancelTask(args: JsonObject): Promise<unknown> {
    return this.management_commands.confirmRunAction({
      action: "cancel",
      run_id: stringArg(args, "run_id"),
      confirmation_token: stringArg(args, "confirmation_token"),
      preconditions: {
        session_id: "mcp-stdio",
        event_cursor: stringArg(args, "event_cursor"),
        target_revision: integerArg(args, "target_revision"),
        idempotency_key: stringArg(args, "idempotency_key"),
      },
    });
  }

  async previewRunAction(args: JsonObject): Promise<unknown> {
    const action = stringArg(args, "action");
    if (action !== "retry" && action !== "cancel" && action !== "cleanup") {
      throw controlError("INVALID_ARGUMENT", { field: "action" });
    }
    return this.management_commands.previewRunAction({
      session_id: "mcp-stdio",
      action,
      run_id: stringArg(args, "run_id"),
    });
  }

  async confirmRunAction(args: JsonObject): Promise<unknown> {
    const action = stringArg(args, "action");
    if (action !== "retry" && action !== "cancel" && action !== "cleanup") {
      throw controlError("INVALID_ARGUMENT", { field: "action" });
    }
    return this.management_commands.confirmRunAction({
      action,
      run_id: stringArg(args, "run_id"),
      confirmation_token: stringArg(args, "confirmation_token"),
      preconditions: {
        session_id: "mcp-stdio",
        event_cursor: stringArg(args, "event_cursor"),
        target_revision: integerArg(args, "target_revision"),
        idempotency_key: stringArg(args, "idempotency_key"),
      },
    });
  }

  async markCompleted(args: JsonObject): Promise<unknown> {
    let task = await this.requireTask(stringArg(args, "task_id"));
    const mergeCommit = stringArg(args, "merge_commit");
    if (task.value.status === "COMPLETED" && task.value.metadata?.merge_commit === mergeCommit) {
      const completedRun = await this.latestRun(task.value.task_id);
      await this.options.runtime.cleanupResources?.(completedRun.value.run_id, "task.completed");
      return task.value;
    }
    const key = stringArg(args, "idempotency_key");
    if (task.value.status === "REVIEW_REQUIRED") {
      const ready = transitionTask(task.value, "APPROVE_REVIEW", this.now().toISOString());
      await this.commitRecords("bridge_approve_review", `${key}:approve`, [
        { kind: "task", expected_revision: task.revision, value: ready },
      ]);
      task = await this.requireTask(task.value.task_id);
    }
    const completedAt = this.now().toISOString();
    const completed = {
      ...transitionTask(task.value, "COMPLETE", completedAt),
      metadata: { ...task.value.metadata, merge_commit: mergeCommit },
    };
    const records: DomainRecordWrite[] = [
      { kind: "task", expected_revision: task.revision, value: completed },
    ];
    const run = await this.latestRun(task.value.task_id);
    if (run.value.status === "running") {
      records.push({
        kind: "agent_run",
        expected_revision: run.revision,
        value: {
          ...run.value,
          status: transitionAgentRunStatus(run.value.status, "SUCCEED"),
          updated_at: completedAt,
          finished_at: completedAt,
        },
      });
    }
    const cycles = await this.options.repository.listReviewCycles({
      task_id: task.value.task_id,
      task_version: run.value.task_version,
      run_id: run.value.run_id,
    });
    const latestCycle = cycles.at(-1);
    if (latestCycle?.value.status === "verified") {
      records.push({
        kind: "review_cycle",
        expected_revision: latestCycle.revision,
        value: {
          ...latestCycle.value,
          status: "resolved",
          updated_at: completedAt,
        },
      });
    }
    await this.commitRecords("bridge_mark_completed", key, records);
    await this.options.runtime.cleanupResources?.(run.value.run_id, "task.completed");
    return completed;
  }

  async recordControlInvocation(input: {
    tool_name: string;
    arguments: JsonObject;
    status: "succeeded" | "failed";
    error_code?: string;
  }): Promise<void> {
    const invocationId = this.createId();
    const taskId = optionalString(input.arguments, "task_id");
    const value: ControlInvocation = {
      schema_version: DOMAIN_SCHEMA_VERSION,
      invocation_id: invocationId,
      tool_name: input.tool_name,
      actor: { kind: "controller", id: "bridge-mcp" },
      request_hash: computeContentHash(input.arguments),
      status: input.status,
      ...(input.error_code === undefined ? {} : { error_code: input.error_code }),
      ...(taskId === undefined ? {} : { task_id: taskId }),
      ...(taskId === undefined || typeof input.arguments.task_version !== "number"
        ? {}
        : { task_version: input.arguments.task_version }),
      ...(optionalString(input.arguments, "run_id") === undefined
        ? {}
        : { run_id: optionalString(input.arguments, "run_id") }),
      occurred_at: this.now().toISOString(),
    };
    await this.commitRecords("bridge_record_control_invocation", invocationId, [
      { kind: "control_invocation", expected_revision: 0, value },
    ]);
  }

  async onAgentEvent(event: AgentEvent, bridgeRunId: string = event.runId): Promise<void> {
    if (event.type === "run.completed") {
      await this.recordCompletedRun(bridgeRunId);
      return;
    }
    if (event.type === "run.failed" || event.type === "run.cancelled") {
      await this.recordTerminalDriverFailure(bridgeRunId, event);
      return;
    }
    if (event.type !== "permission.requested") return;
    const run = await this.options.repository.getAgentRun(bridgeRunId);
    if (run === undefined) return;
    const bindings = await this.options.repository.listAgentSessionBindings(bridgeRunId);
    const binding = bindings.find((item) => item.value.status === "ACTIVE");
    const task = await this.requireTask(run.value.task_id);
    if (binding === undefined || task.value.status !== "RUNNING") return;
    const now = this.now().toISOString();
    const approval: ApprovalRequest = {
      schema_version: DOMAIN_SCHEMA_VERSION,
      approval_id: this.createId(),
      task_id: run.value.task_id,
      task_version: run.value.task_version,
      run_id: run.value.run_id,
      session_id: binding.value.session_id,
      kind: "driver_permission",
      operation: event.permission.kind,
      request_hash: computeContentHash(jsonValue(event.permission)),
      status: "pending",
      permission_id: event.permission.permissionId,
      tool_call_id: event.permission.toolCallId,
      requested_at: now,
      metadata: { title: event.permission.title },
    };
    const waiting = transitionTask(task.value, "REQUEST_APPROVAL", now);
    const waitingRun = {
      ...run.value,
      status: transitionAgentRunStatus(run.value.status, "WAIT_FOR_PERMISSION"),
      updated_at: now,
    };
    await this.commitRecords("driver_permission_requested", event.eventId, [
      { kind: "task", expected_revision: task.revision, value: waiting },
      { kind: "agent_run", expected_revision: run.revision, value: waitingRun },
      { kind: "approval_request", expected_revision: 0, value: approval },
    ]);
  }

  private async recordTerminalDriverFailure(
    runId: string,
    event: Extract<AgentEvent, { readonly type: "run.failed" | "run.cancelled" }>,
  ): Promise<void> {
    const run = await this.options.repository.getAgentRun(runId);
    if (
      run === undefined ||
      !["running", "waiting_permission", "cancelling"].includes(run.value.status)
    ) {
      return;
    }
    const task = await this.requireTask(run.value.task_id);
    const bindings = await this.options.repository.listAgentSessionBindings(runId);
    const activeBinding = bindings.find((item) => item.value.status === "ACTIVE");
    const now = event.occurredAt;
    const runTransition =
      event.type === "run.cancelled" && run.value.status === "cancelling"
        ? "CONFIRM_CANCELLED"
        : "FAIL";
    const terminalRun = {
      ...run.value,
      status: transitionAgentRunStatus(run.value.status, runTransition),
      updated_at: now,
      finished_at: now,
      metadata: {
        ...run.value.metadata,
        terminal_driver_event: event.type,
        failure_code: event.type === "run.failed" ? event.error.code : "DRIVER_CANCELLED",
      },
    };
    const records: DomainRecordWrite[] = [
      { kind: "agent_run", expected_revision: run.revision, value: terminalRun },
    ];
    if (activeBinding !== undefined) {
      records.push({
        kind: "agent_session_binding",
        expected_revision: activeBinding.revision,
        value: transitionAgentSessionBinding(
          activeBinding.value,
          event.type === "run.cancelled" ? "CLOSE" : "FAIL",
          now,
        ),
      });
    }
    if (task.value.status === "RUNNING" || task.value.status === "WAITING_APPROVAL") {
      records.unshift({
        kind: "task",
        expected_revision: task.revision,
        value: transitionTask(task.value, "INTERRUPT", now),
      });
    }
    await this.commitRecords(
      "driver_run_terminal_failure",
      `${runId}:${event.eventId}:terminal`,
      records,
    );
  }

  private async recordCompletedRun(runId: string): Promise<void> {
    const run = await this.options.repository.getAgentRun(runId);
    if (run === undefined) throw controlError("RUN_NOT_FOUND");
    const task = await this.requireTask(run.value.task_id);
    if (task.value.status !== "RUNNING") return;
    const version = await this.options.repository.getTaskVersion({
      task_id: run.value.task_id,
      task_version: run.value.task_version,
    });
    if (version === undefined) throw controlError("TASK_VERSION_NOT_FOUND");
    const outcome = await this.options.runtime.collectOutcome(runId);
    const bindings = await this.options.repository.listAgentSessionBindings(runId);
    const activeBinding = bindings.find((item) => item.value.status === "ACTIVE");
    const existingResult = await this.options.repository.getTaskResult(runId);
    const cycles = await this.options.repository.listReviewCycles({
      task_id: run.value.task_id,
      task_version: run.value.task_version,
      run_id: runId,
    });
    const usage = taskResultUsageFromAgentResult(outcome.result);
    const taskResult: TaskResult = {
      schema_version: DOMAIN_SCHEMA_VERSION,
      task_id: run.value.task_id,
      task_version: run.value.task_version,
      run_id: runId,
      session_ids: bindings.map((item) => item.value.session_id),
      status: "submitted",
      base_commit: version.value.base_commit,
      commit_sha: outcome.commit_sha,
      changed_files: outcome.changed_files,
      acceptance_results: outcome.verification.commands.map((command) => ({
        command: command.contract,
        exit_code: command.exit_code ?? 1,
        duration_ms: command.duration_ms,
        ...(command.log_artifact_id === undefined
          ? {}
          : { log_artifact_id: command.log_artifact_id }),
      })),
      review_findings: [],
      known_risks:
        outcome.verification.status === "passed" ? [] : ["Independent verification failed"],
      unresolved_items:
        outcome.verification.status === "passed" ? [] : ["Review verification artifacts"],
      artifacts: [
        { artifact_id: outcome.verification.report_artifact_id, kind: "verification.report" },
      ],
      ...(usage === undefined ? {} : { usage }),
      output: jsonValue(outcome.result.output),
      started_at: run.value.started_at ?? run.value.created_at,
      finished_at: outcome.verification.finished_at,
      metadata: { agent_summary: outcome.result.summary },
    };
    const submitted = transitionTask(task.value, "SUBMIT", outcome.result.completedAt);
    const succeededRun = {
      ...run.value,
      status: transitionAgentRunStatus(run.value.status, "SUCCEED"),
      updated_at: outcome.result.completedAt,
      finished_at: outcome.result.completedAt,
    };
    const terminalRecords: DomainRecordWrite[] = [
      { kind: "task", expected_revision: task.revision, value: submitted },
      { kind: "agent_run", expected_revision: run.revision, value: succeededRun },
    ];
    if (activeBinding !== undefined) {
      terminalRecords.push({
        kind: "agent_session_binding",
        expected_revision: activeBinding.revision,
        value: transitionAgentSessionBinding(
          activeBinding.value,
          "CLOSE",
          outcome.result.completedAt,
        ),
      });
    }
    let activeReviewId: string | undefined;
    if (existingResult === undefined) {
      await this.commitRecords("driver_run_submitted", `${runId}:submitted`, [
        ...terminalRecords,
        { kind: "task_result", expected_revision: 0, value: taskResult },
      ]);
    } else {
      const activeCycle = cycles.at(-1);
      if (activeCycle?.value.status !== "feedback_dispatched") {
        throw controlError("REVIEW_CYCLE_INVALID");
      }
      const resubmitted: ReviewCycle = {
        ...activeCycle.value,
        status: "resubmitted",
        candidate_commit: outcome.commit_sha,
        verification_results: verificationSummaries(outcome.verification),
        updated_at: outcome.result.completedAt,
      };
      activeReviewId = resubmitted.review_id;
      await this.commitRecords(
        "driver_run_resubmitted",
        `${runId}:resubmitted:${resubmitted.cycle_number}`,
        [
          ...terminalRecords,
          {
            kind: "review_cycle",
            expected_revision: activeCycle.revision,
            value: resubmitted,
          },
        ],
      );
    }
    const submittedStored = await this.requireTask(task.value.task_id);
    const verifying = transitionTask(
      submittedStored.value,
      "START_VERIFICATION",
      outcome.verification.started_at,
    );
    await this.commitRecords("bridge_verification_started", `${runId}:verifying:${cycles.length}`, [
      { kind: "task", expected_revision: submittedStored.revision, value: verifying },
    ]);
    const verifyingStored = await this.requireTask(task.value.task_id);
    const review = transitionTask(
      verifyingStored.value,
      "REQUEST_REVIEW",
      outcome.verification.finished_at,
    );
    const reviewRecords: DomainRecordWrite[] = [
      { kind: "task", expected_revision: verifyingStored.revision, value: review },
    ];
    if (activeReviewId !== undefined) {
      const storedCycle = await this.options.repository.getReviewCycle(activeReviewId);
      if (storedCycle === undefined) throw controlError("REVIEW_CYCLE_INVALID");
      reviewRecords.push({
        kind: "review_cycle",
        expected_revision: storedCycle.revision,
        value: {
          ...storedCycle.value,
          status: "verified",
          updated_at: outcome.verification.finished_at,
        },
      });
    }
    await this.commitRecords(
      "bridge_review_requested",
      `${runId}:review:${cycles.length}`,
      reviewRecords,
    );
  }

  private async requireTask(taskId: string) {
    const task = await this.options.repository.getTask(taskId);
    if (task === undefined) throw controlError("TASK_NOT_FOUND", { task_id: taskId });
    return task;
  }

  private async launchRuntime(
    task: { readonly value: Task; readonly revision: number },
    version: TaskVersion,
    contextPackageId: string,
    idempotencyKey: string,
  ): Promise<BridgeStartResult> {
    const result = await this.options.runtime.start({
      task: task.value,
      task_version: version,
      context_package_id: contextPackageId,
      idempotency_key: idempotencyKey,
    });
    if (result.status === "RUNNING") return result;
    const waiting = transitionTask(task.value, "REQUEST_APPROVAL", this.now().toISOString());
    await this.commitRecords("bridge_driver_fallback_requested", `${idempotencyKey}:approval`, [
      { kind: "task", expected_revision: task.revision, value: waiting },
      { kind: "approval_request", expected_revision: 0, value: result.approval },
    ]);
    return result;
  }

  private async requireBaseline(version: TaskVersion): Promise<ProjectBaseline> {
    const baseline = await this.options.repository.getProjectBaseline(
      version.project_id,
      version.context_policy.project_baseline_version,
    );
    if (baseline === undefined) throw controlError("PROJECT_BASELINE_NOT_FOUND");
    return baseline.value;
  }

  private async latestRun(taskId: string) {
    const runs = await this.options.repository.listAgentRuns({ task_id: taskId });
    const run = runs.at(-1);
    if (run === undefined) throw controlError("RUN_NOT_FOUND");
    return run;
  }

  private async assertCurrentRun(args: JsonObject, runId: string): Promise<void> {
    const run = await this.options.repository.getAgentRun(runId);
    if (
      run === undefined ||
      run.value.task_id !== stringArg(args, "task_id") ||
      run.value.task_version !== integerArg(args, "task_version")
    )
      throw controlError("RUN_SCOPE_INVALID");
    this.options.active_runs.require(runId);
  }

  private audit(operation: string, idempotencyKey: string): RuntimeAuditInput {
    return {
      actor: ACTOR,
      operation,
      request_id: this.createId(),
      correlation_id: this.createId(),
      idempotency_key: idempotencyKey,
      event_id: this.createId(),
      occurred_at: this.now().toISOString(),
    };
  }

  private async commitRecords(
    operation: string,
    idempotencyKey: string,
    records: readonly DomainRecordWrite[],
  ): Promise<void> {
    const audit = this.audit(operation, idempotencyKey);
    const events = records.map((record, index) =>
      eventForRecord(record, audit, this.createId(), index),
    );
    await this.options.repository.commit({
      change_id: audit.request_id,
      idempotency: {
        operation,
        key: idempotencyKey,
        request_hash: computeContentHash(jsonValue({ operation, records })),
      },
      records,
      events,
    });
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
      : (
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
        ];
  if (eventType === undefined) throw controlError("RECORD_UPDATE_UNSUPPORTED");
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

function required(value: JsonObject, field: string): unknown {
  if (value[field] === undefined) throw controlError("INVALID_ARGUMENT", { field });
  return value[field];
}

function stringArg(value: JsonObject, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0)
    throw controlError("INVALID_ARGUMENT", { field });
  return result;
}

function optionalString(value: JsonObject, field: string): string | undefined {
  const result = value[field];
  return typeof result === "string" && result.length > 0 ? result : undefined;
}

function integerArg(value: JsonObject, field: string): number {
  const result = value[field];
  if (!Number.isInteger(result) || (result as number) < 1)
    throw controlError("INVALID_ARGUMENT", { field });
  return result as number;
}

function stringArray(value: JsonObject, field: string): readonly string[] {
  const result = value[field];
  if (!Array.isArray(result)) {
    throw controlError("INVALID_ARGUMENT", { field });
  }
  const strings: string[] = [];
  for (const item of result as readonly unknown[]) {
    if (typeof item !== "string") throw controlError("INVALID_ARGUMENT", { field });
    strings.push(item);
  }
  return Object.freeze(strings);
}

function jsonValue(value: unknown): import("@agent-bridge/schemas").DomainJsonValue {
  return JSON.parse(JSON.stringify(value)) as import("@agent-bridge/schemas").DomainJsonValue;
}

function verificationSummaries(
  verification: import("@agent-bridge/worker-runtime").IndependentVerificationResult,
): readonly import("@agent-bridge/schemas").VerificationSummary[] {
  return verification.commands.map((command) => ({
    command: command.contract,
    status:
      command.status === "passed" ? "passed" : command.status === "not_run" ? "not_run" : "failed",
    ...(command.exit_code === undefined ? {} : { exit_code: command.exit_code }),
    artifact_ids: command.log_artifact_id === undefined ? [] : [command.log_artifact_id],
  }));
}

function stableId(prefix: string, key: string): string {
  return `${prefix}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}
