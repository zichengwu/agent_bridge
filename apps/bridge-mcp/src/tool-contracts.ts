import { taskVersionSchema, type JsonSchema } from "@agent-bridge/schemas";

export interface BridgeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

const id = { type: "string", minLength: 1, maxLength: 128 } as const;
const positive = { type: "integer", minimum: 1 } as const;
const idempotency = { idempotency_key: id } as const;
const task = { task_id: id } as const;
const taskVersion = { task_id: id, task_version: positive } as const;
const managementPreconditions = {
  event_cursor: { type: "string", pattern: "^event-cursor:(0|[1-9][0-9]*)$" },
  target_revision: positive,
  ...idempotency,
} as const;
const runAction = { type: "string", enum: ["retry", "cancel", "cleanup"] } as const;
const reference = strict({ task_id: id, task_version: positive }, ["task_id", "task_version"]);

export const BRIDGE_TOOLS: readonly BridgeToolDefinition[] = Object.freeze([
  tool(
    "bridge_create_task",
    "创建任务及不可变的首个任务版本。",
    { contract: nested(taskVersionSchema), ...idempotency },
    ["contract", "idempotency_key"],
  ),
  tool(
    "bridge_create_task_version",
    "为已有任务创建新的不可变版本和新会话边界。",
    { ...task, contract: nested(taskVersionSchema), ...idempotency },
    ["task_id", "contract", "idempotency_key"],
  ),
  tool(
    "bridge_link_task_versions",
    "声明两个任务版本之间的显式关系。",
    {
      source: reference,
      target: reference,
      relation_type: {
        type: "string",
        enum: ["depends_on", "related_to", "supersedes", "follow_up_of"],
      },
      relation_id: id,
      ...idempotency,
    },
    ["source", "target", "relation_type", "idempotency_key"],
  ),
  tool(
    "bridge_validate_task",
    "根据项目基线和运行限制校验任务版本。",
    { ...taskVersion, ...idempotency },
    ["task_id", "task_version", "idempotency_key"],
  ),
  tool(
    "bridge_prepare_context",
    "从项目基线、当前任务合同和显式 Handoff 生成 Context Package。",
    {
      ...taskVersion,
      selected_handoff_ids: { type: "array", items: id, uniqueItems: true },
      run_id: id,
      ...idempotency,
    },
    ["task_id", "task_version", "selected_handoff_ids", "idempotency_key"],
  ),
  tool(
    "bridge_start_task",
    "在独立 worktree 中启动已校验任务；会话标识由 Bridge 生成。",
    { ...taskVersion, context_package_id: id, ...idempotency },
    ["task_id", "task_version", "context_package_id", "idempotency_key"],
  ),
  tool("bridge_get_task", "查询任务、版本、运行和结果的持久化视图。", task, ["task_id"]),
  tool(
    "bridge_list_tasks",
    "按项目或状态列出可恢复观察的任务。",
    {
      project_id: id,
      status: {
        type: "string",
        enum: [
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
        ],
      },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
    },
    [],
  ),
  tool(
    "bridge_get_events",
    "分页读取任务权威事件。",
    {
      ...task,
      cursor: { type: "string", pattern: "^event-cursor:[0-9]+$" },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
    },
    ["task_id"],
  ),
  tool("bridge_get_result", "读取任务最近的不可变初始结果。", task, ["task_id"]),
  tool("bridge_list_handoffs", "列出任务版本的 Handoff Package。", taskVersion, [
    "task_id",
    "task_version",
  ]),
  tool(
    "bridge_get_context_package",
    "按标识读取持久化 Context Package。",
    { context_package_id: id },
    ["context_package_id"],
  ),
  tool(
    "bridge_rollover_session",
    "在同一 Run 和 TaskVersion 内创建安全的后继会话。",
    {
      ...taskVersion,
      run_id: id,
      reason: { type: "string", minLength: 1, maxLength: 4096 },
      ...idempotency,
    },
    ["task_id", "task_version", "run_id", "reason", "idempotency_key"],
  ),
  tool(
    "bridge_send_feedback",
    "把绑定当前 commit 的结构化 findings 发送给当前有效会话。",
    {
      ...task,
      target_commit: { type: "string", pattern: "^[0-9a-f]{7,64}$" },
      findings: {
        type: "array",
        minItems: 1,
        items: strict(
          {
            finding_id: id,
            severity: { type: "string", enum: ["info", "warning", "error"] },
            summary: { type: "string", minLength: 1, maxLength: 4096 },
            file: { type: "string", minLength: 1, maxLength: 1024 },
            line: positive,
            expected_behavior: { type: "string", minLength: 1, maxLength: 4096 },
          },
          ["finding_id", "severity", "summary"],
        ),
      },
      ...idempotency,
    },
    ["task_id", "target_commit", "findings", "idempotency_key"],
  ),
  tool(
    "bridge_respond_to_approval",
    "响应当前活动运行的待处理审批请求。",
    {
      approval_id: id,
      decision: { type: "string", enum: ["approve", "deny", "reject"] },
      reason: { type: "string", minLength: 1, maxLength: 4096 },
      feedback: { type: "string", minLength: 1, maxLength: 2000 },
      ...managementPreconditions,
    },
    ["approval_id", "decision", "event_cursor", "target_revision", "idempotency_key"],
  ),
  tool(
    "bridge_preview_run_action",
    "只读预览重试、取消或安全清理，并签发 60 秒单次确认令牌。",
    { run_id: id, action: runAction },
    ["run_id", "action"],
  ),
  tool(
    "bridge_confirm_run_action",
    "使用预览令牌确认重试、取消或安全清理。",
    {
      run_id: id,
      action: runAction,
      confirmation_token: { type: "string", minLength: 16, maxLength: 1024 },
      ...managementPreconditions,
    },
    [
      "run_id",
      "action",
      "confirmation_token",
      "event_cursor",
      "target_revision",
      "idempotency_key",
    ],
  ),
  tool(
    "bridge_cancel_task",
    "兼容入口：使用预览令牌取消当前活动 Run，并保留审计和产物。",
    {
      ...task,
      run_id: id,
      reason: { type: "string", minLength: 1, maxLength: 4096 },
      confirmation_token: { type: "string", minLength: 16, maxLength: 1024 },
      ...managementPreconditions,
    },
    ["run_id", "confirmation_token", "event_cursor", "target_revision", "idempotency_key"],
  ),
  tool(
    "bridge_mark_completed",
    "在外部合并已经完成后记录最终 merge commit。",
    { ...task, merge_commit: { type: "string", pattern: "^[0-9a-f]{7,64}$" }, ...idempotency },
    ["task_id", "merge_commit", "idempotency_key"],
  ),
]);

function tool(
  name: string,
  description: string,
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
): BridgeToolDefinition {
  return Object.freeze({ name, description, inputSchema: strict(properties, required) });
}

function strict(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function nested(schema: JsonSchema): JsonSchema {
  return Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== "$schema" && key !== "$id"),
  );
}
