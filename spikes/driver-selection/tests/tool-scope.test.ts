import { describe, expect, it } from "vitest";

import {
  isPathWithinRoot,
  shouldAllowClaudeTool,
  shouldAllowOpenCodePermission,
} from "../src/harness/tool-scope.js";

describe("B 层工具路径门禁", () => {
  const workDirectory = "/private/tmp/agent-bridge/worktree";

  it("只接受工作目录内路径", () => {
    expect(isPathWithinRoot(workDirectory, "src/sum.ts")).toBe(true);
    expect(isPathWithinRoot(workDirectory, `${workDirectory}/src/sum.ts`)).toBe(true);
    expect(isPathWithinRoot(workDirectory, "../outside.txt")).toBe(false);
    expect(isPathWithinRoot(workDirectory, "/Users/example/.claude/config.json")).toBe(false);
  });

  it("OpenCode 只允许 write 场景内的 edit 权限", () => {
    expect(
      shouldAllowOpenCodePermission({
        scenario: "write",
        workDirectory,
        permission: "edit",
        patterns: ["src/sum.ts"],
      }),
    ).toBe(true);
    expect(
      shouldAllowOpenCodePermission({
        scenario: "write",
        workDirectory,
        permission: "bash",
        patterns: ["*"],
      }),
    ).toBe(false);
    expect(
      shouldAllowOpenCodePermission({
        scenario: "deny",
        workDirectory,
        permission: "external_directory",
        patterns: ["../outside.txt"],
      }),
    ).toBe(false);
  });

  it("Claude 按场景、工具和 file_path 三重校验", () => {
    expect(
      shouldAllowClaudeTool({
        scenario: "write",
        workDirectory,
        toolName: "Write",
        toolInput: { file_path: "src/sum.ts" },
      }),
    ).toBe(true);
    expect(
      shouldAllowClaudeTool({
        scenario: "write",
        workDirectory,
        toolName: "Write",
        toolInput: { file_path: "../outside.txt" },
      }),
    ).toBe(false);
    expect(
      shouldAllowClaudeTool({
        scenario: "review",
        workDirectory,
        toolName: "Write",
        toolInput: { file_path: "src/sum.ts" },
      }),
    ).toBe(false);
  });
});
