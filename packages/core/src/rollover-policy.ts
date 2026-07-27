import {
  parseContextPackage,
  parseContinuationSnapshot,
  type AgentSessionBinding,
  type ContextPackage,
  type ContinuationSnapshot,
  type DomainJsonValue,
} from "@agent-bridge/schemas";

import {
  canonicalizeDomainJson,
  hasValidDocumentContentHash,
  scanSensitiveContent,
} from "./content-integrity.js";
import { CoreDomainError } from "./errors.js";
import {
  readAgentSessionBinding,
  readAgentSessionBindingSet,
  transitionAgentSessionBinding,
} from "./session-binding.js";

export const DEFAULT_ROLLOVER_RATIO = 0.7;

export interface RolloverRatioConfiguration {
  readonly task?: number;
  readonly project?: number;
  readonly driver?: number;
}

export interface ContextUsageMeasurement {
  readonly mode: "exact" | "estimated";
  readonly used_tokens: number;
  readonly max_tokens?: number;
}

export interface RolloverBoundaryFacts {
  readonly at_input_boundary: boolean;
  readonly open_tool_call_count: number;
  readonly pending_permission_count: number;
  readonly atomic_step_in_progress: boolean;
}

interface RolloverDecisionBase {
  readonly effective_ratio: number;
  readonly used_ratio: number;
  readonly usage_mode: ContextUsageMeasurement["mode"];
  readonly limiting_sources: readonly ("default" | "task" | "project" | "driver")[];
}

type RolloverRatioSource = "default" | "task" | "project" | "driver";

export type SessionRolloverDecision =
  | (RolloverDecisionBase & {
      readonly action: "NOT_REQUIRED";
      readonly reason: "BELOW_THRESHOLD";
    })
  | (RolloverDecisionBase & {
      readonly action: "WAIT_FOR_SAFE_BOUNDARY";
      readonly reason: "UNSAFE_BOUNDARY";
      readonly unsafe_reasons: readonly RolloverUnsafeReason[];
    })
  | (RolloverDecisionBase & {
      readonly action: "PLAN_ROLLOVER";
      readonly reason: "THRESHOLD_REACHED";
    });

export type RolloverUnsafeReason =
  "NOT_AT_INPUT_BOUNDARY" | "OPEN_TOOL_CALLS" | "PENDING_PERMISSIONS" | "ATOMIC_STEP_IN_PROGRESS";

export type ProviderContextErrorRolloverDecision =
  | {
      readonly action: "PLAN_ROLLOVER";
      readonly reason: "PROVIDER_CONTEXT_ERROR";
      readonly attempt_number: 1;
    }
  | {
      readonly action: "WAIT_FOR_SAFE_BOUNDARY";
      readonly reason: "PROVIDER_CONTEXT_ERROR_UNSAFE_BOUNDARY";
      readonly attempt_number: 1;
      readonly unsafe_reasons: readonly RolloverUnsafeReason[];
    }
  | {
      readonly action: "FAIL_RUN";
      readonly reason: "PROVIDER_CONTEXT_ERROR_ATTEMPT_EXHAUSTED";
      readonly prior_attempt_count: number;
    };

export interface EvaluateSessionRolloverInput {
  readonly ratios?: RolloverRatioConfiguration;
  readonly usage: ContextUsageMeasurement;
  readonly boundary: RolloverBoundaryFacts;
}

export interface EvaluateProviderContextErrorRolloverInput {
  readonly prior_attempt_count: number;
  readonly boundary: RolloverBoundaryFacts;
}

export type RolloverPlanDecision =
  | Extract<SessionRolloverDecision, { readonly action: "PLAN_ROLLOVER" }>
  | Extract<ProviderContextErrorRolloverDecision, { readonly action: "PLAN_ROLLOVER" }>;

export interface CreateSessionRolloverPlanInput {
  readonly decision: SessionRolloverDecision | ProviderContextErrorRolloverDecision;
  readonly bindings: readonly AgentSessionBinding[];
  readonly current_session_id: string;
  readonly snapshot: ContinuationSnapshot;
  readonly successor_binding: AgentSessionBinding;
  readonly successor_context_package: ContextPackage;
  readonly requested_at: string;
}

export interface SessionRolloverPlan {
  readonly decision: RolloverPlanDecision;
  readonly previous_binding: AgentSessionBinding;
  readonly pending_binding: AgentSessionBinding;
  readonly successor_binding: AgentSessionBinding;
  readonly successor_context_package: ContextPackage;
  readonly snapshot: ContinuationSnapshot;
  readonly peer_bindings: readonly AgentSessionBinding[];
}

export interface SessionRolloverSuccess {
  readonly status: "SUCCEEDED";
  readonly previous_binding: AgentSessionBinding;
  readonly successor_binding: AgentSessionBinding;
  readonly bindings: readonly AgentSessionBinding[];
  readonly snapshot: ContinuationSnapshot;
  readonly successor_context_package: ContextPackage;
}

export const ROLLOVER_FAILURE_STAGES = [
  "SUCCESSOR_CREATION",
  "SUCCESSOR_ACTIVATION",
  "ROLLOVER_FINALIZATION",
] as const;

export type RolloverFailureStage = (typeof ROLLOVER_FAILURE_STAGES)[number];

export interface SessionRolloverFailure {
  readonly status: "FAILED";
  readonly error_code: "ROLLOVER_FAILED";
  readonly error_details: {
    readonly entity: "agent_session";
    readonly reason: "ROLLOVER_OPERATION_FAILED";
    readonly failure_stage: RolloverFailureStage;
  };
  readonly run_transition: "FAIL";
  readonly previous_binding: AgentSessionBinding;
  readonly successor_binding: AgentSessionBinding;
  readonly bindings: readonly AgentSessionBinding[];
  readonly snapshot: ContinuationSnapshot;
  readonly successor_context_package: ContextPackage;
}

export function evaluateSessionRollover(value: unknown): SessionRolloverDecision {
  const input = readEvaluationInput(value);
  const threshold = effectiveRatio(input.ratios);
  const usedRatio = input.usage.used_tokens / input.usage.max_tokens;
  const base = {
    effective_ratio: threshold.ratio,
    used_ratio: usedRatio,
    usage_mode: input.usage.mode,
    limiting_sources: threshold.sources,
  } as const;

  if (usedRatio < threshold.ratio) {
    return Object.freeze({
      ...base,
      action: "NOT_REQUIRED",
      reason: "BELOW_THRESHOLD",
    });
  }

  const unsafeReasons = collectUnsafeReasons(input.boundary);
  if (unsafeReasons.length > 0) {
    return Object.freeze({
      ...base,
      action: "WAIT_FOR_SAFE_BOUNDARY",
      reason: "UNSAFE_BOUNDARY",
      unsafe_reasons: Object.freeze(unsafeReasons),
    });
  }

  return Object.freeze({
    ...base,
    action: "PLAN_ROLLOVER",
    reason: "THRESHOLD_REACHED",
  });
}

export function evaluateProviderContextErrorRollover(
  value: unknown,
): ProviderContextErrorRolloverDecision {
  if (!isPlainRecord(value) || !isNonNegativeInteger(value.prior_attempt_count)) {
    throw invalidPlan("PROVIDER_CONTEXT_ERROR_INPUT_INVALID");
  }
  const boundary = readBoundary(value.boundary);
  if (value.prior_attempt_count >= 1) {
    return Object.freeze({
      action: "FAIL_RUN",
      reason: "PROVIDER_CONTEXT_ERROR_ATTEMPT_EXHAUSTED",
      prior_attempt_count: value.prior_attempt_count,
    });
  }

  const unsafeReasons = collectUnsafeReasons(boundary);
  if (unsafeReasons.length > 0) {
    return Object.freeze({
      action: "WAIT_FOR_SAFE_BOUNDARY",
      reason: "PROVIDER_CONTEXT_ERROR_UNSAFE_BOUNDARY",
      attempt_number: 1,
      unsafe_reasons: Object.freeze(unsafeReasons),
    });
  }
  return Object.freeze({
    action: "PLAN_ROLLOVER",
    reason: "PROVIDER_CONTEXT_ERROR",
    attempt_number: 1,
  });
}

export function createSessionRolloverPlan(value: unknown): SessionRolloverPlan {
  const input = readPlanInput(value);
  if (input.decision.action === "NOT_REQUIRED") {
    throw new CoreDomainError("ROLLOVER_NOT_REQUIRED", {
      entity: "agent_session",
      reason: "BELOW_THRESHOLD",
      effective_ratio: input.decision.effective_ratio,
      used_ratio: input.decision.used_ratio,
    });
  }
  if (input.decision.action === "WAIT_FOR_SAFE_BOUNDARY") {
    throw new CoreDomainError("ROLLOVER_UNSAFE_BOUNDARY", {
      entity: "agent_session",
      reason: "UNSAFE_BOUNDARY",
      unsafe_reasons: input.decision.unsafe_reasons,
    });
  }
  if (input.decision.action === "FAIL_RUN") {
    throw new CoreDomainError("ROLLOVER_FAILED", {
      entity: "agent_session",
      reason: "PROVIDER_CONTEXT_ERROR_ATTEMPT_EXHAUSTED",
      prior_attempt_count: input.decision.prior_attempt_count,
    });
  }

  const bindings = readAgentSessionBindingSet(input.bindings);
  const current = bindings.find((binding) => binding.session_id === input.current_session_id);
  if (current === undefined || current.status !== "ACTIVE") {
    throw invalidPlan("CURRENT_ACTIVE_SESSION_MISSING");
  }
  validateSnapshot(current, input.snapshot);
  validateSuccessor(
    current,
    bindings,
    input.snapshot,
    input.successor_binding,
    input.successor_context_package,
  );
  validateRolloverTimes(current, input.snapshot, input.successor_binding, input.requested_at);

  const pending = transitionAgentSessionBinding(
    current,
    "REQUEST_ROLLOVER",
    input.requested_at,
    bindings.filter((binding) => binding.session_id !== current.session_id),
  );

  return Object.freeze({
    decision: input.decision,
    previous_binding: current,
    pending_binding: pending,
    successor_binding: input.successor_binding,
    successor_context_package: input.successor_context_package,
    snapshot: input.snapshot,
    peer_bindings: Object.freeze(
      bindings.filter((binding) => binding.session_id !== current.session_id),
    ),
  });
}

export function completeSessionRollover(
  value: SessionRolloverPlan,
  completedAt: unknown,
): SessionRolloverSuccess {
  const plan = readPlan(value);
  const occurredAt = readCompletionTime(completedAt, plan.successor_binding.created_at);
  const activeSuccessor = transitionAgentSessionBinding(
    plan.successor_binding,
    "ACTIVATE",
    occurredAt,
    [plan.pending_binding, ...plan.peer_bindings],
  );
  const supersededPrevious = transitionAgentSessionBinding(
    plan.pending_binding,
    "SUPERSEDE",
    occurredAt,
    [activeSuccessor, ...plan.peer_bindings],
  );
  const bindings = readAgentSessionBindingSet([
    ...plan.peer_bindings,
    supersededPrevious,
    activeSuccessor,
  ]);

  return Object.freeze({
    status: "SUCCEEDED",
    previous_binding: supersededPrevious,
    successor_binding: activeSuccessor,
    bindings,
    snapshot: plan.snapshot,
    successor_context_package: plan.successor_context_package,
  });
}

export function failSessionRollover(
  value: SessionRolloverPlan,
  failedAt: unknown,
  failureStage: unknown,
): SessionRolloverFailure {
  const plan = readPlan(value);
  const occurredAt = readCompletionTime(failedAt, plan.successor_binding.created_at);
  if (!isFailureStage(failureStage)) {
    throw invalidPlan("FAILURE_STAGE_INVALID");
  }

  const failedPrevious = transitionAgentSessionBinding(
    plan.pending_binding,
    "FAIL",
    occurredAt,
    plan.peer_bindings,
  );
  const failedSuccessor = transitionAgentSessionBinding(
    plan.successor_binding,
    "FAIL",
    occurredAt,
    [failedPrevious, ...plan.peer_bindings],
  );
  const bindings = readAgentSessionBindingSet([
    ...plan.peer_bindings,
    failedPrevious,
    failedSuccessor,
  ]);

  return Object.freeze({
    status: "FAILED",
    error_code: "ROLLOVER_FAILED",
    error_details: Object.freeze({
      entity: "agent_session",
      reason: "ROLLOVER_OPERATION_FAILED",
      failure_stage: failureStage,
    }),
    run_transition: "FAIL",
    previous_binding: failedPrevious,
    successor_binding: failedSuccessor,
    bindings,
    snapshot: plan.snapshot,
    successor_context_package: plan.successor_context_package,
  });
}

function readEvaluationInput(value: unknown): {
  readonly ratios: RolloverRatioConfiguration;
  readonly usage: Required<ContextUsageMeasurement>;
  readonly boundary: RolloverBoundaryFacts;
} {
  if (!isPlainRecord(value)) {
    throw invalidPlan("ROLLOVER_INPUT_INVALID");
  }
  const ratios = readRatios(value.ratios);
  const usage = readUsage(value.usage);
  const boundary = readBoundary(value.boundary);
  return { ratios, usage, boundary };
}

function readRatios(value: unknown): RolloverRatioConfiguration {
  if (value === undefined) {
    return Object.freeze({});
  }
  if (!isPlainRecord(value)) {
    throw invalidPlan("ROLLOVER_RATIO_CONFIG_INVALID");
  }
  const allowedKeys = new Set(["task", "project", "driver"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw invalidPlan("ROLLOVER_RATIO_CONFIG_INVALID");
  }
  for (const source of allowedKeys) {
    const ratio = value[source];
    if (ratio !== undefined && !isRatio(ratio)) {
      throw invalidPlan("ROLLOVER_RATIO_INVALID");
    }
  }
  return Object.freeze({
    ...(value.task === undefined ? {} : { task: value.task as number }),
    ...(value.project === undefined ? {} : { project: value.project as number }),
    ...(value.driver === undefined ? {} : { driver: value.driver as number }),
  });
}

function readUsage(value: unknown): Required<ContextUsageMeasurement> {
  if (
    !isPlainRecord(value) ||
    (value.mode !== "exact" && value.mode !== "estimated") ||
    !isNonNegativeInteger(value.used_tokens)
  ) {
    throw invalidPlan("CONTEXT_USAGE_INVALID");
  }
  if (!isPositiveInteger(value.max_tokens)) {
    throw invalidPlan("CONTEXT_LIMIT_MISSING_OR_INVALID");
  }
  return Object.freeze({
    mode: value.mode,
    used_tokens: value.used_tokens,
    max_tokens: value.max_tokens,
  });
}

function readBoundary(value: unknown): RolloverBoundaryFacts {
  if (
    !isPlainRecord(value) ||
    typeof value.at_input_boundary !== "boolean" ||
    !isNonNegativeInteger(value.open_tool_call_count) ||
    !isNonNegativeInteger(value.pending_permission_count) ||
    typeof value.atomic_step_in_progress !== "boolean"
  ) {
    throw invalidPlan("ROLLOVER_BOUNDARY_INVALID");
  }
  return Object.freeze({
    at_input_boundary: value.at_input_boundary,
    open_tool_call_count: value.open_tool_call_count,
    pending_permission_count: value.pending_permission_count,
    atomic_step_in_progress: value.atomic_step_in_progress,
  });
}

function effectiveRatio(config: RolloverRatioConfiguration): {
  readonly ratio: number;
  readonly sources: readonly RolloverRatioSource[];
} {
  const candidates: Array<readonly [RolloverRatioSource, number]> = [
    ["default", DEFAULT_ROLLOVER_RATIO],
  ];
  if (config.task !== undefined) {
    candidates.push(["task", config.task]);
  }
  if (config.project !== undefined) {
    candidates.push(["project", config.project]);
  }
  if (config.driver !== undefined) {
    candidates.push(["driver", config.driver]);
  }
  const ratio = Math.min(...candidates.map((candidate) => candidate[1]));
  return Object.freeze({
    ratio,
    sources: Object.freeze(
      candidates.filter((candidate) => candidate[1] === ratio).map((candidate) => candidate[0]),
    ),
  });
}

function collectUnsafeReasons(boundary: RolloverBoundaryFacts): RolloverUnsafeReason[] {
  const reasons: RolloverUnsafeReason[] = [];
  if (!boundary.at_input_boundary) {
    reasons.push("NOT_AT_INPUT_BOUNDARY");
  }
  if (boundary.open_tool_call_count > 0) {
    reasons.push("OPEN_TOOL_CALLS");
  }
  if (boundary.pending_permission_count > 0) {
    reasons.push("PENDING_PERMISSIONS");
  }
  if (boundary.atomic_step_in_progress) {
    reasons.push("ATOMIC_STEP_IN_PROGRESS");
  }
  return reasons;
}

function readPlanInput(value: unknown): CreateSessionRolloverPlanInput {
  if (!isPlainRecord(value)) {
    throw invalidPlan("ROLLOVER_PLAN_INPUT_INVALID");
  }
  const decision = readDecision(value.decision);
  if (!Array.isArray(value.bindings) || typeof value.current_session_id !== "string") {
    throw invalidPlan("ROLLOVER_BINDINGS_INVALID");
  }

  let snapshot: ContinuationSnapshot;
  let contextPackage: ContextPackage;
  try {
    snapshot = parseContinuationSnapshot(value.snapshot);
    contextPackage = parseContextPackage(value.successor_context_package);
  } catch {
    throw invalidPlan("ROLLOVER_DOCUMENT_SCHEMA_INVALID");
  }
  if (
    isPlainRecord(value.successor_binding) &&
    value.successor_binding.session_id === value.current_session_id
  ) {
    throw invalidPlan("SUCCESSOR_IDENTITY_INVALID");
  }
  let successor: AgentSessionBinding;
  try {
    successor = readAgentSessionBinding(value.successor_binding);
  } catch {
    throw invalidPlan("SUCCESSOR_BINDING_INVALID");
  }
  if (typeof value.requested_at !== "string" || !Number.isFinite(Date.parse(value.requested_at))) {
    throw invalidPlan("ROLLOVER_REQUEST_TIME_INVALID");
  }

  return {
    decision,
    bindings: value.bindings as readonly AgentSessionBinding[],
    current_session_id: value.current_session_id,
    snapshot,
    successor_binding: successor,
    successor_context_package: contextPackage,
    requested_at: value.requested_at,
  };
}

function readDecision(
  value: unknown,
): SessionRolloverDecision | ProviderContextErrorRolloverDecision {
  if (!isPlainRecord(value)) {
    throw invalidPlan("ROLLOVER_DECISION_INVALID");
  }
  if (
    value.action === "PLAN_ROLLOVER" &&
    value.reason === "PROVIDER_CONTEXT_ERROR" &&
    value.attempt_number === 1
  ) {
    return value as unknown as ProviderContextErrorRolloverDecision;
  }
  if (
    value.action === "WAIT_FOR_SAFE_BOUNDARY" &&
    value.reason === "PROVIDER_CONTEXT_ERROR_UNSAFE_BOUNDARY" &&
    value.attempt_number === 1 &&
    isUnsafeReasonList(value.unsafe_reasons)
  ) {
    return value as unknown as ProviderContextErrorRolloverDecision;
  }
  if (
    value.action === "FAIL_RUN" &&
    value.reason === "PROVIDER_CONTEXT_ERROR_ATTEMPT_EXHAUSTED" &&
    isPositiveInteger(value.prior_attempt_count)
  ) {
    return value as unknown as ProviderContextErrorRolloverDecision;
  }
  if (
    !isRatio(value.effective_ratio) ||
    typeof value.used_ratio !== "number" ||
    !Number.isFinite(value.used_ratio) ||
    value.used_ratio < 0 ||
    (value.usage_mode !== "exact" && value.usage_mode !== "estimated") ||
    !isLimitingSourceList(value.limiting_sources)
  ) {
    throw invalidPlan("ROLLOVER_DECISION_INVALID");
  }
  if (
    value.action === "NOT_REQUIRED" &&
    value.reason === "BELOW_THRESHOLD" &&
    value.used_ratio < value.effective_ratio
  ) {
    return value as unknown as SessionRolloverDecision;
  }
  if (
    value.action === "WAIT_FOR_SAFE_BOUNDARY" &&
    value.reason === "UNSAFE_BOUNDARY" &&
    value.used_ratio >= value.effective_ratio &&
    isUnsafeReasonList(value.unsafe_reasons)
  ) {
    return value as unknown as SessionRolloverDecision;
  }
  if (
    value.action === "PLAN_ROLLOVER" &&
    value.reason === "THRESHOLD_REACHED" &&
    value.used_ratio >= value.effective_ratio
  ) {
    return value as unknown as SessionRolloverDecision;
  }
  throw invalidPlan("ROLLOVER_DECISION_INCONSISTENT");
}

function validateSnapshot(current: AgentSessionBinding, snapshot: ContinuationSnapshot): void {
  if (!hasValidDocumentContentHash(asRecord(snapshot))) {
    throw invalidPlan("SNAPSHOT_CONTENT_HASH_MISMATCH");
  }
  const findings = scanSensitiveContent(asJson(snapshot));
  if (findings.length > 0) {
    throw invalidPlan("SNAPSHOT_FORBIDDEN_CONTENT");
  }
  if (
    snapshot.task_id !== current.task_id ||
    snapshot.task_version !== current.task_version ||
    snapshot.run_id !== current.run_id ||
    snapshot.session_id !== current.session_id ||
    snapshot.source_context_package_id !== current.context_package_id ||
    snapshot.source_context_package_hash !== current.context_package_hash
  ) {
    throw invalidPlan("SNAPSHOT_SCOPE_MISMATCH");
  }
}

function validateSuccessor(
  current: AgentSessionBinding,
  bindings: readonly AgentSessionBinding[],
  snapshot: ContinuationSnapshot,
  successor: AgentSessionBinding,
  contextPackage: ContextPackage,
): void {
  if (successor.status !== "CREATED") {
    throw invalidPlan("SUCCESSOR_NOT_CREATED");
  }
  if (
    successor.predecessor_session_id !== current.session_id ||
    successor.session_id === current.session_id ||
    successor.external_session_id === current.external_session_id ||
    successor.binding_id === current.binding_id
  ) {
    throw invalidPlan("SUCCESSOR_IDENTITY_INVALID");
  }
  for (const field of ["task_id", "task_version", "run_id", "driver_id", "role"] as const) {
    if (successor[field] !== current[field]) {
      throw new CoreDomainError("ROLLOVER_PLAN_INVALID", {
        entity: "agent_session",
        reason: "SUCCESSOR_SCOPE_MISMATCH",
        conflict_fields: [field],
      });
    }
  }
  readAgentSessionBindingSet([...bindings, successor]);
  if (!hasValidDocumentContentHash(asRecord(contextPackage))) {
    throw invalidPlan("SUCCESSOR_CONTEXT_CONTENT_HASH_MISMATCH");
  }
  if (
    contextPackage.task_id !== successor.task_id ||
    contextPackage.task_version !== successor.task_version ||
    contextPackage.run_id !== successor.run_id ||
    contextPackage.target_session_id !== successor.session_id ||
    successor.context_package_id !== contextPackage.context_package_id ||
    successor.context_package_hash !== contextPackage.content_hash
  ) {
    throw invalidPlan("SUCCESSOR_CONTEXT_SCOPE_MISMATCH");
  }
  const allowedKinds = new Set([
    "project_baseline",
    "task_version",
    "handoff",
    "continuation_snapshot",
  ]);
  if (
    contextPackage.metadata?.scenario !== "ROLLOVER" ||
    contextPackage.components.some((component) => !allowedKinds.has(component.kind)) ||
    contextPackage.components.filter((component) => component.kind === "project_baseline")
      .length !== 1 ||
    contextPackage.components.filter((component) => component.kind === "task_version").length !== 1
  ) {
    throw invalidPlan("SUCCESSOR_CONTEXT_COMPONENTS_INVALID");
  }
  if (
    contextPackage.components.some(
      (component) => scanSensitiveContent(component.content).length > 0,
    )
  ) {
    throw invalidPlan("SUCCESSOR_CONTEXT_FORBIDDEN_CONTENT");
  }
  const snapshotComponents = contextPackage.components.filter(
    (component) => component.kind === "continuation_snapshot",
  );
  const snapshotComponent = snapshotComponents[0];
  if (
    snapshotComponents.length !== 1 ||
    snapshotComponent === undefined ||
    snapshotComponent.component_id !== snapshot.snapshot_id ||
    snapshotComponent.version !== snapshot.snapshot_version ||
    snapshotComponent.content_hash !== snapshot.content_hash
  ) {
    throw invalidPlan("SUCCESSOR_CONTEXT_SNAPSHOT_INVALID");
  }
  let embeddedSnapshot: ContinuationSnapshot;
  try {
    embeddedSnapshot = parseContinuationSnapshot(snapshotComponent.content);
  } catch {
    throw invalidPlan("SUCCESSOR_CONTEXT_SNAPSHOT_INVALID");
  }
  if (
    !hasValidDocumentContentHash(asRecord(embeddedSnapshot)) ||
    canonicalizeDomainJson(asJson(embeddedSnapshot)) !== canonicalizeDomainJson(asJson(snapshot))
  ) {
    throw invalidPlan("SUCCESSOR_CONTEXT_SNAPSHOT_INVALID");
  }
}

function validateRolloverTimes(
  current: AgentSessionBinding,
  snapshot: ContinuationSnapshot,
  successor: AgentSessionBinding,
  requestedAt: string,
): void {
  const requestedTime = Date.parse(requestedAt);
  if (
    requestedTime < Date.parse(current.created_at) ||
    requestedTime < Date.parse(snapshot.created_at) ||
    Date.parse(successor.created_at) < Date.parse(snapshot.created_at)
  ) {
    throw invalidPlan("ROLLOVER_TIME_ORDER_INVALID");
  }
}

function readPlan(value: SessionRolloverPlan): SessionRolloverPlan {
  if (
    !isPlainRecord(value) ||
    value.decision.action !== "PLAN_ROLLOVER" ||
    value.pending_binding.status !== "ROLLOVER_PENDING" ||
    value.successor_binding.status !== "CREATED" ||
    !Array.isArray(value.peer_bindings)
  ) {
    throw invalidPlan("ROLLOVER_PLAN_STATE_INVALID");
  }
  return value;
}

function readCompletionTime(value: unknown, notBefore: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    Date.parse(value) < Date.parse(notBefore)
  ) {
    throw invalidPlan("ROLLOVER_COMPLETION_TIME_INVALID");
  }
  return value;
}

function isRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isFailureStage(value: unknown): value is RolloverFailureStage {
  return ROLLOVER_FAILURE_STAGES.some((stage) => stage === value);
}

function isUnsafeReasonList(value: unknown): value is readonly RolloverUnsafeReason[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((reason) =>
      [
        "NOT_AT_INPUT_BOUNDARY",
        "OPEN_TOOL_CALLS",
        "PENDING_PERMISSIONS",
        "ATOMIC_STEP_IN_PROGRESS",
      ].includes(reason as string),
    )
  );
}

function isLimitingSourceList(
  value: unknown,
): value is readonly ("default" | "task" | "project" | "driver")[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((source) => ["default", "task", "project", "driver"].includes(source as string))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: object): Readonly<Record<string, unknown>> {
  return value as unknown as Readonly<Record<string, unknown>>;
}

function asJson(value: object): DomainJsonValue {
  return value as unknown as DomainJsonValue;
}

function invalidPlan(reason: string): CoreDomainError {
  return new CoreDomainError("ROLLOVER_PLAN_INVALID", {
    entity: "agent_session",
    reason,
  });
}
