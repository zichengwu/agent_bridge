import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { resolveDriverCredentialEnvironment } from "./driver-credentials.js";
import { WorkerRuntimeError } from "./errors.js";
import type {
  AgentBridgeRuntimeConfiguration,
  RuntimeDriverConfiguration,
} from "./runtime-config.js";

const execFileAsync = promisify(execFile);

export interface RuntimePreflightCheck {
  readonly id: string;
  readonly status: "passed";
  readonly detail: string;
}

export interface RuntimePreflightReport {
  readonly passed: true;
  readonly schema_version: 1 | 2;
  readonly project_id: string;
  readonly checks: readonly RuntimePreflightCheck[];
}

export async function runRuntimePreflight(
  configuration: AgentBridgeRuntimeConfiguration,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RuntimePreflightReport> {
  const checks: RuntimePreflightCheck[] = [];
  await requireDirectory(configuration.project.workspace_root, "WORKSPACE_DIRECTORY_INVALID");
  checks.push(passed("workspace", "project workspace is a readable directory"));

  const repositoryRoot = await resolveGitRepositoryRoot(configuration.project.workspace_root);
  checks.push(passed("git", "workspace is a Git worktree"));

  await requireReadableFile(configuration.project.project_baseline_path, "BASELINE_FILE_INVALID");
  checks.push(passed("baseline", "project baseline is a readable regular file"));

  if (isWithin(configuration.project.runtime_root, configuration.project.workspace_root)) {
    throw preflightError("RUNTIME_ROOT_INSIDE_WORKSPACE");
  }
  await requireWritableLocation(configuration.project.runtime_root);
  checks.push(passed("runtime_root", "runtime root is outside the workspace and writable"));

  await checkDriver(configuration.drivers.primary, configuration, repositoryRoot, environment);
  checks.push(
    passed("driver.opencode", "Driver executable, runtime, provider, and credentials are ready"),
  );
  if (configuration.drivers.fallback.enabled) {
    await checkDriver(configuration.drivers.fallback, configuration, repositoryRoot, environment);
    checks.push(
      passed(
        "driver.claude-agent",
        "fallback Driver executable, runtime, provider, and credentials are ready",
      ),
    );
  } else {
    checks.push(passed("driver.claude-agent", "fallback Driver is explicitly disabled"));
  }

  return Object.freeze({
    passed: true as const,
    schema_version: configuration.schema_version,
    project_id: configuration.project.id,
    checks: Object.freeze(checks),
  });
}

async function checkDriver(
  driver: RuntimeDriverConfiguration,
  configuration: AgentBridgeRuntimeConfiguration,
  repositoryRoot: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  if (driver.executable === undefined) throw preflightError("DRIVER_EXECUTABLE_MISSING", driver.id);
  await requireExecutable(driver.executable, driver.id, "DRIVER_EXECUTABLE_INVALID");
  if (driver.runtime_executable !== undefined) {
    await requireExecutable(
      driver.runtime_executable,
      driver.id,
      "DRIVER_RUNTIME_EXECUTABLE_INVALID",
    );
  }
  if ((driver.provider === undefined) !== (driver.credentials === undefined)) {
    throw preflightError("PROVIDER_CREDENTIALS_INCOMPLETE", driver.id);
  }
  await resolveDriverCredentialEnvironment(
    driver,
    {
      repositoryRoot,
      workspaceRoot: configuration.project.workspace_root,
      runtimeRoot: configuration.project.runtime_root,
    },
    environment,
  );
}

export async function resolveGitRepositoryRoot(workspaceRoot: string): Promise<string> {
  try {
    const [{ stdout: worktree }, { stdout: commonDirectory }] = await Promise.all([
      execFileAsync("/usr/bin/git", ["-C", workspaceRoot, "rev-parse", "--is-inside-work-tree"]),
      execFileAsync("/usr/bin/git", [
        "-C",
        workspaceRoot,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    ]);
    const gitDirectory = commonDirectory.trim();
    if (worktree.trim() !== "true" || basename(gitDirectory) !== ".git") {
      throw new Error("not a conventional worktree");
    }
    return await realpath(dirname(gitDirectory));
  } catch {
    throw preflightError("GIT_WORKTREE_INVALID");
  }
}

async function requireDirectory(path: string, reason: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory()) throw new Error("not directory");
    await access(path, constants.R_OK);
  } catch {
    throw preflightError(reason);
  }
}

async function requireReadableFile(path: string, reason: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error("not file");
    await access(path, constants.R_OK);
  } catch {
    throw preflightError(reason);
  }
}

async function requireExecutable(path: string, driverId: string, reason: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("not executable file");
    await realpath(path);
    await access(path, constants.R_OK | constants.X_OK);
  } catch {
    throw preflightError(
      reason,
      driverId,
      "code 126 commonly means this path lacks execute permission, is quarantined, or is on a noexec mount",
    );
  }
}

async function requireWritableLocation(path: string): Promise<void> {
  let candidate = resolve(path);
  for (;;) {
    try {
      const stat = await lstat(candidate);
      if (!stat.isDirectory()) throw new Error("not directory");
      await access(candidate, constants.W_OK | constants.X_OK);
      return;
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) throw preflightError("RUNTIME_ROOT_NOT_WRITABLE");
      candidate = parent;
    }
  }
}

function isWithin(candidate: string, root: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

function passed(id: string, detail: string): RuntimePreflightCheck {
  return Object.freeze({ id, status: "passed" as const, detail });
}

function preflightError(reason: string, driverId?: string, hint?: string): WorkerRuntimeError {
  return new WorkerRuntimeError("RUNTIME_CONFIG_INVALID", "Runtime preflight failed", {
    reason,
    ...(driverId === undefined ? {} : { driver_id: driverId }),
    ...(hint === undefined ? {} : { hint }),
    retryable: false,
  });
}
