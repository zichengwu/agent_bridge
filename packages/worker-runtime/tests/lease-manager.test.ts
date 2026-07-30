import { describe, expect, it } from "vitest";

import { InMemoryLeaseManager } from "../src/index.js";

describe("单写入所有者租约", () => {
  it("原子占用全部资源并稳定拒绝冲突", () => {
    const manager = new InMemoryLeaseManager({ now: () => new Date("2026-07-28T00:00:00.000Z") });
    const lease = manager.acquire({
      leaseId: "lease-1",
      ownerId: "run-1",
      resources: ["worktree:/tmp/one", "task:task-1:v1"],
      ttlMs: 1_000,
    });

    expect(
      manager.acquire({
        leaseId: "lease-1",
        ownerId: "run-1",
        resources: ["task:task-1:v1", "worktree:/tmp/one"],
        ttlMs: 1_000,
      }),
    ).toEqual(lease);
    expect(() =>
      manager.acquire({
        leaseId: "lease-2",
        ownerId: "run-2",
        resources: ["task:task-1:v1"],
        ttlMs: 1_000,
      }),
    ).toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
  });

  it("续租和释放必须由同一所有者完成", () => {
    const manager = new InMemoryLeaseManager();
    manager.acquire({
      leaseId: "lease-1",
      ownerId: "run-1",
      resources: ["worktree:a"],
      ttlMs: 1_000,
    });

    expect(() => manager.renew("lease-1", "run-2", 1_000)).toThrowError(
      expect.objectContaining({ code: "LEASE_OWNERSHIP_MISMATCH" }),
    );
    expect(() => manager.release("lease-1", "run-2")).toThrowError(
      expect.objectContaining({ code: "LEASE_OWNERSHIP_MISMATCH" }),
    );
    manager.release("lease-1", "run-1");
    expect(manager.getByResource("worktree:a")).toBeUndefined();
  });

  it("到期后允许新所有者获取资源", () => {
    let now = new Date("2026-07-28T00:00:00.000Z");
    const manager = new InMemoryLeaseManager({ now: () => now });
    manager.acquire({
      leaseId: "lease-1",
      ownerId: "run-1",
      resources: ["worktree:a"],
      ttlMs: 100,
    });
    now = new Date("2026-07-28T00:00:00.100Z");

    expect(
      manager.acquire({
        leaseId: "lease-2",
        ownerId: "run-2",
        resources: ["worktree:a"],
        ttlMs: 100,
      }),
    ).toMatchObject({ ownerId: "run-2" });
  });

  it("恢复快照时拒绝重复资源", () => {
    const records = [
      {
        leaseId: "lease-1",
        ownerId: "run-1",
        resources: ["worktree:a"],
        acquiredAt: "2026-07-28T00:00:00.000Z",
        expiresAt: "2026-07-28T01:00:00.000Z",
      },
      {
        leaseId: "lease-2",
        ownerId: "run-2",
        resources: ["worktree:a"],
        acquiredAt: "2026-07-28T00:00:00.000Z",
        expiresAt: "2026-07-28T01:00:00.000Z",
      },
    ];

    expect(
      () =>
        new InMemoryLeaseManager({
          now: () => new Date("2026-07-28T00:01:00.000Z"),
          restore: records,
        }),
    ).toThrowError(expect.objectContaining({ code: "RECOVERY_STATE_INVALID" }));
  });
});
