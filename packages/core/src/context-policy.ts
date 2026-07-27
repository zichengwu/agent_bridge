import {
  parseContextPackage,
  parseContinuationSnapshot,
  parseHandoffPackage,
  parseTaskRelation,
  parseTaskVersion,
  type ContextComponent,
  type ContextPackage,
  type DomainJsonValue,
  type FieldSource,
  type ReviewFinding,
  type TaskVersion,
  type VerificationSummary,
} from "@agent-bridge/schemas";

import {
  computeContentHash,
  hasValidDocumentContentHash,
  isDomainJsonValue,
  scanSensitiveContent,
} from "./content-integrity.js";
import { CoreDomainError } from "./errors.js";
import type { HandoffPolicyWarning, HandoffSelectionResult } from "./handoff-policy.js";

export const CONTEXT_ASSEMBLY_SCENARIOS = [
  "NEW_TASK",
  "NEW_TASK_VERSION",
  "SAME_VERSION_REWORK",
  "ROLLOVER",
  "MANUAL_RETRY",
] as const;

export type ContextAssemblyScenario = (typeof CONTEXT_ASSEMBLY_SCENARIOS)[number];

export interface ProjectBaselineInput {
  readonly component_id: string;
  readonly project_id: string;
  readonly baseline_version: number;
  readonly content: DomainJsonValue;
  readonly content_hash: string;
}

export interface ScopedReviewFindingInput {
  readonly component_id: string;
  readonly version: number;
  readonly source: "bridge" | "human";
  readonly task_id: string;
  readonly task_version: number;
  readonly run_id: string;
  readonly session_id: string;
  readonly finding: ReviewFinding;
}

export interface ScopedVerificationResultInput {
  readonly component_id: string;
  readonly version: number;
  readonly source: "bridge" | "verification";
  readonly task_id: string;
  readonly task_version: number;
  readonly run_id: string;
  readonly session_id: string;
  readonly verification: VerificationSummary;
}

export interface FailureSummaryInput {
  readonly component_id: string;
  readonly version: number;
  readonly task_id: string;
  readonly task_version: number;
  readonly source_run_id: string;
  readonly source_session_id: string;
  readonly summary: DomainJsonValue;
}

export interface ContextAssemblyInput {
  readonly scenario: ContextAssemblyScenario;
  readonly context_package_id: string;
  readonly task_version: TaskVersion;
  readonly run_id: string;
  readonly target_session_id: string;
  readonly created_at: string;
  readonly project_baseline: ProjectBaselineInput;
  readonly handoff_selection?: HandoffSelectionResult;
  readonly continuation_snapshot?: import("@agent-bridge/schemas").ContinuationSnapshot;
  readonly predecessor_session_id?: string;
  readonly review_findings?: readonly ScopedReviewFindingInput[];
  readonly verification_results?: readonly ScopedVerificationResultInput[];
  readonly failure_summary?: FailureSummaryInput;
}

export interface ContextAssemblyResult {
  readonly context_package: ContextPackage;
  readonly warnings: readonly HandoffPolicyWarning[];
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const COMPONENT_ORDER = {
  project_baseline: 0,
  task_version: 1,
  handoff: 2,
  continuation_snapshot: 3,
  review_finding: 4,
  verification_result: 5,
  failure_summary: 6,
} as const satisfies Readonly<Record<ContextComponent["kind"], number>>;

export function assembleContextPackage(value: unknown): ContextAssemblyResult {
  const input = readAssemblyInput(value);
  validateScenario(input);
  validateTaskVersionIntegrity(input.task_version);
  validateBaseline(input.task_version, input.project_baseline);
  validateHandoffSelection(input.task_version, input.handoff_selection);

  const components: ContextComponent[] = [
    baselineComponent(input.project_baseline),
    taskVersionComponent(input.task_version),
  ];
  const warnings = [...(input.handoff_selection?.warnings ?? [])].sort((left, right) =>
    compareText(left.handoff_id, right.handoff_id),
  );

  for (const selected of input.handoff_selection?.handoffs ?? []) {
    if (!hasValidDocumentContentHash(asRecord(selected.handoff))) {
      throw invalidContext("HANDOFF_CONTENT_HASH_MISMATCH");
    }
    components.push({
      component_id: selected.handoff.handoff_id,
      kind: "handoff",
      version: selected.handoff.handoff_version,
      source: "bridge",
      content_hash: selected.handoff.content_hash,
      content: asJson(selected.handoff),
    });
  }

  if (input.continuation_snapshot !== undefined) {
    const snapshot = readAndValidateSnapshot(input);
    components.push({
      component_id: snapshot.snapshot_id,
      kind: "continuation_snapshot",
      version: snapshot.snapshot_version,
      source: "bridge",
      content_hash: snapshot.content_hash,
      content: asJson(snapshot),
    });
  }

  for (const finding of input.review_findings ?? []) {
    validateScopedItem(input, finding, "review_finding");
    const content = {
      task_id: finding.task_id,
      task_version: finding.task_version,
      run_id: finding.run_id,
      session_id: finding.session_id,
      finding: finding.finding,
    } as unknown as DomainJsonValue;
    components.push(componentFromContent(finding, "review_finding", content));
  }

  for (const result of input.verification_results ?? []) {
    validateScopedItem(input, result, "verification_result");
    const content = {
      task_id: result.task_id,
      task_version: result.task_version,
      run_id: result.run_id,
      session_id: result.session_id,
      verification: result.verification,
    } as unknown as DomainJsonValue;
    components.push(componentFromContent(result, "verification_result", content));
  }

  if (input.failure_summary !== undefined) {
    validateFailureSummary(input, input.failure_summary);
    const content = {
      task_id: input.failure_summary.task_id,
      task_version: input.failure_summary.task_version,
      source_run_id: input.failure_summary.source_run_id,
      source_session_id: input.failure_summary.source_session_id,
      summary: input.failure_summary.summary,
    } as DomainJsonValue;
    components.push(
      componentFromContent(
        { ...input.failure_summary, source: "bridge" },
        "failure_summary",
        content,
      ),
    );
  }

  validateComponents(components);
  components.sort(compareComponents);

  const metadata = {
    scenario: input.scenario,
    handoff_warnings: warnings,
  } as unknown as DomainJsonValue;
  const packageWithoutHash = {
    schema_version: input.task_version.schema_version,
    context_package_id: input.context_package_id,
    task_id: input.task_version.task_id,
    task_version: input.task_version.task_version,
    run_id: input.run_id,
    target_session_id: input.target_session_id,
    components,
    created_at: input.created_at,
    metadata,
  };

  let contextPackage: ContextPackage;
  try {
    contextPackage = parseContextPackage({
      ...packageWithoutHash,
      content_hash: computeContentHash(packageWithoutHash as unknown as DomainJsonValue),
    });
  } catch {
    throw invalidContext("ASSEMBLED_SCHEMA_INVALID");
  }

  return Object.freeze({
    context_package: contextPackage,
    warnings: Object.freeze(warnings),
  });
}

function readAssemblyInput(value: unknown): ContextAssemblyInput {
  const allowedKeys = new Set([
    "scenario",
    "context_package_id",
    "task_version",
    "run_id",
    "target_session_id",
    "created_at",
    "project_baseline",
    "handoff_selection",
    "continuation_snapshot",
    "predecessor_session_id",
    "review_findings",
    "verification_results",
    "failure_summary",
  ]);
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    !isScenario(value.scenario)
  ) {
    throw invalidContext("ASSEMBLY_INPUT_INVALID");
  }
  if (
    !isIdentifier(value.context_package_id) ||
    !isIdentifier(value.run_id) ||
    !isIdentifier(value.target_session_id) ||
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at))
  ) {
    throw invalidContext("ASSEMBLY_SCOPE_INVALID");
  }

  let taskVersion: TaskVersion;
  try {
    taskVersion = parseTaskVersion(value.task_version);
  } catch {
    throw invalidContext("TASK_VERSION_INVALID");
  }

  return {
    scenario: value.scenario,
    context_package_id: value.context_package_id,
    task_version: taskVersion,
    run_id: value.run_id,
    target_session_id: value.target_session_id,
    created_at: value.created_at,
    project_baseline: readBaseline(value.project_baseline),
    ...(value.handoff_selection === undefined
      ? {}
      : { handoff_selection: readHandoffSelection(value.handoff_selection) }),
    ...(value.continuation_snapshot === undefined
      ? {}
      : { continuation_snapshot: readSnapshot(value.continuation_snapshot) }),
    ...(value.predecessor_session_id === undefined
      ? {}
      : { predecessor_session_id: readIdentifier(value.predecessor_session_id) }),
    ...(value.review_findings === undefined
      ? {}
      : { review_findings: readReviewFindings(value.review_findings) }),
    ...(value.verification_results === undefined
      ? {}
      : { verification_results: readVerificationResults(value.verification_results) }),
    ...(value.failure_summary === undefined
      ? {}
      : { failure_summary: readFailureSummary(value.failure_summary) }),
  };
}

function validateScenario(input: ContextAssemblyInput): void {
  const findingCount = input.review_findings?.length ?? 0;
  const verificationCount = input.verification_results?.length ?? 0;
  switch (input.scenario) {
    case "NEW_TASK":
      if (input.task_version.task_version !== 1) {
        throw invalidContext("NEW_TASK_REQUIRES_VERSION_ONE");
      }
      rejectOptionalScenarioContent(input);
      break;
    case "NEW_TASK_VERSION":
      if (input.task_version.task_version <= 1) {
        throw invalidContext("NEW_TASK_VERSION_REQUIRES_LATER_VERSION");
      }
      rejectOptionalScenarioContent(input);
      break;
    case "SAME_VERSION_REWORK":
      if (
        findingCount + verificationCount === 0 ||
        input.continuation_snapshot !== undefined ||
        input.failure_summary !== undefined ||
        input.predecessor_session_id !== undefined
      ) {
        throw invalidContext("REWORK_COMPONENTS_INVALID");
      }
      break;
    case "ROLLOVER":
      if (
        input.continuation_snapshot === undefined ||
        input.predecessor_session_id === undefined ||
        findingCount > 0 ||
        verificationCount > 0 ||
        input.failure_summary !== undefined
      ) {
        throw invalidContext("ROLLOVER_COMPONENTS_INVALID");
      }
      if (input.predecessor_session_id === input.target_session_id) {
        throw invalidContext("ROLLOVER_TARGET_SESSION_NOT_NEW");
      }
      break;
    case "MANUAL_RETRY":
      if (
        input.failure_summary === undefined ||
        input.continuation_snapshot !== undefined ||
        input.predecessor_session_id !== undefined ||
        findingCount > 0 ||
        verificationCount > 0
      ) {
        throw invalidContext("MANUAL_RETRY_COMPONENTS_INVALID");
      }
      break;
  }
}

function rejectOptionalScenarioContent(input: ContextAssemblyInput): void {
  if (
    input.continuation_snapshot !== undefined ||
    input.failure_summary !== undefined ||
    input.predecessor_session_id !== undefined ||
    (input.review_findings?.length ?? 0) > 0 ||
    (input.verification_results?.length ?? 0) > 0
  ) {
    throw invalidContext("SCENARIO_COMPONENT_FORBIDDEN");
  }
}

function validateTaskVersionIntegrity(taskVersion: TaskVersion): void {
  if (!hasValidDocumentContentHash(asRecord(taskVersion))) {
    throw invalidContext("TASK_VERSION_CONTENT_HASH_MISMATCH");
  }
}

function validateBaseline(taskVersion: TaskVersion, baseline: ProjectBaselineInput): void {
  if (
    baseline.project_id !== taskVersion.project_id ||
    baseline.baseline_version !== taskVersion.context_policy.project_baseline_version
  ) {
    throw invalidContext("PROJECT_BASELINE_SCOPE_MISMATCH");
  }
  const payload = baselinePayload(baseline);
  if (computeContentHash(payload) !== baseline.content_hash) {
    throw invalidContext("PROJECT_BASELINE_CONTENT_HASH_MISMATCH");
  }
}

function validateHandoffSelection(
  taskVersion: TaskVersion,
  selection: HandoffSelectionResult | undefined,
): void {
  const expectedIds = [...(taskVersion.selected_handoff_ids ?? [])].sort();
  const receivedIds = [
    ...(selection?.handoffs.map((item) => item.handoff.handoff_id) ?? []),
  ].sort();
  if (
    expectedIds.length !== receivedIds.length ||
    expectedIds.some((handoffId, index) => handoffId !== receivedIds[index])
  ) {
    throw invalidContext("HANDOFF_SELECTION_MISMATCH");
  }

  for (const selected of selection?.handoffs ?? []) {
    const declared = taskVersion.relations?.find(
      (relation) => relation.relation_id === selected.relation.relation_id,
    );
    if (
      declared === undefined ||
      declared.type !== selected.relation.type ||
      selected.relation.source.task_id !== taskVersion.task_id ||
      selected.relation.source.task_version !== taskVersion.task_version ||
      selected.relation.target.task_id !== selected.handoff.source_task.task_id ||
      selected.relation.target.task_version !== selected.handoff.source_task.task_version ||
      declared.target.task_id !== selected.handoff.source_task.task_id ||
      declared.target.task_version !== selected.handoff.source_task.task_version
    ) {
      throw invalidContext("HANDOFF_RELATION_SCOPE_MISMATCH");
    }
  }

  for (const warning of selection?.warnings ?? []) {
    const selected = selection?.handoffs.find(
      (item) => item.handoff.handoff_id === warning.handoff_id,
    );
    if (
      selected === undefined ||
      selected.relation.relation_id !== warning.relation_id ||
      selected.relation.type !== "related_to"
    ) {
      throw invalidContext("HANDOFF_WARNING_INVALID");
    }
  }
}

function readAndValidateSnapshot(
  input: ContextAssemblyInput,
): import("@agent-bridge/schemas").ContinuationSnapshot {
  const snapshot = input.continuation_snapshot;
  if (snapshot === undefined) {
    throw invalidContext("CONTINUATION_SNAPSHOT_MISSING");
  }
  if (!hasValidDocumentContentHash(asRecord(snapshot))) {
    throw invalidContext("CONTINUATION_SNAPSHOT_CONTENT_HASH_MISMATCH");
  }
  if (
    snapshot.task_id !== input.task_version.task_id ||
    snapshot.task_version !== input.task_version.task_version ||
    snapshot.run_id !== input.run_id ||
    snapshot.session_id !== input.predecessor_session_id
  ) {
    throw invalidContext("CONTINUATION_SNAPSHOT_SCOPE_MISMATCH");
  }
  return snapshot;
}

function validateScopedItem(
  input: ContextAssemblyInput,
  item: ScopedReviewFindingInput | ScopedVerificationResultInput,
  kind: "review_finding" | "verification_result",
): void {
  if (
    item.task_id !== input.task_version.task_id ||
    item.task_version !== input.task_version.task_version ||
    item.run_id !== input.run_id ||
    item.session_id !== input.target_session_id
  ) {
    throw invalidContext(`${kind.toUpperCase()}_SCOPE_MISMATCH`);
  }
}

function validateFailureSummary(input: ContextAssemblyInput, summary: FailureSummaryInput): void {
  if (
    summary.task_id !== input.task_version.task_id ||
    summary.task_version !== input.task_version.task_version ||
    summary.source_run_id === input.run_id
  ) {
    throw invalidContext("FAILURE_SUMMARY_SCOPE_MISMATCH");
  }
}

function validateComponents(components: readonly ContextComponent[]): void {
  const componentIds = new Set<string>();
  const semanticKeys = new Set<string>();
  for (const component of components) {
    if (componentIds.has(component.component_id)) {
      throw invalidContext("DUPLICATE_COMPONENT_ID");
    }
    componentIds.add(component.component_id);

    const semanticKey = `${component.kind}:${component.content_hash}`;
    if (semanticKeys.has(semanticKey)) {
      throw invalidContext("DUPLICATE_COMPONENT");
    }
    semanticKeys.add(semanticKey);

    const findings = scanSensitiveContent(component.content);
    if (findings.length > 0) {
      throw new CoreDomainError("CONTEXT_CONTENT_FORBIDDEN", {
        entity: "context_package",
        reason: "SENSITIVE_OR_FORBIDDEN_CONTENT",
        component_kind: component.kind,
        finding_paths: [...new Set(findings.map((finding) => finding.path))].sort(),
        finding_rules: [...new Set(findings.map((finding) => finding.rule))].sort(),
      });
    }
  }
}

function baselineComponent(baseline: ProjectBaselineInput): ContextComponent {
  return {
    component_id: baseline.component_id,
    kind: "project_baseline",
    version: baseline.baseline_version,
    source: "bridge",
    content_hash: baseline.content_hash,
    content: baselinePayload(baseline),
  };
}

function taskVersionComponent(taskVersion: TaskVersion): ContextComponent {
  return {
    component_id: `task-version:${taskVersion.task_id}:v${taskVersion.task_version}`,
    kind: "task_version",
    version: taskVersion.task_version,
    source: "bridge",
    content_hash: taskVersion.content_hash,
    content: asJson(taskVersion),
  };
}

function baselinePayload(baseline: ProjectBaselineInput): DomainJsonValue {
  return {
    project_id: baseline.project_id,
    baseline_version: baseline.baseline_version,
    baseline: baseline.content,
  };
}

function componentFromContent(
  input: { readonly component_id: string; readonly version: number; readonly source: FieldSource },
  kind: ContextComponent["kind"],
  content: DomainJsonValue,
): ContextComponent {
  return {
    component_id: input.component_id,
    kind,
    version: input.version,
    source: input.source,
    content_hash: computeContentHash(content),
    content,
  };
}

function compareComponents(left: ContextComponent, right: ContextComponent): number {
  const kindOrder = COMPONENT_ORDER[left.kind] - COMPONENT_ORDER[right.kind];
  if (kindOrder !== 0) {
    return kindOrder;
  }
  const idOrder = compareText(left.component_id, right.component_id);
  return idOrder === 0 ? left.version - right.version : idOrder;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readBaseline(value: unknown): ProjectBaselineInput {
  if (
    !isPlainRecord(value) ||
    !isIdentifier(value.component_id) ||
    !isIdentifier(value.project_id) ||
    !isPositiveInteger(value.baseline_version) ||
    !isDomainJsonValue(value.content) ||
    typeof value.content_hash !== "string"
  ) {
    throw invalidContext("PROJECT_BASELINE_INVALID");
  }
  return {
    component_id: value.component_id,
    project_id: value.project_id,
    baseline_version: value.baseline_version,
    content: value.content,
    content_hash: value.content_hash,
  };
}

function readHandoffSelection(value: unknown): HandoffSelectionResult {
  if (!isPlainRecord(value) || !Array.isArray(value.handoffs) || !Array.isArray(value.warnings)) {
    throw invalidContext("HANDOFF_SELECTION_INVALID");
  }
  const handoffs = value.handoffs.map((item) => {
    if (!isPlainRecord(item)) {
      throw invalidContext("HANDOFF_SELECTION_INVALID");
    }
    try {
      return Object.freeze({
        handoff: parseHandoffPackage(item.handoff),
        relation: parseTaskRelation(item.relation),
      });
    } catch {
      throw invalidContext("HANDOFF_SELECTION_INVALID");
    }
  });
  const warnings = value.warnings.map((warning) => readHandoffWarning(warning));
  return Object.freeze({
    handoffs: Object.freeze(handoffs),
    warnings: Object.freeze(warnings),
  });
}

function readHandoffWarning(value: unknown): HandoffPolicyWarning {
  const expectedKeys = ["code", "blocking", "reason", "relation_id", "handoff_id", "relation_type"];
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some((key) => !expectedKeys.includes(key)) ||
    value.code !== "STALE_RELATED_HANDOFF" ||
    value.blocking !== false ||
    value.reason !== "SOURCE_HEAD_NOT_IN_TARGET_BASE" ||
    !isIdentifier(value.relation_id) ||
    !isIdentifier(value.handoff_id) ||
    value.relation_type !== "related_to"
  ) {
    throw invalidContext("HANDOFF_WARNING_INVALID");
  }
  return Object.freeze({
    code: value.code,
    blocking: value.blocking,
    reason: value.reason,
    relation_id: value.relation_id,
    handoff_id: value.handoff_id,
    relation_type: value.relation_type,
  });
}

function readSnapshot(value: unknown): import("@agent-bridge/schemas").ContinuationSnapshot {
  try {
    return parseContinuationSnapshot(value);
  } catch {
    throw invalidContext("CONTINUATION_SNAPSHOT_INVALID");
  }
}

function readReviewFindings(value: unknown): readonly ScopedReviewFindingInput[] {
  if (!Array.isArray(value)) {
    throw invalidContext("REVIEW_FINDINGS_INVALID");
  }
  return Object.freeze(value.map((item) => readReviewFinding(item)));
}

function readReviewFinding(value: unknown): ScopedReviewFindingInput {
  if (
    !isPlainRecord(value) ||
    !isComponentEnvelope(value) ||
    (value.source !== "bridge" && value.source !== "human") ||
    !isReviewFinding(value.finding)
  ) {
    throw invalidContext("REVIEW_FINDING_INVALID");
  }
  return value as unknown as ScopedReviewFindingInput;
}

function readVerificationResults(value: unknown): readonly ScopedVerificationResultInput[] {
  if (!Array.isArray(value)) {
    throw invalidContext("VERIFICATION_RESULTS_INVALID");
  }
  return Object.freeze(value.map((item) => readVerificationResult(item)));
}

function readVerificationResult(value: unknown): ScopedVerificationResultInput {
  if (
    !isPlainRecord(value) ||
    !isComponentEnvelope(value) ||
    (value.source !== "bridge" && value.source !== "verification") ||
    !isVerificationSummary(value.verification)
  ) {
    throw invalidContext("VERIFICATION_RESULT_INVALID");
  }
  return value as unknown as ScopedVerificationResultInput;
}

function readFailureSummary(value: unknown): FailureSummaryInput {
  if (
    !isPlainRecord(value) ||
    !isIdentifier(value.component_id) ||
    !isPositiveInteger(value.version) ||
    !isIdentifier(value.task_id) ||
    !isPositiveInteger(value.task_version) ||
    !isIdentifier(value.source_run_id) ||
    !isIdentifier(value.source_session_id) ||
    !isDomainJsonValue(value.summary)
  ) {
    throw invalidContext("FAILURE_SUMMARY_INVALID");
  }
  return value as unknown as FailureSummaryInput;
}

function isComponentEnvelope(value: Record<string, unknown>): boolean {
  return (
    isIdentifier(value.component_id) &&
    isPositiveInteger(value.version) &&
    isIdentifier(value.task_id) &&
    isPositiveInteger(value.task_version) &&
    isIdentifier(value.run_id) &&
    isIdentifier(value.session_id)
  );
}

function isReviewFinding(value: unknown): value is ReviewFinding {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.every((key) => ["finding_id", "severity", "summary", "file", "line"].includes(key)) &&
    isIdentifier(value.finding_id) &&
    (value.severity === "info" || value.severity === "warning" || value.severity === "error") &&
    typeof value.summary === "string" &&
    value.summary.length > 0 &&
    (value.file === undefined || (typeof value.file === "string" && value.file.length > 0)) &&
    (value.line === undefined || isPositiveInteger(value.line))
  );
}

function isVerificationSummary(value: unknown): value is VerificationSummary {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.every((key) => ["command", "status", "exit_code", "artifact_ids"].includes(key)) &&
    typeof value.command === "string" &&
    value.command.length > 0 &&
    (value.status === "passed" || value.status === "failed" || value.status === "not_run") &&
    (value.exit_code === undefined ||
      (typeof value.exit_code === "number" &&
        Number.isInteger(value.exit_code) &&
        value.exit_code >= 0)) &&
    Array.isArray(value.artifact_ids) &&
    value.artifact_ids.every((item) => isIdentifier(item)) &&
    new Set(value.artifact_ids).size === value.artifact_ids.length
  );
}

function isScenario(value: unknown): value is ContextAssemblyScenario {
  return CONTEXT_ASSEMBLY_SCENARIOS.some((scenario) => scenario === value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function readIdentifier(value: unknown): string {
  if (!isIdentifier(value)) {
    throw invalidContext("IDENTIFIER_INVALID");
  }
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
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

function invalidContext(reason: string): CoreDomainError {
  return new CoreDomainError("CONTEXT_PACKAGE_INVALID", {
    entity: "context_package",
    reason,
  });
}
