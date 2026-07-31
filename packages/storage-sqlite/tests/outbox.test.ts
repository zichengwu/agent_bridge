import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteDomainRepository, type OutboxPublisher } from "../src/index.js";
import { requestFor, taskValue } from "./fixtures.js";

const roots: string[] = [];
const repositories: SqliteDomainRepository[] = [];

afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    repository.close();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("transactional Outbox", () => {
  it("publishes in sequence and replays a published event with the same event_id", async () => {
    const repository = await createRepository();
    await seedTwoEvents(repository);
    let clock = new Date("2026-07-31T10:00:01.000Z");
    let token = 0;
    const dispatcher = repository.createOutboxDispatcher({
      dispatcher_id: "dispatcher-1",
      now: () => clock,
      token: () => `lease-${++token}`,
    });
    const delivered: string[] = [];

    expect(await dispatcher.dispatchNext(recordingPublisher(delivered))).toMatchObject({
      outcome: "PUBLISHED",
      event_id: "event-outbox-1",
    });
    expect(await dispatcher.dispatchNext(recordingPublisher(delivered))).toMatchObject({
      outcome: "PUBLISHED",
      event_id: "event-outbox-2",
    });
    expect(await dispatcher.dispatchNext(noopPublisher)).toEqual({
      outcome: "IDLE",
      reason: "EMPTY",
    });

    expect(dispatcher.requeuePublished(["event-outbox-1"])).toBe(1);
    clock = new Date("2026-07-31T10:01:00.000Z");
    await dispatcher.dispatchNext(recordingPublisher(delivered));
    expect(delivered).toEqual(["event-outbox-1", "event-outbox-2", "event-outbox-1"]);
    expect((await repository.listDomainEvents()).events.map((event) => event.event_id)).toEqual([
      "event-outbox-1",
      "event-outbox-2",
    ]);
  });

  it("keeps a failed leading event pending and does not overtake it", async () => {
    const repository = await createRepository();
    await seedTwoEvents(repository);
    let clock = new Date("2026-07-31T10:00:01.000Z");
    let token = 0;
    const dispatcher = repository.createOutboxDispatcher({
      dispatcher_id: "dispatcher-failure",
      retry_delay_ms: 1_000,
      now: () => clock,
      token: () => `failure-lease-${++token}`,
    });

    expect(
      await dispatcher.dispatchNext(() => Promise.reject(new Error("observer secret"))),
    ).toMatchObject({
      outcome: "FAILED",
      event_id: "event-outbox-1",
      retry_at: "2026-07-31T10:00:02.000Z",
    });
    expect(await dispatcher.dispatchNext(noopPublisher)).toEqual({
      outcome: "IDLE",
      reason: "WAITING_RETRY",
    });

    clock = new Date("2026-07-31T10:00:02.000Z");
    const delivered: string[] = [];
    await dispatcher.dispatchNext(recordingPublisher(delivered));
    await dispatcher.dispatchNext(recordingPublisher(delivered));
    expect(delivered).toEqual(["event-outbox-1", "event-outbox-2"]);
    expect(dispatcher.listEntries()[0]).toMatchObject({
      status: "published",
      attempt_count: 2,
    });
  });

  it("recovers an expired delivering lease after a dispatcher disappears", async () => {
    const repository = await createRepository();
    await repository.commit(
      requestFor(
        "outbox-lease",
        { kind: "task", expected_revision: 0, value: taskValue() },
        "task.created",
      ),
    );
    let clock = new Date("2026-07-31T10:00:01.000Z");
    const first = repository.createOutboxDispatcher({
      dispatcher_id: "dispatcher-crashed",
      lease_duration_ms: 1_000,
      now: () => clock,
      token: () => "lease-crashed",
    });
    void first.dispatchNext(() => new Promise<void>(() => undefined));
    await waitFor(() => first.listEntries()[0]?.status === "delivering");

    const replacement = repository.createOutboxDispatcher({
      dispatcher_id: "dispatcher-replacement",
      lease_duration_ms: 1_000,
      now: () => clock,
      token: () => "lease-replacement",
    });
    expect(await replacement.dispatchNext(noopPublisher)).toEqual({
      outcome: "IDLE",
      reason: "LEASED",
    });

    clock = new Date("2026-07-31T10:00:02.001Z");
    expect(await replacement.dispatchNext(noopPublisher)).toMatchObject({
      outcome: "PUBLISHED",
      attempt: 2,
    });
  });
});

async function seedTwoEvents(repository: SqliteDomainRepository): Promise<void> {
  await repository.commit(
    requestFor(
      "outbox-1",
      { kind: "task", expected_revision: 0, value: taskValue("task-1") },
      "task.created",
    ),
  );
  await repository.commit(
    requestFor(
      "outbox-2",
      { kind: "task", expected_revision: 0, value: taskValue("task-2") },
      "task.created",
    ),
  );
}

async function createRepository(): Promise<SqliteDomainRepository> {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-outbox-"));
  roots.push(root);
  const repository = new SqliteDomainRepository({
    database_path: join(root, "bridge.sqlite"),
  });
  repositories.push(repository);
  return repository;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not reached");
}

const noopPublisher: OutboxPublisher = () => Promise.resolve();

function recordingPublisher(target: string[]): OutboxPublisher {
  return (delivery) => {
    target.push(delivery.event_id);
    return Promise.resolve();
  };
}
