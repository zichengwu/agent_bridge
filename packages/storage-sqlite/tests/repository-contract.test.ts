import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CoreDomainError,
  InMemoryDomainRepository,
  type DomainRecordWrite,
  type DomainRepository,
} from "@agent-bridge/core";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteDomainRepository } from "../src/index.js";
import {
  bindingValue,
  contextValue,
  eventFor,
  handoffValue,
  laterTimestamp,
  requestFor,
  runValue,
  snapshotValue,
  taskRelationValue,
  taskResultValue,
  taskValue,
  taskVersionValue,
} from "./fixtures.js";

const roots: string[] = [];
const repositories: SqliteDomainRepository[] = [];

afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    repository.close();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const cases = [
  {
    label: "Task",
    write: { kind: "task", expected_revision: 0, value: taskValue() } satisfies DomainRecordWrite,
    event: "task.created" as const,
    load: (repository: DomainRepository) => repository.getTask("task-1"),
  },
  {
    label: "TaskVersion",
    write: {
      kind: "task_version",
      expected_revision: 0,
      value: taskVersionValue(),
    } satisfies DomainRecordWrite,
    event: "task_version.recorded" as const,
    load: (repository: DomainRepository) =>
      repository.getTaskVersion({ task_id: "task-1", task_version: 1 }),
  },
  {
    label: "TaskResult",
    write: {
      kind: "task_result",
      expected_revision: 0,
      value: taskResultValue(),
    } satisfies DomainRecordWrite,
    event: "task_result.recorded" as const,
    load: (repository: DomainRepository) => repository.getTaskResult("run-1"),
  },
  {
    label: "TaskRelation",
    write: {
      kind: "task_relation",
      expected_revision: 0,
      value: taskRelationValue(),
    } satisfies DomainRecordWrite,
    event: "task_relation.recorded" as const,
    load: (repository: DomainRepository) => repository.getTaskRelation("relation-1"),
  },
  {
    label: "AgentRun",
    write: {
      kind: "agent_run",
      expected_revision: 0,
      value: runValue(),
    } satisfies DomainRecordWrite,
    event: "agent_run.created" as const,
    load: (repository: DomainRepository) => repository.getAgentRun("run-1"),
  },
  {
    label: "SessionBinding",
    write: {
      kind: "agent_session_binding",
      expected_revision: 0,
      value: bindingValue(),
    } satisfies DomainRecordWrite,
    event: "agent_session_binding.recorded" as const,
    load: (repository: DomainRepository) => repository.getAgentSessionBinding("binding-1"),
  },
  {
    label: "ContextPackage",
    write: {
      kind: "context_package",
      expected_revision: 0,
      value: contextValue(),
    } satisfies DomainRecordWrite,
    event: "context_package.recorded" as const,
    load: (repository: DomainRepository) => repository.getContextPackage("context-1"),
  },
  {
    label: "HandoffPackage",
    write: {
      kind: "handoff_package",
      expected_revision: 0,
      value: handoffValue(),
    } satisfies DomainRecordWrite,
    event: "handoff_package.recorded" as const,
    load: (repository: DomainRepository) => repository.getHandoffPackage("handoff-1", 1),
  },
  {
    label: "ContinuationSnapshot",
    write: {
      kind: "continuation_snapshot",
      expected_revision: 0,
      value: snapshotValue(),
    } satisfies DomainRecordWrite,
    event: "continuation_snapshot.recorded" as const,
    load: (repository: DomainRepository) => repository.getContinuationSnapshot("snapshot-1", 1),
  },
] as const;

describe("SQLite Repository contract", () => {
  it("matches the in-memory Repository for shared writes, replay, queries, and recovery ordering", async () => {
    const memory = new InMemoryDomainRepository();
    const sqlite = await createRepository();

    expect(await exerciseParity(sqlite)).toEqual(await exerciseParity(memory));
  });

  it.each(cases)("persists and reads $label with its authoritative event", async (scenario) => {
    const repository = await createRepository();
    const result = await repository.commit(
      requestFor(`record-${scenario.write.kind}`, scenario.write, scenario.event),
    );

    expect(result).toMatchObject({
      outcome: "APPLIED",
      records: [{ kind: scenario.write.kind, revision: 1 }],
    });
    expect(await scenario.load(repository)).toMatchObject({
      kind: scenario.write.kind,
      revision: 1,
      value: scenario.write.value,
    });
    expect((await repository.listDomainEvents()).events).toHaveLength(1);
  });

  it("replays the exact idempotent write without duplicating state, event, or Outbox", async () => {
    const repository = await createRepository();
    const request = requestFor(
      "idempotent",
      { kind: "task", expected_revision: 0, value: taskValue() },
      "task.created",
    );
    const first = await repository.commit(request);
    const replay = await repository.commit(request);

    expect(first.outcome).toBe("APPLIED");
    expect(replay).toEqual({ ...first, outcome: "REPLAYED" });
    expect((await repository.listDomainEvents()).events).toHaveLength(1);
    expect(
      repository.createOutboxDispatcher({ dispatcher_id: "inspect" }).listEntries(),
    ).toHaveLength(1);
  });

  it("rolls back every record, event, reference, and Outbox row on revision conflict", async () => {
    const repository = await createRepository();
    await repository.commit(
      requestFor(
        "seed",
        { kind: "task", expected_revision: 0, value: taskValue() },
        "task.created",
      ),
    );
    const taskUpdate: DomainRecordWrite = {
      kind: "task",
      expected_revision: 1,
      value: { ...taskValue(), status: "VALIDATED", updated_at: laterTimestamp },
    };
    const invalidRun: DomainRecordWrite = {
      kind: "agent_run",
      expected_revision: 1,
      value: runValue(),
    };
    const request = requestFor("atomic-task", taskUpdate, "task.status_changed");
    const conflicting = {
      ...request,
      records: [taskUpdate, invalidRun],
      events: [
        ...request.events,
        eventFor("event-atomic-run", request.change_id, invalidRun, "agent_run.status_changed"),
      ],
    };

    await expect(repository.commit(conflicting)).rejects.toMatchObject({
      code: "REPOSITORY_WRITE_CONFLICT",
      details: { reason: "RECORD_REVISION_MISMATCH" },
    });
    expect(await repository.getTask("task-1")).toMatchObject({
      revision: 1,
      value: { status: "DRAFT" },
    });
    expect((await repository.listDomainEvents()).events).toHaveLength(1);
    expect(
      repository.createOutboxDispatcher({ dispatcher_id: "inspect" }).listEntries(),
    ).toHaveLength(1);
  });

  it("preserves mutable revisions and rejects immutable overwrites", async () => {
    const repository = await createRepository();
    await repository.commit(
      requestFor(
        "task-create",
        { kind: "task", expected_revision: 0, value: taskValue() },
        "task.created",
      ),
    );
    await repository.commit(
      requestFor(
        "task-update",
        {
          kind: "task",
          expected_revision: 1,
          value: { ...taskValue(), status: "VALIDATED", updated_at: laterTimestamp },
        },
        "task.status_changed",
      ),
    );
    expect(await repository.getTask("task-1")).toMatchObject({
      revision: 2,
      value: { status: "VALIDATED" },
    });

    const version = taskVersionValue();
    await repository.commit(
      requestFor(
        "version-create",
        { kind: "task_version", expected_revision: 0, value: version },
        "task_version.recorded",
      ),
    );
    await expect(
      repository.commit(
        requestFor(
          "version-update",
          { kind: "task_version", expected_revision: 1, value: version },
          "task_version.recorded",
        ),
      ),
    ).rejects.toMatchObject({
      code: "REPOSITORY_WRITE_CONFLICT",
      details: { reason: "IMMUTABLE_RECORD_EXISTS" },
    });
  });

  it("enforces one ACTIVE binding per run and role transactionally", async () => {
    const repository = await createRepository();
    const first = bindingValue({ status: "ACTIVE" });
    const second = bindingValue({
      binding_id: "binding-2",
      session_id: "session-2",
      external_session_id: "external-2",
      status: "CREATED",
    });
    await repository.commit(
      requestFor(
        "binding-first",
        { kind: "agent_session_binding", expected_revision: 0, value: first },
        "agent_session_binding.recorded",
      ),
    );
    await repository.commit(
      requestFor(
        "binding-second",
        { kind: "agent_session_binding", expected_revision: 0, value: second },
        "agent_session_binding.recorded",
      ),
    );
    await expect(
      repository.commit(
        requestFor(
          "binding-second-active",
          {
            kind: "agent_session_binding",
            expected_revision: 1,
            value: { ...second, status: "ACTIVE" },
          },
          "agent_session_binding.status_changed",
        ),
      ),
    ).rejects.toMatchObject({
      code: "REPOSITORY_WRITE_CONFLICT",
      details: { reason: "SESSION_BINDING_SET_INVALID" },
    });
  });

  it("persists Artifact references as a transactional projection", async () => {
    const repository = await createRepository();
    await repository.commit(
      requestFor(
        "result-artifacts",
        { kind: "task_result", expected_revision: 0, value: taskResultValue() },
        "task_result.recorded",
      ),
    );

    const references = await repository.listArtifactReferences();
    expect(references).toMatchObject([
      { artifact_id: "artifact-log", field_path: "/acceptance_results/0/log_artifact_id" },
      {
        artifact_id: "artifact-report",
        field_path: "/artifacts/0",
      },
    ]);
    expect(references[1]?.content_hash).toMatch(/^sha256:/u);
  });

  it("uses opaque cursor paging and survives process restart with recovery candidates", async () => {
    const { repository, path } = await createRepositoryWithPath();
    await repository.commit(
      requestFor(
        "restart-version",
        { kind: "task_version", expected_revision: 0, value: taskVersionValue() },
        "task_version.recorded",
      ),
    );
    await repository.commit(
      requestFor(
        "run-recovery",
        { kind: "agent_run", expected_revision: 0, value: runValue("run-1", "running") },
        "agent_run.created",
      ),
    );
    await repository.commit(
      requestFor(
        "restart-context",
        { kind: "context_package", expected_revision: 0, value: contextValue() },
        "context_package.recorded",
      ),
    );
    await repository.commit(
      requestFor(
        "restart-binding",
        {
          kind: "agent_session_binding",
          expected_revision: 0,
          value: bindingValue({ status: "ACTIVE" }),
        },
        "agent_session_binding.recorded",
      ),
    );
    await repository.commit(
      requestFor(
        "restart-snapshot",
        {
          kind: "continuation_snapshot",
          expected_revision: 0,
          value: snapshotValue(),
        },
        "continuation_snapshot.recorded",
      ),
    );
    await repository.commit(
      requestFor(
        "restart-handoff",
        { kind: "handoff_package", expected_revision: 0, value: handoffValue() },
        "handoff_package.recorded",
      ),
    );
    await repository.commit(
      requestFor(
        "restart-relation",
        { kind: "task_relation", expected_revision: 0, value: taskRelationValue() },
        "task_relation.recorded",
      ),
    );
    const firstPage = await repository.listDomainEvents({ run_id: "run-1", limit: 1 });
    const remainingPage = await repository.listDomainEvents({
      run_id: "run-1",
      after_cursor: firstPage.next_cursor,
      limit: 100,
    });
    expect(
      new Set([...firstPage.events, ...remainingPage.events].map((event) => event.event_id)).size,
    ).toBe(firstPage.events.length + remainingPage.events.length);
    repository.close();
    repositories.splice(repositories.indexOf(repository), 1);

    const reopened = new SqliteDomainRepository({ database_path: path });
    repositories.push(reopened);
    expect((await reopened.listRecoveryCandidates()).map((record) => record.value.run_id)).toEqual([
      "run-1",
    ]);
    expect(
      (await reopened.listAgentSessionBindings("run-1")).map((record) => record.value.status),
    ).toEqual(["ACTIVE"]);
    expect((await reopened.getLatestContinuationSnapshot("run-1"))?.value.snapshot_id).toBe(
      "snapshot-1",
    );
    expect(
      (await reopened.listHandoffPackages({ task_id: "task-0", task_version: 1 })).map(
        (record) => record.value.handoff_id,
      ),
    ).toEqual(["handoff-1"]);
    expect(
      await reopened.listTaskRelations({
        task_id: "task-1",
        task_version: 1,
        direction: "source",
      }),
    ).toHaveLength(1);
    expect(
      (await reopened.listArtifactReferences({ artifact_id: "artifact-snapshot" }))[0],
    ).toMatchObject({
      source_kind: "continuation_snapshot",
      source_id: "snapshot-1:v1",
    });
    expect(
      (await reopened.listDomainEvents({ after_cursor: remainingPage.next_cursor })).events,
    ).toEqual([]);
  });

  it("returns stable Core errors without exposing invalid payload content", async () => {
    const repository = await createRepository();
    const secret = "provider-secret-value";
    const request = requestFor(
      "invalid-secret",
      { kind: "task", expected_revision: 0, value: taskValue() },
      "task.created",
    );
    try {
      await repository.commit({
        ...request,
        records: [{ ...request.records[0]!, value: { ...taskValue(), secret } }] as never,
      });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreDomainError);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});

async function createRepository(): Promise<SqliteDomainRepository> {
  return (await createRepositoryWithPath()).repository;
}

async function exerciseParity(repository: DomainRepository): Promise<unknown> {
  const createTask = requestFor(
    "parity-task",
    { kind: "task", expected_revision: 0, value: taskValue() },
    "task.created",
  );
  const first = await repository.commit(createTask);
  const replay = await repository.commit(createTask);
  await repository.commit(
    requestFor(
      "parity-task-update",
      {
        kind: "task",
        expected_revision: 1,
        value: { ...taskValue(), status: "VALIDATED", updated_at: laterTimestamp },
      },
      "task.status_changed",
    ),
  );
  await repository.commit(
    requestFor(
      "parity-run-b",
      { kind: "agent_run", expected_revision: 0, value: runValue("run-b", "running") },
      "agent_run.created",
    ),
  );
  await repository.commit(
    requestFor(
      "parity-run-a",
      {
        kind: "agent_run",
        expected_revision: 0,
        value: { ...runValue("run-a", "running"), updated_at: laterTimestamp },
      },
      "agent_run.created",
    ),
  );
  const firstPage = await repository.listDomainEvents({ limit: 2 });
  const remainingPage = await repository.listDomainEvents({
    after_cursor: firstPage.next_cursor,
    limit: 100,
  });
  return {
    first,
    replay,
    task: await repository.getTask("task-1"),
    recovery: (await repository.listRecoveryCandidates()).map((record) => record.value.run_id),
    event_ids: [...firstPage.events, ...remainingPage.events].map((event) => event.event_id),
    final_cursor: remainingPage.next_cursor,
  };
}

async function createRepositoryWithPath(): Promise<{
  repository: SqliteDomainRepository;
  path: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-sqlite-contract-"));
  roots.push(root);
  const path = join(root, "bridge.sqlite");
  const repository = new SqliteDomainRepository({ database_path: path });
  repositories.push(repository);
  return { repository, path };
}
