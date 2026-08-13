import {
  redactSensitiveContent,
  type AgentRunRecord,
  type AuthoritativeDomainEvent,
  type DomainRepository,
  type StoredDomainRecord,
} from "@agent-bridge/core";
import type {
  ApprovalRequest,
  Task,
  TaskResult,
  TaskResultUsage,
  TaskStatus,
} from "@agent-bridge/schemas";

import { controlError } from "./errors.js";

export type ManagementRangeKind = "session" | "today" | "7d";

export const MANAGEMENT_JSON_BODY_LIMIT_BYTES = 16 * 1024;

export type ManagementDisplayStage =
  "preparing_context" | "executing" | "waiting_approval" | "verifying" | "review" | "completed";

export interface ManagementSnapshot<T> {
  readonly event_cursor: string;
  readonly data: T;
}

export interface ManagementClientRevision {
  readonly server_instance_id: string;
  readonly revision: number;
}

export interface ManagementTaskCard {
  readonly task_id: string;
  readonly run_id: string | null;
  readonly title: string;
  readonly authoritative_status: TaskStatus;
  readonly display_stage: ManagementDisplayStage;
  readonly current_step: string;
  readonly wait_reason: string | null;
  readonly elapsed_ms: number | null;
  readonly latest_event: ManagementSafeEvent | null;
  readonly revision: number;
  readonly etag: string;
}

export interface ManagementSafeEvent {
  readonly kind: "safe_summary";
  readonly message: string;
  readonly occurred_at: string;
}

export interface ManagementUsageView {
  readonly status: "reported" | "unreported";
  readonly input_units: number | null;
  readonly output_units: number | null;
  readonly cache_read_units: number | null;
  readonly cache_write_units: number | null;
  readonly total_units: number | null;
}

export interface ManagementTaskDetail {
  readonly task: ManagementTaskCard;
  readonly task_version_id: string;
  readonly approval: {
    readonly approval_id: string;
    readonly status: ApprovalRequest["status"];
    readonly summary: string;
    readonly feedback_required_on_reject: true;
    readonly etag: string;
  } | null;
  readonly result: {
    readonly outcome: TaskResult["status"] | null;
    readonly verification_summary: "passed" | "failed" | "not_run" | null;
    readonly usage: ManagementUsageView;
  };
  readonly available_actions: readonly ("approve" | "reject" | "cancel")[];
}

export interface ManagementTaskPage {
  readonly items: readonly ManagementTaskCard[];
  readonly next_cursor: string | null;
}

export interface ManagementDashboard {
  readonly range: {
    readonly kind: ManagementRangeKind;
    readonly from: string;
    readonly to: string;
    readonly timezone: string;
  };
  readonly counts: {
    readonly total: number;
    readonly running: number;
    readonly needs_attention: number;
    readonly waiting_approval: number;
    readonly abnormal: number;
    readonly completed: number;
  };
  readonly duration: {
    readonly reported_task_count: number;
    readonly unreported_task_count: number;
    readonly buckets: readonly {
      readonly key: "lt_5m" | "5m_to_lt_15m" | "15m_to_lt_30m" | "gte_30m";
      readonly task_count: number;
      readonly share_basis_points: number;
    }[];
  };
  readonly usage: {
    readonly reported_task_count: number;
    readonly unreported_task_count: number;
    readonly input_units: number | null;
    readonly output_units: number | null;
    readonly cache_read_units: number | null;
    readonly cache_write_units: number | null;
    readonly total_units: number | null;
  };
  readonly lanes: {
    readonly running_task_ids: readonly string[];
    readonly approval_task_ids: readonly string[];
    readonly abnormal_task_ids: readonly string[];
  };
}

export type ManagementProjectionRepository = Pick<
  DomainRepository,
  | "getEventCursor"
  | "listAgentRuns"
  | "listApprovalRequests"
  | "listDomainEvents"
  | "listTaskResults"
  | "listTasks"
  | "listTaskVersions"
>;

export interface ManagementProjectionOptions {
  readonly repository: ManagementProjectionRepository;
  readonly server_started_at: string | Date;
  readonly timezone: string;
  readonly now?: () => Date;
  readonly snapshot_attempts?: number;
}

interface TaskProjectionFacts {
  readonly task: StoredDomainRecord<"task">;
  readonly versions: readonly StoredDomainRecord<"task_version">[];
  readonly runs: readonly StoredDomainRecord<"agent_run">[];
  readonly results: readonly StoredDomainRecord<"task_result">[];
  readonly approvals: readonly StoredDomainRecord<"approval_request">[];
  readonly events: readonly AuthoritativeDomainEvent[];
}

interface ProjectionRange {
  readonly kind: ManagementRangeKind;
  readonly fromDate: Date;
  readonly toDate: Date;
  readonly from: string;
  readonly to: string;
  readonly timezone: string;
}

const TASK_STATUSES = new Set<TaskStatus>([
  "DRAFT",
  "VALIDATED",
  "QUEUED",
  "RUNNING",
  "WAITING_APPROVAL",
  "INTERRUPTED",
  "FAILED",
  "CANCELLED",
  "SUBMITTED",
  "VERIFYING",
  "REVIEW_REQUIRED",
  "CHANGES_REQUESTED",
  "READY_FOR_MERGE",
  "COMPLETED",
]);
const REPOSITORY_READ_LIMIT = 1_000;
const DEFAULT_TASK_PAGE_LIMIT = 50;
const MAX_TASK_PAGE_LIMIT = 200;
const EVENT_CURSOR_PATTERN = /^event-cursor:(0|[1-9][0-9]*)$/u;
const TASK_PAGE_CURSOR_PREFIX = "task-page:";
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["FAILED", "CANCELLED", "COMPLETED"]);
const DURATION_ENDED_TASK_STATUSES = new Set<TaskStatus>([
  "INTERRUPTED",
  "FAILED",
  "CANCELLED",
  "COMPLETED",
]);
const ACTIVE_RUN_STATUSES = new Set<AgentRunRecord["status"]>([
  "created",
  "running",
  "waiting_permission",
  "cancelling",
]);

export class ManagementProjectionService {
  private readonly now: () => Date;
  private readonly serverStartedAt: Date;
  private readonly snapshotAttempts: number;

  constructor(private readonly options: ManagementProjectionOptions) {
    this.now = options.now ?? (() => new Date());
    this.serverStartedAt = readDate(options.server_started_at, "SERVER_STARTED_AT_INVALID");
    assertTimeZone(options.timezone);
    this.snapshotAttempts = readSnapshotAttempts(options.snapshot_attempts);
  }

  async getCurrentCursor(): Promise<string> {
    const cursor = await this.options.repository.getEventCursor();
    decodeEventCursor(cursor);
    return cursor;
  }

  async getDashboard(
    range: ManagementRangeKind = "today",
  ): Promise<ManagementSnapshot<ManagementDashboard>> {
    if (range !== "session" && range !== "today" && range !== "7d") {
      throw controlError("VALIDATION_ERROR", { field: "range" });
    }
    return this.withConsistentSnapshot(async (headCursor) => {
      const now = this.now();
      const projectionRange = createRange(range, this.serverStartedAt, now, this.options.timezone);
      const [tasks, events] = await Promise.all([
        this.readAllTasks(),
        this.readEventsThrough(headCursor),
      ]);
      const rangeTasks = tasks.filter((task) =>
        taskBelongsToRange(task.value, events, projectionRange),
      );
      const results = await Promise.all(
        rangeTasks.map((task) => this.options.repository.listTaskResults(task.value.task_id)),
      );
      return dashboardFromFacts(rangeTasks, results, projectionRange, now);
    });
  }

  async listTasks(query: unknown = {}): Promise<ManagementSnapshot<ManagementTaskPage>> {
    const parsed = readTaskListQuery(query);
    return this.withConsistentSnapshot(async (headCursor) => {
      const [tasks, events] = await Promise.all([
        this.readAllTasks(),
        this.readEventsThrough(headCursor),
      ]);
      const filtered = tasks
        .filter(
          (task) => parsed.statuses.length === 0 || parsed.statuses.includes(task.value.status),
        )
        .sort((left, right) => compareText(left.value.task_id, right.value.task_id));
      const start = pageStart(filtered, parsed.cursor);
      const selected = filtered.slice(start, start + parsed.limit);
      const facts = await Promise.all(selected.map((task) => this.readTaskFacts(task, events)));
      const now = this.now();
      const hasMore = start + selected.length < filtered.length;
      return Object.freeze({
        items: Object.freeze(facts.map((item) => taskCardFromFacts(item, now))),
        next_cursor:
          hasMore && selected.length > 0
            ? encodeTaskPageCursor(selected.at(-1)!.value.task_id)
            : null,
      });
    });
  }

  async getTaskDetail(taskId: string): Promise<ManagementSnapshot<ManagementTaskDetail>> {
    if (!isIdentifier(taskId)) {
      throw controlError("VALIDATION_ERROR", { field: "task_id" });
    }
    return this.withConsistentSnapshot(async (headCursor) => {
      const [tasks, events] = await Promise.all([
        this.readAllTasks(),
        this.readEventsThrough(headCursor),
      ]);
      const task = tasks.find((item) => item.value.task_id === taskId);
      if (task === undefined) {
        throw controlError("RESOURCE_NOT_FOUND", { resource: "task" });
      }
      return taskDetailFromFacts(await this.readTaskFacts(task, events), this.now());
    });
  }

  private async readTaskFacts(
    task: StoredDomainRecord<"task">,
    events: readonly AuthoritativeDomainEvent[],
  ): Promise<TaskProjectionFacts> {
    const [versions, runs, results, approvals] = await Promise.all([
      this.options.repository.listTaskVersions(task.value.task_id),
      this.options.repository.listAgentRuns({
        task_id: task.value.task_id,
        limit: REPOSITORY_READ_LIMIT,
      }),
      this.options.repository.listTaskResults(task.value.task_id),
      this.options.repository.listApprovalRequests({
        task_id: task.value.task_id,
        limit: REPOSITORY_READ_LIMIT,
      }),
    ]);
    return Object.freeze({
      task,
      versions,
      runs,
      results,
      approvals,
      events: Object.freeze(events.filter((event) => event.audit.task_id === task.value.task_id)),
    });
  }

  private async readAllTasks(): Promise<readonly StoredDomainRecord<"task">[]> {
    const tasks: StoredDomainRecord<"task">[] = [];
    let afterTaskId: string | undefined;
    while (true) {
      const page = await this.options.repository.listTasks({
        limit: REPOSITORY_READ_LIMIT,
        order_by: "record_id",
        ...(afterTaskId === undefined ? {} : { after_task_id: afterTaskId }),
      });
      if (page.length === 0) break;
      const nextTaskId = page.at(-1)!.value.task_id;
      if (afterTaskId !== undefined && compareText(nextTaskId, afterTaskId) <= 0) {
        throw controlError("SNAPSHOT_BUSY");
      }
      tasks.push(...page);
      afterTaskId = nextTaskId;
      if (page.length < REPOSITORY_READ_LIMIT) break;
    }
    return Object.freeze(tasks);
  }

  private async readEventsThrough(
    headCursor: string,
  ): Promise<readonly AuthoritativeDomainEvent[]> {
    const head = decodeEventCursor(headCursor);
    let cursor = "event-cursor:0";
    const events: AuthoritativeDomainEvent[] = [];
    while (decodeEventCursor(cursor) < head) {
      const page = await this.options.repository.listDomainEvents({
        after_cursor: cursor,
        limit: REPOSITORY_READ_LIMIT,
      });
      const next = decodeEventCursor(page.next_cursor);
      if (next <= decodeEventCursor(cursor)) {
        throw controlError("SNAPSHOT_BUSY");
      }
      events.push(...page.events);
      cursor = page.next_cursor;
    }
    return Object.freeze(events);
  }

  private async withConsistentSnapshot<T>(
    read: (headCursor: string) => Promise<T>,
  ): Promise<ManagementSnapshot<T>> {
    for (let attempt = 0; attempt < this.snapshotAttempts; attempt += 1) {
      const cursorBefore = await this.options.repository.getEventCursor();
      decodeEventCursor(cursorBefore);
      const data = await read(cursorBefore);
      const cursorAfter = await this.options.repository.getEventCursor();
      decodeEventCursor(cursorAfter);
      if (cursorBefore === cursorAfter) {
        return Object.freeze({ event_cursor: cursorAfter, data });
      }
    }
    throw controlError("SNAPSHOT_BUSY", { attempts: this.snapshotAttempts });
  }
}

export function deriveDisplayStage(input: {
  readonly task_status: TaskStatus;
  readonly run_status?: AgentRunRecord["status"];
  readonly approval_status?: ApprovalRequest["status"];
}): ManagementDisplayStage {
  if (input.task_status === "WAITING_APPROVAL" || input.approval_status === "pending") {
    return "waiting_approval";
  }
  switch (input.task_status) {
    case "DRAFT":
    case "VALIDATED":
    case "QUEUED":
      return "preparing_context";
    case "RUNNING":
    case "INTERRUPTED":
    case "CANCELLED":
      return "executing";
    case "FAILED":
      return input.run_status === "succeeded" ? "verifying" : "executing";
    case "SUBMITTED":
    case "VERIFYING":
      return "verifying";
    case "REVIEW_REQUIRED":
    case "CHANGES_REQUESTED":
    case "READY_FOR_MERGE":
      return "review";
    case "COMPLETED":
      return "completed";
  }
}

export function assertManagementJsonBodySize(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw controlError("VALIDATION_ERROR", { field: "content_length" });
  }
  if (byteLength > MANAGEMENT_JSON_BODY_LIMIT_BYTES) {
    throw controlError("REQUEST_BODY_TOO_LARGE");
  }
}

export function shouldAcceptManagementRevision(
  current: ManagementClientRevision | undefined,
  candidate: ManagementClientRevision,
): boolean {
  if (
    typeof candidate.server_instance_id !== "string" ||
    candidate.server_instance_id.length === 0 ||
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision < 0
  ) {
    return false;
  }
  return (
    current === undefined ||
    (candidate.server_instance_id === current.server_instance_id &&
      candidate.revision >= current.revision)
  );
}

function dashboardFromFacts(
  tasks: readonly StoredDomainRecord<"task">[],
  resultsByTask: readonly (readonly StoredDomainRecord<"task_result">[])[],
  range: ProjectionRange,
  now: Date,
): ManagementDashboard {
  const statuses = tasks.map((task) => task.value.status);
  const running = statuses.filter((status) =>
    ["RUNNING", "SUBMITTED", "VERIFYING"].includes(status),
  ).length;
  const waitingApproval = statuses.filter((status) => status === "WAITING_APPROVAL").length;
  const abnormal = statuses.filter((status) =>
    ["INTERRUPTED", "FAILED", "CHANGES_REQUESTED"].includes(status),
  ).length;
  const completed = statuses.filter((status) => status === "COMPLETED").length;
  return Object.freeze({
    range: Object.freeze({
      kind: range.kind,
      from: range.from,
      to: range.to,
      timezone: range.timezone,
    }),
    counts: Object.freeze({
      total: tasks.length,
      running,
      needs_attention: waitingApproval + abnormal,
      waiting_approval: waitingApproval,
      abnormal,
      completed,
    }),
    duration: durationSummary(tasks, now),
    usage: usageSummary(tasks, resultsByTask, range),
    lanes: Object.freeze({
      running_task_ids: taskIdsForStatuses(tasks, ["RUNNING", "SUBMITTED", "VERIFYING"]),
      approval_task_ids: taskIdsForStatuses(tasks, ["WAITING_APPROVAL"]),
      abnormal_task_ids: taskIdsForStatuses(tasks, ["INTERRUPTED", "FAILED", "CHANGES_REQUESTED"]),
    }),
  });
}

function durationSummary(
  tasks: readonly StoredDomainRecord<"task">[],
  now: Date,
): ManagementDashboard["duration"] {
  const counts = [0, 0, 0, 0];
  let unreported = 0;
  for (const task of tasks) {
    const start = Date.parse(task.value.created_at);
    const end = DURATION_ENDED_TASK_STATUSES.has(task.value.status)
      ? Date.parse(task.value.updated_at)
      : now.getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      unreported += 1;
      continue;
    }
    const elapsed = end - start;
    const index = elapsed < 300_000 ? 0 : elapsed < 900_000 ? 1 : elapsed < 1_800_000 ? 2 : 3;
    counts[index] = counts[index]! + 1;
  }
  const shares = largestRemainderShares(counts);
  const keys = ["lt_5m", "5m_to_lt_15m", "15m_to_lt_30m", "gte_30m"] as const;
  return Object.freeze({
    reported_task_count: tasks.length - unreported,
    unreported_task_count: unreported,
    buckets: Object.freeze(
      keys.map((key, index) =>
        Object.freeze({ key, task_count: counts[index]!, share_basis_points: shares[index]! }),
      ),
    ),
  });
}

function usageSummary(
  tasks: readonly StoredDomainRecord<"task">[],
  resultsByTask: readonly (readonly StoredDomainRecord<"task_result">[])[],
  range: ProjectionRange,
): ManagementDashboard["usage"] {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let reportedTaskCount = 0;
  resultsByTask.forEach((results) => {
    const facts = results
      .map((result) => result.value.usage)
      .filter((usage): usage is TaskResultUsage =>
        usage === undefined ? false : timestampInRange(usage.measured_at, range),
      );
    if (facts.length === 0) return;
    reportedTaskCount += 1;
    for (const usage of facts) {
      totals.input += usage.input_units;
      totals.output += usage.output_units;
      totals.cacheRead += usage.cache_read_units;
      totals.cacheWrite += usage.cache_write_units;
      totals.total += usage.total_units;
    }
  });
  const hasUsage = reportedTaskCount > 0;
  return Object.freeze({
    reported_task_count: reportedTaskCount,
    unreported_task_count: tasks.length - reportedTaskCount,
    input_units: hasUsage ? totals.input : null,
    output_units: hasUsage ? totals.output : null,
    cache_read_units: hasUsage ? totals.cacheRead : null,
    cache_write_units: hasUsage ? totals.cacheWrite : null,
    total_units: hasUsage ? totals.total : null,
  });
}

function taskBelongsToRange(
  task: Task,
  events: readonly AuthoritativeDomainEvent[],
  range: ProjectionRange,
): boolean {
  const hasEvent = events.some(
    (event) => event.audit.task_id === task.task_id && timestampInRange(event.occurred_at, range),
  );
  return (
    hasEvent ||
    (!TERMINAL_TASK_STATUSES.has(task.status) &&
      Date.parse(task.created_at) < range.toDate.getTime())
  );
}

function taskCardFromFacts(facts: TaskProjectionFacts, now: Date): ManagementTaskCard {
  const run = facts.runs.at(-1);
  const pendingApproval = [...facts.approvals]
    .reverse()
    .find((approval) => approval.value.status === "pending");
  const rejectedWorkerApproval = [...facts.approvals]
    .reverse()
    .find(
      (approval) =>
        approval.value.kind === "driver_permission" && approval.value.status === "denied",
    );
  const stage = deriveDisplayStage({
    task_status: facts.task.value.status,
    ...(run === undefined ? {} : { run_status: run.value.status }),
    ...(pendingApproval === undefined ? {} : { approval_status: pendingApproval.value.status }),
  });
  const version = facts.versions.find(
    (item) => item.value.task_version === facts.task.value.latest_version,
  );
  return Object.freeze({
    task_id: facts.task.value.task_id,
    run_id: run?.value.run_id ?? null,
    title: safeManagementText(version?.value.objective, "未命名任务"),
    authoritative_status: facts.task.value.status,
    display_stage: stage,
    current_step: currentStep(stage),
    wait_reason: waitReason(facts.task.value.status, stage, rejectedWorkerApproval !== undefined),
    elapsed_ms: elapsedMilliseconds(facts.task.value, now),
    latest_event: latestSafeEvent(facts.events, now),
    revision: facts.task.revision,
    etag: `"task-${facts.task.value.task_id}-r${facts.task.revision}"`,
  });
}

function taskDetailFromFacts(facts: TaskProjectionFacts, now: Date): ManagementTaskDetail {
  const task = taskCardFromFacts(facts, now);
  const approval = [...facts.approvals].reverse().find((item) => item.value.status === "pending");
  const result = facts.results.at(-1)?.value;
  const actions: Array<"approve" | "reject" | "cancel"> = [];
  if (approval !== undefined) actions.push("approve", "reject");
  const run = facts.runs.at(-1);
  if (run !== undefined && ACTIVE_RUN_STATUSES.has(run.value.status)) actions.push("cancel");
  return Object.freeze({
    task,
    task_version_id: `${facts.task.value.task_id}:v${facts.task.value.latest_version}`,
    approval:
      approval === undefined
        ? null
        : Object.freeze({
            approval_id: approval.value.approval_id,
            status: approval.value.status,
            summary:
              approval.value.kind === "driver_permission"
                ? "需要确认 Driver 权限动作"
                : "需要确认运行控制动作",
            feedback_required_on_reject: true as const,
            etag: `"approval-${approval.value.approval_id}-r${approval.revision}"`,
          }),
    result: Object.freeze({
      outcome: result?.status ?? null,
      verification_summary: result === undefined ? null : verificationSummary(result),
      usage: usageView(result?.usage),
    }),
    available_actions: Object.freeze(actions),
  });
}

function usageView(usage: TaskResultUsage | undefined): ManagementUsageView {
  if (usage === undefined) {
    return Object.freeze({
      status: "unreported",
      input_units: null,
      output_units: null,
      cache_read_units: null,
      cache_write_units: null,
      total_units: null,
    });
  }
  return Object.freeze({
    status: "reported",
    input_units: usage.input_units,
    output_units: usage.output_units,
    cache_read_units: usage.cache_read_units,
    cache_write_units: usage.cache_write_units,
    total_units: usage.total_units,
  });
}

function verificationSummary(result: TaskResult): "passed" | "failed" | "not_run" {
  if (result.acceptance_results.length === 0) return "not_run";
  return result.acceptance_results.every((item) => item.exit_code === 0) ? "passed" : "failed";
}

function latestSafeEvent(
  events: readonly AuthoritativeDomainEvent[],
  to: Date,
): ManagementSafeEvent | null {
  const event = events
    .filter((item) => Date.parse(item.occurred_at) <= to.getTime())
    .sort((left, right) => {
      const timeOrder = Date.parse(left.occurred_at) - Date.parse(right.occurred_at);
      return timeOrder === 0 ? compareText(left.event_id, right.event_id) : timeOrder;
    })
    .at(-1);
  if (event === undefined) return null;
  return Object.freeze({
    kind: "safe_summary",
    message: safeEventMessage(event.event_type),
    occurred_at: event.occurred_at,
  });
}

function safeEventMessage(eventType: AuthoritativeDomainEvent["event_type"]): string {
  const messages: Readonly<Record<AuthoritativeDomainEvent["event_type"], string>> = {
    "task.created": "任务已创建",
    "task.status_changed": "任务状态已更新",
    "task.updated": "任务记录已更新",
    "task_version.recorded": "任务版本已记录",
    "task_result.recorded": "任务结果已记录",
    "task_relation.recorded": "任务关系已记录",
    "agent_run.created": "执行 Run 已创建",
    "agent_run.status_changed": "执行 Run 状态已更新",
    "agent_run.updated": "执行 Run 已更新",
    "agent_session_binding.recorded": "Agent Session 已绑定",
    "agent_session_binding.status_changed": "Agent Session 状态已更新",
    "context_package.recorded": "任务上下文已准备",
    "handoff_package.recorded": "交接包已记录",
    "continuation_snapshot.recorded": "续接检查点已记录",
    "project_baseline.recorded": "项目基线已记录",
    "approval_request.recorded": "审批请求已创建",
    "approval_request.status_changed": "审批状态已更新",
    "review_cycle.recorded": "Review 轮次已创建",
    "review_cycle.status_changed": "Review 状态已更新",
    "control_invocation.recorded": "控制操作已审计",
  };
  return messages[eventType];
}

function currentStep(stage: ManagementDisplayStage): string {
  return {
    preparing_context: "准备任务上下文",
    executing: "Agent 执行",
    waiting_approval: "等待审批决定",
    verifying: "独立验证",
    review: "Codex Review",
    completed: "已完成",
  }[stage];
}

function waitReason(
  status: TaskStatus,
  stage: ManagementDisplayStage,
  rejectedWorkerApproval: boolean,
): string | null {
  if (stage === "waiting_approval") return "等待人工审批";
  if (status === "INTERRUPTED" && rejectedWorkerApproval) return "等待 Codex 重新规划";
  if (status === "INTERRUPTED" || status === "FAILED" || status === "CHANGES_REQUESTED") {
    return "等待人工处理";
  }
  if (status === "REVIEW_REQUIRED") return "等待 Codex 审查";
  if (status === "READY_FOR_MERGE") return "等待最终集成";
  if (status === "QUEUED") return "等待运行启动";
  return null;
}

function elapsedMilliseconds(task: Task, now: Date): number | null {
  const start = Date.parse(task.created_at);
  const end = DURATION_ENDED_TASK_STATUSES.has(task.status)
    ? Date.parse(task.updated_at)
    : now.getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function safeManagementText(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const redacted = redactSensitiveContent(value);
  if (typeof redacted !== "string") throw controlError("MANAGEMENT_PROJECTION_UNSAFE");
  const safe = redacted
    .replace(
      /\b(?:api[_-]?key|access[_-]?token|password|passwd|secret)\s*[:=]\s*\S+/giu,
      "[REDACTED]",
    )
    .replace(/\/(?:Users|home|private|tmp|var\/folders)\/[^\s"'<>]*/gu, "[LOCAL_PATH]")
    .replace(/\b[A-Za-z]:\\[^\s"'<>]*/gu, "[LOCAL_PATH]");
  const withoutControls = [...safe]
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("")
    .trim();
  return [...withoutControls].slice(0, 240).join("") || fallback;
}

function createRange(
  kind: ManagementRangeKind,
  serverStartedAt: Date,
  now: Date,
  timeZone: string,
): ProjectionRange {
  let fromDate: Date;
  if (kind === "session") {
    fromDate = serverStartedAt;
  } else {
    const currentDate = calendarDate(now, timeZone);
    const startDate = kind === "today" ? currentDate : addCalendarDays(currentDate, -6);
    fromDate = zonedMidnight(startDate, timeZone);
  }
  return Object.freeze({
    kind,
    fromDate,
    toDate: now,
    from: formatInstant(fromDate, timeZone),
    to: formatInstant(now, timeZone),
    timezone: timeZone,
  });
}

function calendarDate(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = zonedParts(date, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function addCalendarDays(
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function zonedMidnight(date: { year: number; month: number; day: number }, timeZone: string): Date {
  const localUtc = Date.UTC(date.year, date.month - 1, date.day);
  let instant = localUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const adjusted = localUtc - offsetMilliseconds(new Date(instant), timeZone);
    if (adjusted === instant) break;
    instant = adjusted;
  }
  return new Date(instant);
}

function formatInstant(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  const offset = offsetMilliseconds(date, timeZone);
  const sign = offset < 0 ? "-" : "+";
  const absoluteMinutes = Math.abs(offset) / 60_000;
  const offsetHours = Math.floor(absoluteMinutes / 60);
  const offsetMinutes = absoluteMinutes % 60;
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.${pad(date.getUTCMilliseconds(), 3)}${sign}${pad(offsetHours)}:${pad(offsetMinutes)}`;
}

function zonedParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) throw controlError("TIMEZONE_INVALID");
    return Number(value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

function offsetMilliseconds(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const represented = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return represented - Math.floor(date.getTime() / 1_000) * 1_000;
}

function timestampInRange(value: string, range: ProjectionRange): boolean {
  const timestamp = Date.parse(value);
  return timestamp >= range.fromDate.getTime() && timestamp <= range.toDate.getTime();
}

function taskIdsForStatuses(
  tasks: readonly StoredDomainRecord<"task">[],
  statuses: readonly TaskStatus[],
): readonly string[] {
  const allowed = new Set(statuses);
  return Object.freeze(
    tasks
      .filter((task) => allowed.has(task.value.status))
      .map((task) => task.value.task_id)
      .sort(compareText),
  );
}

function largestRemainderShares(counts: readonly number[]): readonly number[] {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return Object.freeze(counts.map(() => 0));
  const shares = counts.map((count) => Math.floor((count * 10_000) / total));
  const remaining = 10_000 - shares.reduce((sum, share) => sum + share, 0);
  const order = counts
    .map((count, index) => ({ index, remainder: (count * 10_000) % total }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let index = 0; index < remaining; index += 1) {
    const bucket = order[index]!;
    shares[bucket.index] = shares[bucket.index]! + 1;
  }
  return Object.freeze(shares);
}

function readTaskListQuery(value: unknown): {
  readonly statuses: readonly TaskStatus[];
  readonly cursor?: string;
  readonly limit: number;
} {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some((key) => !["status", "cursor", "limit"].includes(key))
  ) {
    throw controlError("VALIDATION_ERROR");
  }
  const rawStatuses =
    value.status === undefined ? [] : Array.isArray(value.status) ? value.status : [value.status];
  if (
    rawStatuses.some(
      (status) => typeof status !== "string" || !TASK_STATUSES.has(status as TaskStatus),
    )
  ) {
    throw controlError("VALIDATION_ERROR", { field: "status" });
  }
  if (value.cursor !== undefined && typeof value.cursor !== "string") {
    throw controlError("VALIDATION_ERROR", { field: "cursor" });
  }
  const limit = value.limit ?? DEFAULT_TASK_PAGE_LIMIT;
  if (
    !Number.isInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MAX_TASK_PAGE_LIMIT
  ) {
    throw controlError("VALIDATION_ERROR", { field: "limit" });
  }
  return Object.freeze({
    statuses: Object.freeze(rawStatuses as TaskStatus[]),
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
    limit: limit as number,
  });
}

function pageStart(
  tasks: readonly StoredDomainRecord<"task">[],
  cursor: string | undefined,
): number {
  if (cursor === undefined) return 0;
  const taskId = decodeTaskPageCursor(cursor);
  const index = tasks.findIndex((task) => task.value.task_id === taskId);
  if (index < 0) throw controlError("VALIDATION_ERROR", { field: "cursor" });
  return index + 1;
}

function encodeTaskPageCursor(taskId: string): string {
  return `${TASK_PAGE_CURSOR_PREFIX}${Buffer.from(taskId, "utf8").toString("base64url")}`;
}

function decodeTaskPageCursor(cursor: string): string {
  if (!cursor.startsWith(TASK_PAGE_CURSOR_PREFIX) || EVENT_CURSOR_PATTERN.test(cursor)) {
    throw controlError("VALIDATION_ERROR", { field: "cursor" });
  }
  try {
    const taskId = Buffer.from(cursor.slice(TASK_PAGE_CURSOR_PREFIX.length), "base64url").toString(
      "utf8",
    );
    if (!isIdentifier(taskId) || encodeTaskPageCursor(taskId) !== cursor) throw new Error();
    return taskId;
  } catch {
    throw controlError("VALIDATION_ERROR", { field: "cursor" });
  }
}

function decodeEventCursor(cursor: string): number {
  const match = EVENT_CURSOR_PATTERN.exec(cursor);
  const sequence = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(sequence)) throw controlError("SNAPSHOT_BUSY");
  return sequence;
}

function readSnapshotAttempts(value: number | undefined): number {
  const attempts = value ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw controlError("MANAGEMENT_CONFIGURATION_INVALID");
  }
  return attempts;
}

function readDate(value: string | Date, code: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw controlError(code);
  return date;
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date(0));
  } catch {
    throw controlError("TIMEZONE_INVALID");
  }
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
