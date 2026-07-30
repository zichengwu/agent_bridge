import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentRole, TaskScope } from "@agent-bridge/schemas";

import {
  authorizeWorkspacePath,
  classifyWorkspacePath,
  matchesWorkspacePattern,
  normalizeWorkspacePath,
} from "../src/index.js";

const scope: TaskScope = {
  read: ["**"],
  write: ["src/**", "tests/**", "docs/**", "*.md"],
  deny: ["src/secrets/**"],
};

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-bridge-path-root-"));
  outside = await mkdtemp(join(tmpdir(), "agent-bridge-path-outside-"));
  await Promise.all([
    mkdir(join(root, "src", "secrets"), { recursive: true }),
    mkdir(join(root, "tests"), { recursive: true }),
    mkdir(join(root, "docs"), { recursive: true }),
    writeFile(join(outside, "escape.txt"), "outside", "utf8"),
  ]);
});

afterEach(async () => {
  await Promise.all([
    rm(root, { force: true, recursive: true }),
    rm(outside, { force: true, recursive: true }),
  ]);
});

describe("路径安全策略", () => {
  it.each([
    ["developer", "src/index.ts", "product"],
    ["tester", "tests/index.test.ts", "test"],
    ["docs", "docs/guide.md", "docs"],
    ["docs", "README.md", "docs"],
  ] as const)("允许 %s 写入合同内的 %s", async (role, requestedPath, kind) => {
    await expect(authorize(role, requestedPath)).resolves.toMatchObject({
      relativePath: requestedPath,
      kind,
    });
  });

  it.each([
    ["tester", "src/index.ts", "ROLE_POLICY_DENIED"],
    ["docs", "tests/index.test.ts", "ROLE_POLICY_DENIED"],
    ["developer", "src/secrets/key.txt", "PATH_POLICY_DENIED"],
    ["developer", "package.json", "PATH_POLICY_DENIED"],
  ] as const)("拒绝 %s 越权写入 %s", async (role, requestedPath, code) => {
    await expect(authorize(role, requestedPath)).rejects.toMatchObject({ code });
  });

  it.each(["../escape", "src/../escape", "/tmp/escape", "C:\\escape", "src\0file"])(
    "拒绝路径穿越 %s",
    (value) => {
      expect(() => normalizeWorkspacePath(value)).toThrowError(
        expect.objectContaining({ code: "PATH_TRAVERSAL" }),
      );
    },
  );

  it("拒绝符号链接逃逸", async () => {
    await symlink(outside, join(root, "src", "linked-outside"));

    await expect(authorize("developer", "src/linked-outside/escape.txt")).rejects.toMatchObject({
      code: "PATH_SYMLINK_ESCAPE",
    });
  });

  it("glob 与路径分类不跨越目录边界", () => {
    expect(matchesWorkspacePattern("src/nested/a.ts", "src/**")).toBe(true);
    expect(matchesWorkspacePattern("other/a.ts", "src/**")).toBe(false);
    expect(matchesWorkspacePattern("nested/a.test.ts", "**/*.test.*")).toBe(true);
    expect(classifyWorkspacePath("nested/a.test.ts")).toBe("test");
    expect(classifyWorkspacePath("nested/readme.md")).toBe("docs");
  });
});

function authorize(role: AgentRole, requestedPath: string) {
  return authorizeWorkspacePath({
    worktreeRoot: root,
    requestedPath,
    access: "write",
    role,
    scope,
  });
}
