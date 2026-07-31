import type { ArtifactRepository } from "@agent-bridge/core";
import type { AgentRole } from "@agent-bridge/schemas";

import { WorkerRuntimeError } from "./errors.js";
import {
  ProcessSupervisor,
  type ManagedProcess,
  type ManagedProcessOutcome,
} from "./process-supervisor.js";
import type { VerificationCommandConfiguration } from "./runtime-config.js";

export type VerificationStatus = "passed" | "failed" | "timed_out" | "cancelled";
export type VerificationCommandStatus = VerificationStatus | "not_run" | "start_failed";

export type VerificationInitiator =
  | { readonly kind: "bridge"; readonly id: string }
  | { readonly kind: "agent"; readonly id: string; readonly role: AgentRole };

export interface VerificationCommandResult {
  readonly contract: string;
  readonly status: VerificationCommandStatus;
  readonly exit_code?: number;
  readonly duration_ms: number;
  readonly log_artifact_id?: string;
}

export interface IndependentVerificationResult {
  readonly verification_id: string;
  readonly run_id: string;
  readonly status: VerificationStatus;
  readonly commands: readonly VerificationCommandResult[];
  readonly report_artifact_id: string;
  readonly started_at: string;
  readonly finished_at: string;
}

export interface IndependentVerificationRequest {
  readonly verification_id: string;
  readonly run_id: string;
  readonly worktree_path: string;
  readonly acceptance_commands: readonly string[];
  readonly command_catalog: Readonly<Record<string, VerificationCommandConfiguration>>;
  readonly initiator: VerificationInitiator;
  readonly environment: Readonly<Record<string, string>>;
  readonly max_output_bytes: number;
  readonly termination_grace_ms: number;
}

export interface VerificationExecution {
  readonly result: Promise<IndependentVerificationResult>;
  cancel(reason: string): Promise<void>;
}

export class IndependentVerificationRunner {
  constructor(
    private readonly supervisor: ProcessSupervisor,
    private readonly artifacts: ArtifactRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(value: IndependentVerificationRequest): VerificationExecution {
    const request = readRequest(value);
    const state: {
      cancelled: boolean;
      reason?: string;
      active?: ManagedProcess;
    } = { cancelled: false };
    const result = this.execute(request, state);
    return Object.freeze({
      result,
      cancel: async (reason: string) => {
        if (typeof reason !== "string" || reason.length === 0) {
          throw invalidVerification("CANCELLATION_REASON_INVALID");
        }
        state.cancelled = true;
        state.reason = reason;
        await state.active?.cancel("Independent verification cancelled");
      },
    });
  }

  private async execute(
    request: IndependentVerificationRequest,
    state: { cancelled: boolean; reason?: string; active?: ManagedProcess },
  ): Promise<IndependentVerificationResult> {
    const startedAt = this.now().toISOString();
    const results: VerificationCommandResult[] = [];
    let overall: VerificationStatus = "passed";

    for (const [index, contract] of request.acceptance_commands.entries()) {
      if (state.cancelled) {
        results.push(notRun(contract));
        overall = "cancelled";
        continue;
      }
      const command = findCommand(contract, request.command_catalog);
      const processId = `${request.verification_id}.command.${index + 1}`;
      let managed: ManagedProcess;
      try {
        managed = await this.supervisor.start({
          processId,
          command: command.executable,
          args: command.args,
          cwd: request.worktree_path,
          environment: request.environment,
          timeoutMs: command.timeout_seconds * 1_000,
          terminationGraceMs: request.termination_grace_ms,
          maxOutputBytes: request.max_output_bytes,
        });
      } catch {
        results.push(
          Object.freeze({
            contract,
            status: "start_failed" as const,
            duration_ms: 0,
          }),
        );
        overall = "failed";
        continue;
      }

      state.active = managed;
      if (state.cancelled) {
        await managed.cancel("Independent verification cancelled");
      }
      const exit = await managed.wait();
      state.active = undefined;
      const logArtifactId = `${request.verification_id}.command.${index + 1}.log`;
      await this.artifacts.put({
        artifact_id: logArtifactId,
        kind: "verification.command.log",
        media_type: "text/plain",
        retention_class: "audit",
        created_at: exit.finishedAt,
        metadata: {
          verification_id: request.verification_id,
          run_id: request.run_id,
          contract,
          outcome: exit.outcome,
          stdout_truncated: exit.stdoutTruncated,
          stderr_truncated: exit.stderrTruncated,
        },
        content: Buffer.from(renderLog(exit.stdout, exit.stderr)),
      });
      const status = commandStatus(exit.outcome, exit.exitCode);
      results.push(
        Object.freeze({
          contract,
          status,
          ...(exit.exitCode === null ? {} : { exit_code: exit.exitCode }),
          duration_ms: Math.max(0, Date.parse(exit.finishedAt) - Date.parse(exit.startedAt)),
          log_artifact_id: logArtifactId,
        }),
      );
      if (status === "cancelled") {
        overall = "cancelled";
        state.cancelled = true;
      } else if (status === "timed_out") {
        overall = "timed_out";
        state.cancelled = true;
      } else if (status !== "passed" && overall === "passed") {
        overall = "failed";
      }
    }

    const finishedAt = this.now().toISOString();
    const reportArtifactId = `${request.verification_id}.report`;
    const report = {
      verification_id: request.verification_id,
      run_id: request.run_id,
      status: overall,
      commands: results,
      started_at: startedAt,
      finished_at: finishedAt,
      ...(state.reason === undefined ? {} : { cancellation_reason: state.reason }),
    };
    await this.artifacts.put({
      artifact_id: reportArtifactId,
      kind: "verification.report",
      media_type: "application/json",
      retention_class: "audit",
      created_at: finishedAt,
      metadata: {
        verification_id: request.verification_id,
        run_id: request.run_id,
        status: overall,
      },
      content: Buffer.from(`${JSON.stringify(report)}\n`),
    });

    return Object.freeze({
      verification_id: request.verification_id,
      run_id: request.run_id,
      status: overall,
      commands: Object.freeze(results),
      report_artifact_id: reportArtifactId,
      started_at: startedAt,
      finished_at: finishedAt,
    });
  }
}

export function assertVerificationInitiatorAllowed(initiator: VerificationInitiator): void {
  if (initiator.kind === "bridge" || initiator.role === "tester") {
    return;
  }
  throw new WorkerRuntimeError(
    "ROLE_POLICY_DENIED",
    "Only Bridge Verification or the Tester role may request independent verification",
    { role: initiator.role },
  );
}

function readRequest(value: IndependentVerificationRequest): IndependentVerificationRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !isIdentifier(value.verification_id) ||
    !isIdentifier(value.run_id) ||
    typeof value.worktree_path !== "string" ||
    !value.worktree_path.startsWith("/") ||
    !isPositiveInteger(value.max_output_bytes) ||
    !isPositiveInteger(value.termination_grace_ms)
  ) {
    throw invalidVerification("VERIFICATION_REQUEST_INVALID");
  }
  const acceptanceCommands = readAcceptanceCommands(value.acceptance_commands);
  assertVerificationInitiatorAllowed(value.initiator);
  const environment = readEnvironment(value.environment);
  for (const contract of acceptanceCommands) {
    findCommand(contract, value.command_catalog);
  }
  return Object.freeze({
    ...value,
    acceptance_commands: acceptanceCommands,
    environment,
  });
}

function readAcceptanceCommands(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw invalidVerification("VERIFICATION_REQUEST_INVALID");
  }
  const commands: string[] = [];
  for (const item of value as readonly unknown[]) {
    if (typeof item !== "string" || item.length === 0) {
      throw invalidVerification("VERIFICATION_REQUEST_INVALID");
    }
    commands.push(item);
  }
  if (commands.length === 0 || new Set(commands).size !== commands.length) {
    throw invalidVerification("VERIFICATION_REQUEST_INVALID");
  }
  return Object.freeze(commands);
}

function findCommand(
  contract: string,
  catalog: Readonly<Record<string, VerificationCommandConfiguration>>,
): VerificationCommandConfiguration {
  const matches = Object.values(catalog).filter((command) => command.contract === contract);
  if (matches.length !== 1) {
    throw invalidVerification(
      matches.length === 0 ? "ACCEPTANCE_COMMAND_NOT_CONFIGURED" : "ACCEPTANCE_COMMAND_AMBIGUOUS",
    );
  }
  return matches[0]!;
}

function readEnvironment(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const allowed = new Set(["PATH", "LANG", "LC_ALL", "CI", "NO_COLOR", "TMPDIR"]);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([key, item]) => !allowed.has(key) || typeof item !== "string" || item.includes("\0"),
    )
  ) {
    throw invalidVerification("VERIFICATION_ENVIRONMENT_INVALID");
  }
  return Object.freeze({ ...value });
}

function commandStatus(
  outcome: ManagedProcessOutcome,
  exitCode: number | null,
): Exclude<VerificationCommandStatus, "not_run" | "start_failed"> {
  if (outcome === "cancelled") {
    return "cancelled";
  }
  if (outcome === "timed_out") {
    return "timed_out";
  }
  return exitCode === 0 ? "passed" : "failed";
}

function notRun(contract: string): VerificationCommandResult {
  return Object.freeze({ contract, status: "not_run", duration_ms: 0 });
}

function renderLog(stdout: string, stderr: string): string {
  return ["[stdout]", redactLog(stdout), "[stderr]", redactLog(stderr), ""].join("\n");
}

function redactLog(value: string): string {
  return value
    .replaceAll(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replaceAll(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gu, "Bearer [REDACTED]")
    .replaceAll(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED_TOKEN]")
    .replaceAll(/\bAKIA[0-9A-Z]{16}\b/gu, "[REDACTED_ACCESS_KEY]");
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function invalidVerification(reason: string): WorkerRuntimeError {
  return new WorkerRuntimeError(
    "VERIFICATION_CONFIGURATION_INVALID",
    "Independent verification configuration is invalid",
    { reason },
  );
}
