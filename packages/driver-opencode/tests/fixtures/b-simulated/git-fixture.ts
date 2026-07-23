import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FormalGitFixture {
  readonly repository: string;
  readonly workDirectory: string;
  readonly outsidePath: string;
  readonly baselineCommit: string;
  readonly baselineSha256: string;
}

export interface FormalGitEvidence {
  readonly changedFiles: readonly string[];
  readonly patchSha256: string;
  readonly verificationExitCode: number;
}

export async function createFormalGitFixture(root: string): Promise<FormalGitFixture> {
  const repository = join(root, "repo");
  const workDirectory = join(root, "worktree");
  await Promise.all([
    mkdir(join(repository, "src"), { recursive: true }),
    mkdir(join(repository, "test"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(repository, "package.json"),
      `${JSON.stringify(
        {
          name: "agent-bridge-opencode-b-simulated-fixture",
          private: true,
          type: "module",
          scripts: { test: "node --test test/sum.test.mjs" },
        },
        null,
        2,
      )}\n`,
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
    "user.name=Agent Bridge Test",
    "-c",
    "user.email=test@invalid.local",
    "commit",
    "-m",
    "fixture baseline",
  ]);
  const baselineCommit = (await runGit(repository, ["rev-parse", "HEAD"])).trim();
  const baselineSha256 = await hashBaseline(repository);
  await runGit(repository, ["worktree", "add", "-b", "opencode-b-simulated", workDirectory]);
  return {
    repository,
    workDirectory,
    outsidePath: join(root, "outside.txt"),
    baselineCommit,
    baselineSha256,
  };
}

export async function collectFormalGitEvidence(
  fixture: FormalGitFixture,
): Promise<FormalGitEvidence> {
  const status = await runGit(fixture.workDirectory, [
    "status",
    "--short",
    "--untracked-files=all",
  ]);
  const changedFiles = status
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .sort();
  const invalid = changedFiles.filter((path) => path !== "src/sum.ts");
  if (invalid.length > 0) {
    throw new Error(`OPENCODE_B_SIMULATED_GIT_SCOPE_VIOLATION:${invalid.join(",")}`);
  }
  const patch = await runGit(fixture.workDirectory, [
    "diff",
    "--binary",
    "--no-ext-diff",
    fixture.baselineCommit,
  ]);
  const verification = await runVerification(fixture.workDirectory);
  return {
    changedFiles,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    verificationExitCode: verification.exitCode,
  };
}

export function readSumSource(fixture: FormalGitFixture): Promise<string> {
  return readFile(join(fixture.workDirectory, "src/sum.ts"), "utf8");
}

function runVerification(workDirectory: string): Promise<{ readonly exitCode: number }> {
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
    child.once("exit", (code) => resolve({ exitCode: code ?? 1 }));
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
