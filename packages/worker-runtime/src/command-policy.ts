import { isAbsolute } from "node:path";

import type { AgentRole } from "@agent-bridge/schemas";

import { WorkerRuntimeError } from "./errors.js";
import { evaluateRoleTool, type PolicyDecision } from "./role-templates.js";

export interface StructuredCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface CommandRule {
  readonly executable: string;
  readonly argsPrefix?: readonly string[];
  readonly allowAdditionalArgs?: boolean;
  readonly decision: Exclude<PolicyDecision, "approval"> | "approval";
}

export function evaluateCommand(
  role: AgentRole,
  command: StructuredCommand,
  rules: readonly CommandRule[],
): PolicyDecision {
  readCommand(command);
  const roleDecision = evaluateRoleTool(role, "process.execute");
  if (roleDecision === "deny") {
    return "deny";
  }
  const matching = rules.find((rule) => commandMatches(command, rule));
  if (matching === undefined || matching.decision === "deny") {
    return "deny";
  }
  return roleDecision === "approval" || matching.decision === "approval" ? "approval" : "allow";
}

export function assertCommandAllowed(
  role: AgentRole,
  command: StructuredCommand,
  rules: readonly CommandRule[],
): void {
  const decision = evaluateCommand(role, command, rules);
  if (decision !== "allow") {
    throw new WorkerRuntimeError("COMMAND_POLICY_DENIED", "Worker command is not authorized", {
      role,
      decision,
    });
  }
}

function readCommand(command: StructuredCommand): void {
  if (
    typeof command !== "object" ||
    command === null ||
    typeof command.executable !== "string" ||
    !isAbsolute(command.executable) ||
    !Array.isArray(command.args) ||
    !command.args.every((argument) => typeof argument === "string" && !argument.includes("\0"))
  ) {
    throw new WorkerRuntimeError(
      "COMMAND_POLICY_DENIED",
      "Worker commands must use an absolute executable and structured arguments",
    );
  }
}

function commandMatches(command: StructuredCommand, rule: CommandRule): boolean {
  if (command.executable !== rule.executable) {
    return false;
  }
  const prefix = rule.argsPrefix ?? [];
  if (prefix.some((argument, index) => command.args[index] !== argument)) {
    return false;
  }
  return rule.allowAdditionalArgs === true || command.args.length === prefix.length;
}
