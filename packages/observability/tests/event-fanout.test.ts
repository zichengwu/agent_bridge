import {
  AUTHORITATIVE_DOMAIN_EVENT_VERSION,
  InMemoryDomainRepository,
  type DomainRecordWrite,
  type DomainWriteRequest,
} from "@agent-bridge/core";
import { DOMAIN_SCHEMA_VERSION, type Task } from "@agent-bridge/schemas";
import { describe, expect, it } from "vitest";

import { NOOP_TRACER, PersistentEventFanout, SinkStructuredLogger } from "../src/index.js";

const timestamp = "2026-07-31T10:00:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;

describe("persistent event fanout", () => {
  it("delivers the same persisted stream to multiple observers and isolates a failing observer", async () => {
    const repository = new InMemoryDomainRepository();
    await seedTasks(repository, 2);
    const fanout = new PersistentEventFanout(repository, { prefetch_per_poll: 4 });
    const healthy: string[] = [];
    const disconnected: string[] = [];
    fanout.subscribe({
      subscription_id: "healthy",
      observer: {
        onEvent: (delivery) => {
          healthy.push(delivery.event.event_id);
        },
      },
    });
    fanout.subscribe({
      subscription_id: "failing",
      observer: {
        onEvent: () => Promise.reject(new Error("observer failed")),
        onDisconnect: (reason) => {
          disconnected.push(reason);
        },
      },
    });

    await fanout.pollOnce();
    await waitFor(() => healthy.length === 2 && disconnected.length === 1);

    expect(healthy).toEqual(["event-task-1", "event-task-2"]);
    expect(disconnected).toEqual(["OBSERVER_FAILED"]);
  });

  it("disconnects a slow consumer at a bounded queue without blocking other observers", async () => {
    const repository = new InMemoryDomainRepository();
    await seedTasks(repository, 3);
    const fanout = new PersistentEventFanout(repository, {
      queue_capacity: 1,
      prefetch_per_poll: 1,
    });
    const slowDisconnects: string[] = [];
    const healthy: string[] = [];
    fanout.subscribe({
      subscription_id: "slow",
      observer: {
        onEvent: () => new Promise<void>(() => undefined),
        onDisconnect: (reason) => {
          slowDisconnects.push(reason);
        },
      },
    });
    fanout.subscribe({
      subscription_id: "healthy",
      observer: {
        onEvent: (delivery) => {
          healthy.push(delivery.event.event_id);
        },
      },
    });

    await fanout.pollOnce();
    await fanout.pollOnce();
    await fanout.pollOnce();
    await fanout.pollOnce();
    await waitFor(() => slowDisconnects.length === 1 && healthy.length === 3);

    expect(slowDisconnects).toEqual(["SLOW_CONSUMER"]);
    expect(healthy).toEqual(["event-task-1", "event-task-2", "event-task-3"]);
  });

  it("resumes from the last delivered opaque cursor without replaying earlier events", async () => {
    const repository = new InMemoryDomainRepository();
    await seedTasks(repository, 2);
    const fanout = new PersistentEventFanout(repository, { prefetch_per_poll: 1 });
    const first: string[] = [];
    const firstSubscription = fanout.subscribe({
      subscription_id: "first",
      observer: {
        onEvent: (delivery) => {
          first.push(delivery.event.event_id);
        },
      },
    });
    await fanout.pollOnce();
    await waitFor(() => first.length === 1);
    const cursor = firstSubscription.resume_cursor;
    firstSubscription.close();

    const resumed: string[] = [];
    fanout.subscribe({
      subscription_id: "resumed",
      after_cursor: cursor,
      observer: {
        onEvent: (delivery) => {
          resumed.push(delivery.event.event_id);
        },
      },
    });
    await fanout.pollOnce();
    await waitFor(() => resumed.length === 1);
    expect(resumed).toEqual(["event-task-2"]);
  });
});

describe("vendor-neutral observability contracts", () => {
  it("contains sink failures and provides a no-op tracer", () => {
    const logger = new SinkStructuredLogger({
      emit: () => {
        throw new Error("backend unavailable");
      },
    });
    expect(() => logger.log("info", "task_started", { task_id: "task-1" })).not.toThrow();

    const span = NOOP_TRACER.startSpan("task.run", { run_id: "run-1" });
    expect(() => {
      span.setAttribute("status", "running");
      span.recordError("FIXTURE_ERROR");
      span.end();
    }).not.toThrow();
  });
});

async function seedTasks(repository: InMemoryDomainRepository, count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    const taskId = `task-${index}`;
    const write: DomainRecordWrite = {
      kind: "task",
      expected_revision: 0,
      value: taskValue(taskId),
    };
    await repository.commit(requestFor(taskId, write));
  }
}

function taskValue(taskId: string): Task {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: taskId,
    project_id: "project-1",
    status: "DRAFT",
    latest_version: 1,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function requestFor(taskId: string, write: DomainRecordWrite): DomainWriteRequest {
  const changeId = `change-${taskId}`;
  return {
    change_id: changeId,
    idempotency: {
      operation: "fanout_test",
      key: `key-${taskId}`,
      request_hash: hash,
    },
    records: [write],
    events: [
      {
        event_id: `event-${taskId}`,
        event_version: AUTHORITATIVE_DOMAIN_EVENT_VERSION,
        event_type: "task.created",
        aggregate: { kind: "task", id: taskId, revision: 1 },
        occurred_at: timestamp,
        audit: {
          actor: { kind: "bridge", id: "bridge-core" },
          operation: "fanout_test",
          request_id: changeId,
          correlation_id: `correlation-${taskId}`,
          idempotency_key: `key-${taskId}`,
          task_id: taskId,
        },
        payload: {},
      },
    ],
  };
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
