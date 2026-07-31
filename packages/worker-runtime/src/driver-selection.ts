import type { AgentCapabilities, HealthStatus } from "@agent-bridge/driver-protocol";

import { WorkerRuntimeError } from "./errors.js";

export interface DriverProbe {
  readonly driver_id: string;
  inspect(): Promise<{
    readonly health: HealthStatus;
    readonly capabilities: AgentCapabilities;
  }>;
}

export interface DriverSelectionScope {
  readonly task_id: string;
  readonly task_version: number;
  readonly planned_run_id: string;
  readonly active_run?: {
    readonly run_id: string;
    readonly status: "created" | "running" | "waiting_permission" | "cancelling";
  };
}

export interface FallbackConfirmation {
  readonly decision_id: string;
  readonly task_id: string;
  readonly task_version: number;
  readonly planned_run_id: string;
  readonly actor: {
    readonly kind: "human" | "codex";
    readonly id: string;
  };
  readonly reason: string;
  readonly confirmed_at: string;
}

export type DriverSelectionDecision =
  | {
      readonly action: "USE_PRIMARY";
      readonly driver_id: "opencode";
      readonly scope: DriverSelectionScope;
      readonly health: HealthStatus;
      readonly capabilities: AgentCapabilities;
    }
  | {
      readonly action: "FALLBACK_CONFIRMATION_REQUIRED";
      readonly decision_id: string;
      readonly driver_id: "claude-agent";
      readonly reason: "PRIMARY_UNHEALTHY" | "PRIMARY_START_FAILED";
      readonly scope: DriverSelectionScope;
      readonly primary_evidence: Readonly<Record<string, unknown>>;
      readonly fallback_health: HealthStatus;
      readonly fallback_capabilities: AgentCapabilities;
      readonly proposed_at: string;
    }
  | {
      readonly action: "NO_DRIVER_AVAILABLE";
      readonly scope: DriverSelectionScope;
      readonly reason:
        | "PRIMARY_UNAVAILABLE"
        | "PRIMARY_CAPABILITY_MISMATCH"
        | "FALLBACK_DISABLED"
        | "FALLBACK_UNAVAILABLE"
        | "FALLBACK_CAPABILITY_MISMATCH";
    };

export interface ConfirmedFallbackSelection {
  readonly action: "USE_FALLBACK";
  readonly driver_id: "claude-agent";
  readonly scope: DriverSelectionScope;
  readonly reason: "PRIMARY_UNHEALTHY" | "PRIMARY_START_FAILED";
  readonly decision_id: string;
  readonly confirmation: FallbackConfirmation;
  readonly fallback_health: HealthStatus;
  readonly fallback_capabilities: AgentCapabilities;
}

export interface ExplicitDriverSelectorOptions {
  readonly primary: DriverProbe;
  readonly fallback?: DriverProbe;
  readonly fallback_enabled: boolean;
  readonly create_decision_id: () => string;
  readonly now?: () => Date;
}

export class ExplicitDriverSelector {
  private readonly now: () => Date;

  constructor(private readonly options: ExplicitDriverSelectorOptions) {
    if (options.primary.driver_id !== "opencode") {
      throw invalidSelection("PRIMARY_DRIVER_INVALID");
    }
    if (options.fallback !== undefined && options.fallback.driver_id !== "claude-agent") {
      throw invalidSelection("FALLBACK_DRIVER_INVALID");
    }
    this.now = options.now ?? (() => new Date());
  }

  async assessNewRun(scope: DriverSelectionScope): Promise<DriverSelectionDecision> {
    const normalized = readScope(scope);
    assertNoActiveRun(normalized);
    let primary:
      { readonly health: HealthStatus; readonly capabilities: AgentCapabilities } | undefined;
    try {
      primary = await this.options.primary.inspect();
    } catch {
      return this.proposeFallback(normalized, "PRIMARY_UNHEALTHY", {
        status: "inspection_failed",
      });
    }
    if (primary.health.status === "healthy" && hasRequiredCapabilities(primary.capabilities)) {
      return Object.freeze({
        action: "USE_PRIMARY",
        driver_id: "opencode",
        scope: normalized,
        health: structuredClone(primary.health),
        capabilities: structuredClone(primary.capabilities),
      });
    }
    return this.proposeFallback(normalized, "PRIMARY_UNHEALTHY", {
      health_status: primary.health.status,
      capability_match: hasRequiredCapabilities(primary.capabilities),
    });
  }

  assessAfterPrimaryStartFailure(
    scope: DriverSelectionScope,
    failureCode: string,
  ): Promise<DriverSelectionDecision> {
    const normalized = readScope(scope);
    assertNoActiveRun(normalized);
    if (!isIdentifier(failureCode)) {
      throw invalidSelection("PRIMARY_FAILURE_CODE_INVALID");
    }
    return this.proposeFallback(normalized, "PRIMARY_START_FAILED", {
      failure_code: failureCode,
    });
  }

  confirmFallback(
    proposal: DriverSelectionDecision,
    confirmation: FallbackConfirmation,
  ): ConfirmedFallbackSelection {
    if (proposal.action !== "FALLBACK_CONFIRMATION_REQUIRED") {
      throw invalidSelection("FALLBACK_PROPOSAL_REQUIRED");
    }
    const parsed = readConfirmation(confirmation);
    if (
      parsed.decision_id !== proposal.decision_id ||
      parsed.task_id !== proposal.scope.task_id ||
      parsed.task_version !== proposal.scope.task_version ||
      parsed.planned_run_id !== proposal.scope.planned_run_id ||
      Date.parse(parsed.confirmed_at) < Date.parse(proposal.proposed_at)
    ) {
      throw invalidSelection("FALLBACK_CONFIRMATION_SCOPE_MISMATCH");
    }
    return Object.freeze({
      action: "USE_FALLBACK",
      driver_id: "claude-agent",
      scope: proposal.scope,
      reason: proposal.reason,
      decision_id: proposal.decision_id,
      confirmation: parsed,
      fallback_health: structuredClone(proposal.fallback_health),
      fallback_capabilities: structuredClone(proposal.fallback_capabilities),
    });
  }

  private async proposeFallback(
    scope: DriverSelectionScope,
    reason: "PRIMARY_UNHEALTHY" | "PRIMARY_START_FAILED",
    primaryEvidence: Readonly<Record<string, unknown>>,
  ): Promise<DriverSelectionDecision> {
    if (!this.options.fallback_enabled) {
      return Object.freeze({
        action: "NO_DRIVER_AVAILABLE",
        scope,
        reason: "FALLBACK_DISABLED",
      });
    }
    if (this.options.fallback === undefined) {
      return Object.freeze({
        action: "NO_DRIVER_AVAILABLE",
        scope,
        reason: "FALLBACK_UNAVAILABLE",
      });
    }
    let fallback:
      { readonly health: HealthStatus; readonly capabilities: AgentCapabilities } | undefined;
    try {
      fallback = await this.options.fallback.inspect();
    } catch {
      return Object.freeze({
        action: "NO_DRIVER_AVAILABLE",
        scope,
        reason: "FALLBACK_UNAVAILABLE",
      });
    }
    if (fallback.health.status !== "healthy") {
      return Object.freeze({
        action: "NO_DRIVER_AVAILABLE",
        scope,
        reason: "FALLBACK_UNAVAILABLE",
      });
    }
    if (!hasRequiredCapabilities(fallback.capabilities)) {
      return Object.freeze({
        action: "NO_DRIVER_AVAILABLE",
        scope,
        reason: "FALLBACK_CAPABILITY_MISMATCH",
      });
    }
    const decisionId = this.options.create_decision_id();
    if (!isIdentifier(decisionId)) {
      throw invalidSelection("DECISION_ID_INVALID");
    }
    return Object.freeze({
      action: "FALLBACK_CONFIRMATION_REQUIRED",
      decision_id: decisionId,
      driver_id: "claude-agent",
      reason,
      scope,
      primary_evidence: Object.freeze({ ...primaryEvidence }),
      fallback_health: structuredClone(fallback.health),
      fallback_capabilities: structuredClone(fallback.capabilities),
      proposed_at: this.now().toISOString(),
    });
  }
}

export function hasRequiredCapabilities(capabilities: AgentCapabilities): boolean {
  return (
    capabilities.protocolVersion === "1.0" &&
    capabilities.sessions.persistentIds &&
    capabilities.sessions.resume &&
    capabilities.sessions.successorSessions &&
    capabilities.events.streaming &&
    capabilities.events.strictOrdering &&
    capabilities.permissions.mode === "interactive" &&
    capabilities.permissions.decisions.includes("allow") &&
    capabilities.permissions.decisions.includes("deny") &&
    capabilities.cancellation.supported &&
    capabilities.cancellation.terminalEvent &&
    capabilities.contextUsage.mode !== "unavailable"
  );
}

function readScope(scope: DriverSelectionScope): DriverSelectionScope {
  if (
    typeof scope !== "object" ||
    scope === null ||
    !isIdentifier(scope.task_id) ||
    !Number.isSafeInteger(scope.task_version) ||
    scope.task_version <= 0 ||
    !isIdentifier(scope.planned_run_id) ||
    (scope.active_run !== undefined &&
      (!isIdentifier(scope.active_run.run_id) ||
        !["created", "running", "waiting_permission", "cancelling"].includes(
          scope.active_run.status,
        )))
  ) {
    throw invalidSelection("SELECTION_SCOPE_INVALID");
  }
  return Object.freeze(structuredClone(scope));
}

function assertNoActiveRun(scope: DriverSelectionScope): void {
  if (scope.active_run !== undefined) {
    throw invalidSelection("RUNNING_TASK_DRIVER_SWITCH_FORBIDDEN");
  }
}

function readConfirmation(value: FallbackConfirmation): FallbackConfirmation {
  if (
    typeof value !== "object" ||
    value === null ||
    !isIdentifier(value.decision_id) ||
    !isIdentifier(value.task_id) ||
    !Number.isSafeInteger(value.task_version) ||
    value.task_version <= 0 ||
    !isIdentifier(value.planned_run_id) ||
    typeof value.actor !== "object" ||
    value.actor === null ||
    (value.actor.kind !== "human" && value.actor.kind !== "codex") ||
    !isIdentifier(value.actor.id) ||
    typeof value.reason !== "string" ||
    value.reason.length === 0 ||
    !Number.isFinite(Date.parse(value.confirmed_at))
  ) {
    throw invalidSelection("FALLBACK_CONFIRMATION_INVALID");
  }
  return Object.freeze(structuredClone(value));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function invalidSelection(reason: string): WorkerRuntimeError {
  return new WorkerRuntimeError(
    "DRIVER_SELECTION_INVALID",
    "Driver selection decision is invalid",
    { reason },
  );
}
