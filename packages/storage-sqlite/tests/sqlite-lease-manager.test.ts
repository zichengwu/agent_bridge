import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteDomainRepository } from "../src/index.js";

const roots: string[] = [];
const repositories: SqliteDomainRepository[] = [];

afterEach(async () => {
  repositories.splice(0).forEach((repository) => repository.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SQLite runtime leases", () => {
  it("survives repository reopen and rejects a conflicting owner", async () => {
    const { path, repository } = await createRepository();
    const first = repository.createLeaseManager({
      now: () => new Date("2026-08-07T00:00:00.000Z"),
    });
    first.acquire({
      leaseId: "lease:run-1",
      ownerId: "run-1",
      resources: ["task:task-1:v1", "worktree:/tmp/run-1"],
      ttlMs: 60_000,
    });
    repository.close();
    repositories.splice(repositories.indexOf(repository), 1);

    const reopened = new SqliteDomainRepository({ database_path: path });
    repositories.push(reopened);
    const second = reopened.createLeaseManager({
      now: () => new Date("2026-08-07T00:00:01.000Z"),
    });
    expect(second.snapshot()).toHaveLength(1);
    expect(() =>
      second.acquire({
        leaseId: "lease:run-2",
        ownerId: "run-2",
        resources: ["task:task-1:v1"],
        ttlMs: 60_000,
      }),
    ).toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
  });

  it("reclaims expired resources but never lets a different owner release an active lease", async () => {
    let now = new Date("2026-08-07T00:00:00.000Z");
    const { repository } = await createRepository();
    const leases = repository.createLeaseManager({ now: () => now });
    leases.acquire({
      leaseId: "lease:run-1",
      ownerId: "run-1",
      resources: ["worktree:/tmp/run"],
      ttlMs: 100,
    });
    expect(() => leases.release("lease:run-1", "run-2")).toThrowError(
      expect.objectContaining({ code: "LEASE_OWNERSHIP_MISMATCH" }),
    );
    now = new Date("2026-08-07T00:00:00.101Z");
    expect(
      leases.acquire({
        leaseId: "lease:run-2",
        ownerId: "run-2",
        resources: ["worktree:/tmp/run"],
        ttlMs: 100,
      }),
    ).toMatchObject({ ownerId: "run-2" });
  });
});

async function createRepository(): Promise<{
  readonly path: string;
  readonly repository: SqliteDomainRepository;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-leases-"));
  roots.push(root);
  const path = join(root, "bridge.sqlite");
  const repository = new SqliteDomainRepository({ database_path: path });
  repositories.push(repository);
  return { path, repository };
}
