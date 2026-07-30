import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PermissionRequest } from "@agent-bridge/driver-protocol";

import { evaluatePermissionRequest, type PermissionPolicyContext } from "../src/index.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-bridge-permission-"));
  await mkdir(join(root, "src"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("Driver 权限请求映射", () => {
  it.each([
    [permission("filesystem.write", { path: "src/index.ts" }), "allow", "PATH_AUTHORIZED"],
    [permission("filesystem.write", { path: "outside.txt" }), "deny", "PATH_POLICY_DENIED"],
    [
      permission("process.execute", { executable: "/usr/bin/git", args: ["status"] }),
      "allow",
      "COMMAND_AUTHORIZED",
    ],
    [permission("network.access", {}), "deny", "NETWORK_DENIED"],
    [permission("tool.use", { toolName: "formatter" }), "approval", "TOOL_APPROVAL_REQUIRED"],
    [permission("tool.use", { toolName: "unknown" }), "deny", "TOOL_DENIED"],
    [permission("other", {}), "deny", "UNCLASSIFIED_PERMISSION"],
  ] as const)("将 %s 映射为 %s", async (request, decision, reason) => {
    await expect(evaluatePermissionRequest(request, context())).resolves.toEqual({
      decision,
      reason,
    });
  });
});

function context(): PermissionPolicyContext {
  return {
    role: "developer",
    worktreeRoot: root,
    scope: { read: ["**"], write: ["src/**"], deny: [] },
    commandRules: [{ executable: "/usr/bin/git", argsPrefix: ["status"], decision: "allow" }],
    toolRules: [{ name: "formatter", decision: "approval" }],
  };
}

function permission(
  kind: PermissionRequest["kind"],
  details: PermissionRequest["details"],
): PermissionRequest {
  return { permissionId: `permission-${kind}`, toolCallId: "tool-1", kind, title: kind, details };
}
