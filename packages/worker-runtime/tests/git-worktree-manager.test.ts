import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DefaultGitClient,
  GitWorktreeManager,
  InMemoryLeaseManager,
  type CreateWorktreeRequest,
} from "../src/index.js";

const gitExecutable = "/usr/bin/git";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Git worktree 隔离", () => {
  it("从精确 base 创建所有权并校验 diff 和 rename 两端", async () => {
    const fixture = await createRepository();
    const manager = new GitWorktreeManager(fixture.git, new InMemoryLeaseManager());
    const ownership = await manager.create(request(fixture));
    await writeFile(
      join(ownership.worktreePath, "src", "index.ts"),
      "export const value = 2;\n",
      "utf8",
    );
    await rename(
      join(ownership.worktreePath, "src", "old.ts"),
      join(ownership.worktreePath, "src", "renamed.ts"),
    );

    await expect(
      manager.validateDiff({
        worktreePath: ownership.worktreePath,
        baseCommit: fixture.baseCommit,
        ownerId: "run-1",
        role: "developer",
        scope: { read: ["**"], write: ["src/**"], deny: [] },
      }),
    ).resolves.toEqual({ changedFiles: ["src/index.ts", "src/old.ts", "src/renamed.ts"] });
    expect(manager.getOwnership(ownership.worktreePath)).toMatchObject({
      baseCommit: fixture.baseCommit,
      runId: "run-1",
    });
  });

  it("拒绝 diff 中的越权路径", async () => {
    const fixture = await createRepository();
    const manager = new GitWorktreeManager(fixture.git, new InMemoryLeaseManager());
    const ownership = await manager.create(request(fixture));
    await writeFile(join(ownership.worktreePath, "secret.txt"), "not allowed\n", "utf8");

    await expect(
      manager.validateDiff({
        worktreePath: ownership.worktreePath,
        baseCommit: fixture.baseCommit,
        ownerId: "run-1",
        role: "developer",
        scope: { read: ["**"], write: ["src/**"], deny: [] },
      }),
    ).rejects.toMatchObject({
      code: "GIT_DIFF_POLICY_VIOLATION",
      details: { paths: ["secret.txt"] },
    });
  });

  it("单任务写租约冲突返回稳定 LEASE_CONFLICT", async () => {
    const fixture = await createRepository();
    const leases = new InMemoryLeaseManager();
    const manager = new GitWorktreeManager(fixture.git, leases);
    await manager.create(request(fixture));

    await expect(
      manager.create(
        request(fixture, {
          worktreeName: "worktree-2",
          branch: "codex/task-2",
          runId: "run-2",
        }),
      ),
    ).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
  });

  it("source ref 变化后拒绝陈旧 base", async () => {
    const fixture = await createRepository();
    await writeFile(join(fixture.repositoryPath, "new.txt"), "new commit\n", "utf8");
    await fixture.git.run(fixture.repositoryPath, ["add", "new.txt"]);
    await fixture.git.run(fixture.repositoryPath, ["commit", "-m", "advance source"]);
    const manager = new GitWorktreeManager(fixture.git, new InMemoryLeaseManager());

    await expect(manager.create(request(fixture))).rejects.toMatchObject({
      code: "GIT_BASE_MISMATCH",
    });
  });

  it("拒绝可能被 Git 解析为选项的 source ref", async () => {
    const fixture = await createRepository();
    const manager = new GitWorktreeManager(fixture.git, new InMemoryLeaseManager());

    await expect(
      manager.create(request(fixture, { sourceRef: "--output=/tmp/not-allowed" })),
    ).rejects.toMatchObject({ code: "WORKER_CONFIGURATION_INVALID" });
  });

  it("只有当前所有者可以释放 worktree 租约", async () => {
    const fixture = await createRepository();
    const leases = new InMemoryLeaseManager();
    const manager = new GitWorktreeManager(fixture.git, leases);
    const ownership = await manager.create(request(fixture));

    expect(() => manager.release(ownership.worktreePath, "run-2")).toThrowError(
      expect.objectContaining({ code: "LEASE_OWNERSHIP_MISMATCH" }),
    );
    manager.release(ownership.worktreePath, "run-1");
    expect(leases.snapshot()).toEqual([]);
  });
});

interface RepositoryFixture {
  readonly repositoryPath: string;
  readonly worktreesRoot: string;
  readonly baseCommit: string;
  readonly git: DefaultGitClient;
}

async function createRepository(): Promise<RepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-git-"));
  roots.push(root);
  const repositoryPath = join(root, "repository");
  const worktreesRoot = join(root, "worktrees");
  await Promise.all([mkdir(repositoryPath), mkdir(worktreesRoot)]);
  const git = new DefaultGitClient({ executable: gitExecutable });
  await git.run(repositoryPath, ["init", "-b", "main"]);
  await git.run(repositoryPath, ["config", "user.email", "agent-bridge@example.invalid"]);
  await git.run(repositoryPath, ["config", "user.name", "Agent Bridge Test"]);
  await mkdir(join(repositoryPath, "src"));
  await Promise.all([
    writeFile(join(repositoryPath, "src", "index.ts"), "export const value = 1;\n", "utf8"),
    writeFile(join(repositoryPath, "src", "old.ts"), "export const old = true;\n", "utf8"),
  ]);
  await git.run(repositoryPath, ["add", "src"]);
  await git.run(repositoryPath, ["commit", "-m", "base"]);
  const baseCommit = (await git.run(repositoryPath, ["rev-parse", "HEAD"])).stdout
    .toString("utf8")
    .trim();
  return { repositoryPath, worktreesRoot, baseCommit, git };
}

function request(
  fixture: RepositoryFixture,
  overrides: Partial<CreateWorktreeRequest> = {},
): CreateWorktreeRequest {
  return {
    repositoryPath: fixture.repositoryPath,
    worktreesRoot: fixture.worktreesRoot,
    worktreeName: "worktree-1",
    branch: "codex/task-1",
    sourceRef: "HEAD",
    baseCommit: fixture.baseCommit,
    taskId: "task-1",
    taskVersion: 1,
    runId: "run-1",
    leaseTtlMs: 60_000,
    ...overrides,
  };
}
