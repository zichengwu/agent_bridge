import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BUGGY_SOURCE = "export const sum = (a, b) => a - b;\n";
const FIXED_SOURCE = "export const sum = (a, b) => a + b;\n";

export interface ClaudeFormalGitFixture {
  readonly repository: string;
  readonly workDirectories: {
    readonly fallback: string;
    readonly review: string;
  };
  readonly outsidePath: string;
  readonly baselineCommit: string;
  readonly baselineSha256: string;
}

export interface ClaudeFormalGitEvidence {
  readonly changedFiles: readonly string[];
  readonly patchSha256: string;
  readonly verificationExitCode: number;
}

export interface ClaudeWorktreeSnapshot {
  readonly source: string;
  readonly status: string;
  readonly patchSha256: string;
  readonly outsideExists: boolean;
}

export async function createClaudeFormalGitFixture(root: string): Promise<ClaudeFormalGitFixture> {
  const repository = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  const fallback = join(worktreeRoot, "claude-fallback");
  const review = join(worktreeRoot, "claude-review");
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
          name: "agent-bridge-claude-b-simulated-fixture",
          private: true,
          type: "module",
          scripts: { test: "node --test test/sum.test.mjs" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    writeFile(join(repository, "src/sum.ts"), BUGGY_SOURCE, "utf8"),
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
    "user.name=Agent Bridge Test",
    "-c",
    "user.email=test@invalid.local",
    "commit",
    "-m",
    "fixture baseline",
  ]);
  const baselineCommit = (await runGit(repository, ["rev-parse", "HEAD"])).trim();
  const baselineSha256 = await hashBaseline(repository);
  await runGit(repository, ["worktree", "add", "-b", "claude-fallback", fallback]);
  await runGit(repository, ["worktree", "add", "-b", "claude-review", review]);
  return {
    repository,
    workDirectories: { fallback, review },
    outsidePath: join(worktreeRoot, "outside.txt"),
    baselineCommit,
    baselineSha256,
  };
}

export async function applyReviewHandoff(fixture: ClaudeFormalGitFixture): Promise<void> {
  await writeFile(join(fixture.workDirectories.review, "src/sum.ts"), FIXED_SOURCE, "utf8");
}

export async function collectClaudeFormalGitEvidence(
  fixture: ClaudeFormalGitFixture,
  workDirectory: string,
): Promise<ClaudeFormalGitEvidence> {
  const status = await runGit(workDirectory, ["status", "--short", "--untracked-files=all"]);
  const changedFiles = changedPaths(status);
  const invalid = changedFiles.filter((path) => path !== "src/sum.ts");
  if (invalid.length > 0) {
    throw new Error(`CLAUDE_B_SIMULATED_GIT_SCOPE_VIOLATION:${invalid.join(",")}`);
  }
  const patch = await runGit(workDirectory, [
    "diff",
    "--binary",
    "--no-ext-diff",
    fixture.baselineCommit,
  ]);
  return {
    changedFiles,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    verificationExitCode: await runVerification(workDirectory),
  };
}

export async function snapshotClaudeWorktree(
  fixture: ClaudeFormalGitFixture,
  workDirectory: string,
): Promise<ClaudeWorktreeSnapshot> {
  const status = await runGit(workDirectory, ["status", "--short", "--untracked-files=all"]);
  const patch = await runGit(workDirectory, [
    "diff",
    "--binary",
    "--no-ext-diff",
    fixture.baselineCommit,
  ]);
  return {
    source: await readFile(join(workDirectory, "src/sum.ts"), "utf8"),
    status,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    outsideExists: await pathExists(fixture.outsidePath),
  };
}

export function readClaudeSumSource(workDirectory: string): Promise<string> {
  return readFile(join(workDirectory, "src/sum.ts"), "utf8");
}

export function buggyClaudeSumSource(): string {
  return BUGGY_SOURCE;
}

export function fixedClaudeSumSource(): string {
  return FIXED_SOURCE;
}

async function runVerification(workDirectory: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "test/sum.test.mjs"], {
      cwd: workDirectory,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: workDirectory,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function hashBaseline(repository: string): Promise<string> {
  const hash = createHash("sha256");
  for (const path of ["package.json", "src/sum.ts", "test/sum.test.mjs"]) {
    hash.update(path);
    hash.update(await readFile(join(repository, path)));
  }
  return hash.digest("hex");
}

function changedPaths(status: string): string[] {
  return status
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .map((path) => (path.includes(" -> ") ? path.split(" -> ").at(-1)! : path))
    .sort();
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      LC_ALL: "C",
    },
  });
  return stdout;
}

function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
