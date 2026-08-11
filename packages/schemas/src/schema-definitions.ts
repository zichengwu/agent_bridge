import {
  DOMAIN_SCHEMA_IDS,
  DOMAIN_SCHEMA_VERSION,
  JSON_SCHEMA_DIALECT,
  type DomainSchemaKind,
} from "./constants.js";

export type JsonSchemaType =
  "array" | "boolean" | "integer" | "null" | "number" | "object" | "string";

export interface JsonSchema {
  readonly $schema?: string;
  readonly $id?: string;
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  readonly $comment?: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: JsonSchemaType;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly anyOf?: readonly JsonSchema[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: "date-time";
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
}

const identifierSchema: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
};

const opaqueIdentifierSchema: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 512,
};

const nonEmptyStringSchema: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 4096,
};

const pathSchema: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
};

const positiveIntegerSchema: JsonSchema = {
  type: "integer",
  minimum: 1,
};

const nonNegativeIntegerSchema: JsonSchema = {
  type: "integer",
  minimum: 0,
};

const timestampSchema: JsonSchema = {
  type: "string",
  format: "date-time",
};

const gitCommitSchema: JsonSchema = {
  type: "string",
  pattern: "^[0-9a-f]{7,64}$",
};

const contentHashSchema: JsonSchema = {
  type: "string",
  pattern: "^sha256:[0-9a-f]{64}$",
};

const stringListSchema: JsonSchema = {
  type: "array",
  items: nonEmptyStringSchema,
  uniqueItems: true,
};

const pathListSchema: JsonSchema = {
  type: "array",
  items: pathSchema,
  uniqueItems: true,
};

const jsonValueDefinition: JsonSchema = {
  anyOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    {
      type: "array",
      items: { $ref: "#/$defs/jsonValue" },
    },
    {
      type: "object",
      additionalProperties: { $ref: "#/$defs/jsonValue" },
    },
  ],
};

const jsonValueReference: JsonSchema = {
  $ref: "#/$defs/jsonValue",
};

const metadataSchema: JsonSchema = {
  type: "object",
  additionalProperties: jsonValueReference,
};

const taskVersionReferenceSchema: JsonSchema = strictObject(
  {
    task_id: identifierSchema,
    task_version: positiveIntegerSchema,
  },
  ["task_id", "task_version"],
);

const agentRoleSchema: JsonSchema = {
  type: "string",
  enum: ["coordinator", "developer", "tester", "reviewer", "docs", "research"],
};

const taskRelationTypeSchema: JsonSchema = {
  type: "string",
  enum: ["depends_on", "related_to", "supersedes", "follow_up_of"],
};

const fieldSourceSchema: JsonSchema = {
  type: "string",
  enum: ["bridge", "git", "verification", "agent", "human"],
};

const businessRuleSchema: JsonSchema = strictObject(
  {
    id: identifierSchema,
    description: nonEmptyStringSchema,
  },
  ["id", "description"],
);

const taskScopeSchema: JsonSchema = strictObject(
  {
    read: pathListSchema,
    write: pathListSchema,
    deny: pathListSchema,
  },
  ["read", "write", "deny"],
);

const taskRelationReferenceSchema: JsonSchema = strictObject(
  {
    relation_id: identifierSchema,
    type: taskRelationTypeSchema,
    target: taskVersionReferenceSchema,
  },
  ["relation_id", "type", "target"],
);

const taskContextPolicySchema: JsonSchema = strictObject(
  {
    project_baseline_version: positiveIntegerSchema,
    rollover_ratio: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: 0.7,
    },
    inherit_full_transcript: {
      type: "boolean",
      const: false,
    },
  },
  ["project_baseline_version", "rollover_ratio", "inherit_full_transcript"],
);

const taskLimitsSchema: JsonSchema = strictObject(
  {
    timeout_seconds: positiveIntegerSchema,
    max_review_cycles: positiveIntegerSchema,
    max_agent_count: positiveIntegerSchema,
  },
  ["timeout_seconds", "max_review_cycles", "max_agent_count"],
);

const acceptanceResultSchema: JsonSchema = strictObject(
  {
    command: nonEmptyStringSchema,
    exit_code: nonNegativeIntegerSchema,
    duration_ms: nonNegativeIntegerSchema,
    log_artifact_id: identifierSchema,
  },
  ["command", "exit_code", "duration_ms"],
);

const reviewFindingSchema: JsonSchema = strictObject(
  {
    finding_id: identifierSchema,
    severity: {
      type: "string",
      enum: ["info", "warning", "error"],
    },
    summary: nonEmptyStringSchema,
    file: pathSchema,
    line: positiveIntegerSchema,
    expected_behavior: nonEmptyStringSchema,
  },
  ["finding_id", "severity", "summary"],
);

const artifactReferenceSchema: JsonSchema = strictObject(
  {
    artifact_id: identifierSchema,
    kind: nonEmptyStringSchema,
    content_hash: contentHashSchema,
  },
  ["artifact_id", "kind"],
);

const taskResultUsageSchema: JsonSchema = strictObject(
  {
    unit: {
      type: "string",
      const: "token",
    },
    input_units: nonNegativeIntegerSchema,
    output_units: nonNegativeIntegerSchema,
    cache_read_units: nonNegativeIntegerSchema,
    cache_write_units: nonNegativeIntegerSchema,
    total_units: nonNegativeIntegerSchema,
    source: {
      type: "string",
      enum: ["driver_exact", "driver_estimate", "bridge_estimate"],
    },
    measured_at: timestampSchema,
  },
  [
    "unit",
    "input_units",
    "output_units",
    "cache_read_units",
    "cache_write_units",
    "total_units",
    "source",
    "measured_at",
  ],
);

const contextComponentSchema: JsonSchema = strictObject(
  {
    component_id: identifierSchema,
    kind: {
      type: "string",
      enum: [
        "project_baseline",
        "task_version",
        "handoff",
        "continuation_snapshot",
        "review_finding",
        "verification_result",
        "failure_summary",
      ],
    },
    version: positiveIntegerSchema,
    source: fieldSourceSchema,
    content_hash: contentHashSchema,
    content: jsonValueReference,
  },
  ["component_id", "kind", "version", "source", "content_hash", "content"],
);

const handoffFieldSourcesSchema: JsonSchema = strictObject(
  {
    completed: fieldSourceSchema,
    decisions: fieldSourceSchema,
    contracts: fieldSourceSchema,
    known_issues: fieldSourceSchema,
    downstream_notes: fieldSourceSchema,
  },
  ["completed", "decisions", "contracts", "known_issues", "downstream_notes"],
);

const verificationSummarySchema: JsonSchema = strictObject(
  {
    command: nonEmptyStringSchema,
    status: {
      type: "string",
      enum: ["passed", "failed", "not_run"],
    },
    exit_code: nonNegativeIntegerSchema,
    artifact_ids: {
      type: "array",
      items: identifierSchema,
      uniqueItems: true,
    },
  },
  ["command", "status", "artifact_ids"],
);

const snapshotBlockerSchema: JsonSchema = strictObject(
  {
    code: identifierSchema,
    message: nonEmptyStringSchema,
    details: metadataSchema,
  },
  ["code", "message"],
);

const taskSchema = topLevelSchema(
  "task",
  "Task",
  {
    task_id: identifierSchema,
    project_id: identifierSchema,
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
    latest_version: positiveIntegerSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema,
    metadata: metadataSchema,
  },
  ["task_id", "project_id", "status", "latest_version", "created_at", "updated_at"],
);

const taskVersionSchema = topLevelSchema(
  "taskVersion",
  "TaskVersion",
  {
    task_id: identifierSchema,
    task_version: positiveIntegerSchema,
    project_id: identifierSchema,
    base_commit: gitCommitSchema,
    policy_version: {
      type: "string",
      pattern: "^[0-9]+\\.[0-9]+$",
    },
    objective: nonEmptyStringSchema,
    role: agentRoleSchema,
    business_rules: {
      type: "array",
      items: businessRuleSchema,
    },
    scope: taskScopeSchema,
    acceptance_commands: {
      type: "array",
      items: nonEmptyStringSchema,
      minItems: 1,
      uniqueItems: true,
    },
    git: strictObject(
      {
        branch: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          pattern: "^[^\\s]+$",
        },
      },
      ["branch"],
    ),
    relations: {
      type: "array",
      items: taskRelationReferenceSchema,
    },
    selected_handoff_ids: {
      type: "array",
      items: identifierSchema,
      uniqueItems: true,
    },
    context_policy: taskContextPolicySchema,
    limits: taskLimitsSchema,
    required_output: {
      type: "array",
      items: identifierSchema,
      minItems: 1,
      uniqueItems: true,
    },
    content_hash: contentHashSchema,
    created_at: timestampSchema,
    metadata: metadataSchema,
  },
  [
    "task_id",
    "task_version",
    "project_id",
    "base_commit",
    "policy_version",
    "objective",
    "role",
    "business_rules",
    "scope",
    "acceptance_commands",
    "git",
    "context_policy",
    "limits",
    "required_output",
    "content_hash",
    "created_at",
  ],
  "TaskVersion is immutable after creation. Corrections create a new task_version.",
);

const taskResultSchema = topLevelSchema(
  "taskResult",
  "TaskResult",
  {
    task_id: identifierSchema,
    task_version: positiveIntegerSchema,
    run_id: identifierSchema,
    session_ids: {
      type: "array",
      items: identifierSchema,
      minItems: 1,
      uniqueItems: true,
    },
    status: {
      type: "string",
      enum: ["submitted", "failed", "cancelled"],
    },
    base_commit: gitCommitSchema,
    commit_sha: gitCommitSchema,
    changed_files: pathListSchema,
    acceptance_results: {
      type: "array",
      items: acceptanceResultSchema,
    },
    review_findings: {
      type: "array",
      items: reviewFindingSchema,
    },
    known_risks: stringListSchema,
    unresolved_items: stringListSchema,
    artifacts: {
      type: "array",
      items: artifactReferenceSchema,
    },
    provider_id: opaqueIdentifierSchema,
    model_id: opaqueIdentifierSchema,
    usage: taskResultUsageSchema,
    output: jsonValueReference,
    started_at: timestampSchema,
    finished_at: timestampSchema,
    metadata: metadataSchema,
  },
  [
    "task_id",
    "task_version",
    "run_id",
    "session_ids",
    "status",
    "base_commit",
    "changed_files",
    "acceptance_results",
    "review_findings",
    "known_risks",
    "unresolved_items",
    "started_at",
    "finished_at",
  ],
);

const taskRelationSchema = topLevelSchema(
  "taskRelation",
  "TaskRelation",
  {
    relation_id: identifierSchema,
    type: taskRelationTypeSchema,
    source: taskVersionReferenceSchema,
    target: taskVersionReferenceSchema,
    created_at: timestampSchema,
    metadata: metadataSchema,
  },
  ["relation_id", "type", "source", "target", "created_at"],
);

const agentSessionBindingSchema = topLevelSchema(
  "agentSessionBinding",
  "AgentSessionBinding",
  {
    binding_id: identifierSchema,
    session_id: identifierSchema,
    external_session_id: opaqueIdentifierSchema,
    task_id: identifierSchema,
    task_version: positiveIntegerSchema,
    run_id: identifierSchema,
    driver_id: identifierSchema,
    role: agentRoleSchema,
    predecessor_session_id: identifierSchema,
    status: {
      type: "string",
      enum: ["CREATED", "ACTIVE", "ROLLOVER_PENDING", "SUPERSEDED", "CLOSED", "FAILED"],
    },
    context_package_id: identifierSchema,
    context_package_hash: contentHashSchema,
    created_at: timestampSchema,
    closed_at: timestampSchema,
    metadata: metadataSchema,
  },
  [
    "binding_id",
    "session_id",
    "external_session_id",
    "task_id",
    "task_version",
    "run_id",
    "driver_id",
    "role",
    "status",
    "context_package_id",
    "context_package_hash",
    "created_at",
  ],
  "A binding segment is append-only. Session selection and lifecycle transitions are Phase 1B concerns.",
);

const contextPackageSchema = topLevelSchema(
  "contextPackage",
  "ContextPackage",
  {
    context_package_id: identifierSchema,
    task_id: identifierSchema,
    task_version: positiveIntegerSchema,
    run_id: identifierSchema,
    target_session_id: identifierSchema,
    components: {
      type: "array",
      items: contextComponentSchema,
      minItems: 1,
    },
    content_hash: contentHashSchema,
    created_at: timestampSchema,
    metadata: metadataSchema,
  },
  [
    "context_package_id",
    "task_id",
    "task_version",
    "run_id",
    "components",
    "content_hash",
    "created_at",
  ],
  "Allowed component composition and selection policy are enforced in Phase 1C.",
);

const handoffPackageSchema = topLevelSchema(
  "handoffPackage",
  "HandoffPackage",
  {
    handoff_id: identifierSchema,
    handoff_version: positiveIntegerSchema,
    source_task: strictObject(
      {
        task_id: identifierSchema,
        task_version: positiveIntegerSchema,
        final_run_id: identifierSchema,
      },
      ["task_id", "task_version", "final_run_id"],
    ),
    code_state: strictObject(
      {
        repository_id: identifierSchema,
        base_commit: gitCommitSchema,
        head_commit: gitCommitSchema,
      },
      ["repository_id", "base_commit", "head_commit"],
    ),
    completed: stringListSchema,
    decisions: stringListSchema,
    contracts: stringListSchema,
    changed_files: pathListSchema,
    verification: strictObject(
      {
        status: {
          type: "string",
          enum: ["passed", "failed", "not_run"],
        },
        artifact_ids: {
          type: "array",
          items: identifierSchema,
          uniqueItems: true,
        },
      },
      ["status", "artifact_ids"],
    ),
    known_issues: stringListSchema,
    downstream_notes: stringListSchema,
    field_sources: handoffFieldSourcesSchema,
    content_hash: contentHashSchema,
    generated_at: timestampSchema,
    metadata: metadataSchema,
  },
  [
    "handoff_id",
    "handoff_version",
    "source_task",
    "code_state",
    "completed",
    "decisions",
    "contracts",
    "changed_files",
    "verification",
    "known_issues",
    "downstream_notes",
    "field_sources",
    "content_hash",
    "generated_at",
  ],
  "A published HandoffPackage is immutable. Corrections create a new handoff_version.",
);

const continuationSnapshotSchema = topLevelSchema(
  "continuationSnapshot",
  "ContinuationSnapshot",
  {
    snapshot_id: identifierSchema,
    snapshot_version: positiveIntegerSchema,
    task_id: identifierSchema,
    task_version: positiveIntegerSchema,
    run_id: identifierSchema,
    session_id: identifierSchema,
    source_context_package_id: identifierSchema,
    source_context_package_hash: contentHashSchema,
    current_step: nonEmptyStringSchema,
    completed: stringListSchema,
    remaining_plan: stringListSchema,
    git_state: strictObject(
      {
        repository_id: identifierSchema,
        base_commit: gitCommitSchema,
        head_commit: gitCommitSchema,
        changed_files: pathListSchema,
      },
      ["repository_id", "base_commit", "head_commit", "changed_files"],
    ),
    recent_verification: {
      type: "array",
      items: verificationSummarySchema,
    },
    blockers: {
      type: "array",
      items: snapshotBlockerSchema,
    },
    next_actions: stringListSchema,
    artifact_ids: {
      type: "array",
      items: identifierSchema,
      uniqueItems: true,
    },
    content_hash: contentHashSchema,
    created_at: timestampSchema,
    metadata: metadataSchema,
  },
  [
    "snapshot_id",
    "snapshot_version",
    "task_id",
    "task_version",
    "run_id",
    "session_id",
    "source_context_package_id",
    "source_context_package_hash",
    "current_step",
    "completed",
    "remaining_plan",
    "git_state",
    "recent_verification",
    "blockers",
    "next_actions",
    "artifact_ids",
    "content_hash",
    "created_at",
  ],
  "A ContinuationSnapshot is immutable. Rollover timing and successor-session policy are Phase 1C concerns.",
);

const projectBaselineSchema = topLevelSchema(
  "projectBaseline",
  "ProjectBaseline",
  {
    project_id: identifierSchema,
    baseline_version: positiveIntegerSchema,
    content: jsonValueReference,
    content_hash: contentHashSchema,
    created_at: timestampSchema,
    metadata: metadataSchema,
  },
  ["project_id", "baseline_version", "content", "content_hash", "created_at"],
  "Project baselines are immutable and versioned.",
);

const approvalRequestSchema = topLevelSchema(
  "approvalRequest",
  "ApprovalRequest",
  {
    approval_id: identifierSchema,
    task_id: identifierSchema,
    task_version: positiveIntegerSchema,
    run_id: identifierSchema,
    session_id: identifierSchema,
    kind: { type: "string", enum: ["driver_permission", "control_operation"] },
    operation: identifierSchema,
    request_hash: contentHashSchema,
    status: { type: "string", enum: ["pending", "approved", "denied", "cancelled"] },
    permission_id: identifierSchema,
    tool_call_id: identifierSchema,
    reason: nonEmptyStringSchema,
    requested_at: timestampSchema,
    decided_at: timestampSchema,
    decided_by: { type: "string", enum: ["human", "controller"] },
    metadata: metadataSchema,
  },
  [
    "approval_id",
    "task_id",
    "task_version",
    "run_id",
    "session_id",
    "kind",
    "operation",
    "request_hash",
    "status",
    "requested_at",
  ],
);

const reviewCycleSchema = topLevelSchema(
  "reviewCycle",
  "ReviewCycle",
  {
    review_id: identifierSchema,
    task_id: identifierSchema,
    task_version: positiveIntegerSchema,
    run_id: identifierSchema,
    session_id: identifierSchema,
    cycle_number: positiveIntegerSchema,
    target_commit: gitCommitSchema,
    findings: { type: "array", items: reviewFindingSchema, minItems: 1 },
    feedback_id: identifierSchema,
    status: {
      type: "string",
      enum: [
        "requested",
        "feedback_dispatched",
        "resubmitted",
        "verified",
        "resolved",
        "exhausted",
      ],
    },
    candidate_commit: gitCommitSchema,
    verification_results: { type: "array", items: verificationSummarySchema },
    created_at: timestampSchema,
    updated_at: timestampSchema,
    metadata: metadataSchema,
  },
  [
    "review_id",
    "task_id",
    "task_version",
    "run_id",
    "session_id",
    "cycle_number",
    "target_commit",
    "findings",
    "feedback_id",
    "status",
    "verification_results",
    "created_at",
    "updated_at",
  ],
);

const controlInvocationSchema = topLevelSchema(
  "controlInvocation",
  "ControlInvocation",
  {
    invocation_id: identifierSchema,
    tool_name: identifierSchema,
    actor: strictObject(
      {
        kind: { type: "string", enum: ["human", "controller", "bridge", "system"] },
        id: identifierSchema,
      },
      ["kind", "id"],
    ),
    request_hash: contentHashSchema,
    status: { type: "string", enum: ["succeeded", "failed"] },
    error_code: identifierSchema,
    task_id: identifierSchema,
    task_version: positiveIntegerSchema,
    run_id: identifierSchema,
    occurred_at: timestampSchema,
    metadata: metadataSchema,
  },
  ["invocation_id", "tool_name", "actor", "request_hash", "status", "occurred_at"],
  "Control invocations are immutable and contain only redacted audit facts.",
);

export const DOMAIN_SCHEMA_REGISTRY = {
  task: taskSchema,
  taskVersion: taskVersionSchema,
  taskResult: taskResultSchema,
  taskRelation: taskRelationSchema,
  agentSessionBinding: agentSessionBindingSchema,
  contextPackage: contextPackageSchema,
  handoffPackage: handoffPackageSchema,
  continuationSnapshot: continuationSnapshotSchema,
  projectBaseline: projectBaselineSchema,
  approvalRequest: approvalRequestSchema,
  reviewCycle: reviewCycleSchema,
  controlInvocation: controlInvocationSchema,
} as const satisfies Readonly<Record<DomainSchemaKind, JsonSchema>>;

export {
  agentSessionBindingSchema,
  contextPackageSchema,
  continuationSnapshotSchema,
  projectBaselineSchema,
  approvalRequestSchema,
  reviewCycleSchema,
  controlInvocationSchema,
  handoffPackageSchema,
  taskRelationSchema,
  taskResultSchema,
  taskSchema,
  taskVersionSchema,
};

function strictObject(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function topLevelSchema(
  kind: DomainSchemaKind,
  title: string,
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
  comment?: string,
): JsonSchema {
  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: DOMAIN_SCHEMA_IDS[kind],
    ...(comment === undefined ? {} : { $comment: comment }),
    title,
    type: "object",
    properties: {
      schema_version: {
        type: "string",
        const: DOMAIN_SCHEMA_VERSION,
      },
      ...properties,
    },
    required: ["schema_version", ...required],
    additionalProperties: false,
    $defs: {
      jsonValue: jsonValueDefinition,
    },
  };
}
