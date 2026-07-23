import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { GitEvidence } from "../contract.js";

const execFileAsync = promisify(execFile);

export interface GitFixture {
  root: string;
  repository: string;
  worktrees: {
    opencodeExec: string;
    claudeReview: string;
    claudeFallback: string;
  };
  baselineCommit: string;
  baselineSha256: string;
}

export async function createGitFixture(root: string): Promise<GitFixture> {
  const repository = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  await Promise.all([
    mkdir(join(repository, "src"), { recursive: true }),
    mkdir(join(repository, "test"), { recursive: true }),
    mkdir(worktreeRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(repository, "package.json"),
      `${JSON.stringify(
        {
          name: "agent-bridge-b-layer-fixture",
          private: true,
          type: "module",
          scripts: { test: "node --test test/sum.test.mjs" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    writeFile(
      join(repository, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n",
      "utf8",
    ),
    writeFile(join(repository, "src/sum.ts"), "export const sum = (a, b) => a - b;\n", "utf8"),
    writeFile(
      join(repository, "test/sum.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        'import { sum } from "../src/sum.ts";',
        "",
        'test("adds two numbers", () => {',
        "  assert.equal(sum(2, 3), 5);",
        "});",
        "",
      ].join("\n"),
      "utf8",
    ),
  ]);

  await runGit(repository, ["init", "-b", "baseline"]);
  await runGit(repository, ["add", "."]);
  await runGit(repository, [
    "-c",
    "user.name=Agent Bridge Spike",
    "-c",
    "user.email=spike@invalid.local",
    "commit",
    "-m",
    "fixture baseline",
  ]);
  const baselineCommit = (await runGit(repository, ["rev-parse", "HEAD"])).trim();
  const baselineSha256 = await hashFixture(repository);
  const worktrees = {
    opencodeExec: join(worktreeRoot, "opencode-exec"),
    claudeReview: join(worktreeRoot, "claude-review"),
    claudeFallback: join(worktreeRoot, "claude-fallback"),
  };
  await runGit(repository, ["worktree", "add", "-b", "opencode-exec", worktrees.opencodeExec]);
  await runGit(repository, ["worktree", "add", "-b", "claude-review", worktrees.claudeReview]);
  await runGit(repository, ["worktree", "add", "-b", "claude-fallback", worktrees.claudeFallback]);
  return { root, repository, worktrees, baselineCommit, baselineSha256 };
}

export async function collectGitEvidence(
  fixture: GitFixture,
  worktree: string,
): Promise<GitEvidence> {
  const patch = await runGit(worktree, [
    "diff",
    "--binary",
    "--no-ext-diff",
    fixture.baselineCommit,
  ]);
  const changedFilesOutput = await runGit(worktree, ["status", "--short", "--untracked-files=all"]);
  const changedFiles = changedFilesOutput
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .sort();
  assertAllowedChanges(changedFiles);
  const verification = await runVerification(worktree);
  return {
    baselineCommit: fixture.baselineCommit,
    baselineSha256: fixture.baselineSha256,
    changedFiles,
    patchSha256: sha256(patch),
    verificationExitCode: verification.exitCode,
  };
}

export async function exportPatch(fixture: GitFixture, worktree: string): Promise<string> {
  return runGit(worktree, ["diff", "--binary", "--no-ext-diff", fixture.baselineCommit]);
}

export async function applyPatch(worktree: string, patch: string): Promise<void> {
  await runWithInput("git", ["apply", "--whitespace=error-all", "-"], worktree, patch);
}

export async function runVerification(
  worktree: string,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "test/sum.test.mjs"], {
      cwd: worktree,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: worktree, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    child.once("exit", (code) => resolve({ exitCode: code ?? 1, output }));
  });
}

function assertAllowedChanges(changedFiles: string[]): void {
  const invalid = changedFiles.filter((path) => path !== "src/sum.ts");
  if (invalid.length > 0) {
    throw new Error(`B_LAYER_GIT_SCOPE_VIOLATION:${invalid.join(",")}`);
  }
}

async function hashFixture(repository: string): Promise<string> {
  const files = ["package.json", "pnpm-lock.yaml", "src/sum.ts", "test/sum.test.mjs"];
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update(await readFile(join(repository, file)));
  }
  return hash.digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, LC_ALL: "C" },
  });
  return stdout;
}

function runWithInput(command: string, args: string[], cwd: string, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (chunk) => (error += String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git apply failed: ${error.trim()}`));
    });
    child.stdin.end(input);
  });
}
