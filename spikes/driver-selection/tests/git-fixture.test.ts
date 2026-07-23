import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyPatch,
  collectGitEvidence,
  createGitFixture,
  exportPatch,
  runVerification,
} from "../src/harness/git-fixture.js";

describe("B 层一次性 Git 仓库", () => {
  it("创建三个独立 worktree 并可校验和传递 patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-bridge-git-fixture-test-"));
    try {
      const fixture = await createGitFixture(root);
      expect(Object.values(fixture.worktrees).map((path) => path.split("/").at(-1))).toEqual([
        "opencode-exec",
        "claude-review",
        "claude-fallback",
      ]);
      const failing = await runVerification(fixture.worktrees.opencodeExec);
      expect(failing.exitCode).not.toBe(0);

      const source = join(fixture.worktrees.opencodeExec, "src/sum.ts");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(source, "export const sum = (a, b) => a + b;\n", "utf8");
      const evidence = await collectGitEvidence(fixture, fixture.worktrees.opencodeExec);
      expect(evidence.changedFiles).toEqual(["src/sum.ts"]);
      expect(evidence.verificationExitCode).toBe(0);

      const patch = await exportPatch(fixture, fixture.worktrees.opencodeExec);
      await applyPatch(fixture.worktrees.claudeReview, patch);
      expect((await runVerification(fixture.worktrees.claudeReview)).exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
