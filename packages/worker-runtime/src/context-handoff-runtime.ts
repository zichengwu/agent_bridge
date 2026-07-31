import {
  assembleContextPackage,
  computeContentHash,
  generateHandoffPackage,
  selectExplicitHandoffs,
  type AuditActor,
  type DomainRepository,
  type HandoffGenerationInput,
  type HandoffPolicyWarning,
  type ProjectBaselineInput,
} from "@agent-bridge/core";
import type {
  ContextPackage,
  FieldSource,
  HandoffFieldSources,
  HandoffPackage,
  TaskVersionReference,
} from "@agent-bridge/schemas";

import { WorkerRuntimeError } from "./errors.js";
import type { GitClient } from "./git-client.js";

export interface RuntimeAuditInput {
  readonly actor: AuditActor;
  readonly operation: string;
  readonly request_id: string;
  readonly correlation_id: string;
  readonly idempotency_key: string;
  readonly event_id: string;
  readonly occurred_at: string;
}

export interface SelectedHandoffVersion {
  readonly handoff_id: string;
  readonly handoff_version: number;
}

export interface PrepareRuntimeContextRequest {
  readonly task: TaskVersionReference;
  readonly run_id: string;
  readonly target_session_id: string;
  readonly scenario: import("@agent-bridge/core").ContextAssemblyScenario;
  readonly context_package_id: string;
  readonly project_baseline: ProjectBaselineInput;
  readonly repository_id: string;
  readonly repository_path: string;
  readonly selected_handoffs: readonly SelectedHandoffVersion[];
  readonly audit: RuntimeAuditInput;
}

export interface PrepareRuntimeContextResult {
  readonly context_package: ContextPackage;
  readonly warnings: readonly HandoffPolicyWarning[];
}

export interface GenerateRuntimeHandoffRequest {
  readonly handoff_id: string;
  readonly handoff_version: number;
  readonly source_task: TaskVersionReference;
  readonly final_run_id: string;
  readonly repository_id: string;
  readonly completed: readonly string[];
  readonly decisions: readonly string[];
  readonly contracts: readonly string[];
  readonly known_issues: readonly string[];
  readonly downstream_notes: readonly string[];
  readonly field_sources: HandoffFieldSources;
  readonly generated_at: string;
  readonly audit: RuntimeAuditInput;
}

export class ContextHandoffRuntime {
  constructor(
    private readonly repository: DomainRepository,
    private readonly git: GitClient,
  ) {}

  async prepareContext(
    request: PrepareRuntimeContextRequest,
  ): Promise<PrepareRuntimeContextResult> {
    const taskVersion = await this.repository.getTaskVersion(request.task);
    if (taskVersion === undefined) {
      throw runtimeFailure("TASK_VERSION_MISSING");
    }
    const expectedHandoffs = [...(taskVersion.value.selected_handoff_ids ?? [])].sort();
    const requestedHandoffs = request.selected_handoffs
      .map((selected) => selected.handoff_id)
      .sort();
    if (
      expectedHandoffs.length !== requestedHandoffs.length ||
      expectedHandoffs.some((handoffId, index) => handoffId !== requestedHandoffs[index])
    ) {
      throw runtimeFailure("HANDOFF_SELECTION_MISMATCH");
    }

    const candidates = await Promise.all(
      request.selected_handoffs.map(async (selected) => {
        const handoff = await this.repository.getHandoffPackage(
          selected.handoff_id,
          selected.handoff_version,
        );
        if (handoff === undefined) {
          throw runtimeFailure("SELECTED_HANDOFF_MISSING");
        }
        const relationReference = taskVersion.value.relations?.find(
          (relation) =>
            relation.target.task_id === handoff.value.source_task.task_id &&
            relation.target.task_version === handoff.value.source_task.task_version,
        );
        if (relationReference === undefined) {
          throw runtimeFailure("HANDOFF_RELATION_MISSING");
        }
        const relation = await this.repository.getTaskRelation(relationReference.relation_id);
        const sourceVersion = await this.repository.getTaskVersion({
          task_id: handoff.value.source_task.task_id,
          task_version: handoff.value.source_task.task_version,
        });
        const sourceResult = await this.repository.getTaskResult(
          handoff.value.source_task.final_run_id,
        );
        if (
          relation === undefined ||
          sourceVersion === undefined ||
          sourceResult === undefined ||
          sourceResult.value.commit_sha === undefined
        ) {
          throw runtimeFailure("HANDOFF_AUTHORITY_MISSING");
        }
        const containment = await this.git.run(
          request.repository_path,
          [
            "merge-base",
            "--is-ancestor",
            handoff.value.code_state.head_commit,
            taskVersion.value.base_commit,
          ],
          [0, 1],
        );
        return {
          handoff: handoff.value,
          relation: relation.value,
          authority: {
            task_id: sourceVersion.value.task_id,
            task_version: sourceVersion.value.task_version,
            repository_id: request.repository_id,
            base_commit: sourceVersion.value.base_commit,
            head_commit: sourceResult.value.commit_sha,
            field_sources: handoff.value.field_sources,
          },
          containment: {
            source_head_commit: handoff.value.code_state.head_commit,
            target_base_commit: taskVersion.value.base_commit,
            is_contained: containment.exitCode === 0,
          },
        };
      }),
    );
    const selection = selectExplicitHandoffs({
      target_task_version: taskVersion.value,
      repository_id: request.repository_id,
      candidates,
    });
    const assembled = assembleContextPackage({
      scenario: request.scenario,
      context_package_id: request.context_package_id,
      task_version: taskVersion.value,
      run_id: request.run_id,
      target_session_id: request.target_session_id,
      created_at: request.audit.occurred_at,
      project_baseline: request.project_baseline,
      handoff_selection: selection,
    });

    await this.repository.commit({
      change_id: request.audit.request_id,
      idempotency: {
        operation: request.audit.operation,
        key: request.audit.idempotency_key,
        request_hash: computeContentHash({
          operation: request.audit.operation,
          context_package_id: assembled.context_package.context_package_id,
          content_hash: assembled.context_package.content_hash,
        }),
      },
      records: [
        {
          kind: "context_package",
          expected_revision: 0,
          value: assembled.context_package,
        },
      ],
      events: [
        {
          event_id: request.audit.event_id,
          event_version: 1,
          event_type: "context_package.recorded",
          aggregate: {
            kind: "context_package",
            id: assembled.context_package.context_package_id,
            revision: 1,
          },
          occurred_at: request.audit.occurred_at,
          audit: {
            actor: request.audit.actor,
            operation: request.audit.operation,
            request_id: request.audit.request_id,
            correlation_id: request.audit.correlation_id,
            idempotency_key: request.audit.idempotency_key,
            task_id: taskVersion.value.task_id,
            task_version: taskVersion.value.task_version,
            run_id: request.run_id,
            session_id: request.target_session_id,
            context_package_id: assembled.context_package.context_package_id,
            context_package_hash: assembled.context_package.content_hash,
          },
          payload: {
            scenario: request.scenario,
            handoff_ids: selection.handoffs.map((item) => item.handoff.handoff_id),
            warning_codes: assembled.warnings.map((warning) => warning.code),
          },
        },
      ],
    });

    return Object.freeze(assembled);
  }

  async generateHandoff(request: GenerateRuntimeHandoffRequest): Promise<HandoffPackage> {
    const [sourceVersion, sourceResult, sourceRun] = await Promise.all([
      this.repository.getTaskVersion(request.source_task),
      this.repository.getTaskResult(request.final_run_id),
      this.repository.getAgentRun(request.final_run_id),
    ]);
    if (
      sourceVersion === undefined ||
      sourceResult === undefined ||
      sourceRun === undefined ||
      sourceResult.value.commit_sha === undefined ||
      sourceResult.value.task_id !== request.source_task.task_id ||
      sourceResult.value.task_version !== request.source_task.task_version ||
      sourceRun.value.task_id !== request.source_task.task_id ||
      sourceRun.value.task_version !== request.source_task.task_version ||
      sourceRun.value.status !== "succeeded"
    ) {
      throw runtimeFailure("HANDOFF_SOURCE_FACTS_INVALID");
    }

    const verificationPassed =
      sourceResult.value.acceptance_results.length ===
        sourceVersion.value.acceptance_commands.length &&
      sourceResult.value.acceptance_results.every(
        (result, index) =>
          result.command === sourceVersion.value.acceptance_commands[index] &&
          result.exit_code === 0,
      );
    const verificationArtifactIds = new Set<string>();
    for (const result of sourceResult.value.acceptance_results) {
      if (result.log_artifact_id !== undefined) {
        verificationArtifactIds.add(result.log_artifact_id);
      }
    }
    for (const artifact of sourceResult.value.artifacts ?? []) {
      if (artifact.kind.startsWith("verification.")) {
        verificationArtifactIds.add(artifact.artifact_id);
      }
    }

    const generation: HandoffGenerationInput = {
      handoff_id: request.handoff_id,
      handoff_version: request.handoff_version,
      source_task: {
        task_id: request.source_task.task_id,
        task_version: request.source_task.task_version,
        final_run_id: request.final_run_id,
      },
      code_state: {
        repository_id: request.repository_id,
        base_commit: sourceVersion.value.base_commit,
        head_commit: sourceResult.value.commit_sha,
      },
      completed: request.completed,
      decisions: request.decisions,
      contracts: request.contracts,
      changed_files: sourceResult.value.changed_files,
      verification: {
        status: verificationPassed ? "passed" : "failed",
        artifact_ids: [...verificationArtifactIds],
      },
      known_issues: request.known_issues,
      downstream_notes: request.downstream_notes,
      field_sources: request.field_sources,
      generated_at: request.generated_at,
      metadata: {
        authority: {
          task_result_run_id: sourceResult.value.run_id,
          agent_run_status: sourceRun.value.status,
        },
      },
    };
    const handoff = generateHandoffPackage(generation);
    const recordId = `${handoff.handoff_id}:v${handoff.handoff_version}`;
    await this.repository.commit({
      change_id: request.audit.request_id,
      idempotency: {
        operation: request.audit.operation,
        key: request.audit.idempotency_key,
        request_hash: computeContentHash({
          operation: request.audit.operation,
          handoff_id: handoff.handoff_id,
          handoff_version: handoff.handoff_version,
          content_hash: handoff.content_hash,
        }),
      },
      records: [
        {
          kind: "handoff_package",
          expected_revision: 0,
          value: handoff,
        },
      ],
      events: [
        {
          event_id: request.audit.event_id,
          event_version: 1,
          event_type: "handoff_package.recorded",
          aggregate: { kind: "handoff_package", id: recordId, revision: 1 },
          occurred_at: request.audit.occurred_at,
          audit: {
            actor: request.audit.actor,
            operation: request.audit.operation,
            request_id: request.audit.request_id,
            correlation_id: request.audit.correlation_id,
            idempotency_key: request.audit.idempotency_key,
            task_id: request.source_task.task_id,
            task_version: request.source_task.task_version,
            run_id: request.final_run_id,
            handoff_id: handoff.handoff_id,
            handoff_version: handoff.handoff_version,
            handoff_hash: handoff.content_hash,
            commit_sha: handoff.code_state.head_commit,
            verification: handoff.verification,
          },
          payload: {
            changed_files: handoff.changed_files,
            field_sources: sourcesPayload(handoff.field_sources),
          },
        },
      ],
    });
    return handoff;
  }
}

function sourcesPayload(sources: HandoffFieldSources): Readonly<Record<string, FieldSource>> {
  return {
    completed: sources.completed,
    decisions: sources.decisions,
    contracts: sources.contracts,
    known_issues: sources.known_issues,
    downstream_notes: sources.downstream_notes,
  };
}

function runtimeFailure(reason: string): WorkerRuntimeError {
  return new WorkerRuntimeError(
    "RUNTIME_CONTEXT_INVALID",
    "Runtime Context or Handoff authority facts are invalid",
    { reason },
  );
}
