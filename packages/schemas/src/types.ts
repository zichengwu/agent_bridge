import type { DomainSchemaVersion } from "./constants.js";

export type DomainJsonPrimitive = boolean | number | string | null;
export type DomainJsonValue =
  DomainJsonPrimitive | readonly DomainJsonValue[] | { readonly [key: string]: DomainJsonValue };
export type DomainMetadata = { readonly [key: string]: DomainJsonValue };

export type TaskStatus =
  | "DRAFT"
  | "VALIDATED"
  | "QUEUED"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "INTERRUPTED"
  | "FAILED"
  | "CANCELLED"
  | "SUBMITTED"
  | "VERIFYING"
  | "REVIEW_REQUIRED"
  | "CHANGES_REQUESTED"
  | "READY_FOR_MERGE"
  | "COMPLETED";

export type AgentRole = "coordinator" | "developer" | "tester" | "reviewer" | "docs" | "research";

export type TaskRelationType = "depends_on" | "related_to" | "supersedes" | "follow_up_of";

export interface TaskVersionReference {
  readonly task_id: string;
  readonly task_version: number;
}

export interface Task {
  readonly schema_version: DomainSchemaVersion;
  readonly task_id: string;
  readonly project_id: string;
  readonly status: TaskStatus;
  readonly latest_version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly metadata?: DomainMetadata;
}

export interface BusinessRule {
  readonly id: string;
  readonly description: string;
}

export interface TaskScope {
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly deny: readonly string[];
}

export interface TaskRelationReference {
  readonly relation_id: string;
  readonly type: TaskRelationType;
  readonly target: TaskVersionReference;
}

export interface TaskContextPolicy {
  readonly project_baseline_version: number;
  readonly rollover_ratio: number;
  readonly inherit_full_transcript: false;
}

export interface TaskLimits {
  readonly timeout_seconds: number;
  readonly max_review_cycles: number;
  readonly max_agent_count: number;
}

export interface TaskVersion {
  readonly schema_version: DomainSchemaVersion;
  readonly task_id: string;
  readonly task_version: number;
  readonly project_id: string;
  readonly base_commit: string;
  readonly policy_version: string;
  readonly objective: string;
  readonly role: AgentRole;
  readonly business_rules: readonly BusinessRule[];
  readonly scope: TaskScope;
  readonly acceptance_commands: readonly string[];
  readonly git: {
    readonly branch: string;
  };
  readonly relations?: readonly TaskRelationReference[];
  readonly selected_handoff_ids?: readonly string[];
  readonly context_policy: TaskContextPolicy;
  readonly limits: TaskLimits;
  readonly required_output: readonly string[];
  readonly content_hash: string;
  readonly created_at: string;
  readonly metadata?: DomainMetadata;
}

export interface TaskRelation {
  readonly schema_version: DomainSchemaVersion;
  readonly relation_id: string;
  readonly type: TaskRelationType;
  readonly source: TaskVersionReference;
  readonly target: TaskVersionReference;
  readonly created_at: string;
  readonly metadata?: DomainMetadata;
}

export interface AcceptanceResult {
  readonly command: string;
  readonly exit_code: number;
  readonly duration_ms: number;
  readonly log_artifact_id?: string;
}

export interface ReviewFinding {
  readonly finding_id: string;
  readonly severity: "info" | "warning" | "error";
  readonly summary: string;
  readonly file?: string;
  readonly line?: number;
}

export interface ArtifactReference {
  readonly artifact_id: string;
  readonly kind: string;
  readonly content_hash?: string;
}

export interface TaskResult {
  readonly schema_version: DomainSchemaVersion;
  readonly task_id: string;
  readonly task_version: number;
  readonly run_id: string;
  readonly session_ids: readonly string[];
  readonly status: "submitted" | "failed" | "cancelled";
  readonly base_commit: string;
  readonly commit_sha?: string;
  readonly changed_files: readonly string[];
  readonly acceptance_results: readonly AcceptanceResult[];
  readonly review_findings: readonly ReviewFinding[];
  readonly known_risks: readonly string[];
  readonly unresolved_items: readonly string[];
  readonly artifacts?: readonly ArtifactReference[];
  readonly provider_id?: string;
  readonly model_id?: string;
  readonly output?: DomainJsonValue;
  readonly started_at: string;
  readonly finished_at: string;
  readonly metadata?: DomainMetadata;
}

export type AgentSessionBindingStatus =
  "CREATED" | "ACTIVE" | "ROLLOVER_PENDING" | "SUPERSEDED" | "CLOSED" | "FAILED";

export interface AgentSessionBinding {
  readonly schema_version: DomainSchemaVersion;
  readonly binding_id: string;
  readonly session_id: string;
  readonly external_session_id: string;
  readonly task_id: string;
  readonly task_version: number;
  readonly run_id: string;
  readonly driver_id: string;
  readonly role: AgentRole;
  readonly predecessor_session_id?: string;
  readonly status: AgentSessionBindingStatus;
  readonly context_package_id: string;
  readonly context_package_hash: string;
  readonly created_at: string;
  readonly closed_at?: string;
  readonly metadata?: DomainMetadata;
}

export type ContextComponentKind =
  | "project_baseline"
  | "task_version"
  | "handoff"
  | "continuation_snapshot"
  | "review_finding"
  | "verification_result"
  | "failure_summary";

export type FieldSource = "bridge" | "git" | "verification" | "agent" | "human";

export interface ContextComponent {
  readonly component_id: string;
  readonly kind: ContextComponentKind;
  readonly version: number;
  readonly source: FieldSource;
  readonly content_hash: string;
  readonly content: DomainJsonValue;
}

export interface ContextPackage {
  readonly schema_version: DomainSchemaVersion;
  readonly context_package_id: string;
  readonly task_id: string;
  readonly task_version: number;
  readonly run_id: string;
  readonly target_session_id?: string;
  readonly components: readonly ContextComponent[];
  readonly content_hash: string;
  readonly created_at: string;
  readonly metadata?: DomainMetadata;
}

export interface HandoffFieldSources {
  readonly completed: FieldSource;
  readonly decisions: FieldSource;
  readonly contracts: FieldSource;
  readonly known_issues: FieldSource;
  readonly downstream_notes: FieldSource;
}

export interface HandoffPackage {
  readonly schema_version: DomainSchemaVersion;
  readonly handoff_id: string;
  readonly handoff_version: number;
  readonly source_task: TaskVersionReference & {
    readonly final_run_id: string;
  };
  readonly code_state: {
    readonly repository_id: string;
    readonly base_commit: string;
    readonly head_commit: string;
  };
  readonly completed: readonly string[];
  readonly decisions: readonly string[];
  readonly contracts: readonly string[];
  readonly changed_files: readonly string[];
  readonly verification: {
    readonly status: "passed" | "failed" | "not_run";
    readonly artifact_ids: readonly string[];
  };
  readonly known_issues: readonly string[];
  readonly downstream_notes: readonly string[];
  readonly field_sources: HandoffFieldSources;
  readonly content_hash: string;
  readonly generated_at: string;
  readonly metadata?: DomainMetadata;
}

export interface VerificationSummary {
  readonly command: string;
  readonly status: "passed" | "failed" | "not_run";
  readonly exit_code?: number;
  readonly artifact_ids: readonly string[];
}

export interface SnapshotBlocker {
  readonly code: string;
  readonly message: string;
  readonly details?: DomainMetadata;
}

export interface ContinuationSnapshot {
  readonly schema_version: DomainSchemaVersion;
  readonly snapshot_id: string;
  readonly snapshot_version: number;
  readonly task_id: string;
  readonly task_version: number;
  readonly run_id: string;
  readonly session_id: string;
  readonly source_context_package_id: string;
  readonly source_context_package_hash: string;
  readonly current_step: string;
  readonly completed: readonly string[];
  readonly remaining_plan: readonly string[];
  readonly git_state: {
    readonly repository_id: string;
    readonly base_commit: string;
    readonly head_commit: string;
    readonly changed_files: readonly string[];
  };
  readonly recent_verification: readonly VerificationSummary[];
  readonly blockers: readonly SnapshotBlocker[];
  readonly next_actions: readonly string[];
  readonly artifact_ids: readonly string[];
  readonly content_hash: string;
  readonly created_at: string;
  readonly metadata?: DomainMetadata;
}

export interface DomainSchemaTypeMap {
  readonly task: Task;
  readonly taskVersion: TaskVersion;
  readonly taskResult: TaskResult;
  readonly taskRelation: TaskRelation;
  readonly agentSessionBinding: AgentSessionBinding;
  readonly contextPackage: ContextPackage;
  readonly handoffPackage: HandoffPackage;
  readonly continuationSnapshot: ContinuationSnapshot;
}
