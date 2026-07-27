import {
  parseHandoffPackage,
  parseTaskRelation,
  parseTaskVersion,
  type HandoffFieldSources,
  type HandoffPackage,
  type TaskRelation,
  type TaskVersion,
} from "@agent-bridge/schemas";

import { hasValidDocumentContentHash, scanSensitiveContent } from "./content-integrity.js";
import { CoreDomainError } from "./errors.js";

const FIELD_SOURCE_VALUES = ["bridge", "git", "verification", "agent", "human"] as const;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{7,64}$/u;

export interface HandoffAuthorityFacts {
  readonly task_id: string;
  readonly task_version: number;
  readonly repository_id: string;
  readonly base_commit: string;
  readonly head_commit: string;
  readonly field_sources: HandoffFieldSources;
}

export interface CommitContainmentFact {
  readonly source_head_commit: string;
  readonly target_base_commit: string;
  readonly is_contained: boolean;
}

export interface HandoffCandidate {
  readonly handoff: HandoffPackage;
  readonly relation: TaskRelation;
  readonly authority: HandoffAuthorityFacts;
  readonly containment: CommitContainmentFact;
}

export interface HandoffSelectionInput {
  readonly target_task_version: TaskVersion;
  readonly repository_id: string;
  readonly candidates: readonly HandoffCandidate[];
}

export interface HandoffPolicyWarning {
  readonly code: "STALE_RELATED_HANDOFF";
  readonly blocking: false;
  readonly reason: "SOURCE_HEAD_NOT_IN_TARGET_BASE";
  readonly relation_id: string;
  readonly handoff_id: string;
  readonly relation_type: "related_to";
}

export interface ValidatedHandoff {
  readonly handoff: HandoffPackage;
  readonly relation: TaskRelation;
}

export interface HandoffSelectionResult {
  readonly handoffs: readonly ValidatedHandoff[];
  readonly warnings: readonly HandoffPolicyWarning[];
}

export function selectExplicitHandoffs(value: unknown): HandoffSelectionResult {
  const input = readSelectionInput(value);
  const selectedIds = input.target_task_version.selected_handoff_ids ?? [];
  const selectedIdSet = new Set(selectedIds);
  const seenHandoffIds = new Set<string>();
  const validated: ValidatedHandoff[] = [];
  const warnings: HandoffPolicyWarning[] = [];

  for (const candidate of input.candidates) {
    if (!selectedIdSet.has(candidate.handoff.handoff_id)) {
      throw new CoreDomainError("CONTEXT_PACKAGE_INVALID", {
        entity: "context_package",
        reason: "HANDOFF_NOT_EXPLICITLY_SELECTED",
      });
    }
    if (seenHandoffIds.has(candidate.handoff.handoff_id)) {
      throw handoffIntegrityError("DUPLICATE_HANDOFF");
    }
    seenHandoffIds.add(candidate.handoff.handoff_id);

    validateCandidate(input.target_task_version, input.repository_id, candidate);
    validated.push(
      Object.freeze({
        handoff: candidate.handoff,
        relation: candidate.relation,
      }),
    );

    if (candidate.relation.type === "related_to" && !candidate.containment.is_contained) {
      warnings.push(
        Object.freeze({
          code: "STALE_RELATED_HANDOFF",
          blocking: false,
          reason: "SOURCE_HEAD_NOT_IN_TARGET_BASE",
          relation_id: candidate.relation.relation_id,
          handoff_id: candidate.handoff.handoff_id,
          relation_type: "related_to",
        }),
      );
    }
  }

  if (selectedIds.some((handoffId) => !seenHandoffIds.has(handoffId))) {
    throw new CoreDomainError("CONTEXT_PACKAGE_INVALID", {
      entity: "context_package",
      reason: "SELECTED_HANDOFF_MISSING",
    });
  }

  validated.sort((left, right) => compareHandoffs(left.handoff, right.handoff));
  warnings.sort((left, right) => compareText(left.handoff_id, right.handoff_id));
  return Object.freeze({
    handoffs: Object.freeze(validated),
    warnings: Object.freeze(warnings),
  });
}

function validateCandidate(
  target: TaskVersion,
  repositoryId: string,
  candidate: HandoffCandidate,
): void {
  const { authority, containment, handoff, relation } = candidate;
  const declaredRelation = target.relations?.find(
    (item) => item.relation_id === relation.relation_id,
  );
  if (
    declaredRelation === undefined ||
    declaredRelation.type !== relation.type ||
    !sameTaskVersion(declaredRelation.target, relation.target)
  ) {
    throw handoffIntegrityError("RELATION_NOT_DECLARED");
  }
  if (!sameTaskVersion(relation.source, target)) {
    throw handoffIntegrityError("RELATION_TARGET_SCOPE_MISMATCH");
  }
  if (!sameTaskVersion(relation.target, handoff.source_task)) {
    throw handoffIntegrityError("HANDOFF_SOURCE_RELATION_MISMATCH");
  }
  if (
    authority.task_id !== handoff.source_task.task_id ||
    authority.task_version !== handoff.source_task.task_version
  ) {
    throw handoffIntegrityError("AUTHORITATIVE_SOURCE_TASK_MISMATCH");
  }
  if (
    repositoryId !== handoff.code_state.repository_id ||
    authority.repository_id !== handoff.code_state.repository_id
  ) {
    throw handoffIntegrityError("REPOSITORY_MISMATCH");
  }
  if (
    authority.base_commit !== handoff.code_state.base_commit ||
    authority.head_commit !== handoff.code_state.head_commit
  ) {
    throw handoffIntegrityError("AUTHORITATIVE_COMMIT_MISMATCH");
  }
  if (!sameFieldSources(authority.field_sources, handoff.field_sources)) {
    throw handoffIntegrityError("FIELD_SOURCES_MISMATCH");
  }
  if (
    containment.source_head_commit !== handoff.code_state.head_commit ||
    containment.target_base_commit !== target.base_commit
  ) {
    throw handoffIntegrityError("COMMIT_CONTAINMENT_FACT_MISMATCH");
  }
  if (!hasValidDocumentContentHash(asRecord(handoff))) {
    throw handoffIntegrityError("CONTENT_HASH_MISMATCH");
  }

  const sensitiveFindings = scanSensitiveContent(asJson(handoff));
  if (sensitiveFindings.length > 0) {
    throw new CoreDomainError("HANDOFF_INTEGRITY_ERROR", {
      entity: "handoff",
      reason: "SENSITIVE_CONTENT",
      finding_paths: [...new Set(sensitiveFindings.map((finding) => finding.path))].sort(),
      finding_rules: [...new Set(sensitiveFindings.map((finding) => finding.rule))].sort(),
    });
  }
  if (relation.type === "depends_on" && !containment.is_contained) {
    throw new CoreDomainError("STALE_HANDOFF", {
      entity: "handoff",
      reason: "SOURCE_HEAD_NOT_IN_TARGET_BASE",
      relation_id: relation.relation_id,
      handoff_id: handoff.handoff_id,
      relation_type: relation.type,
    });
  }
}

function readSelectionInput(value: unknown): HandoffSelectionInput {
  if (!isPlainRecord(value)) {
    throw handoffIntegrityError("SELECTION_INPUT_INVALID");
  }

  let targetTaskVersion: TaskVersion;
  try {
    targetTaskVersion = parseTaskVersion(value.target_task_version);
  } catch {
    throw handoffIntegrityError("TARGET_TASK_VERSION_INVALID");
  }
  if (typeof value.repository_id !== "string" || value.repository_id.length === 0) {
    throw handoffIntegrityError("TARGET_REPOSITORY_INVALID");
  }
  if (!Array.isArray(value.candidates)) {
    throw handoffIntegrityError("HANDOFF_CANDIDATES_INVALID");
  }

  return {
    target_task_version: targetTaskVersion,
    repository_id: value.repository_id,
    candidates: Object.freeze(value.candidates.map((candidate) => readCandidate(candidate))),
  };
}

function readCandidate(value: unknown): HandoffCandidate {
  if (!isPlainRecord(value)) {
    throw handoffIntegrityError("HANDOFF_CANDIDATE_INVALID");
  }

  let handoff: HandoffPackage;
  let relation: TaskRelation;
  try {
    handoff = parseHandoffPackage(value.handoff);
    relation = parseTaskRelation(value.relation);
  } catch {
    throw handoffIntegrityError("HANDOFF_OR_RELATION_SCHEMA_INVALID");
  }

  return Object.freeze({
    handoff,
    relation,
    authority: readAuthority(value.authority),
    containment: readContainment(value.containment),
  });
}

function readAuthority(value: unknown): HandoffAuthorityFacts {
  if (
    !isPlainRecord(value) ||
    typeof value.task_id !== "string" ||
    value.task_id.length === 0 ||
    typeof value.task_version !== "number" ||
    !Number.isInteger(value.task_version) ||
    value.task_version <= 0 ||
    typeof value.repository_id !== "string" ||
    value.repository_id.length === 0 ||
    !isGitCommit(value.base_commit) ||
    !isGitCommit(value.head_commit) ||
    !isHandoffFieldSources(value.field_sources)
  ) {
    throw handoffIntegrityError("AUTHORITATIVE_FACTS_INVALID");
  }
  return Object.freeze({
    task_id: value.task_id,
    task_version: value.task_version,
    repository_id: value.repository_id,
    base_commit: value.base_commit,
    head_commit: value.head_commit,
    field_sources: Object.freeze({ ...value.field_sources }),
  });
}

function readContainment(value: unknown): CommitContainmentFact {
  if (
    !isPlainRecord(value) ||
    !isGitCommit(value.source_head_commit) ||
    !isGitCommit(value.target_base_commit) ||
    typeof value.is_contained !== "boolean"
  ) {
    throw handoffIntegrityError("COMMIT_CONTAINMENT_FACT_INVALID");
  }
  return Object.freeze({
    source_head_commit: value.source_head_commit,
    target_base_commit: value.target_base_commit,
    is_contained: value.is_contained,
  });
}

function isHandoffFieldSources(value: unknown): value is HandoffFieldSources {
  return (
    isPlainRecord(value) &&
    isFieldSource(value.completed) &&
    isFieldSource(value.decisions) &&
    isFieldSource(value.contracts) &&
    isFieldSource(value.known_issues) &&
    isFieldSource(value.downstream_notes)
  );
}

function isFieldSource(value: unknown): value is (typeof FIELD_SOURCE_VALUES)[number] {
  return FIELD_SOURCE_VALUES.some((source) => source === value);
}

function sameFieldSources(left: HandoffFieldSources, right: HandoffFieldSources): boolean {
  return (
    left.completed === right.completed &&
    left.decisions === right.decisions &&
    left.contracts === right.contracts &&
    left.known_issues === right.known_issues &&
    left.downstream_notes === right.downstream_notes
  );
}

function sameTaskVersion(
  left: { readonly task_id: string; readonly task_version: number },
  right: { readonly task_id: string; readonly task_version: number },
): boolean {
  return left.task_id === right.task_id && left.task_version === right.task_version;
}

function compareHandoffs(left: HandoffPackage, right: HandoffPackage): number {
  const idOrder = compareText(left.handoff_id, right.handoff_id);
  return idOrder === 0 ? left.handoff_version - right.handoff_version : idOrder;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isGitCommit(value: unknown): value is string {
  return typeof value === "string" && GIT_COMMIT_PATTERN.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: object): Readonly<Record<string, unknown>> {
  return value as unknown as Readonly<Record<string, unknown>>;
}

function asJson(value: object): import("@agent-bridge/schemas").DomainJsonValue {
  return value as unknown as import("@agent-bridge/schemas").DomainJsonValue;
}

function handoffIntegrityError(reason: string): CoreDomainError {
  return new CoreDomainError("HANDOFF_INTEGRITY_ERROR", {
    entity: "handoff",
    reason,
  });
}
