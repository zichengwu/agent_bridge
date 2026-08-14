import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  startManagementHttpServer,
  type ManagementHttpAuditEvent,
  type ManagementHttpOptions,
  type StartedManagementHttpServer,
} from "../../../src/management-http.js";

const roots: string[] = [];
const servers: StartedManagementHttpServer[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Slice C management HTTP contract", () => {
  it("SEC-001/SEC-004/OPS-002 只监听数值回环随机端口，fragment 不进入请求或安全审计", async () => {
    const fixture = await startFixture();
    const secret = fixture.server.activateLaunchSecret();
    expect(fixture.server.origin).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u);
    expect(fixture.server.port).toBeGreaterThan(0);

    const response = await send(fixture.server, { path: "/" });
    expect(response.status).toBe(200);
    expect(JSON.stringify(fixture.audit)).not.toContain(secret);
    expect(fixture.audit.at(-1)).toMatchObject({ route: "static", status_code: 200 });
  });

  it("SEC-002/SEC-011 Host、代理身份头与 DNS rebinding 在业务服务前 fail closed", async () => {
    const fixture = await startFixture();
    const wrongHost = await send(fixture.server, {
      path: "/internal/v1/dashboard",
      headers: internalHeaders(fixture.server, { host: "localhost:9999" }),
    });
    const forwarded = await send(fixture.server, {
      path: "/internal/v1/dashboard",
      headers: internalHeaders(fixture.server, { "x-forwarded-host": "127.0.0.1" }),
    });

    expect(wrongHost).toMatchObject({ status: 403, json: { error: { code: "HOST_REJECTED" } } });
    expect(forwarded).toMatchObject({ status: 403, json: { error: { code: "HOST_REJECTED" } } });
    expect(fixture.calls.dashboard).toBe(0);
    expect(wrongHost.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("SEC-003/SEC-012 会话交换与跨源/预检请求要求精确 Origin 且永不开放 CORS", async () => {
    const fixture = await startFixture();
    const secret = fixture.server.activateLaunchSecret();
    for (const origin of [undefined, "http://evil.example"] as const) {
      const response = await send(fixture.server, {
        method: "POST",
        path: "/internal/v1/session/exchange",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          ...(origin === undefined ? {} : { origin }),
        },
        body: { schema_version: 1, launch_secret: secret },
      });
      expect(response).toMatchObject({ status: 403, json: { error: { code: "ORIGIN_REJECTED" } } });
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
    const options = await send(fixture.server, {
      method: "OPTIONS",
      path: "/internal/v1/session/exchange",
      headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(options).toMatchObject({ status: 405, json: { error: { code: "METHOD_NOT_ALLOWED" } } });
    expect(options.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("SEC-003/WRITE-010 原生同源 GET preview 可缺 Origin，但错误 Origin 仍在命令前拒绝", async () => {
    const fixture = await startFixture();
    const session = await exchange(fixture);
    const headers = internalHeaders(fixture.server, {
      cookie: session.cookiePair,
      "x-agent-bridge-stream-id": "stream-1",
    });
    const nativeBrowser = await send(fixture.server, {
      path: "/internal/v1/runs/run-1/actions/cancel/preview",
      headers,
    });
    const wrongOrigin = await send(fixture.server, {
      path: "/internal/v1/runs/run-1/actions/cancel/preview",
      headers: { ...headers, origin: "http://evil.example" },
    });
    const crossSiteWithoutOrigin = await send(fixture.server, {
      path: "/internal/v1/runs/run-1/actions/cancel/preview",
      headers: { ...headers, "sec-fetch-site": "cross-site" },
    });

    expect(nativeBrowser).toMatchObject({ status: 200, json: { data: { action: "cancel" } } });
    expect(wrongOrigin).toMatchObject({
      status: 403,
      json: { error: { code: "ORIGIN_REJECTED" } },
    });
    expect(crossSiteWithoutOrigin).toMatchObject({
      status: 403,
      json: { error: { code: "CLIENT_CONTEXT_REJECTED" } },
    });
    expect(fixture.calls.preview).toBe(1);
  });

  it("SEC-005 首次秘密交换设置随机 host-only Cookie 和内存 CSRF", async () => {
    const fixture = await startFixture();
    const session = await exchange(fixture);

    expect(session.cookieName).toBe(fixture.server.cookie_name);
    expect(session.cookie).toContain("HttpOnly");
    expect(session.cookie).toContain("SameSite=Strict");
    expect(session.cookie).toContain("Path=/internal/v1");
    expect(session.cookie).not.toMatch(/(?:^|;)\s*(?:Domain|Secure)=?/iu);
    expect(session.cookieName).not.toMatch(/^__Host-/u);
    expect(session.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("SEC-006 启动秘密单次、60 秒、三次失败撤销且错误不回显秘密", async () => {
    let now = new Date("2026-08-13T00:00:00.000Z");
    const fixture = await startFixture({ now: () => now });
    const secret = fixture.server.activateLaunchSecret();
    const first = await exchangeWithSecret(fixture.server, secret);
    const replay = await exchangeWithSecret(fixture.server, secret);
    expect(first.status).toBe(200);
    expect(replay).toMatchObject({
      status: 401,
      json: { error: { code: "LAUNCH_SECRET_INVALID" } },
    });
    expect(replay.text).not.toContain(secret);

    const second = fixture.server.activateLaunchSecret();
    for (let index = 0; index < 3; index += 1) {
      expect((await exchangeWithSecret(fixture.server, `wrong-${index}`)).status).toBe(401);
    }
    expect((await exchangeWithSecret(fixture.server, second)).status).toBe(401);

    const expiring = fixture.server.activateLaunchSecret();
    now = new Date(now.getTime() + 60_000);
    expect((await exchangeWithSecret(fixture.server, expiring)).status).toBe(401);
  });

  it("SEC-007 缺会话、读取标记、CSRF 或精确 Origin 均不触达业务服务", async () => {
    const fixture = await startFixture();
    const session = await exchange(fixture);
    const missingCookie = await send(fixture.server, {
      path: "/internal/v1/dashboard",
      headers: internalHeaders(fixture.server),
    });
    const missingMarker = await send(fixture.server, {
      path: "/internal/v1/dashboard",
      headers: { cookie: session.cookiePair, "sec-fetch-site": "same-origin" },
    });
    const missingCsrf = await send(fixture.server, {
      method: "POST",
      path: "/internal/v1/approvals/approval-1/decision",
      headers: writeHeaders(fixture.server, session, { "x-agent-bridge-csrf": undefined }),
      body: { schema_version: 1, decision: "approve" },
    });
    expect(missingCookie.json).toMatchObject({ error: { code: "SESSION_REQUIRED" } });
    expect(missingMarker.json).toMatchObject({ error: { code: "CLIENT_CONTEXT_REJECTED" } });
    expect(missingCsrf.json).toMatchObject({ error: { code: "CSRF_REJECTED" } });
    expect(fixture.calls.dashboard).toBe(0);
    expect(fixture.calls.decision).toBe(0);
  });

  it("SEC-008 静态启动基础不包含浏览器持久化或秘密存储机制", async () => {
    const fixture = await startFixture();
    const html = await send(fixture.server, { path: "/" });
    const script = await send(fixture.server, { path: "/assets/app.abcdefgh.js" });
    expect(`${html.text}\n${script.text}`).not.toMatch(/localStorage|sessionStorage|indexedDB/iu);
  });

  it("SEC-009 服务重启后旧实例 Cookie/CSRF 全部失效", async () => {
    const first = await startFixture();
    const session = await exchange(first);
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    const second = await startFixture();
    const response = await send(second.server, {
      path: "/internal/v1/session",
      headers: internalHeaders(second.server, { cookie: session.cookiePair }),
    });
    expect(response).toMatchObject({ status: 401, json: { error: { code: "SESSION_EXPIRED" } } });
  });

  it("SEC-010 DELETE session 幂等重放返回同一安全结果", async () => {
    const fixture = await startFixture();
    const session = await exchange(fixture);
    const request = {
      method: "DELETE",
      path: "/internal/v1/session",
      headers: {
        ...internalHeaders(fixture.server, { cookie: session.cookiePair }),
        origin: fixture.server.origin,
        "x-agent-bridge-csrf": session.csrf,
        "idempotency-key": "logout-1",
      },
    } as const;
    const first = await send(fixture.server, request);
    const replay = await send(fixture.server, request);
    expect(first.status).toBe(200);
    expect(replay.json).toEqual(first.json);
    expect(first.json).toMatchObject({ data: { revoked: true } });
  });

  it("SEC-013 不同 runtime 实例 Cookie 名随机且不会互认", async () => {
    const first = await startFixture();
    const second = await startFixture();
    const session = await exchange(first);
    expect(first.server.cookie_name).not.toBe(second.server.cookie_name);
    const response = await send(second.server, {
      path: "/internal/v1/session",
      headers: internalHeaders(second.server, { cookie: session.cookiePair }),
    });
    expect(response.json).toMatchObject({ error: { code: "SESSION_EXPIRED" } });
  });

  it("OPS-005 固定 manifest 资源返回正确 MIME、nosniff 与缓存策略", async () => {
    const fixture = await startFixture();
    const html = await send(fixture.server, { path: "/" });
    const script = await send(fixture.server, { path: "/assets/app.abcdefgh.js" });
    expect(html.headers).toMatchObject({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    expect(script.headers).toMatchObject({
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  it("OPS-006 穿越、双重编码、dotfile、source map、NUL、目录与 symlink 均不能读取", async () => {
    const fixture = await startFixture({ includeSymlink: true });
    for (const path of [
      "/../outside.txt",
      "/%252e%252e/outside.txt",
      "/.env",
      "/assets/app.abcdefgh.js.map",
      "/assets/%00x",
      "/assets/",
      "/linked.txt",
    ]) {
      const response = await send(fixture.server, { path });
      expect(response.status, path).toBe(404);
      expect(response.text, path).not.toContain("outside-secret");
    }
  });

  it("OPS-007/OPS-012 未知 internal 路由 JSON 404，已知路由错误方法稳定 405", async () => {
    const fixture = await startFixture();
    const unknown = await send(fixture.server, {
      path: "/internal/v1/unknown",
      headers: internalHeaders(fixture.server),
    });
    const wrongMethod = await send(fixture.server, {
      method: "POST",
      path: "/internal/v1/dashboard",
      headers: internalHeaders(fixture.server),
    });
    expect(unknown).toMatchObject({
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
      json: { error: { code: "RESOURCE_NOT_FOUND" } },
    });
    expect(wrongMethod).toMatchObject({
      status: 405,
      json: { error: { code: "METHOD_NOT_ALLOWED" } },
    });
  });

  it("OPS-008 全部响应含严格 CSP、frame/referrer/nosniff 且无 CORS", async () => {
    const fixture = await startFixture();
    const response = await send(fixture.server, { path: "/" });
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["content-security-policy"]).not.toMatch(
      /unsafe-inline|unsafe-eval|https?:/u,
    );
    expect(response.headers).toMatchObject({
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("OPS-009/OPS-010 错误与审计不含秘密、Token、绝对路径或原始 HTML payload", async () => {
    const fixture = await startFixture();
    const secret = fixture.server.activateLaunchSecret();
    const response = await exchangeWithSecret(fixture.server, `${secret}<script>/Users/alice/key`);
    const serialized = JSON.stringify({ response, audit: fixture.audit });
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).not.toContain("<script>");
  });

  it("严格 JSON：16 KiB、媒体类型、未知字段和重复字段稳定拒绝", async () => {
    const fixture = await startFixture();
    const secret = fixture.server.activateLaunchSecret();
    const base = {
      method: "POST",
      path: "/internal/v1/session/exchange",
      headers: {
        origin: fixture.server.origin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
    } as const;
    const tooLarge = await send(fixture.server, {
      ...base,
      bodyText: JSON.stringify({ schema_version: 1, launch_secret: "x".repeat(17_000) }),
    });
    const wrongType = await send(fixture.server, {
      ...base,
      headers: { ...base.headers, "content-type": "text/plain" },
      bodyText: "{}",
    });
    const unknown = await send(fixture.server, {
      ...base,
      body: { schema_version: 1, launch_secret: secret, extra: true },
    });
    const duplicate = await send(fixture.server, {
      ...base,
      bodyText: `{"schema_version":1,"launch_secret":"${secret}","launch_secret":"again"}`,
    });
    expect(tooLarge.json).toMatchObject({ error: { code: "REQUEST_BODY_TOO_LARGE" } });
    expect(wrongType.status).toBe(415);
    expect(unknown.json).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(duplicate.json).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("有效 HTTP 读取只触达 Management Projection；写入只触达共享命令服务", async () => {
    const fixture = await startFixture();
    const session = await exchange(fixture);
    const dashboard = await send(fixture.server, {
      path: "/internal/v1/dashboard?range=today",
      headers: internalHeaders(fixture.server, { cookie: session.cookiePair }),
    });
    const decision = await send(fixture.server, {
      method: "POST",
      path: "/internal/v1/approvals/approval-1/decision",
      headers: writeHeaders(fixture.server, session),
      body: { schema_version: 1, decision: "approve" },
    });
    expect(dashboard.status).toBe(200);
    expect(decision.status).toBe(200);
    expect(fixture.calls.dashboard).toBe(1);
    expect(fixture.calls.decision).toBe(1);
  });

  it("OPS-011 关闭第一阶段立即停止管理写入，且不会触达共享命令服务", async () => {
    const fixture = await startFixture();
    const session = await exchange(fixture);
    fixture.server.stopAcceptingWrites();
    const read = await send(fixture.server, {
      path: "/internal/v1/dashboard",
      headers: internalHeaders(fixture.server, { cookie: session.cookiePair }),
    });
    const write = await send(fixture.server, {
      method: "POST",
      path: "/internal/v1/approvals/approval-1/decision",
      headers: writeHeaders(fixture.server, session),
      body: { schema_version: 1, decision: "approve" },
    });
    expect(read.status).toBe(200);
    expect(write).toMatchObject({
      status: 503,
      json: { error: { code: "RECOVERY_IN_PROGRESS", retryable: true } },
    });
    expect(fixture.calls.decision).toBe(0);
  });

  it("Slice D 前生产默认 stream 门禁 fail closed，不伪造可写连接", async () => {
    const fixture = await startFixture({ allowStream: false });
    const session = await exchange(fixture);
    const decision = await send(fixture.server, {
      method: "POST",
      path: "/internal/v1/approvals/approval-1/decision",
      headers: writeHeaders(fixture.server, session),
      body: { schema_version: 1, decision: "approve" },
    });
    expect(decision).toMatchObject({
      status: 403,
      json: { error: { code: "STREAM_NOT_CURRENT", retryable: true } },
    });
    expect(fixture.calls.decision).toBe(0);
  });
});

async function startFixture(
  options: {
    readonly now?: () => Date;
    readonly includeSymlink?: boolean;
    readonly allowStream?: boolean;
  } = {},
) {
  const root = await mkdtemp(resolve(tmpdir(), "agent-bridge-http-"));
  roots.push(root);
  await writeFile(resolve(root, "index.html"), "<!doctype html><title>Agent Bridge</title>");
  await writeFile(resolve(root, "app.abcdefgh.js"), "globalThis.agentBridgeReady = true;");
  await writeFile(resolve(root, "outside.txt"), "outside-secret");
  if (options.includeSymlink === true)
    await symlink(resolve(root, "outside.txt"), resolve(root, "linked.txt"));
  const calls = { dashboard: 0, decision: 0, preview: 0 };
  const audit: ManagementHttpAuditEvent[] = [];
  const projection = {
    getCurrentCursor: () => Promise.resolve("event-cursor:5"),
    getDashboard: (range: string) => {
      calls.dashboard += 1;
      return Promise.resolve({ event_cursor: "event-cursor:5", data: { range } });
    },
    listTasks: () =>
      Promise.resolve({ event_cursor: "event-cursor:5", data: { items: [], next_cursor: null } }),
    getTaskDetail: (taskId: string) =>
      Promise.resolve({ event_cursor: "event-cursor:5", data: { task_id: taskId } }),
  } as unknown as ManagementHttpOptions["projection"];
  const commands = {
    decideApproval: () => {
      calls.decision += 1;
      return Promise.resolve({ approval_id: "approval-1", status: "approved" });
    },
    previewRunAction: () => {
      calls.preview += 1;
      return Promise.resolve({
        action: "cancel",
        run_id: "run-1",
        target_revision: 1,
        etag: '"run-run-1-r1"',
        effects: [],
        warnings: [],
        confirmation_token: "confirmation-token-value",
        expires_at: "2026-08-13T00:01:00.000Z",
        event_cursor: "event-cursor:5",
      });
    },
    confirmRunAction: () => Promise.resolve({ run_id: "run-1", status: "cancelled" }),
  } as unknown as ManagementHttpOptions["commands"];
  const server = await startManagementHttpServer({
    projection,
    commands,
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
      {
        url_path: "/assets/app.abcdefgh.js",
        file_path: "app.abcdefgh.js",
        media_type: "text/javascript; charset=utf-8",
        cache: "immutable",
      },
      ...(options.includeSymlink === true
        ? [
            {
              url_path: "/linked.txt",
              file_path: "linked.txt",
              media_type: "text/html; charset=utf-8" as const,
              cache: "no-store" as const,
            },
          ]
        : []),
    ],
    ...(options.allowStream === false
      ? {}
      : { stream_gate: { assertCurrent: () => Promise.resolve() } }),
    ...(options.now === undefined ? {} : { now: options.now }),
    audit: (event) => audit.push(event),
  });
  servers.push(server);
  return { server, calls, audit };
}

async function exchange(fixture: Awaited<ReturnType<typeof startFixture>>) {
  const secret = fixture.server.activateLaunchSecret();
  const response = await exchangeWithSecret(fixture.server, secret);
  expect(response.status).toBe(200);
  const cookie = response.headers["set-cookie"];
  if (typeof cookie !== "string") throw new Error("missing cookie");
  const cookiePair = cookie.split(";", 1)[0]!;
  return {
    cookie,
    cookiePair,
    cookieName: cookiePair.split("=", 1)[0]!,
    csrf: (response.json as { data: { csrf_token: string } }).data.csrf_token,
  };
}

function exchangeWithSecret(server: StartedManagementHttpServer, secret: string) {
  return send(server, {
    method: "POST",
    path: "/internal/v1/session/exchange",
    headers: {
      origin: server.origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: { schema_version: 1, launch_secret: secret },
  });
}

function internalHeaders(
  server: StartedManagementHttpServer,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  return compactHeaders({
    host: `127.0.0.1:${server.port}`,
    "sec-fetch-site": "same-origin",
    "x-agent-bridge-client": "dashboard",
    ...overrides,
  });
}

function writeHeaders(
  server: StartedManagementHttpServer,
  session: Awaited<ReturnType<typeof exchange>>,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  return compactHeaders({
    ...internalHeaders(server),
    cookie: session.cookiePair,
    origin: server.origin,
    "content-type": "application/json",
    "x-agent-bridge-csrf": session.csrf,
    "x-agent-bridge-stream-id": "stream-1",
    "x-agent-bridge-event-cursor": "event-cursor:5",
    "idempotency-key": "decision-1",
    "if-match": '"approval-approval-1-r1"',
    ...overrides,
  });
}

function compactHeaders(
  input: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

interface SendOptions {
  readonly method?: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly bodyText?: string;
}

async function send(server: StartedManagementHttpServer, options: SendOptions) {
  const body =
    options.bodyText ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
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
