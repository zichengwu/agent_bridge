import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AgentRole, TaskScope, TaskVersion } from "@agent-bridge/schemas";

import { WorkerRuntimeError } from "./errors.js";
import type { GitClient } from "./git-client.js";
import type { LeaseManager, LeaseRecord } from "./lease-manager.js";
import { authorizeWorkspacePath, normalizeWorkspacePath } from "./path-policy.js";

export interface CreateWorktreeRequest {
  readonly repositoryPath: string;
  readonly worktreesRoot: string;
  readonly worktreeName: string;
  readonly branch: string;
  readonly sourceRef: string;
  readonly baseCommit: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly runId: string;
  readonly leaseTtlMs: number;
}

export interface WorktreeOwnership {
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly runId: string;
  readonly lease: LeaseRecord;
}

export interface ValidateWorktreeDiffRequest {
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly ownerId: string;
  readonly role: AgentRole;
  readonly scope: TaskScope;
}

export interface WorktreeDiff {
  readonly changedFiles: readonly string[];
}

export class GitWorktreeManager {
  private readonly ownershipByPath = new Map<string, WorktreeOwnership>();
  private readonly ownershipByBranch = new Map<string, string>();

  constructor(
    private readonly git: GitClient,
    private readonly leases: LeaseManager,
  ) {}

  async ensure(request: CreateWorktreeRequest): Promise<WorktreeOwnership> {
    readCreateRequest(request);
    const expectedPath = resolve(request.worktreesRoot, request.worktreeName);
    return (await pathExists(expectedPath)) ? this.adopt(request) : this.create(request);
  }

  async create(request: CreateWorktreeRequest): Promise<WorktreeOwnership> {
    readCreateRequest(request);
    const repositoryPath = await canonicalDirectory(
      request.repositoryPath,
      "GIT_REPOSITORY_INVALID",
    );
    const root = await canonicalDirectory(request.worktreesRoot, "GIT_WORKTREE_CONFLICT");
    const topLevel = decodeText(
      (await this.git.run(repositoryPath, ["rev-parse", "--show-toplevel"])).stdout,
    );
    const canonicalTopLevel = await realpath(topLevel);
    if (canonicalTopLevel !== repositoryPath) {
      throw new WorkerRuntimeError("GIT_REPOSITORY_INVALID", "Git repository root does not match");
    }
    await this.git.run(repositoryPath, ["check-ref-format", "--branch", request.branch]);
    if (request.sourceRef !== "HEAD") {
      await this.git.run(repositoryPath, ["check-ref-format", "--branch", request.sourceRef]);
    }
    const base = decodeText(
      (
        await this.git.run(repositoryPath, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${request.baseCommit}^{commit}`,
        ])
      ).stdout,
    );
    const source = decodeText(
      (
        await this.git.run(repositoryPath, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${request.sourceRef}^{commit}`,
        ])
      ).stdout,
    );
    if (base !== source) {
      throw new WorkerRuntimeError("GIT_BASE_MISMATCH", "Git base commit is stale", {
        expected: base,
        actual: source,
      });
    }
    const branchCheck = await this.git.run(
      repositoryPath,
      ["show-ref", "--verify", "--quiet", `refs/heads/${request.branch}`],
      [0, 1],
    );
    if (branchCheck.exitCode === 0 || this.ownershipByBranch.has(request.branch)) {
      throw new WorkerRuntimeError("GIT_BRANCH_CONFLICT", "Git branch already exists");
    }

    const worktreePath = resolve(root, request.worktreeName);
    assertContained(root, worktreePath);
    if (await pathExists(worktreePath)) {
      throw new WorkerRuntimeError("GIT_WORKTREE_CONFLICT", "Git worktree path already exists");
    }
    if (this.ownershipByPath.has(worktreePath)) {
      throw new WorkerRuntimeError("GIT_WORKTREE_CONFLICT", "Git worktree is already owned");
    }

    const leaseId = `lease:${request.runId}`;
    const lease = this.leases.acquire({
      leaseId,
      ownerId: request.runId,
      resources: [`task:${request.taskId}:v${request.taskVersion}`, `worktree:${worktreePath}`],
      ttlMs: request.leaseTtlMs,
    });
    try {
      await this.git.run(repositoryPath, [
        "worktree",
        "add",
        "-b",
        request.branch,
        worktreePath,
        base,
      ]);
    } catch (error) {
      this.leases.release(leaseId, request.runId);
      throw error;
    }
    const ownership = Object.freeze({
      repositoryPath,
      worktreePath,
      branch: request.branch,
      baseCommit: base,
      taskId: request.taskId,
      taskVersion: request.taskVersion,
      runId: request.runId,
      lease,
    });
    this.ownershipByPath.set(worktreePath, ownership);
    this.ownershipByBranch.set(request.branch, worktreePath);
    return ownership;
  }

  async adopt(request: CreateWorktreeRequest): Promise<WorktreeOwnership> {
    readCreateRequest(request);
    const repositoryPath = await canonicalDirectory(
      request.repositoryPath,
      "GIT_REPOSITORY_INVALID",
    );
    const root = await canonicalDirectory(request.worktreesRoot, "GIT_WORKTREE_CONFLICT");
    const worktreePath = await canonicalDirectory(
      resolve(root, request.worktreeName),
      "GIT_WORKTREE_CONFLICT",
    );
    assertContained(root, worktreePath);
    const existing = this.ownershipByPath.get(worktreePath);
    if (existing !== undefined) {
      if (
        existing.runId === request.runId &&
        existing.taskId === request.taskId &&
        existing.taskVersion === request.taskVersion
      ) {
        return structuredClone(existing);
      }
      throw new WorkerRuntimeError("GIT_WORKTREE_CONFLICT", "Git worktree ownership conflicts");
    }
    const topLevel = decodeText(
      (await this.git.run(worktreePath, ["rev-parse", "--show-toplevel"])).stdout,
    );
    if ((await realpath(topLevel)) !== worktreePath) {
      throw new WorkerRuntimeError("GIT_WORKTREE_CONFLICT", "Git worktree root does not match");
    }
    const branch = decodeText(
      (await this.git.run(worktreePath, ["symbolic-ref", "--short", "HEAD"])).stdout,
    );
    if (branch !== request.branch) {
      throw new WorkerRuntimeError("GIT_BRANCH_CONFLICT", "Git worktree branch does not match");
    }
    const base = decodeText(
      (
        await this.git.run(repositoryPath, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${request.baseCommit}^{commit}`,
        ])
      ).stdout,
    );
    const ancestor = await this.git.run(
      worktreePath,
      ["merge-base", "--is-ancestor", base, "HEAD"],
      [0, 1],
    );
    if (ancestor.exitCode !== 0) {
      throw new WorkerRuntimeError("GIT_BASE_MISMATCH", "Git base is not an ancestor of HEAD");
    }
    const acquiredLease = this.leases.acquire({
      leaseId: `lease:${request.runId}`,
      ownerId: request.runId,
      resources: [`task:${request.taskId}:v${request.taskVersion}`, `worktree:${worktreePath}`],
      ttlMs: request.leaseTtlMs,
    });
    const lease = this.leases.renew(acquiredLease.leaseId, request.runId, request.leaseTtlMs);
    const ownership = Object.freeze({
      repositoryPath,
      worktreePath,
      branch,
      baseCommit: base,
      taskId: request.taskId,
      taskVersion: request.taskVersion,
      runId: request.runId,
      lease,
    });
    this.ownershipByPath.set(worktreePath, ownership);
    this.ownershipByBranch.set(branch, worktreePath);
    return ownership;
  }

  getOwnership(worktreePath: string): WorktreeOwnership | undefined {
    const normalized = resolve(worktreePath);
    const ownership = this.ownershipByPath.get(normalized);
    return ownership === undefined ? undefined : structuredClone(ownership);
  }

  async validateDiff(request: ValidateWorktreeDiffRequest): Promise<WorktreeDiff> {
    const worktreePath = await canonicalDirectory(request.worktreePath, "GIT_WORKTREE_CONFLICT");
    const ownership = this.ownershipByPath.get(worktreePath);
    if (ownership === undefined || ownership.runId !== request.ownerId) {
      throw new WorkerRuntimeError("GIT_WORKTREE_CONFLICT", "Git worktree ownership is invalid");
    }
    if (ownership.baseCommit !== request.baseCommit) {
      throw new WorkerRuntimeError("GIT_BASE_MISMATCH", "Git diff base does not match ownership");
    }
    const ancestor = await this.git.run(
      worktreePath,
      ["merge-base", "--is-ancestor", request.baseCommit, "HEAD"],
      [0, 1],
    );
    if (ancestor.exitCode !== 0) {
      throw new WorkerRuntimeError("GIT_BASE_MISMATCH", "Git base is not an ancestor of HEAD");
    }

    const diff = await this.git.run(worktreePath, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-status",
      "-z",
      "--find-renames",
      request.baseCommit,
      "--",
    ]);
    const untracked = await this.git.run(worktreePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const changed = new Set(parseNameStatus(diff.stdout));
    for (const path of splitNul(untracked.stdout)) {
      changed.add(normalizeWorkspacePath(path));
    }

    const violations: string[] = [];
    for (const path of [...changed].sort()) {
      try {
        await authorizeWorkspacePath({
          worktreeRoot: worktreePath,
          requestedPath: path,
          access: "write",
          role: request.role,
          scope: request.scope,
        });
      } catch (error) {
        if (error instanceof WorkerRuntimeError) {
          violations.push(path);
          continue;
        }
        throw error;
      }
    }
    if (violations.length > 0) {
      throw new WorkerRuntimeError(
        "GIT_DIFF_POLICY_VIOLATION",
        "Git diff contains unauthorized paths",
        { paths: Object.freeze(violations) },
      );
    }
    return Object.freeze({ changedFiles: Object.freeze([...changed].sort()) });
  }

  release(worktreePath: string, ownerId: string): void {
    const normalized = resolve(worktreePath);
    const ownership = this.ownershipByPath.get(normalized);
    if (ownership === undefined) {
      return;
    }
    if (ownership.runId !== ownerId) {
      throw new WorkerRuntimeError("LEASE_OWNERSHIP_MISMATCH", "Worktree owner does not match");
    }
    this.leases.release(ownership.lease.leaseId, ownerId);
    this.ownershipByPath.delete(normalized);
    this.ownershipByBranch.delete(ownership.branch);
  }
}

export function taskVersionWorktreeScope(taskVersion: TaskVersion): TaskScope {
  return taskVersion.scope;
}

function parseNameStatus(value: Buffer): readonly string[] {
  const tokens = splitNul(value);
  const paths: string[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (status === undefined) {
      break;
    }
    const first = tokens[index++];
    if (first === undefined) {
      throw invalidGitDiff();
    }
    paths.push(normalizeWorkspacePath(first));
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = tokens[index++];
      if (second === undefined) {
        throw invalidGitDiff();
      }
      paths.push(normalizeWorkspacePath(second));
    }
  }
  return paths;
}

function splitNul(value: Buffer): string[] {
  const parts = value.toString("utf8").split("\0");
  if (parts.at(-1) === "") {
    parts.pop();
  }
  return parts;
}

function readCreateRequest(request: CreateWorktreeRequest): void {
  if (
    !isAbsolute(request.repositoryPath) ||
    !isAbsolute(request.worktreesRoot) ||
    !isIdentifier(request.worktreeName) ||
    !isIdentifier(request.taskId) ||
    !isIdentifier(request.runId) ||
    !isSafeSourceRef(request.sourceRef) ||
    !Number.isSafeInteger(request.taskVersion) ||
    request.taskVersion <= 0 ||
    !Number.isSafeInteger(request.leaseTtlMs) ||
    request.leaseTtlMs <= 0 ||
    !/^[0-9a-f]{7,64}$/u.test(request.baseCommit)
  ) {
    throw new WorkerRuntimeError("WORKER_CONFIGURATION_INVALID", "Git worktree request is invalid");
  }
}

async function canonicalDirectory(
  path: string,
  code: "GIT_REPOSITORY_INVALID" | "GIT_WORKTREE_CONFLICT",
): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new WorkerRuntimeError(code, "Git directory is unavailable");
  }
}

function assertContained(root: string, target: string): void {
  const fromRoot = relative(root, target);
  if (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  ) {
    return;
  }
  throw new WorkerRuntimeError("GIT_WORKTREE_CONFLICT", "Git worktree path escapes its root");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function decodeText(value: Buffer): string {
  return value.toString("utf8").trim();
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isSafeSourceRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !value.startsWith("-") &&
    !value.includes("\0")
  );
}

function invalidGitDiff(): WorkerRuntimeError {
  return new WorkerRuntimeError("GIT_REPOSITORY_INVALID", "Git diff output is malformed");
}
