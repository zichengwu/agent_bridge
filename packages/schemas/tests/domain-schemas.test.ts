import { describe, expect, it } from "vitest";

import {
  DOMAIN_SCHEMA_IDS,
  DOMAIN_SCHEMA_KINDS,
  DOMAIN_SCHEMA_REGISTRY,
  DOMAIN_SCHEMA_VERSION,
  DomainSchemaError,
  JSON_SCHEMA_DIALECT,
  assertTask,
  parseDomainObject,
  parseTaskVersion,
  validateDomainObject,
  type DomainSchemaErrorCode,
  type DomainSchemaKind,
} from "../src/index.js";

const timestamp = "2026-07-24T10:00:00+08:00";
const laterTimestamp = "2026-07-24T10:10:00+08:00";
const baseCommit = "8f34b21";
const headCommit = "abc1234";
const contentHash = `sha256:${"a".repeat(64)}`;
const secondContentHash = `sha256:${"b".repeat(64)}`;

type JsonRecord = Record<string, unknown>;
type SampleFactory = () => JsonRecord;

const minimalSamples: Readonly<Record<DomainSchemaKind, SampleFactory>> = {
  task: () => ({
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "AUTH-123",
    project_id: "example-project",
    status: "DRAFT",
    latest_version: 1,
    created_at: timestamp,
    updated_at: timestamp,
  }),
  taskVersion: () => ({
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "AUTH-123",
    task_version: 1,
    project_id: "example-project",
    base_commit: baseCommit,
    policy_version: "1.0",
    objective: "实现登录失败锁定机制",
    role: "developer",
    business_rules: [],
    scope: {
      read: ["src/auth/**"],
      write: ["src/auth/**"],
      deny: ["secrets/**"],
    },
    acceptance_commands: ["pnpm test"],
    git: {
      branch: "agent/AUTH-123/developer",
    },
    context_policy: {
      project_baseline_version: 1,
      rollover_ratio: 0.7,
      inherit_full_transcript: false,
    },
    limits: {
      timeout_seconds: 3600,
      max_review_cycles: 3,
      max_agent_count: 4,
    },
    required_output: ["commit_sha"],
    content_hash: contentHash,
    created_at: timestamp,
  }),
  taskResult: () => ({
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "AUTH-123",
    task_version: 1,
    run_id: "run-001",
    session_ids: ["session-001"],
    status: "submitted",
    base_commit: baseCommit,
    changed_files: [],
    acceptance_results: [],
    review_findings: [],
    known_risks: [],
    unresolved_items: [],
    started_at: timestamp,
    finished_at: laterTimestamp,
  }),
  taskRelation: () => ({
    schema_version: DOMAIN_SCHEMA_VERSION,
    relation_id: "relation-001",
    type: "depends_on",
    source: {
      task_id: "AUTH-123",
      task_version: 1,
    },
    target: {
      task_id: "AUTH-100",
      task_version: 2,
    },
    created_at: timestamp,
  }),
  agentSessionBinding: () => ({
    schema_version: DOMAIN_SCHEMA_VERSION,
    binding_id: "binding-001",
    session_id: "session-001",
    external_session_id: "external-session-001",
    task_id: "AUTH-123",
    task_version: 1,
    run_id: "run-001",
    driver_id: "driver-primary",
    role: "developer",
    status: "ACTIVE",
    context_package_id: "context-001",
    context_package_hash: contentHash,
    created_at: timestamp,
  }),
  contextPackage: () => ({
    schema_version: DOMAIN_SCHEMA_VERSION,
    context_package_id: "context-001",
    task_id: "AUTH-123",
    task_version: 1,
    run_id: "run-001",
    components: [
      {
        component_id: "baseline-001",
        kind: "project_baseline",
        version: 1,
        source: "bridge",
        content_hash: contentHash,
        content: {
          project_id: "example-project",
        },
      },
    ],
    content_hash: secondContentHash,
    created_at: timestamp,
  }),
  handoffPackage: () => ({
    schema_version: DOMAIN_SCHEMA_VERSION,
    handoff_id: "handoff-AUTH-100-v2-001",
    handoff_version: 1,
    source_task: {
      task_id: "AUTH-100",
      task_version: 2,
      final_run_id: "run-008",
    },
    code_state: {
      repository_id: "example-project",
      base_commit: baseCommit,
      head_commit: headCommit,
    },
    completed: [],
    decisions: [],
    contracts: [],
    changed_files: [],
    verification: {
      status: "not_run",
      artifact_ids: [],
    },
    known_issues: [],
    downstream_notes: [],
    field_sources: {
      completed: "agent",
      decisions: "human",
      contracts: "bridge",
      known_issues: "agent",
      downstream_notes: "agent",
    },
    content_hash: contentHash,
    generated_at: timestamp,
  }),
  continuationSnapshot: () => ({
    schema_version: DOMAIN_SCHEMA_VERSION,
    snapshot_id: "snapshot-001",
    snapshot_version: 1,
    task_id: "AUTH-123",
    task_version: 1,
    run_id: "run-001",
    session_id: "session-001",
    source_context_package_id: "context-001",
    source_context_package_hash: contentHash,
    current_step: "补齐领域 Schema",
    completed: [],
    remaining_plan: [],
    git_state: {
      repository_id: "example-project",
      base_commit: baseCommit,
      head_commit: headCommit,
      changed_files: [],
    },
    recent_verification: [],
    blockers: [],
    next_actions: [],
    artifact_ids: [],
    content_hash: secondContentHash,
    created_at: timestamp,
  }),
  projectBaseline: () => ({
    schema_version: DOMAIN_SCHEMA_VERSION,
    project_id: "example-project",
    baseline_version: 1,
    content: { constraints: ["保持领域边界"] },
    content_hash: contentHash,
    created_at: timestamp,
  }),
  approvalRequest: () => ({
    schema_version: DOMAIN_SCHEMA_VERSION,
    approval_id: "approval-001",
    task_id: "AUTH-123",
    task_version: 1,
    run_id: "run-001",
    session_id: "session-001",
    kind: "driver_permission",
    operation: "tool.use",
    request_hash: contentHash,
    status: "pending",
    requested_at: timestamp,
  }),
  reviewCycle: () => ({
    schema_version: DOMAIN_SCHEMA_VERSION,
    review_id: "review-001",
    task_id: "AUTH-123",
    task_version: 1,
    run_id: "run-001",
    session_id: "session-001",
    cycle_number: 1,
    target_commit: headCommit,
    findings: [
      {
        finding_id: "finding-001",
        severity: "error",
        summary: "行为不符合合同",
      },
    ],
    feedback_id: "feedback-001",
    status: "requested",
    verification_results: [],
    created_at: timestamp,
    updated_at: timestamp,
  }),
  controlInvocation: () => ({
    schema_version: DOMAIN_SCHEMA_VERSION,
    invocation_id: "invocation-001",
    tool_name: "bridge_get_task",
    actor: { kind: "controller", id: "controller-local" },
    request_hash: contentHash,
    status: "succeeded",
    occurred_at: timestamp,
  }),
};

const fullSamples: Readonly<Record<DomainSchemaKind, SampleFactory>> = {
  task: () => ({
    ...minimalSamples.task(),
    status: "RUNNING",
    metadata: {
      labels: ["security", "backend"],
      priority: 1,
    },
  }),
  taskVersion: () => ({
    ...minimalSamples.taskVersion(),
    business_rules: [
      {
        id: "BR-AUTH-004",
        description: "连续失败 5 次后锁定 30 分钟",
      },
    ],
    relations: [
      {
        relation_id: "relation-001",
        type: "depends_on",
        target: {
          task_id: "AUTH-100",
          task_version: 2,
        },
      },
    ],
    selected_handoff_ids: ["handoff-AUTH-100-v2-001"],
    metadata: {
      requested_by: "human",
    },
  }),
  taskResult: () => ({
    ...minimalSamples.taskResult(),
    commit_sha: headCommit,
    changed_files: ["src/auth/routes.ts"],
    acceptance_results: [
      {
        command: "pnpm test",
        exit_code: 0,
        duration_ms: 1200,
        log_artifact_id: "artifact-test-auth",
      },
    ],
    review_findings: [
      {
        finding_id: "finding-001",
        severity: "warning",
        summary: "需要补充限流说明",
        file: "src/auth/routes.ts",
        line: 42,
      },
    ],
    known_risks: ["旧客户端暂未展示锁定倒计时"],
    unresolved_items: ["补充运维告警"],
    artifacts: [
      {
        artifact_id: "artifact-test-auth",
        kind: "test_log",
        content_hash: contentHash,
      },
    ],
    provider_id: "configured/provider",
    model_id: "configured/model[extended]",
    output: {
      summary: "完成",
      counters: [1, 2, 3],
      nullable: null,
    },
    metadata: {
      attempt: 1,
    },
  }),
  taskRelation: () => ({
    ...minimalSamples.taskRelation(),
    type: "related_to",
    metadata: {
      rationale: "共享认证领域接口",
    },
  }),
  agentSessionBinding: () => ({
    ...minimalSamples.agentSessionBinding(),
    external_session_id: "opaque/external session#1",
    predecessor_session_id: "session-000",
    status: "CLOSED",
    closed_at: laterTimestamp,
    metadata: {
      reason: "run completed",
    },
  }),
  contextPackage: () => ({
    ...minimalSamples.contextPackage(),
    target_session_id: "session-001",
    components: [
      {
        component_id: "baseline-001",
        kind: "project_baseline",
        version: 1,
        source: "bridge",
        content_hash: contentHash,
        content: {
          constraints: ["不读取凭据"],
        },
      },
      {
        component_id: "handoff-AUTH-100-v2-001",
        kind: "handoff",
        version: 1,
        source: "git",
        content_hash: secondContentHash,
        content: ["POST /api/login", { verified: true }],
      },
    ],
    metadata: {
      selection_reason: "explicit",
    },
  }),
  handoffPackage: () => ({
    ...minimalSamples.handoffPackage(),
    completed: ["已实现登录接口"],
    decisions: ["Token 格式保持不变"],
    contracts: ["POST /api/login"],
    changed_files: ["src/auth/routes.ts"],
    verification: {
      status: "passed",
      artifact_ids: ["artifact-test-auth"],
    },
    known_issues: ["暂未实现找回密码"],
    downstream_notes: ["找回密码应复用 UserRepository"],
    metadata: {
      reviewed: true,
    },
  }),
  continuationSnapshot: () => ({
    ...minimalSamples.continuationSnapshot(),
    completed: ["Schema 类型已定义"],
    remaining_plan: ["运行完整验证"],
    git_state: {
      repository_id: "example-project",
      base_commit: baseCommit,
      head_commit: headCommit,
      changed_files: ["packages/schemas/src/types.ts"],
    },
    recent_verification: [
      {
        command: "pnpm test",
        status: "passed",
        exit_code: 0,
        artifact_ids: ["artifact-test-auth"],
      },
    ],
    blockers: [
      {
        code: "WAITING_REVIEW",
        message: "等待审阅",
        details: {
          owner: "human",
        },
      },
    ],
    next_actions: ["运行 pnpm verify"],
    artifact_ids: ["artifact-test-auth"],
    metadata: {
      rollover_reason: "manual",
    },
  }),
  projectBaseline: () => ({
    ...minimalSamples.projectBaseline(),
    metadata: { source: "configured_file" },
  }),
  approvalRequest: () => ({
    ...minimalSamples.approvalRequest(),
    status: "approved",
    permission_id: "permission-001",
    tool_call_id: "tool-call-001",
    reason: "合同范围内操作",
    decided_at: laterTimestamp,
    decided_by: "human",
    metadata: { policy: "explicit" },
  }),
  reviewCycle: () => ({
    ...minimalSamples.reviewCycle(),
    status: "verified",
    candidate_commit: baseCommit,
    verification_results: [
      { command: "pnpm test", status: "passed", exit_code: 0, artifact_ids: [] },
    ],
    updated_at: laterTimestamp,
    metadata: { bounded: true },
  }),
  controlInvocation: () => ({
    ...minimalSamples.controlInvocation(),
    task_id: "AUTH-123",
    task_version: 1,
    run_id: "run-001",
    metadata: { transport: "stdio" },
  }),
};

describe("领域 Schema 注册表", () => {
  it("为每类 Schema 暴露唯一且版本化的 Draft 2020-12 标识", () => {
    const ids = DOMAIN_SCHEMA_KINDS.map((kind) => DOMAIN_SCHEMA_REGISTRY[kind].$id);

    expect(new Set(ids).size).toBe(DOMAIN_SCHEMA_KINDS.length);
    for (const kind of DOMAIN_SCHEMA_KINDS) {
      expect(DOMAIN_SCHEMA_REGISTRY[kind].$schema).toBe(JSON_SCHEMA_DIALECT);
      expect(DOMAIN_SCHEMA_REGISTRY[kind].$id).toBe(DOMAIN_SCHEMA_IDS[kind]);
      expect(DOMAIN_SCHEMA_REGISTRY[kind].properties?.schema_version?.const).toBe(
        DOMAIN_SCHEMA_VERSION,
      );
    }
  });

  it("不包含具体 Agent、SDK、CLI 或 Provider 私有类型名称", () => {
    const serialized = JSON.stringify(DOMAIN_SCHEMA_REGISTRY).toLowerCase();

    expect(serialized).not.toMatch(/opencode|claude|codex|deepseek|agent sdk|provider sdk/u);
  });
});

describe("每类 Schema 的有效样例", () => {
  it.each(DOMAIN_SCHEMA_KINDS)("接受 %s 的最小样例", (kind) => {
    expect(() => parseDomainObject(kind, minimalSamples[kind]())).not.toThrow();
  });

  it.each(DOMAIN_SCHEMA_KINDS)("接受 %s 的完整嵌套样例", (kind) => {
    expect(() => parseDomainObject(kind, fullSamples[kind]())).not.toThrow();
  });
});

describe("必填字段、枚举和结构约束", () => {
  const requiredCases = [
    ["task", "task_id"],
    ["taskVersion", "objective"],
    ["taskResult", "run_id"],
    ["taskRelation", "source"],
    ["agentSessionBinding", "driver_id"],
    ["contextPackage", "components"],
    ["handoffPackage", "code_state"],
    ["continuationSnapshot", "current_step"],
  ] as const satisfies readonly (readonly [DomainSchemaKind, string])[];

  it.each(requiredCases)("%s 缺少 %s 时返回字段级 required 错误", (kind, field) => {
    const sample = minimalSamples[kind]();
    delete sample[field];

    const error = expectSchemaError(() => parseDomainObject(kind, sample), "DOMAIN_SCHEMA_INVALID");
    expect(error.details.issues).toContainEqual({
      path: `/${field}`,
      keyword: "required",
      message: "is required",
    });
  });

  it.each(["depends_on", "related_to", "supersedes", "follow_up_of"])(
    "接受 TaskRelation 枚举 %s",
    (type) => {
      expect(() =>
        parseDomainObject("taskRelation", {
          ...minimalSamples.taskRelation(),
          type,
        }),
      ).not.toThrow();
    },
  );

  it("拒绝未声明的关系、角色、状态和嵌套枚举", () => {
    expectInvalidAt("taskRelation", { ...minimalSamples.taskRelation(), type: "blocks" }, "/type");
    expectInvalidAt("taskVersion", { ...minimalSamples.taskVersion(), role: "writer" }, "/role");
    expectInvalidAt("task", { ...minimalSamples.task(), status: "UNKNOWN" }, "/status");
    expectInvalidAt(
      "taskResult",
      { ...minimalSamples.taskResult(), status: "succeeded" },
      "/status",
    );
    expectInvalidAt(
      "agentSessionBinding",
      { ...minimalSamples.agentSessionBinding(), status: "RUNNING" },
      "/status",
    );

    const context = fullSamples.contextPackage();
    context.components = [
      {
        component_id: "bad-component",
        kind: "transcript",
        version: 1,
        source: "bridge",
        content_hash: contentHash,
        content: {},
      },
    ];
    expectInvalidAt("contextPackage", context, "/components/0/kind");

    const handoff = minimalSamples.handoffPackage();
    handoff.verification = {
      status: "unknown",
      artifact_ids: [],
    };
    expectInvalidAt("handoffPackage", handoff, "/verification/status");

    const snapshot = fullSamples.continuationSnapshot();
    snapshot.recent_verification = [
      {
        command: "pnpm test",
        status: "unknown",
        artifact_ids: [],
      },
    ];
    expectInvalidAt("continuationSnapshot", snapshot, "/recent_verification/0/status");
  });
});

describe("ID、版本、时间、哈希与不可变性", () => {
  it("拒绝非法 ID、非正版本和越界滚动比例", () => {
    expectInvalidAt("task", { ...minimalSamples.task(), task_id: "../escape" }, "/task_id");
    expectInvalidAt(
      "taskVersion",
      { ...minimalSamples.taskVersion(), task_version: 0 },
      "/task_version",
    );

    const taskVersion = minimalSamples.taskVersion();
    taskVersion.context_policy = {
      project_baseline_version: 1,
      rollover_ratio: 0.71,
      inherit_full_transcript: false,
    };
    expectInvalidAt("taskVersion", taskVersion, "/context_policy/rollover_ratio");
  });

  it("拒绝非法 RFC 3339 时间、Git commit 和 sha256 内容哈希", () => {
    expectInvalidAt("task", { ...minimalSamples.task(), created_at: "2026-02-30" }, "/created_at");
    expectInvalidAt(
      "taskResult",
      { ...minimalSamples.taskResult(), base_commit: "main" },
      "/base_commit",
    );
    expectInvalidAt(
      "contextPackage",
      { ...minimalSamples.contextPackage(), content_hash: "sha256:example" },
      "/content_hash",
    );
  });

  it("解析返回独立且深度冻结的 TaskVersion", () => {
    const input = fullSamples.taskVersion();
    const parsed = parseTaskVersion(input);

    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.scope)).toBe(true);
    expect(Object.isFrozen(parsed.scope.read)).toBe(true);
    expect(Reflect.set(parsed, "objective", "篡改")).toBe(false);
    expect(Reflect.set(parsed.scope.read, "0", "secrets/**")).toBe(false);
  });

  it("断言 API 在校验成功后提供领域类型收窄", () => {
    const input: unknown = minimalSamples.task();

    assertTask(input);

    expect(input.task_id).toBe("AUTH-123");
  });
});

describe("未知字段、JSON 扩展和值边界", () => {
  it("拒绝顶层和嵌套对象的未知字段", () => {
    expectInvalidAt(
      "task",
      { ...minimalSamples.task(), unexpected: true },
      "/unexpected",
      "additionalProperties",
    );

    const taskVersion = minimalSamples.taskVersion();
    taskVersion.scope = {
      read: [],
      write: [],
      deny: [],
      unexpected: true,
    };
    expectInvalidAt("taskVersion", taskVersion, "/scope/unexpected", "additionalProperties");
  });

  it("仅在显式 metadata、details 和 content 字段接受任意纯 JSON 值", () => {
    const task = minimalSamples.task();
    task.metadata = {
      nested: {
        flags: [true, false, null],
        count: 2,
      },
    };
    expect(() => parseDomainObject("task", task)).not.toThrow();

    const context = minimalSamples.contextPackage();
    context.components = [
      {
        component_id: "component-001",
        kind: "task_version",
        version: 1,
        source: "bridge",
        content_hash: contentHash,
        content: {
          arbitrary: ["json", 1, true, null],
        },
      },
    ];
    expect(() => parseDomainObject("contextPackage", context)).not.toThrow();
  });

  it("拒绝 undefined、函数、Date 和循环引用等非 JSON 值", () => {
    const taskWithUndefined = minimalSamples.task();
    taskWithUndefined.metadata = {
      invalid: undefined,
    };
    expectInvalidAt("task", taskWithUndefined, "/metadata/invalid");

    const resultWithFunction = minimalSamples.taskResult();
    resultWithFunction.output = {
      invalid: () => "secret",
    };
    expectInvalidAt("taskResult", resultWithFunction, "/output");

    const resultWithDate = minimalSamples.taskResult();
    resultWithDate.output = new Date(timestamp);
    expectInvalidAt("taskResult", resultWithDate, "/output");

    const circular: JsonRecord = {};
    circular.self = circular;
    const resultWithCycle = minimalSamples.taskResult();
    resultWithCycle.output = circular;
    expectInvalidAt("taskResult", resultWithCycle, "/output");
  });

  it("拒绝重复的 Session、路径和稳定输出字段", () => {
    expectInvalidAt(
      "taskResult",
      { ...minimalSamples.taskResult(), session_ids: ["session-001", "session-001"] },
      "/session_ids",
      "uniqueItems",
    );

    const taskVersion = minimalSamples.taskVersion();
    taskVersion.required_output = ["commit_sha", "commit_sha"];
    expectInvalidAt("taskVersion", taskVersion, "/required_output", "uniqueItems");
  });
});

describe("版本兼容与稳定错误边界", () => {
  it.each(DOMAIN_SCHEMA_KINDS)("%s 拒绝未知 Schema 版本且不静默降级", (kind) => {
    const sample = {
      ...minimalSamples[kind](),
      schema_version: "2.0",
    };

    const error = expectSchemaError(
      () => parseDomainObject(kind, sample),
      "DOMAIN_SCHEMA_VERSION_UNSUPPORTED",
    );
    expect(error.message).toBe("Unsupported domain schema version");
    expect(error.details).toEqual({
      schema_kind: kind,
      schema_id: DOMAIN_SCHEMA_IDS[kind],
      expected_version: DOMAIN_SCHEMA_VERSION,
      received_version: "2.0",
    });
  });

  it("缺少版本字段属于非法 Schema，而不是未知版本", () => {
    const sample = minimalSamples.task();
    delete sample.schema_version;

    const error = expectSchemaError(
      () => parseDomainObject("task", sample),
      "DOMAIN_SCHEMA_INVALID",
    );
    expect(error.details.issues?.[0]).toEqual({
      path: "/schema_version",
      keyword: "required",
      message: "is required",
    });
  });

  it("对同一非法输入返回稳定、无输入值泄漏的错误", () => {
    const invalid = {
      ...minimalSamples.task(),
      task_id: "",
      secret_field: "should-not-leak",
    };

    const first = expectSchemaError(
      () => parseDomainObject("task", invalid),
      "DOMAIN_SCHEMA_INVALID",
    );
    const second = expectSchemaError(
      () => parseDomainObject("task", invalid),
      "DOMAIN_SCHEMA_INVALID",
    );

    expect(first.message).toBe("Domain schema validation failed");
    expect(first.details).toEqual(second.details);
    expect(first.details).toEqual({
      schema_kind: "task",
      schema_id: DOMAIN_SCHEMA_IDS.task,
      expected_version: DOMAIN_SCHEMA_VERSION,
      issues: [
        {
          path: "/task_id",
          keyword: "minLength",
          message: "must not be empty or shorter than the minimum length",
        },
        {
          path: "/task_id",
          keyword: "pattern",
          message: "must match the required format",
        },
        {
          path: "/secret_field",
          keyword: "additionalProperties",
          message: "is not an allowed property",
        },
      ],
    });
    expect(JSON.stringify(first)).not.toContain("should-not-leak");
  });

  it("提供不抛异常的判别联合校验结果", () => {
    const valid = validateDomainObject("task", minimalSamples.task());
    const invalid = validateDomainObject("task", {
      ...minimalSamples.task(),
      schema_version: "9.0",
    });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.code).toBe("DOMAIN_SCHEMA_VERSION_UNSUPPORTED");
    }
  });
});

function expectInvalidAt(
  kind: DomainSchemaKind,
  sample: JsonRecord,
  path: string,
  keyword?: string,
): void {
  const error = expectSchemaError(() => parseDomainObject(kind, sample), "DOMAIN_SCHEMA_INVALID");
  expect(error.details.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path,
        ...(keyword === undefined ? {} : { keyword }),
      }),
    ]),
  );
}

function expectSchemaError(operation: () => void, code: DomainSchemaErrorCode): DomainSchemaError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainSchemaError);
    expect((error as DomainSchemaError).code).toBe(code);
    return error as DomainSchemaError;
  }

  throw new Error(`Expected DomainSchemaError with code ${code}`);
}
