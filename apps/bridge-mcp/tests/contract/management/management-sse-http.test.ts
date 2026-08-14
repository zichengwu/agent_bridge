import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  AUTHORITATIVE_DOMAIN_EVENT_VERSION,
  InMemoryDomainRepository,
  computeDocumentContentHash,
  type AuthoritativeDomainEvent,
  type DomainRecordWrite,
} from "@agent-bridge/core";
import type {
  EventObserver,
  EventSubscription,
  EventSubscriptionOptions,
  ObserverDisconnectReason,
  ObservedDomainEvent,
} from "@agent-bridge/observability";
import { PersistentEventFanout } from "@agent-bridge/observability";
import { DOMAIN_SCHEMA_VERSION, type Task } from "@agent-bridge/schemas";
import { afterEach, describe, expect, it } from "vitest";

import {
  startManagementHttpServer,
  type ManagementHttpOptions,
  type StartedManagementHttpServer,
} from "../../../src/management-http.js";
import { ManagementSseService } from "../../../src/management-sse.js";
import { BridgeControlService } from "../../../src/bridge-control-service.js";

const roots: string[] = [];
const servers: StartedManagementHttpServer[] = [];
const clients: SseClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Slice D management SSE contract", () => {
  it("SSE-001/SSE-015 sends ready first with frozen headers and no CORS", async () => {
    const fixture = await startFixture();
    const session = await exchange(fixture.server);
    const client = await openSse(
      fixture.server,
      session,
      "/internal/v1/events?after=event-cursor:5",
    );
    await client.waitFor("event: bridge.ready");

    expect(client.status).toBe(200);
    expect(client.headers).toMatchObject({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    expect(client.headers["access-control-allow-origin"]).toBeUndefined();
    expect(client.text).toContain("id: event-cursor:5\nevent: bridge.ready");
    expect(readEventData(client.text, "bridge.ready")).toMatchObject({
      schema_version: 1,
      server_instance_id: "11111111-1111-4111-8111-111111111111",
      head_cursor: "event-cursor:5",
    });
  });

  it("SEC-003/SSE-001 native EventSource GET may omit Origin, but an explicit wrong Origin is rejected", async () => {
    const fixture = await startFixture();
    const session = await exchange(fixture.server);
    const wrongOrigin = await send(fixture.server, {
      path: "/internal/v1/events?after=event-cursor:5",
      headers: sseHeaders(fixture.server, session, { origin: "http://evil.example" }),
    });
    const crossSiteWithoutOrigin = await send(fixture.server, {
      path: "/internal/v1/events?after=event-cursor:5",
      headers: sseHeaders(fixture.server, session, { "sec-fetch-site": "cross-site" }),
    });

    expect(wrongOrigin).toMatchObject({
      status: 403,
      json: { error: { code: "ORIGIN_REJECTED" } },
    });
    expect(crossSiteWithoutOrigin).toMatchObject({
      status: 403,
      json: { error: { code: "CLIENT_CONTEXT_REJECTED" } },
    });
    expect(wrongOrigin.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("SSE-002/SSE-005 Last-Event-ID resumes at the next persistent cursor monotonically", async () => {
    const fixture = await startFixture({ headCursor: "event-cursor:2" });
    const session = await exchange(fixture.server);
    const client = await openSse(fixture.server, session, "/internal/v1/events", {
      "last-event-id": "event-cursor:1",
    });
    await client.waitFor("event: bridge.ready");
    await fixture.fanout.emit(observedEvent("event-cursor:2", "task-1"));
    await fixture.fanout.emit(observedEvent("event-cursor:2", "task-1"));
    await client.waitForOccurrences("event: bridge.invalidate", 2);

    expect(client.text.indexOf("id: event-cursor:1")).toBeLessThan(
      client.text.indexOf("id: event-cursor:2"),
    );
    expect(client.text).toContain("id: event-cursor:2\nevent: bridge.invalidate");
    expect(client.text.match(/id: event-cursor:2\nevent: bridge\.invalidate/gu)).toHaveLength(2);
  });

  it("SSE-003 conflicting query and Last-Event-ID returns stable JSON error", async () => {
    const fixture = await startFixture();
    const session = await exchange(fixture.server);
    const response = await send(fixture.server, {
      path: "/internal/v1/events?after=event-cursor:4",
      headers: sseHeaders(fixture.server, session, { "last-event-id": "event-cursor:3" }),
    });
    expect(response).toMatchObject({
      status: 400,
      json: { error: { code: "CURSOR_CONFLICT", retryable: false } },
    });
  });

  it("SSE-004 unavailable cursor emits reset at the current head and closes", async () => {
    const fixture = await startFixture();
    const session = await exchange(fixture.server);
    const client = await openSse(
      fixture.server,
      session,
      "/internal/v1/events?after=event-cursor:999",
    );
    await client.waitForEnd();
    expect(client.text).toContain("event: bridge.reset");
    expect(readEventData(client.text, "bridge.reset")).toEqual({
      schema_version: 1,
      server_instance_id: "11111111-1111-4111-8111-111111111111",
      reason: "cursor_unavailable",
      head_cursor: "event-cursor:5",
    });
  });

  it("SSE-006/SSE-007 only emits merged invalidation resources, never raw event data", async () => {
    const fixture = await startFixture();
    const session = await exchange(fixture.server);
    const client = await openSse(
      fixture.server,
      session,
      "/internal/v1/events?after=event-cursor:5",
    );
    await client.waitFor("event: bridge.ready");
    fixture.headCursor = "event-cursor:6";
    await fixture.fanout.emit(
      observedEvent("event-cursor:6", "task-1", {
        driver_payload: "raw-driver-secret",
        absolute_path: "/Users/alice/private/key",
        cookie: "session-secret",
      }),
    );
    await client.waitFor("event: bridge.invalidate");

    expect(readEventData(client.text, "bridge.invalidate")).toEqual({
      schema_version: 1,
      server_instance_id: "11111111-1111-4111-8111-111111111111",
      resources: ["dashboard", "task:task-1", "tasks"],
      head_cursor: "event-cursor:6",
    });
    expect(client.text).not.toMatch(
      /raw-driver-secret|\/Users\/alice|session-secret|driver_payload/u,
    );
  });

  it("SSE-008 sends comment heartbeat without creating an event id", async () => {
    const fixture = await startFixture({ heartbeatIntervalMs: 5 });
    const session = await exchange(fixture.server);
    const client = await openSse(
      fixture.server,
      session,
      "/internal/v1/events?after=event-cursor:5",
    );
    await client.waitFor(": heartbeat");
    expect(client.text).toContain(": heartbeat\n\n");
    expect(client.text.match(/event: bridge\./gu)).toHaveLength(1);
  });

  it("SSE-009/SSE-012 disconnect revokes stream and a forged write stays fail closed", async () => {
    const fixture = await startFixture();
    const session = await exchange(fixture.server);
    const client = await openSse(
      fixture.server,
      session,
      "/internal/v1/events?after=event-cursor:5",
    );
    await client.waitFor("event: bridge.ready");
    const streamId = String(readEventData(client.text, "bridge.ready").stream_id);
    await readDashboard(fixture.server, session);
    expect((await decide(fixture.server, session, streamId, "event-cursor:5")).status).toBe(200);

    fixture.fanout.disconnect("SLOW_CONSUMER");
    await client.waitForEnd();
    const rejected = await decide(fixture.server, session, streamId, "event-cursor:5");
    expect(rejected).toMatchObject({
      status: 403,
      json: { error: { code: "STREAM_NOT_CURRENT" } },
    });
    expect(fixture.decisionCalls).toBe(1);
  });

  it("SSE-010 limits each session to two live event streams", async () => {
    const fixture = await startFixture();
    const session = await exchange(fixture.server);
    await openSse(fixture.server, session, "/internal/v1/events");
    await openSse(fixture.server, session, "/internal/v1/events");
    const third = await send(fixture.server, {
      path: "/internal/v1/events",
      headers: sseHeaders(fixture.server, session),
    });
    expect(third).toMatchObject({
      status: 429,
      json: { error: { code: "SSE_CONNECTION_LIMIT", retryable: true } },
    });
  });

  it("SSE-013 server gate remains read-only until ready, catch-up and a fresh snapshot align", async () => {
    const fixture = await startFixture();
    const session = await exchange(fixture.server);
    const client = await openSse(
      fixture.server,
      session,
      "/internal/v1/events?after=event-cursor:5",
    );
    await client.waitFor("event: bridge.ready");
    const streamId = String(readEventData(client.text, "bridge.ready").stream_id);

    expect((await decide(fixture.server, session, streamId, "event-cursor:5")).status).toBe(403);
    await readDashboard(fixture.server, session);
    expect((await decide(fixture.server, session, streamId, "event-cursor:5")).status).toBe(200);

    fixture.headCursor = "event-cursor:6";
    expect((await decide(fixture.server, session, streamId, "event-cursor:6")).status).toBe(403);
    await fixture.fanout.emit(observedEvent("event-cursor:6", "task-1"));
    await client.waitFor('head_cursor":"event-cursor:6');
    expect((await decide(fixture.server, session, streamId, "event-cursor:6")).status).toBe(403);
    await readDashboard(fixture.server, session);
    expect((await decide(fixture.server, session, streamId, "event-cursor:6")).status).toBe(200);
  });

  it("SSE-014 logout/restart boundaries revoke the old stream id", async () => {
    const fixture = await startFixture();
    const session = await exchange(fixture.server);
    const client = await openSse(fixture.server, session, "/internal/v1/events");
    await client.waitFor("event: bridge.ready");
    const streamId = String(readEventData(client.text, "bridge.ready").stream_id);
    await readDashboard(fixture.server, session);
    const logout = await send(fixture.server, {
      method: "DELETE",
      path: "/internal/v1/session",
      headers: {
        ...internalHeaders(fixture.server, { cookie: session.cookiePair }),
        origin: fixture.server.origin,
        "x-agent-bridge-csrf": session.csrf,
        "idempotency-key": "logout-sse-1",
      },
    });
    expect(logout.status).toBe(200);
    await client.waitForEnd();
    expect((await decide(fixture.server, session, streamId, "event-cursor:5")).status).toBe(401);
  });

  it("ARCH-002/ARCH-003/ARCH-005 real Repository/Fanout makes MCP and HTTP writes visible both ways", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-bridge-sse-integration-"));
    roots.push(root);
    await writeFile(resolve(root, "index.html"), "<!doctype html><title>Agent Bridge</title>");
    const repository = new InMemoryDomainRepository();
    await commitTask(repository, taskValue("task-http", "DRAFT"), 0, "mcp-seed");
    const fanout = new PersistentEventFanout(repository, {
      queue_capacity: 8,
      prefetch_per_poll: 8,
    });
    const commands = {
      decideApproval: async () => {
        const stored = await repository.getTask("task-http");
        if (stored === undefined) throw new Error("task missing");
        await commitTask(
          repository,
          { ...stored.value, status: "VALIDATED", updated_at: "2026-08-13T00:01:00.000Z" },
          stored.revision,
          "http-decision",
        );
        return { approval_id: "approval-1", status: "approved" };
      },
      previewRunAction: () => Promise.reject(new Error("not used")),
      confirmRunAction: () => Promise.reject(new Error("not used")),
    } as unknown as ManagementHttpOptions["commands"];
    const mcp = new BridgeControlService({
      repository,
      contexts: {} as never,
      active_runs: {} as never,
      runtime: {} as never,
      project_id: "project-1",
      repository_path: "/test/repository",
      max_review_cycles: 3,
      timeout_seconds: 60,
      max_agent_count: 1,
      management_commands: commands as never,
    });
    const projection = {
      getCurrentCursor: () => repository.getEventCursor(),
      getDashboard: async (range: string) => ({
        event_cursor: await repository.getEventCursor(),
        data: { range },
      }),
      listTasks: async () => ({
        event_cursor: await repository.getEventCursor(),
        data: { items: [], next_cursor: null },
      }),
      getTaskDetail: async (taskId: string) => ({
        event_cursor: await repository.getEventCursor(),
        data: { task_id: taskId },
      }),
    } as unknown as ManagementHttpOptions["projection"];
    const eventStream = new ManagementSseService({
      fanout,
      get_current_cursor: () => repository.getEventCursor(),
      server_instance_id: "11111111-1111-4111-8111-111111111111",
      catch_up_interval_ms: 5,
    });
    const server = await startManagementHttpServer({
      projection,
      commands,
      event_stream: eventStream,
      server_instance_id: "11111111-1111-4111-8111-111111111111",
      server_started_at: "2026-08-13T00:00:00.000Z",
      timezone: "Asia/Shanghai",
      static_root: root,
      static_manifest: [
        {
          url_path: "/index.html",
          file_path: "index.html",
          media_type: "text/html; charset=utf-8",
          cache: "no-store",
        },
      ],
    });
    servers.push(server);
    const session = await exchange(server);
    const startingCursor = await repository.getEventCursor();
    const client = await openSse(server, session, `/internal/v1/events?after=${startingCursor}`);
    await client.waitFor("event: bridge.ready");
    const streamId = String(readEventData(client.text, "bridge.ready").stream_id);
    await readDashboard(server, session);

    const httpWrite = await decide(server, session, streamId, startingCursor);
    expect(httpWrite.status).toBe(200);
    await fanout.pollOnce();
    await client.waitFor("task:task-http");
    const mcpRead = (await mcp.getTask({ task_id: "task-http" })) as {
      task: { status: string };
    };
    expect(mcpRead.task.status).toBe("VALIDATED");

    await mcp.createTask({
      contract: taskContract("task-mcp"),
      idempotency_key: "mcp-create-task",
    });
    await fanout.pollOnce();
    await client.waitFor("task:task-mcp");
    expect(client.text).not.toContain("Verify MCP visibility");
    expect(await repository.getTask("task-mcp")).toBeDefined();

    const cursorBeforeFailure = await repository.getEventCursor();
    await expect(
      repository.commit({
        change_id: "change-atomic-failure",
        idempotency: {
          operation: "atomic-failure",
          key: "atomic-failure",
          request_hash: `sha256:${"b".repeat(64)}`,
        },
        records: [
          {
            kind: "task",
            expected_revision: 999,
            value: taskValue("task-http", "FAILED"),
          },
        ],
        events: [
          {
            event_id: "event-atomic-failure",
            event_version: AUTHORITATIVE_DOMAIN_EVENT_VERSION,
            event_type: "task.updated",
            aggregate: { kind: "task", id: "task-http", revision: 1000 },
            occurred_at: "2026-08-13T00:03:00.000Z",
            audit: {
              actor: { kind: "bridge", id: "bridge-core" },
              operation: "atomic-failure",
              request_id: "change-atomic-failure",
              correlation_id: "correlation-atomic-failure",
              idempotency_key: "atomic-failure",
              task_id: "task-http",
            },
            payload: {},
          },
        ],
      }),
    ).rejects.toBeDefined();
    expect(await repository.getEventCursor()).toBe(cursorBeforeFailure);
    expect(client.text).not.toContain("event-atomic-failure");
  });
});

class FakeFanout {
  private observer?: EventObserver;
  private subscription?: MutableSubscription;

  subscribe(options: EventSubscriptionOptions): EventSubscription {
    this.observer = options.observer;
    this.subscription = new MutableSubscription(options.subscription_id, options.after_cursor);
    return this.subscription;
  }

  pollOnce(): Promise<void> {
    return Promise.resolve();
  }

  async emit(delivery: ObservedDomainEvent): Promise<void> {
    await this.observer?.onEvent(delivery);
    this.subscription?.setCursor(delivery.cursor);
  }

  disconnect(reason: ObserverDisconnectReason): void {
    this.subscription?.close();
    void this.observer?.onDisconnect?.(
      reason,
      this.subscription?.resume_cursor ?? "event-cursor:0",
    );
  }
}

class MutableSubscription implements EventSubscription {
  private isClosed = false;
  private cursor: string;

  constructor(
    readonly subscription_id: string,
    afterCursor: string | undefined,
  ) {
    this.cursor = afterCursor ?? "event-cursor:0";
  }

  get closed(): boolean {
    return this.isClosed;
  }

  get resume_cursor(): string {
    return this.cursor;
  }

  setCursor(cursor: string): void {
    this.cursor = cursor;
  }

  close(): void {
    this.isClosed = true;
  }
}

async function startFixture(
  options: { readonly headCursor?: string; readonly heartbeatIntervalMs?: number } = {},
) {
  const root = await mkdtemp(resolve(tmpdir(), "agent-bridge-sse-http-"));
  roots.push(root);
  await writeFile(resolve(root, "index.html"), "<!doctype html><title>Agent Bridge</title>");
  const fanout = new FakeFanout();
  const fixture = {
    headCursor: options.headCursor ?? "event-cursor:5",
    decisionCalls: 0,
    fanout,
    server: undefined as unknown as StartedManagementHttpServer,
  };
  const projection = {
    getCurrentCursor: () => Promise.resolve(fixture.headCursor),
    getDashboard: (range: string) =>
      Promise.resolve({ event_cursor: fixture.headCursor, data: { range } }),
    listTasks: () =>
      Promise.resolve({
        event_cursor: fixture.headCursor,
        data: { items: [], next_cursor: null },
      }),
    getTaskDetail: (taskId: string) =>
      Promise.resolve({ event_cursor: fixture.headCursor, data: { task_id: taskId } }),
  } as unknown as ManagementHttpOptions["projection"];
  const commands = {
    decideApproval: () => {
      fixture.decisionCalls += 1;
      return Promise.resolve({ approval_id: "approval-1", status: "approved" });
    },
    previewRunAction: () => Promise.reject(new Error("not used")),
    confirmRunAction: () => Promise.reject(new Error("not used")),
  } as unknown as ManagementHttpOptions["commands"];
  const eventStream = new ManagementSseService({
    fanout,
    get_current_cursor: () => Promise.resolve(fixture.headCursor),
    server_instance_id: "11111111-1111-4111-8111-111111111111",
    heartbeat_interval_ms: options.heartbeatIntervalMs ?? 15_000,
    catch_up_interval_ms: 5,
  });
  fixture.server = await startManagementHttpServer({
    projection,
    commands,
    event_stream: eventStream,
    server_instance_id: "11111111-1111-4111-8111-111111111111",
    server_started_at: "2026-08-13T00:00:00.000Z",
    timezone: "Asia/Shanghai",
    static_root: root,
    static_manifest: [
      {
        url_path: "/index.html",
        file_path: "index.html",
        media_type: "text/html; charset=utf-8",
        cache: "no-store",
      },
    ],
  });
  servers.push(fixture.server);
  return fixture;
}

function observedEvent(
  cursor: string,
  taskId: string,
  payload: Readonly<Record<string, unknown>> = {},
): ObservedDomainEvent {
  return {
    cursor,
    event: {
      event_id: `event-${cursor}`,
      event_version: 1,
      event_type: "task.updated",
      aggregate: { kind: "task", id: taskId, revision: Number(cursor.split(":")[1]) },
      occurred_at: "2026-08-13T00:00:00.000Z",
      audit: {
        actor: { kind: "bridge", id: "bridge-core" },
        operation: "test",
        request_id: `request-${cursor}`,
        correlation_id: `correlation-${cursor}`,
        idempotency_key: `key-${cursor}`,
        task_id: taskId,
      },
      payload,
    } as unknown as AuthoritativeDomainEvent,
  };
}

async function commitTask(
  repository: InMemoryDomainRepository,
  task: Task,
  expectedRevision: number,
  key: string,
): Promise<void> {
  const write: DomainRecordWrite = {
    kind: "task",
    expected_revision: expectedRevision,
    value: task,
  };
  await repository.commit({
    change_id: `change-${key}`,
    idempotency: {
      operation: key,
      key,
      request_hash: `sha256:${"a".repeat(64)}`,
    },
    records: [write],
    events: [
      {
        event_id: `event-${key}`,
        event_version: AUTHORITATIVE_DOMAIN_EVENT_VERSION,
        event_type: expectedRevision === 0 ? "task.created" : "task.updated",
        aggregate: { kind: "task", id: task.task_id, revision: expectedRevision + 1 },
        occurred_at: task.updated_at,
        audit: {
          actor: { kind: "bridge", id: "bridge-core" },
          operation: key,
          request_id: `change-${key}`,
          correlation_id: `correlation-${key}`,
          idempotency_key: key,
          task_id: task.task_id,
        },
        payload: {},
      },
    ],
  });
}

function taskValue(taskId: string, status: Task["status"]): Task {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: taskId,
    project_id: "project-1",
    status,
    latest_version: 1,
    created_at: "2026-08-13T00:00:00.000Z",
    updated_at: "2026-08-13T00:00:00.000Z",
  };
}

function taskContract(taskId: string) {
  const base = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: taskId,
    task_version: 1,
    project_id: "project-1",
    base_commit: "abcdef1",
    policy_version: "1.0",
    objective: "Verify MCP visibility",
    role: "developer",
    business_rules: [],
    scope: { read: ["src/**"], write: ["src/**"], deny: [".git/**"] },
    acceptance_commands: ["pnpm test"],
    git: { branch: `codex/${taskId}` },
    context_policy: {
      project_baseline_version: 1,
      rollover_ratio: 0.7,
      inherit_full_transcript: false,
    },
    limits: { timeout_seconds: 60, max_review_cycles: 3, max_agent_count: 1 },
    required_output: ["test_results"],
    created_at: "2026-08-13T00:02:00.000Z",
  } as const;
  return { ...base, content_hash: computeDocumentContentHash(base) };
}

interface Session {
  readonly cookiePair: string;
  readonly csrf: string;
}

async function exchange(server: StartedManagementHttpServer): Promise<Session> {
  const secret = server.activateLaunchSecret();
  const response = await send(server, {
    method: "POST",
    path: "/internal/v1/session/exchange",
    headers: {
      origin: server.origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: { schema_version: 1, launch_secret: secret },
  });
  const cookie = response.headers["set-cookie"];
  if (response.status !== 200 || typeof cookie !== "string") throw new Error("session failed");
  return {
    cookiePair: cookie.split(";", 1)[0]!,
    csrf: (response.json as { data: { csrf_token: string } }).data.csrf_token,
  };
}

function readDashboard(server: StartedManagementHttpServer, session: Session) {
  return send(server, {
    path: "/internal/v1/dashboard",
    headers: internalHeaders(server, { cookie: session.cookiePair }),
  });
}

function decide(
  server: StartedManagementHttpServer,
  session: Session,
  streamId: string,
  cursor: string,
) {
  return send(server, {
    method: "POST",
    path: "/internal/v1/approvals/approval-1/decision",
    headers: {
      ...internalHeaders(server, { cookie: session.cookiePair }),
      origin: server.origin,
      "content-type": "application/json",
      "x-agent-bridge-csrf": session.csrf,
      "x-agent-bridge-stream-id": streamId,
      "x-agent-bridge-event-cursor": cursor,
      "idempotency-key": `decision-${cursor.replace(":", "-")}`,
      "if-match": '"approval-approval-1-r1"',
    },
    body: { schema_version: 1, decision: "approve" },
  });
}

function internalHeaders(
  server: StartedManagementHttpServer,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    host: `127.0.0.1:${server.port}`,
    "sec-fetch-site": "same-origin",
    "x-agent-bridge-client": "dashboard",
    ...overrides,
  };
}

function sseHeaders(
  server: StartedManagementHttpServer,
  session: Session,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    host: `127.0.0.1:${server.port}`,
    cookie: session.cookiePair,
    "sec-fetch-site": "same-origin",
    accept: "text/event-stream",
    ...overrides,
  };
}

interface SendOptions {
  readonly method?: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

async function send(server: StartedManagementHttpServer, options: SendOptions) {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    text: string;
    json: unknown;
  }>((resolvePromise, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        method: options.method ?? "GET",
        path: options.path,
        headers: {
          host: `127.0.0.1:${server.port}`,
          ...options.headers,
          ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = JSON.parse(text) as unknown;
          } catch {
            json = undefined;
          }
          const headers = { ...response.headers } as Record<string, string | string[] | undefined>;
          if (Array.isArray(headers["set-cookie"]))
            headers["set-cookie"] = headers["set-cookie"][0];
          resolvePromise({ status: response.statusCode ?? 0, headers, text, json });
        });
      },
    );
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

class SseClient {
  text = "";
  private ended = false;
  private readonly waiters = new Set<() => void>();

  constructor(
    readonly request: ClientRequest,
    readonly response: IncomingMessage,
  ) {
    response.on("data", (chunk: Buffer) => {
      this.text += chunk.toString("utf8");
      this.notify();
    });
    response.on("end", () => {
      this.ended = true;
      this.notify();
    });
    response.on("close", () => {
      this.ended = true;
      this.notify();
    });
  }

  get status(): number {
    return this.response.statusCode ?? 0;
  }

  get headers(): IncomingMessage["headers"] {
    return this.response.headers;
  }

  waitFor(fragment: string): Promise<void> {
    return this.waitUntil(() => this.text.includes(fragment));
  }

  waitForOccurrences(fragment: string, count: number): Promise<void> {
    return this.waitUntil(() => this.text.split(fragment).length - 1 >= count);
  }

  waitForEnd(): Promise<void> {
    return this.waitUntil(() => this.ended);
  }

  close(): void {
    this.request.destroy();
    this.response.destroy();
  }

  private async waitUntil(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      await new Promise<void>((resolvePromise) => {
        const waiter = () => resolvePromise();
        this.waiters.add(waiter);
        setTimeout(() => {
          this.waiters.delete(waiter);
          resolvePromise();
        }, 5).unref?.();
      });
    }
    throw new Error("SSE condition not reached");
  }

  private notify(): void {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }
}

function openSse(
  server: StartedManagementHttpServer,
  session: Session,
  path: string,
  overrides: Readonly<Record<string, string>> = {},
): Promise<SseClient> {
  return new Promise<SseClient>((resolvePromise, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        headers: sseHeaders(server, session, overrides),
      },
      (response) => {
        const client = new SseClient(request, response);
        clients.push(client);
        resolvePromise(client);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function readEventData(text: string, event: string): Record<string, unknown> {
  const pattern = new RegExp(`event: ${event.replace(".", "\\.")}\\ndata: ([^\\n]+)`, "u");
  const source = pattern.exec(text)?.[1];
  if (source === undefined) throw new Error(`missing ${event}`);
  return JSON.parse(source) as Record<string, unknown>;
}
