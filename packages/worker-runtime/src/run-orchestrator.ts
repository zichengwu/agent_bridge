import { computeContentHash, type AgentRunRecord, type DomainRepository } from "@agent-bridge/core";
import {
  DRIVER_PROTOCOL_VERSION,
  asJsonObject,
  type AgentDriver,
  type RunHandle,
} from "@agent-bridge/driver-protocol";
import type {
  AgentRole,
  AgentSessionBinding,
  ContextPackage,
  TaskVersion,
} from "@agent-bridge/schemas";

import type { ConfirmedFallbackSelection, DriverSelectionDecision } from "./driver-selection.js";
import { WorkerRuntimeError } from "./errors.js";
import type { RuntimeAuditInput } from "./context-handoff-runtime.js";

export interface RuntimeDriverHandle extends AgentDriver {
  close?(): Promise<unknown>;
}

export interface RuntimeDriverFactory {
  readonly driver_id: "opencode" | "claude-agent";
  create(): Promise<RuntimeDriverHandle>;
}

export interface StartSelectedRunRequest {
  readonly run_id: string;
  readonly session_id: string;
  readonly binding_id: string;
  readonly task_version: TaskVersion;
  readonly context_package: ContextPackage;
  readonly role: AgentRole;
  readonly selection:
    | Extract<DriverSelectionDecision, { readonly action: "USE_PRIMARY" }>
    | ConfirmedFallbackSelection;
  readonly prepare_idempotency_key: string;
  readonly create_audit: RuntimeAuditInput;
  readonly outcome_audit: RuntimeAuditInput;
  readonly session_event_id: string;
}

export type StartSelectedRunResult =
  | {
      readonly status: "RUNNING";
      readonly run: AgentRunRecord;
      readonly binding: AgentSessionBinding;
      readonly driver: RuntimeDriverHandle;
      readonly external: RunHandle;
    }
  | {
      readonly status: "START_FAILED";
      readonly run: AgentRunRecord;
      readonly failure_code: string;
    };

export class RunOrchestrator {
  private readonly factories: ReadonlyMap<string, RuntimeDriverFactory>;

  constructor(
    private readonly repository: DomainRepository,
    factories: readonly RuntimeDriverFactory[],
  ) {
    this.factories = new Map(factories.map((factory) => [factory.driver_id, factory]));
  }

  async start(request: StartSelectedRunRequest): Promise<StartSelectedRunResult> {
    validateStartRequest(request);
    const driverId = request.selection.driver_id;
    const created: AgentRunRecord = {
      schema_version: request.task_version.schema_version,
      run_id: request.run_id,
      task_id: request.task_version.task_id,
      task_version: request.task_version.task_version,
      project_id: request.task_version.project_id,
      driver_id: driverId,
      role: request.role,
      status: "created",
      created_at: request.create_audit.occurred_at,
      updated_at: request.create_audit.occurred_at,
      metadata: {
        driver_selection: selectionMetadata(request.selection),
      },
    };
    await this.repository.commit({
      change_id: request.create_audit.request_id,
      idempotency: {
        operation: request.create_audit.operation,
        key: request.create_audit.idempotency_key,
        request_hash: computeContentHash({
          operation: request.create_audit.operation,
          run_id: request.run_id,
          driver_id: driverId,
          context_package_hash: request.context_package.content_hash,
        }),
      },
      records: [{ kind: "agent_run", expected_revision: 0, value: created }],
      events: [
        {
          event_id: request.create_audit.event_id,
          event_version: 1,
          event_type: "agent_run.created",
          aggregate: { kind: "agent_run", id: request.run_id, revision: 1 },
          occurred_at: request.create_audit.occurred_at,
          audit: {
            actor: request.create_audit.actor,
            operation: request.create_audit.operation,
            request_id: request.create_audit.request_id,
            correlation_id: request.create_audit.correlation_id,
            idempotency_key: request.create_audit.idempotency_key,
            task_id: request.task_version.task_id,
            task_version: request.task_version.task_version,
            run_id: request.run_id,
            session_id: request.session_id,
            context_package_id: request.context_package.context_package_id,
            context_package_hash: request.context_package.content_hash,
            role: request.role,
            metadata: {
              driver_selection: selectionMetadata(request.selection),
            },
          },
          payload: {
            selected_driver_id: driverId,
            explicit_fallback: request.selection.action === "USE_FALLBACK",
          },
        },
      ],
    });

    let driver: RuntimeDriverHandle | undefined;
    try {
      driver = await this.requireFactory(driverId).create();
      const prepared = await driver.prepareTask({
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        taskId: request.task_version.task_id,
        taskVersion: request.task_version.task_version,
        idempotencyKey: request.prepare_idempotency_key,
        task: asJsonObject(request.task_version),
      });
      if (prepared.driverId !== driverId) {
        throw invalidRun("PREPARED_DRIVER_MISMATCH");
      }
      const external = await driver.startTask({
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        preparedTask: prepared,
        context: asJsonObject(request.context_package),
      });
      if (external.state !== "running") {
        throw invalidRun("DRIVER_START_STATE_INVALID");
      }
      const running = runningRecord(created, external, request.outcome_audit.occurred_at);
      const binding: AgentSessionBinding = {
        schema_version: request.task_version.schema_version,
        binding_id: request.binding_id,
        session_id: request.session_id,
        external_session_id: external.session.externalSessionId,
        task_id: request.task_version.task_id,
        task_version: request.task_version.task_version,
        run_id: request.run_id,
        driver_id: driverId,
        role: request.role,
        status: "ACTIVE",
        context_package_id: request.context_package.context_package_id,
        context_package_hash: request.context_package.content_hash,
        created_at: request.outcome_audit.occurred_at,
        metadata: {
          external_driver_run_id: external.runId,
          external_driver_session_id: external.session.sessionId,
        },
      };
      await this.repository.commit({
        change_id: request.outcome_audit.request_id,
        idempotency: {
          operation: request.outcome_audit.operation,
          key: request.outcome_audit.idempotency_key,
          request_hash: computeContentHash({
            operation: request.outcome_audit.operation,
            run_id: request.run_id,
            external_run_id: external.runId,
            external_session_id: external.session.externalSessionId,
          }),
        },
        records: [
          { kind: "agent_run", expected_revision: 1, value: running },
          { kind: "agent_session_binding", expected_revision: 0, value: binding },
        ],
        events: [
          runStatusEvent(request, 2, "running", external.runId),
          {
            event_id: request.session_event_id,
            event_version: 1,
            event_type: "agent_session_binding.recorded",
            aggregate: {
              kind: "agent_session_binding",
              id: request.binding_id,
              revision: 1,
            },
            occurred_at: request.outcome_audit.occurred_at,
            audit: outcomeAudit(request),
            payload: {
              status: "ACTIVE",
              external_driver_run_id: external.runId,
            },
          },
        ],
      });
      return Object.freeze({ status: "RUNNING", run: running, binding, driver, external });
    } catch (error) {
      await driver?.close?.().catch(() => undefined);
      const failureCode = safeFailureCode(error);
      const failed = failedRecord(created, request.outcome_audit.occurred_at, failureCode);
      await this.repository.commit({
        change_id: request.outcome_audit.request_id,
        idempotency: {
          operation: request.outcome_audit.operation,
          key: request.outcome_audit.idempotency_key,
          request_hash: computeContentHash({
            operation: request.outcome_audit.operation,
            run_id: request.run_id,
            failure_code: failureCode,
          }),
        },
        records: [{ kind: "agent_run", expected_revision: 1, value: failed }],
        events: [runStatusEvent(request, 2, "failed", undefined, failureCode)],
      });
      return Object.freeze({ status: "START_FAILED", run: failed, failure_code: failureCode });
    }
  }

  private requireFactory(driverId: string): RuntimeDriverFactory {
    const factory = this.factories.get(driverId);
    if (factory === undefined) {
      throw invalidRun("DRIVER_COMPONENT_UNAVAILABLE");
    }
    return factory;
  }
}

function validateStartRequest(request: StartSelectedRunRequest): void {
  if (
    request.selection.scope.task_id !== request.task_version.task_id ||
    request.selection.scope.task_version !== request.task_version.task_version ||
    request.selection.scope.planned_run_id !== request.run_id ||
    request.context_package.task_id !== request.task_version.task_id ||
    request.context_package.task_version !== request.task_version.task_version ||
    request.context_package.run_id !== request.run_id ||
    request.context_package.target_session_id !== request.session_id ||
    request.role !== request.task_version.role ||
    Date.parse(request.create_audit.occurred_at) > Date.parse(request.outcome_audit.occurred_at) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.session_event_id)
  ) {
    throw invalidRun("RUN_START_SCOPE_INVALID");
  }
}

function runningRecord(
  created: AgentRunRecord,
  external: RunHandle,
  occurredAt: string,
): AgentRunRecord {
  return {
    ...created,
    status: "running",
    updated_at: occurredAt,
    started_at: occurredAt,
    metadata: {
      ...created.metadata,
      external_driver_run_id: external.runId,
      external_driver_session_id: external.session.sessionId,
    },
  };
}

function failedRecord(
  created: AgentRunRecord,
  occurredAt: string,
  failureCode: string,
): AgentRunRecord {
  return {
    ...created,
    status: "failed",
    updated_at: occurredAt,
    started_at: created.created_at,
    finished_at: occurredAt,
    metadata: {
      ...created.metadata,
      start_failure_code: failureCode,
    },
  };
}

function runStatusEvent(
  request: StartSelectedRunRequest,
  revision: number,
  status: "running" | "failed",
  externalRunId?: string,
  failureCode?: string,
): import("@agent-bridge/core").AuthoritativeDomainEvent {
  return {
    event_id: request.outcome_audit.event_id,
    event_version: 1,
    event_type: "agent_run.status_changed",
    aggregate: { kind: "agent_run", id: request.run_id, revision },
    occurred_at: request.outcome_audit.occurred_at,
    audit: outcomeAudit(request),
    payload: {
      status,
      ...(externalRunId === undefined ? {} : { external_driver_run_id: externalRunId }),
      ...(failureCode === undefined ? {} : { failure_code: failureCode }),
    },
  };
}

function outcomeAudit(
  request: StartSelectedRunRequest,
): import("@agent-bridge/core").AuditEnvelope {
  return {
    actor: request.outcome_audit.actor,
    operation: request.outcome_audit.operation,
    request_id: request.outcome_audit.request_id,
    correlation_id: request.outcome_audit.correlation_id,
    idempotency_key: request.outcome_audit.idempotency_key,
    task_id: request.task_version.task_id,
    task_version: request.task_version.task_version,
    run_id: request.run_id,
    session_id: request.session_id,
    context_package_id: request.context_package.context_package_id,
    context_package_hash: request.context_package.content_hash,
    role: request.role,
  };
}

function selectionMetadata(
  selection: StartSelectedRunRequest["selection"],
): import("@agent-bridge/schemas").DomainJsonValue {
  if (selection.action === "USE_PRIMARY") {
    return {
      action: selection.action,
      driver_id: selection.driver_id,
      health_status: selection.health.status,
    };
  }
  return {
    action: selection.action,
    driver_id: selection.driver_id,
    decision_id: selection.decision_id,
    reason: selection.reason,
    confirmed_by: {
      kind: selection.confirmation.actor.kind,
      id: selection.confirmation.actor.id,
    },
    confirmation_reason: selection.confirmation.reason,
    confirmed_at: selection.confirmation.confirmed_at,
  };
}

function safeFailureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(error.code)
  ) {
    return error.code;
  }
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,127}$/u.test(error.name)
    ? error.name
    : "DRIVER_START_FAILED";
}

function invalidRun(reason: string): WorkerRuntimeError {
  return new WorkerRuntimeError("DRIVER_SELECTION_INVALID", "Selected Driver run is invalid", {
    reason,
  });
}
