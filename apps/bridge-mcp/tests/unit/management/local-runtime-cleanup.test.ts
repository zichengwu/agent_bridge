import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  InMemoryDomainRepository,
  computeContentHash,
  type AgentRunRecord,
  type ArtifactRepository,
  type AuthoritativeDomainEvent,
  type DomainRecordWrite,
} from "@agent-bridge/core";
import type { JsonObject } from "@agent-bridge/driver-protocol";
import { DOMAIN_SCHEMA_VERSION, type Task, type TaskVersion } from "@agent-bridge/schemas";
import {
  ActiveRunRegistry,
  InMemoryLeaseManager,
  type AgentBridgeRuntimeConfiguration,
} from "@agent-bridge/worker-runtime";
import { afterEach, describe, expect, it } from "vitest";

import { LocalBridgeRuntime } from "../../../src/local-runtime.js";

const roots: string[] = [];
const STARTED_AT = "2026-08-13T01:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalBridgeRuntime cleanup ownership", () => {
  it("ACT-012/ACT-013 只清理证明属于目标 Run 的租约和 runtime 目录，并保留领域事实与工作树引用", async () => {
    const fixture = await createFixture("owned");
    const beforeEvents = (await fixture.repository.listDomainEvents()).events.length;

    const preview = await fixture.runtime.previewCleanupResources("run-1");
    expect(preview).toEqual({
      targets: [
        { kind: "lease", target_id: "lease:run-1", ownership: "owned" },
        { kind: "runtime_directory", target_id: "runtime:run-1", ownership: "owned" },
      ],
      warnings: [],
    });

    const result = await fixture.runtime.cleanupResources("run-1", "management-confirmed");
    expect(result.removed_targets).toEqual(["lease:run-1", "runtime:run-1"]);
    expect(result.refused_targets).toEqual([]);
    expect(fixture.leases.snapshot()).toEqual([]);
    await expect(readFile(fixture.ownerMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fixture.repository.getTask("task-1")).toBeDefined();
    expect(
      await fixture.repository.getTaskVersion({ task_id: "task-1", task_version: 1 }),
    ).toBeDefined();
    expect(await fixture.repository.getAgentRun("run-1")).toMatchObject({
      value: {
        status: "failed",
        metadata: {
          worktree_path: "/retained/worktree",
          artifact_id: "artifact-1",
          resource_cleanup: { worktree_retained: true, removed_count: 2 },
        },
      },
    });
    expect((await fixture.repository.listDomainEvents()).events.length).toBe(beforeEvents + 1);
  });

  it("ACT-014/ACT-015 所有权不匹配时拒绝删除；无残留时 cleanup 成功 no-op", async () => {
    const unverified = await createFixture("unverified");
    const preview = await unverified.runtime.previewCleanupResources("run-1");
    expect(preview.targets).toEqual([
      { kind: "lease", target_id: "lease:run-1", ownership: "unverified" },
      { kind: "runtime_directory", target_id: "runtime:run-1", ownership: "unverified" },
    ]);
    expect(preview.warnings).toHaveLength(2);

    const refused = await unverified.runtime.cleanupResources("run-1", "management-confirmed");
    expect(refused.removed_targets).toEqual([]);
    expect(refused.refused_targets).toEqual(["lease:run-1", "runtime:run-1"]);
    expect(unverified.leases.snapshot()).toHaveLength(1);
    expect(JSON.parse(await readFile(unverified.ownerMarker, "utf8"))).toMatchObject({
      run_id: "foreign-run",
    });

    const noOp = await createFixture("missing");
    const result = await noOp.runtime.cleanupResources("run-1", "management-confirmed");
    expect(result).toMatchObject({ targets: [], warnings: [], removed_targets: [] });
    expect(result.refused_targets).toEqual([]);
    expect(await noOp.repository.getAgentRun("run-1")).toBeDefined();
  });
});

async function createFixture(ownership: "owned" | "unverified" | "missing") {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "agent-bridge-cleanup-")));
  roots.push(root);
  const runtimeRoot = resolve(root, "runtime");
  const isolationRoot = resolve(runtimeRoot, "isolation", "driver-fake", "run-1");
  const ownerMarker = resolve(isolationRoot, ".agent-bridge-owner.json");
  if (ownership !== "missing") {
    await mkdir(isolationRoot, { recursive: true });
    await writeFile(
      ownerMarker,
      JSON.stringify({
        schema_version: 1,
        run_id: ownership === "owned" ? "run-1" : "foreign-run",
      }),
    );
  }
  const repository = new InMemoryDomainRepository();
  await seed(repository, isolationRoot);
  const leases = new InMemoryLeaseManager();
  if (ownership !== "missing") {
    leases.acquire({
      leaseId: "lease:run-1",
      ownerId: ownership === "owned" ? "run-1" : "foreign-run",
      resources: ["task:task-1:v1", "worktree:/retained/worktree"],
      ttlMs: 60_000,
    });
  }
  const runtime = new LocalBridgeRuntime(
    repository,
    new ActiveRunRegistry(),
    configuration(root, runtimeRoot),
    leases,
    {} as ArtifactRepository,
  );
  return { repository, leases, runtime, ownerMarker };
}

function configuration(root: string, runtimeRoot: string): AgentBridgeRuntimeConfiguration {
  const driver = {
    executable: "/usr/bin/false",
    args: [] as const,
    startup_timeout_ms: 1_000,
    request_timeout_ms: 1_000,
  };
  return {
    schema_version: 1,
    project: {
      id: "project-1",
      workspace_root: resolve(root, "workspace"),
      runtime_root: runtimeRoot,
      project_baseline_path: resolve(root, "baseline.json"),
    },
    limits: { timeout_seconds: 60, max_review_cycles: 3, max_agent_count: 1 },
    context: { rollover_ratio: 0.7 },
    drivers: {
      primary: { ...driver, id: "opencode" },
      fallback: { ...driver, id: "claude-agent", enabled: false },
    },
    verification: { max_output_bytes: 1_024, termination_grace_ms: 100, commands: {} },
  };
}

async function seed(repository: InMemoryDomainRepository, isolationRoot: string): Promise<void> {
  const task: Task = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "task-1",
    project_id: "project-1",
    status: "FAILED",
    latest_version: 1,
    created_at: STARTED_AT,
    updated_at: STARTED_AT,
  };
  const versionBase: Omit<TaskVersion, "content_hash"> = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "task-1",
    task_version: 1,
    project_id: "project-1",
    base_commit: "abcdef1",
    policy_version: "1.0",
    objective: "验证安全资源清理",
    role: "developer",
    business_rules: [],
    scope: { read: ["src/**"], write: ["src/**"], deny: [] },
    acceptance_commands: ["pnpm test"],
    git: { branch: "codex/task-1" },
    context_policy: {
      project_baseline_version: 1,
      rollover_ratio: 0.7,
      inherit_full_transcript: false,
    },
    limits: { timeout_seconds: 60, max_review_cycles: 3, max_agent_count: 1 },
    required_output: ["test_results"],
    created_at: STARTED_AT,
  };
  const version: TaskVersion = {
    ...versionBase,
    content_hash: computeContentHash(versionBase as unknown as JsonObject),
  };
  const run: AgentRunRecord = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    run_id: "run-1",
    task_id: "task-1",
    task_version: 1,
    project_id: "project-1",
    driver_id: "driver-fake",
    role: "developer",
    status: "failed",
    created_at: STARTED_AT,
    updated_at: STARTED_AT,
    started_at: STARTED_AT,
    finished_at: STARTED_AT,
    metadata: {
      worktree_path: "/retained/worktree",
      lease_id: "lease:run-1",
      isolation_root: isolationRoot,
      artifact_id: "artifact-1",
    },
  };
  await commitRecords(repository, [
    { kind: "task", expected_revision: 0, value: task },
    { kind: "task_version", expected_revision: 0, value: version },
    { kind: "agent_run", expected_revision: 0, value: run },
  ]);
}

async function commitRecords(
  repository: InMemoryDomainRepository,
  records: readonly DomainRecordWrite[],
): Promise<void> {
  await repository.commit({
    change_id: "cleanup-seed",
    idempotency: {
      operation: "test_cleanup_seed",
      key: "cleanup-seed",
      request_hash: computeContentHash(records as unknown as JsonObject),
    },
    records,
    events: records.map((record, index) => seedEvent(record, index)),
  });
}

function seedEvent(record: DomainRecordWrite, index: number): AuthoritativeDomainEvent {
  const aggregate =
    record.kind === "task"
      ? { kind: record.kind, id: record.value.task_id, revision: 1 }
      : record.kind === "task_version"
        ? {
            kind: record.kind,
            id: `${record.value.task_id}:v${record.value.task_version}`,
            revision: 1,
          }
        : record.kind === "agent_run"
          ? { kind: record.kind, id: record.value.run_id, revision: 1 }
          : { kind: record.kind, id: `unused-${index}`, revision: 1 };
  return {
    event_id: `cleanup-seed-${index}`,
    event_version: 1,
    event_type:
      record.kind === "task"
        ? "task.created"
        : record.kind === "task_version"
          ? "task_version.recorded"
          : "agent_run.created",
    aggregate,
    occurred_at: STARTED_AT,
    audit: {
      actor: { kind: "system", id: "test" },
      operation: "test_cleanup_seed",
      request_id: "cleanup-seed",
      correlation_id: "cleanup-seed",
      idempotency_key: "cleanup-seed",
      ...(record.kind === "task_version" || record.kind === "agent_run"
        ? { task_id: record.value.task_id, task_version: record.value.task_version }
        : record.kind === "task"
          ? { task_id: record.value.task_id }
          : {}),
      ...(record.kind === "agent_run" ? { run_id: record.value.run_id } : {}),
    },
    payload: { seeded: true },
  };
}
