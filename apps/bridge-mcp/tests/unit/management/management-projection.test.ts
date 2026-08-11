import type {
  AgentRunQuery,
  AgentRunRecord,
  ApprovalRequestQuery,
  AuthoritativeDomainEvent,
  DomainEventPage,
  DomainEventQuery,
  StoredDomainRecord,
  TaskQuery,
} from "@agent-bridge/core";
import {
  DOMAIN_SCHEMA_VERSION,
  type Task,
  type TaskResult,
  type TaskStatus,
  type TaskVersion,
} from "@agent-bridge/schemas";
import { describe, expect, it } from "vitest";

import {
  MANAGEMENT_JSON_BODY_LIMIT_BYTES,
  ManagementProjectionService,
  assertManagementJsonBodySize,
  deriveDisplayStage,
  shouldAcceptManagementRevision,
  type ManagementProjectionRepository,
} from "../../../src/management-projection.js";

const NOW = new Date("2026-08-11T10:30:00.000Z");
const SERVER_STARTED_AT = "2026-08-11T08:00:00.000Z";

describe("Slice A Management Projection", () => {
  it("ARCH-001/007、READ-016 仅依赖 Repository 端口并返回脱敏白名单 DTO", async () => {
    const repository = fixtureRepository({
      tasks: [taskRecord("task-safe", "RUNNING", 7)],
      versions: [
        versionRecord(
          "task-safe",
          "读取 api_key=sk-abcdefghijklmnop 与 /Users/alice/private/config.json",
        ),
      ],
      runs: [runRecord("task-safe", "running")],
      results: [
        resultRecord("task-safe", undefined, {
          transcript: "private transcript",
          artifact_uri: "file:///Users/alice/private/artifact",
        }),
      ],
      events: [event("task-safe", "task.created", "2026-08-11T09:00:00.000Z")],
    });
    const service = createService(repository);

    const detail = await service.getTaskDetail("task-safe");
    const serialized = JSON.stringify(detail);

    expect(detail.data.task.title).toBe("读取 [REDACTED] 与 [LOCAL_PATH]");
    expect(detail.data.task.latest_event).toMatchObject({ message: "任务已创建" });
    expect(serialized).not.toMatch(
      /sk-abcdefghijklmnop|private transcript|artifact_uri|file:\/\/|\/Users\/alice|unsafe_driver_payload|"output":/u,
    );
  });

  it.each([
    ["DRAFT", undefined, undefined, "preparing_context"],
    ["RUNNING", "running", undefined, "executing"],
    ["RUNNING", "waiting_permission", "pending", "waiting_approval"],
    ["VERIFYING", "succeeded", undefined, "verifying"],
    ["REVIEW_REQUIRED", "succeeded", undefined, "review"],
    ["FAILED", "succeeded", undefined, "verifying"],
    ["FAILED", "failed", undefined, "executing"],
    ["COMPLETED", "succeeded", undefined, "completed"],
  ] as const)(
    "ARCH-004 从权威事实派生 %s → %s",
    (taskStatus, runStatus, approvalStatus, expected) => {
      expect(
        deriveDisplayStage({
          task_status: taskStatus,
          ...(runStatus === undefined ? {} : { run_status: runStatus }),
          ...(approvalStatus === undefined ? {} : { approval_status: approvalStatus }),
        }),
      ).toBe(expected);
    },
  );

  it("READ-001 默认 today，并返回服务器时区、自然日起止和互斥计数", async () => {
    const repository = fixtureRepository({
      tasks: [
        taskRecord("task-running", "RUNNING", 2, "2026-08-11T01:00:00.000Z"),
        taskRecord("task-done", "COMPLETED", 3, "2026-08-10T01:00:00.000Z"),
        taskRecord("task-old", "COMPLETED", 4, "2026-08-01T01:00:00.000Z"),
      ],
      results: [
        resultRecord("task-running", {
          unit: "token",
          input_units: 10,
          output_units: 5,
          cache_read_units: 2,
          cache_write_units: 1,
          total_units: 18,
          source: "driver_exact",
          measured_at: "2026-08-11T02:00:00.000Z",
        }),
      ],
      events: [
        event("task-running", "task.created", "2026-08-11T01:00:00.000Z"),
        event("task-done", "task.status_changed", "2026-08-11T03:00:00.000Z"),
        event("task-old", "task.status_changed", "2026-08-02T03:00:00.000Z"),
      ],
    });

    const snapshot = await createService(repository).getDashboard();

    expect(snapshot.data.range).toEqual({
      kind: "today",
      from: "2026-08-11T00:00:00.000+08:00",
      to: "2026-08-11T18:30:00.000+08:00",
      timezone: "Asia/Shanghai",
    });
    expect(snapshot.data.counts).toEqual({
      total: 2,
      running: 1,
      needs_attention: 0,
      waiting_approval: 0,
      abnormal: 0,
      completed: 1,
    });
    expect(snapshot.data.lanes.running_task_ids).toEqual(["task-running"]);
  });

  it("READ-002 session 从 server_started_at 而不是 Agent Session 或浏览器时间计算", async () => {
    const dashboard = await createService(fixtureRepository({})).getDashboard("session");
    expect(dashboard.data.range).toMatchObject({
      kind: "session",
      from: "2026-08-11T16:00:00.000+08:00",
      to: "2026-08-11T18:30:00.000+08:00",
    });
  });

  it("READ-003 today 使用服务端时区自然日并正确跨越 DST 偏移变化", async () => {
    const service = new ManagementProjectionService({
      repository: fixtureRepository({}),
      server_started_at: "2026-03-08T06:00:00.000Z",
      timezone: "America/New_York",
      now: () => new Date("2026-03-08T20:00:00.000Z"),
    });

    const dashboard = await service.getDashboard("today");

    expect(dashboard.data.range.from).toBe("2026-03-08T00:00:00.000-05:00");
    expect(dashboard.data.range.to).toBe("2026-03-08T16:00:00.000-04:00");
  });

  it("READ-004 7d 包含今天在内的七个服务端自然日", async () => {
    const dashboard = await createService(fixtureRepository({})).getDashboard("7d");
    expect(dashboard.data.range.from).toBe("2026-08-05T00:00:00.000+08:00");
    expect(dashboard.data.range.to).toBe("2026-08-11T18:30:00.000+08:00");
  });

  it("READ-005/006 usage 缺失不记零，部分上报只汇总范围内事实与四分量总和", async () => {
    const tasks = [
      taskRecord("task-reported", "RUNNING", 1),
      taskRecord("task-unreported", "RUNNING", 1),
    ];
    const noUsage = await createService(fixtureRepository({ tasks })).getDashboard();
    expect(noUsage.data.usage).toEqual({
      reported_task_count: 0,
      unreported_task_count: 2,
      input_units: null,
      output_units: null,
      cache_read_units: null,
      cache_write_units: null,
      total_units: null,
    });

    const partial = await createService(
      fixtureRepository({
        tasks,
        results: [
          resultRecord("task-reported", {
            unit: "token",
            input_units: 1200,
            output_units: 300,
            cache_read_units: 100,
            cache_write_units: 20,
            total_units: 1620,
            source: "driver_exact",
            measured_at: "2026-08-11T09:00:00.000Z",
          }),
          resultRecord(
            "task-reported",
            {
              unit: "token",
              input_units: 999,
              output_units: 999,
              cache_read_units: 0,
              cache_write_units: 0,
              total_units: 1998,
              source: "driver_exact",
              measured_at: "2026-08-10T09:00:00.000Z",
            },
            undefined,
            "run-old",
          ),
        ],
      }),
    ).getDashboard();
    expect(partial.data.usage).toEqual({
      reported_task_count: 1,
      unreported_task_count: 1,
      input_units: 1200,
      output_units: 300,
      cache_read_units: 100,
      cache_write_units: 20,
      total_units: 1620,
    });
  });

  it("耗时桶使用互斥边界并以最大余数法精确合计 10000 basis points", async () => {
    const repository = fixtureRepository({
      tasks: [
        taskRecord("task-a", "RUNNING", 1, "2026-08-11T10:29:00.000Z"),
        taskRecord("task-b", "RUNNING", 1, "2026-08-11T10:20:00.000Z"),
        taskRecord("task-c", "RUNNING", 1, "2026-08-11T10:10:00.000Z"),
      ],
    });
    const duration = (await createService(repository).getDashboard()).data.duration;
    expect(duration.buckets.map((bucket) => bucket.task_count)).toEqual([1, 1, 1, 0]);
    expect(duration.buckets.reduce((sum, bucket) => sum + bucket.share_basis_points, 0)).toBe(
      10_000,
    );
  });

  it("READ-008/009 任务分页默认/最大边界明确，page cursor 不接受 event cursor", async () => {
    const repository = fixtureRepository({
      tasks: [
        taskRecord("task-c", "FAILED"),
        taskRecord("task-a", "RUNNING"),
        taskRecord("task-b", "COMPLETED"),
      ],
      versions: [versionRecord("task-a"), versionRecord("task-b"), versionRecord("task-c")],
    });
    const service = createService(repository);
    const first = await service.listTasks({ limit: 2 });
    expect(first.data.items.map((item) => item.task_id)).toEqual(["task-a", "task-b"]);
    expect(first.data.next_cursor).toMatch(/^task-page:/u);
    const second = await service.listTasks({ limit: 2, cursor: first.data.next_cursor });
    expect(second.data.items.map((item) => item.task_id)).toEqual(["task-c"]);

    await expect(service.listTasks({ cursor: "event-cursor:1" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(service.listTasks({ limit: 201 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(service.listTasks({ unknown: true })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(service.getDashboard("week" as never)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("READ-010 16 KiB 读取请求体上限在 JSON 解析前可稳定拒绝", () => {
    expect(() => assertManagementJsonBodySize(MANAGEMENT_JSON_BODY_LIMIT_BYTES)).not.toThrow();
    expect(() => assertManagementJsonBodySize(MANAGEMENT_JSON_BODY_LIMIT_BYTES + 1)).toThrowError(
      expect.objectContaining({ code: "REQUEST_BODY_TOO_LARGE" }),
    );
  });

  it("READ-011 快照期间事件头变化时丢弃混合结果并有界重试", async () => {
    const repository = fixtureRepository({
      tasks: [taskRecord("task-1", "RUNNING")],
      events: [event("task-1", "task.created", "2026-08-11T09:00:00.000Z")],
      cursorReads: ["event-cursor:0", "event-cursor:1", "event-cursor:1", "event-cursor:1"],
    });

    const dashboard = await createService(repository).getDashboard();

    expect(dashboard.event_cursor).toBe("event-cursor:1");
    expect(repository.cursorReadCount).toBe(4);
  });

  it("READ-012 快照持续繁忙时返回稳定 SNAPSHOT_BUSY", async () => {
    const repository = fixtureRepository({
      events: [event("task-1", "task.created", "2026-08-11T09:00:00.000Z")],
      cursorReads: ["event-cursor:0", "event-cursor:1", "event-cursor:0", "event-cursor:1"],
    });
    const service = new ManagementProjectionService({
      repository,
      server_started_at: SERVER_STARTED_AT,
      timezone: "Asia/Shanghai",
      now: () => NOW,
      snapshot_attempts: 2,
    });

    await expect(service.getDashboard()).rejects.toMatchObject({
      code: "SNAPSHOT_BUSY",
      retryable: true,
    });
  });

  it("READ-013 客户端归约规则拒绝旧实例和 revision 倒退的异步结果", () => {
    const current = { server_instance_id: "instance-new", revision: 7 };
    expect(
      shouldAcceptManagementRevision(current, {
        server_instance_id: "instance-old",
        revision: 99,
      }),
    ).toBe(false);
    expect(
      shouldAcceptManagementRevision(current, {
        server_instance_id: "instance-new",
        revision: 6,
      }),
    ).toBe(false);
    expect(
      shouldAcceptManagementRevision(current, {
        server_instance_id: "instance-new",
        revision: 7,
      }),
    ).toBe(true);
  });

  it("READ-014/015 详情与列表共享 status/revision/etag，未上报 usage 全部为 null", async () => {
    const repository = fixtureRepository({
      tasks: [taskRecord("task-1", "RUNNING", 9)],
      versions: [versionRecord("task-1")],
      runs: [runRecord("task-1", "running")],
    });
    const service = createService(repository);

    const list = await service.listTasks();
    const detail = await service.getTaskDetail("task-1");

    expect(detail.data.task).toMatchObject({
      authoritative_status: list.data.items[0]!.authoritative_status,
      revision: list.data.items[0]!.revision,
      etag: list.data.items[0]!.etag,
    });
    expect(detail.data.result.usage).toEqual({
      status: "unreported",
      input_units: null,
      output_units: null,
      cache_read_units: null,
      cache_write_units: null,
      total_units: null,
    });
  });
});

function createService(repository: ManagementProjectionRepository): ManagementProjectionService {
  return new ManagementProjectionService({
    repository,
    server_started_at: SERVER_STARTED_AT,
    timezone: "Asia/Shanghai",
    now: () => NOW,
  });
}

interface FixtureInput {
  readonly tasks?: readonly StoredDomainRecord<"task">[];
  readonly versions?: readonly StoredDomainRecord<"task_version">[];
  readonly runs?: readonly StoredDomainRecord<"agent_run">[];
  readonly results?: readonly StoredDomainRecord<"task_result">[];
  readonly approvals?: readonly StoredDomainRecord<"approval_request">[];
  readonly events?: readonly AuthoritativeDomainEvent[];
  readonly cursorReads?: readonly string[];
}

class FixtureRepository implements ManagementProjectionRepository {
  readonly tasks: readonly StoredDomainRecord<"task">[];
  readonly versions: readonly StoredDomainRecord<"task_version">[];
  readonly runs: readonly StoredDomainRecord<"agent_run">[];
  readonly results: readonly StoredDomainRecord<"task_result">[];
  readonly approvals: readonly StoredDomainRecord<"approval_request">[];
  readonly events: readonly AuthoritativeDomainEvent[];
  private readonly cursorReads?: readonly string[];
  cursorReadCount = 0;

  constructor(input: FixtureInput) {
    this.tasks = input.tasks ?? [];
    this.versions = input.versions ?? [];
    this.runs = input.runs ?? [];
    this.results = input.results ?? [];
    this.approvals = input.approvals ?? [];
    this.events = input.events ?? [];
    this.cursorReads = input.cursorReads;
  }

  getEventCursor(): Promise<string> {
    const scripted = this.cursorReads?.[this.cursorReadCount];
    this.cursorReadCount += 1;
    return Promise.resolve(scripted ?? `event-cursor:${this.events.length}`);
  }

  listTasks(query: TaskQuery = {}): Promise<readonly StoredDomainRecord<"task">[]> {
    return Promise.resolve(
      this.tasks
        .filter(
          (task) =>
            (query.project_id === undefined || task.value.project_id === query.project_id) &&
            (query.status === undefined || task.value.status === query.status) &&
            (query.after_task_id === undefined || task.value.task_id > query.after_task_id),
        )
        .sort((left, right) => left.value.task_id.localeCompare(right.value.task_id))
        .slice(0, query.limit ?? this.tasks.length),
    );
  }

  listTaskVersions(taskId: string): Promise<readonly StoredDomainRecord<"task_version">[]> {
    return Promise.resolve(this.versions.filter((version) => version.value.task_id === taskId));
  }

  listAgentRuns(query: AgentRunQuery = {}): Promise<readonly StoredDomainRecord<"agent_run">[]> {
    return Promise.resolve(
      this.runs
        .filter(
          (run) =>
            (query.task_id === undefined || run.value.task_id === query.task_id) &&
            (query.status === undefined || run.value.status === query.status),
        )
        .slice(0, query.limit ?? this.runs.length),
    );
  }

  listTaskResults(taskId: string): Promise<readonly StoredDomainRecord<"task_result">[]> {
    return Promise.resolve(this.results.filter((result) => result.value.task_id === taskId));
  }

  listApprovalRequests(
    query: ApprovalRequestQuery = {},
  ): Promise<readonly StoredDomainRecord<"approval_request">[]> {
    return Promise.resolve(
      this.approvals
        .filter(
          (approval) =>
            (query.task_id === undefined || approval.value.task_id === query.task_id) &&
            (query.status === undefined || approval.value.status === query.status),
        )
        .slice(0, query.limit ?? this.approvals.length),
    );
  }

  listDomainEvents(query: DomainEventQuery = {}): Promise<DomainEventPage> {
    const after = Number(/^event-cursor:(\d+)$/u.exec(query.after_cursor ?? "event-cursor:0")?.[1]);
    const limit = query.limit ?? 100;
    const selected = this.events.slice(after, after + limit);
    const next = selected.length === limit ? after + selected.length : this.events.length;
    return Promise.resolve({ events: selected, next_cursor: `event-cursor:${next}` });
  }
}

function fixtureRepository(input: FixtureInput): FixtureRepository {
  return new FixtureRepository(input);
}

function taskRecord(
  taskId: string,
  status: TaskStatus,
  revision = 1,
  createdAt = "2026-08-11T09:00:00.000Z",
): StoredDomainRecord<"task"> {
  const value: Task = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: taskId,
    project_id: "project-1",
    status,
    latest_version: 1,
    created_at: createdAt,
    updated_at: status === "COMPLETED" ? "2026-08-11T10:00:00.000Z" : createdAt,
  };
  return { kind: "task", record_id: taskId, revision, value };
}

function versionRecord(
  taskId: string,
  objective = `目标 ${taskId}`,
): StoredDomainRecord<"task_version"> {
  const value: TaskVersion = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: taskId,
    task_version: 1,
    project_id: "project-1",
    base_commit: "1942e4d",
    policy_version: "1.0",
    objective,
    role: "developer",
    business_rules: [],
    scope: { read: ["src/**"], write: ["src/**"], deny: [] },
    acceptance_commands: ["pnpm test"],
    git: { branch: `codex/${taskId}` },
    context_policy: {
      project_baseline_version: 1,
      rollover_ratio: 0.7,
      inherit_full_transcript: false,
    },
    limits: { timeout_seconds: 3600, max_review_cycles: 3, max_agent_count: 4 },
    required_output: ["test_results"],
    content_hash: `sha256:${"a".repeat(64)}`,
    created_at: "2026-08-11T09:00:00.000Z",
  };
  return { kind: "task_version", record_id: `${taskId}:v1`, revision: 1, value };
}

function runRecord(
  taskId: string,
  status: AgentRunRecord["status"],
): StoredDomainRecord<"agent_run"> {
  const value: AgentRunRecord = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    run_id: `run-${taskId}`,
    task_id: taskId,
    task_version: 1,
    project_id: "project-1",
    driver_id: "driver-fake",
    role: "developer",
    status,
    created_at: "2026-08-11T09:00:00.000Z",
    updated_at: "2026-08-11T09:00:00.000Z",
  };
  return { kind: "agent_run", record_id: value.run_id, revision: 1, value };
}

function resultRecord(
  taskId: string,
  usage?: TaskResult["usage"],
  output?: TaskResult["output"],
  runId = `run-${taskId}`,
): StoredDomainRecord<"task_result"> {
  const value: TaskResult = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: taskId,
    task_version: 1,
    run_id: runId,
    session_ids: [`session-${taskId}`],
    status: "submitted",
    base_commit: "1942e4d",
    changed_files: [],
    acceptance_results: [],
    review_findings: [],
    known_risks: [],
    unresolved_items: [],
    ...(usage === undefined ? {} : { usage }),
    ...(output === undefined ? {} : { output }),
    started_at: "2026-08-11T09:00:00.000Z",
    finished_at: "2026-08-11T10:00:00.000Z",
  };
  return { kind: "task_result", record_id: runId, revision: 1, value };
}

function event(
  taskId: string,
  eventType: AuthoritativeDomainEvent["event_type"],
  occurredAt: string,
): AuthoritativeDomainEvent {
  return {
    event_id: `event-${taskId}-${occurredAt}`,
    event_version: 1,
    event_type: eventType,
    aggregate: {
      kind: eventType.startsWith("task.") ? "task" : "task_result",
      id: taskId,
      revision: 1,
    },
    occurred_at: occurredAt,
    audit: {
      actor: { kind: "bridge", id: "fixture" },
      operation: "fixture",
      request_id: `request-${taskId}`,
      correlation_id: `correlation-${taskId}`,
      idempotency_key: `key-${taskId}`,
      task_id: taskId,
    },
    payload: {
      unsafe_driver_payload: "sk-abcdefghijklmnop /Users/alice/private",
    },
  };
}
