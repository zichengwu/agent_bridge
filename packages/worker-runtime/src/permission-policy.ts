import type { PermissionRequest } from "@agent-bridge/driver-protocol";
import type { AgentRole, TaskScope } from "@agent-bridge/schemas";

import { evaluateCommand, type CommandRule, type StructuredCommand } from "./command-policy.js";
import { WorkerRuntimeError } from "./errors.js";
import { authorizeWorkspacePath } from "./path-policy.js";
import { evaluateRoleTool, type PolicyDecision } from "./role-templates.js";

export interface ToolRule {
  readonly name: string;
  readonly decision: PolicyDecision;
}

export interface PermissionPolicyContext {
  readonly role: AgentRole;
  readonly worktreeRoot: string;
  readonly scope: TaskScope;
  readonly commandRules: readonly CommandRule[];
  readonly toolRules: readonly ToolRule[];
}

export interface PermissionPolicyResult {
  readonly decision: PolicyDecision;
  readonly reason: string;
}

export async function evaluatePermissionRequest(
  request: PermissionRequest,
  context: PermissionPolicyContext,
): Promise<PermissionPolicyResult> {
  switch (request.kind) {
    case "filesystem.read":
    case "filesystem.write": {
      const access = request.kind === "filesystem.read" ? "read" : "write";
      const path = readDetailString(request, "path");
      try {
        await authorizeWorkspacePath({
          worktreeRoot: context.worktreeRoot,
          requestedPath: path,
          access,
          role: context.role,
          scope: context.scope,
        });
        return { decision: "allow", reason: "PATH_AUTHORIZED" };
      } catch (error) {
        if (error instanceof WorkerRuntimeError) {
          return { decision: "deny", reason: error.code };
        }
        throw error;
      }
    }
    case "process.execute": {
      const command = readCommandDetails(request);
      const decision = evaluateCommand(context.role, command, context.commandRules);
      return { decision, reason: decision === "allow" ? "COMMAND_AUTHORIZED" : "COMMAND_DENIED" };
    }
    case "network.access": {
      const decision = evaluateRoleTool(context.role, "network.access");
      return {
        decision,
        reason: decision === "approval" ? "NETWORK_APPROVAL_REQUIRED" : "NETWORK_DENIED",
      };
    }
    case "tool.use": {
      const toolName = readDetailString(request, "toolName");
      const roleDecision = evaluateRoleTool(context.role, "tool.use");
      const rule = context.toolRules.find((candidate) => candidate.name === toolName);
      if (roleDecision === "deny" || rule === undefined || rule.decision === "deny") {
        return { decision: "deny", reason: "TOOL_DENIED" };
      }
      const decision =
        roleDecision === "approval" || rule.decision === "approval" ? "approval" : "allow";
      return {
        decision,
        reason: decision === "allow" ? "TOOL_AUTHORIZED" : "TOOL_APPROVAL_REQUIRED",
      };
    }
    case "other":
      return { decision: "deny", reason: "UNCLASSIFIED_PERMISSION" };
  }
  return { decision: "deny", reason: "UNCLASSIFIED_PERMISSION" };
}

function readDetailString(request: PermissionRequest, field: string): string {
  const value = request.details?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkerRuntimeError("TOOL_POLICY_DENIED", "Permission request details are invalid", {
      field,
    });
  }
  return value;
}

function readCommandDetails(request: PermissionRequest): StructuredCommand {
  const executable = request.details?.executable;
  const args = request.details?.args;
  if (
    typeof executable !== "string" ||
    !Array.isArray(args) ||
    !args.every((argument) => typeof argument === "string")
  ) {
    throw new WorkerRuntimeError(
      "COMMAND_POLICY_DENIED",
      "Process permission request must contain a structured command",
    );
  }
  return { executable, args };
}
