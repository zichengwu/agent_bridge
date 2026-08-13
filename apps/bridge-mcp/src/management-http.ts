import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { relative, resolve, sep } from "node:path";

import { controlError } from "./errors.js";
import type {
  ManagementCommandPreconditions,
  ManagementCommandService,
  ManagementRunAction,
} from "./management-command-service.js";
import {
  MANAGEMENT_JSON_BODY_LIMIT_BYTES,
  type ManagementProjectionService,
} from "./management-projection.js";

const LOOPBACK_HOST = "127.0.0.1";
const SESSION_COOKIE_PREFIX = "agent_bridge_session_";
const LAUNCH_SECRET_TTL_MS = 60_000;
const MAX_LAUNCH_FAILURES = 3;
const MAX_STATIC_ASSET_BYTES = 8 * 1024 * 1024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_CURSOR_PATTERN = /^event-cursor:(0|[1-9][0-9]*)$/u;

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

export interface ManagementStaticAsset {
  readonly url_path: string;
  readonly file_path: string;
  readonly media_type:
    | "text/html; charset=utf-8"
    | "text/css; charset=utf-8"
    | "text/javascript; charset=utf-8"
    | "image/x-icon";
  readonly cache: "no-store" | "immutable";
}

export interface ManagementStreamGate {
  assertCurrent(input: {
    readonly session_id: string;
    readonly stream_id: string;
    readonly event_cursor?: string;
  }): Promise<void>;
}

export interface ManagementHttpAuditEvent {
  readonly request_id: string;
  readonly route: string;
  readonly status_code: number;
  readonly duration_ms: number;
  readonly server_instance_tag: string;
  readonly error_code?: string;
}

export interface ManagementHttpOptions {
  readonly projection: Pick<
    ManagementProjectionService,
    "getCurrentCursor" | "getDashboard" | "getTaskDetail" | "listTasks"
  >;
  readonly commands: Pick<
    ManagementCommandService,
    "confirmRunAction" | "decideApproval" | "previewRunAction"
  >;
  readonly server_instance_id: string;
  readonly server_started_at: string;
  readonly timezone: string;
  readonly static_root: string;
  readonly static_manifest: readonly ManagementStaticAsset[];
  readonly stream_gate?: ManagementStreamGate;
  readonly now?: () => Date;
  readonly random_bytes?: (size: number) => Buffer;
  readonly audit?: (event: ManagementHttpAuditEvent) => void;
}

export interface StartedManagementHttpServer {
  readonly origin: string;
  readonly port: number;
  readonly cookie_name: string;
  activateLaunchSecret(): string;
  revokeLaunchSecret(): void;
  close(): Promise<void>;
}

interface SessionRecord {
  readonly session_id: string;
  readonly cookie_hash: string;
  readonly csrf_token: string;
}

interface LaunchSecretRecord {
  readonly secret_hash: string;
  readonly expires_at_ms: number;
  failures: number;
}

interface LogoutReplay {
  readonly idempotency_key: string;
  readonly response: SuccessEnvelope<{ readonly revoked: true }>;
}

interface SuccessEnvelope<T> {
  readonly schema_version: 1;
  readonly server_instance_id: string;
  readonly event_cursor: string;
  readonly data: T;
}

interface RequestContext {
  readonly request_id: string;
  route: string;
  error_code?: string;
}

export async function startManagementHttpServer(
  options: ManagementHttpOptions,
): Promise<StartedManagementHttpServer> {
  const controller = new ManagementHttpController(options);
  const server = createServer((request, response) => void controller.handle(request, response));
  server.on("upgrade", (_request, socket) => socket.destroy());
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== LOOPBACK_HOST) {
    await closeServer(server);
    throw controlError("INTERNAL_ERROR");
  }
  const origin = `http://${LOOPBACK_HOST}:${address.port}`;
  controller.setOrigin(origin);
  let closed = false;
  return Object.freeze({
    origin,
    port: address.port,
    cookie_name: controller.cookieName,
    activateLaunchSecret: () => controller.activateLaunchSecret(),
    revokeLaunchSecret: () => controller.revokeLaunchSecret(),
    close: async () => {
      if (closed) return;
      closed = true;
      controller.revokeAll();
      await closeServer(server);
    },
  });
}

class ManagementHttpController {
  readonly cookieName: string;
  private readonly now: () => Date;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly manifest = new Map<string, ManagementStaticAsset>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly logoutReplays = new Map<string, LogoutReplay>();
  private readonly streamGate: ManagementStreamGate;
  private origin: string | undefined;
  private expectedHost: string | undefined;
  private launchSecret: LaunchSecretRecord | undefined;
  private lastEventCursor = "event-cursor:0";

  constructor(private readonly options: ManagementHttpOptions) {
    if (!IDENTIFIER_PATTERN.test(options.server_instance_id)) {
      throw controlError("MANAGEMENT_CONFIGURATION_INVALID");
    }
    this.now = options.now ?? (() => new Date());
    this.randomBytes = options.random_bytes ?? randomBytes;
    this.cookieName = `${SESSION_COOKIE_PREFIX}${this.randomBytes(8).toString("hex")}`;
    this.streamGate =
      options.stream_gate ??
      Object.freeze({
        assertCurrent: () => Promise.reject(controlError("STREAM_NOT_CURRENT")),
      });
    for (const asset of options.static_manifest) {
      validateStaticAsset(asset);
      if (this.manifest.has(asset.url_path)) {
        throw controlError("MANAGEMENT_CONFIGURATION_INVALID");
      }
      this.manifest.set(asset.url_path, Object.freeze({ ...asset }));
    }
  }

  setOrigin(origin: string): void {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" || parsed.hostname !== LOOPBACK_HOST || parsed.port === "") {
      throw controlError("MANAGEMENT_CONFIGURATION_INVALID");
    }
    this.origin = parsed.origin;
    this.expectedHost = parsed.host;
  }

  activateLaunchSecret(): string {
    const secret = this.randomBytes(32).toString("base64url");
    this.launchSecret = {
      secret_hash: hashToken(secret),
      expires_at_ms: this.now().getTime() + LAUNCH_SECRET_TTL_MS,
      failures: 0,
    };
    return secret;
  }

  revokeLaunchSecret(): void {
    this.launchSecret = undefined;
  }

  revokeAll(): void {
    this.revokeLaunchSecret();
    this.sessions.clear();
    this.logoutReplays.clear();
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const context: RequestContext = { request_id: randomUUID(), route: "unmatched" };
    applySecurityHeaders(response);
    try {
      await this.dispatch(request, response, context);
    } catch (error) {
      if (!response.headersSent) {
        const code = publicErrorCode(error);
        context.error_code = code;
        sendJson(response, httpStatus(code), this.errorEnvelope(code, context.request_id));
      } else {
        response.destroy();
      }
    } finally {
      this.options.audit?.({
        request_id: context.request_id,
        route: context.route,
        status_code: response.statusCode,
        duration_ms: Math.max(0, Date.now() - startedAt),
        server_instance_tag: this.options.server_instance_id.slice(0, 8),
        ...(context.error_code === undefined ? {} : { error_code: context.error_code }),
      });
    }
  }

  private async dispatch(
    request: IncomingMessage,
    response: ServerResponse,
    context: RequestContext,
  ): Promise<void> {
    this.assertTransportContext(request);
    const url = this.requestUrl(request);
    const route = classifyRoute(url.pathname);
    context.route = route.template;
    if (route.kind === "static") {
      await this.serveStatic(request, response, url.pathname);
      return;
    }
    if (route.kind === "unknown") throw controlError("RESOURCE_NOT_FOUND");

    assertMethod(request.method, route.methods);
    assertFetchMetadata(request);
    switch (route.name) {
      case "session_exchange":
        assertOrigin(request, this.requireOrigin());
        await this.exchangeSession(request, response);
        return;
      case "session":
        if (request.method === "GET") {
          assertClientMarker(request);
          await this.getSession(request, response);
        } else {
          assertOrigin(request, this.requireOrigin());
          await this.deleteSession(request, response);
        }
        return;
      case "dashboard":
        assertClientMarker(request);
        await this.getDashboard(request, response, url);
        return;
      case "tasks":
        assertClientMarker(request);
        await this.listTasks(request, response, url);
        return;
      case "task_detail":
        assertClientMarker(request);
        await this.getTaskDetail(request, response, decodeIdentifier(route.params[0]!, "task_id"));
        return;
      case "approval_decision":
        assertOrigin(request, this.requireOrigin());
        await this.decideApproval(
          request,
          response,
          decodeIdentifier(route.params[0]!, "approval_id"),
        );
        return;
      case "run_preview":
        assertOrigin(request, this.requireOrigin());
        assertClientMarker(request);
        await this.previewRunAction(
          request,
          response,
          decodeIdentifier(route.params[0]!, "run_id"),
          readAction(route.params[1]!),
        );
        return;
      case "run_action":
        assertOrigin(request, this.requireOrigin());
        await this.confirmRunAction(
          request,
          response,
          decodeIdentifier(route.params[0]!, "run_id"),
          readAction(route.params[1]!),
        );
    }
  }

  private assertTransportContext(request: IncomingMessage): void {
    if (request.headers.host !== this.expectedHost) throw controlError("HOST_REJECTED");
    if (
      header(request, "upgrade") !== undefined ||
      header(request, "forwarded") !== undefined ||
      header(request, "x-forwarded-for") !== undefined ||
      header(request, "x-forwarded-host") !== undefined ||
      header(request, "x-forwarded-proto") !== undefined ||
      header(request, "x-real-ip") !== undefined
    ) {
      throw controlError("HOST_REJECTED");
    }
  }

  private requestUrl(request: IncomingMessage): URL {
    const raw = request.url;
    if (raw === undefined || !raw.startsWith("/") || raw.startsWith("//")) {
      throw controlError("VALIDATION_ERROR");
    }
    return new URL(raw, this.requireOrigin());
  }

  private async exchangeSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonObject(request);
    onlyKeys(body, ["schema_version", "launch_secret"]);
    if (body.schema_version !== 1 || typeof body.launch_secret !== "string") {
      throw controlError("VALIDATION_ERROR");
    }
    this.consumeLaunchSecret(body.launch_secret);
    const eventCursor = await this.currentCursor();
    const cookieToken = this.randomBytes(32).toString("base64url");
    const session: SessionRecord = Object.freeze({
      session_id: `http-session-${randomUUID()}`,
      cookie_hash: hashToken(cookieToken),
      csrf_token: this.randomBytes(32).toString("base64url"),
    });
    this.sessions.set(session.cookie_hash, session);
    response.setHeader("Set-Cookie", sessionCookie(this.cookieName, cookieToken));
    sendJson(
      response,
      200,
      this.successEnvelope(eventCursor, {
        csrf_token: session.csrf_token,
        server_started_at: this.options.server_started_at,
        timezone: this.options.timezone,
      }),
    );
  }

  private async getSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.requireSession(request);
    const eventCursor = await this.currentCursor();
    sendJson(
      response,
      200,
      this.successEnvelope(eventCursor, {
        csrf_token: session.csrf_token,
        server_started_at: this.options.server_started_at,
        timezone: this.options.timezone,
      }),
    );
  }

  private async deleteSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const cookieToken = ownCookieToken(request, this.cookieName);
    const idempotencyKey = requiredHeader(request, "idempotency-key", "IDEMPOTENCY_KEY_REQUIRED");
    const cookieHash = hashToken(cookieToken);
    const replay = this.logoutReplays.get(cookieHash);
    if (replay?.idempotency_key === idempotencyKey) {
      response.setHeader("Set-Cookie", clearSessionCookie(this.cookieName));
      sendJson(response, 200, replay.response);
      return;
    }
    const session = this.requireSessionToken(cookieToken);
    assertCsrf(request, session.csrf_token);
    const eventCursor = await this.currentCursor();
    const envelope = this.successEnvelope(eventCursor, { revoked: true as const });
    this.sessions.delete(cookieHash);
    this.logoutReplays.set(cookieHash, { idempotency_key: idempotencyKey, response: envelope });
    response.setHeader("Set-Cookie", clearSessionCookie(this.cookieName));
    sendJson(response, 200, envelope);
  }

  private async getDashboard(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    this.requireSession(request);
    onlyQueryKeys(url, ["range"]);
    const values = url.searchParams.getAll("range");
    if (values.length > 1) throw controlError("VALIDATION_ERROR");
    const range = values[0] ?? "today";
    if (range !== "session" && range !== "today" && range !== "7d") {
      throw controlError("VALIDATION_ERROR");
    }
    const snapshot = await this.options.projection.getDashboard(range);
    this.lastEventCursor = snapshot.event_cursor;
    sendJson(response, 200, this.successEnvelope(snapshot.event_cursor, snapshot.data));
  }

  private async listTasks(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    this.requireSession(request);
    onlyQueryKeys(url, ["status", "cursor", "limit"]);
    if (
      url.searchParams.getAll("cursor").length > 1 ||
      url.searchParams.getAll("limit").length > 1
    ) {
      throw controlError("VALIDATION_ERROR");
    }
    const rawLimit = url.searchParams.get("limit");
    const query = {
      ...(url.searchParams.getAll("status").length === 0
        ? {}
        : { status: url.searchParams.getAll("status") }),
      ...(url.searchParams.get("cursor") === null
        ? {}
        : { cursor: url.searchParams.get("cursor")! }),
      ...(rawLimit === null ? {} : { limit: strictInteger(rawLimit) }),
    };
    const snapshot = await this.options.projection.listTasks(query);
    this.lastEventCursor = snapshot.event_cursor;
    sendJson(response, 200, this.successEnvelope(snapshot.event_cursor, snapshot.data));
  }

  private async getTaskDetail(
    request: IncomingMessage,
    response: ServerResponse,
    taskId: string,
  ): Promise<void> {
    this.requireSession(request);
    const snapshot = await this.options.projection.getTaskDetail(taskId);
    this.lastEventCursor = snapshot.event_cursor;
    sendJson(response, 200, this.successEnvelope(snapshot.event_cursor, snapshot.data));
  }

  private async decideApproval(
    request: IncomingMessage,
    response: ServerResponse,
    approvalId: string,
  ): Promise<void> {
    const session = this.requireWriteContext(request, true);
    const body = await readJsonObject(request);
    onlyKeys(body, ["schema_version", "decision", "feedback"]);
    if (body.schema_version !== 1 || (body.decision !== "approve" && body.decision !== "reject")) {
      throw controlError("VALIDATION_ERROR");
    }
    const preconditions = readWritePreconditions(
      request,
      session.session_id,
      "approval",
      approvalId,
    );
    await this.assertStream(request, session.session_id, preconditions.event_cursor);
    const result = await this.options.commands.decideApproval({
      approval_id: approvalId,
      decision: body.decision,
      ...(body.feedback === undefined ? {} : { feedback: body.feedback as string }),
      preconditions,
    });
    const cursor = await this.currentCursor();
    sendJson(
      response,
      200,
      this.successEnvelope(cursor, {
        approval_id: result.approval_id,
        status: result.status,
      }),
    );
  }

  private async previewRunAction(
    request: IncomingMessage,
    response: ServerResponse,
    runId: string,
    action: ManagementRunAction,
  ): Promise<void> {
    const session = this.requireWriteContext(request, false);
    await this.assertStream(request, session.session_id);
    const preview = await this.options.commands.previewRunAction({
      session_id: session.session_id,
      action,
      run_id: runId,
    });
    this.lastEventCursor = preview.event_cursor;
    sendJson(response, 200, this.successEnvelope(preview.event_cursor, preview));
  }

  private async confirmRunAction(
    request: IncomingMessage,
    response: ServerResponse,
    runId: string,
    action: ManagementRunAction,
  ): Promise<void> {
    const session = this.requireWriteContext(request, true);
    const body = await readJsonObject(request);
    onlyKeys(body, ["schema_version", "confirmation_token"]);
    if (body.schema_version !== 1 || typeof body.confirmation_token !== "string") {
      throw controlError("VALIDATION_ERROR");
    }
    const preconditions = readWritePreconditions(request, session.session_id, "run", runId);
    await this.assertStream(request, session.session_id, preconditions.event_cursor);
    const result = await this.options.commands.confirmRunAction({
      action,
      run_id: runId,
      confirmation_token: body.confirmation_token,
      preconditions,
    });
    const cursor = await this.currentCursor();
    sendJson(response, 200, this.successEnvelope(cursor, result));
  }

  private requireWriteContext(request: IncomingMessage, requireCsrfHeader: boolean): SessionRecord {
    const session = this.requireSession(request);
    if (requireCsrfHeader) assertCsrf(request, session.csrf_token);
    return session;
  }

  private async assertStream(
    request: IncomingMessage,
    sessionId: string,
    eventCursor?: string,
  ): Promise<void> {
    const streamId = requiredHeader(request, "x-agent-bridge-stream-id", "PRECONDITION_REQUIRED");
    await this.streamGate.assertCurrent({
      session_id: sessionId,
      stream_id: streamId,
      ...(eventCursor === undefined ? {} : { event_cursor: eventCursor }),
    });
  }

  private requireSession(request: IncomingMessage): SessionRecord {
    return this.requireSessionToken(ownCookieToken(request, this.cookieName));
  }

  private requireSessionToken(cookieToken: string): SessionRecord {
    const session = this.sessions.get(hashToken(cookieToken));
    if (session === undefined) throw controlError("SESSION_EXPIRED");
    return session;
  }

  private consumeLaunchSecret(candidate: string): void {
    const record = this.launchSecret;
    if (record === undefined || this.now().getTime() >= record.expires_at_ms) {
      this.revokeLaunchSecret();
      throw controlError("LAUNCH_SECRET_INVALID");
    }
    if (!safeHashEqual(record.secret_hash, hashToken(candidate))) {
      record.failures += 1;
      if (record.failures >= MAX_LAUNCH_FAILURES) this.revokeLaunchSecret();
      throw controlError("LAUNCH_SECRET_INVALID");
    }
    this.revokeLaunchSecret();
  }

  private async currentCursor(): Promise<string> {
    const cursor = await this.options.projection.getCurrentCursor();
    if (!EVENT_CURSOR_PATTERN.test(cursor)) throw controlError("INTERNAL_ERROR");
    this.lastEventCursor = cursor;
    return cursor;
  }

  private async serveStatic(
    request: IncomingMessage,
    response: ServerResponse,
    rawPathname: string,
  ): Promise<void> {
    const pathname = decodeStaticPath(rawPathname);
    const manifestPath = pathname === "/" ? "/index.html" : pathname;
    const asset = this.manifest.get(manifestPath);
    if (asset === undefined) throw controlError("RESOURCE_NOT_FOUND");
    assertMethod(request.method, ["GET"]);
    const root = await realpath(this.options.static_root).catch(() => {
      throw controlError("RESOURCE_NOT_FOUND");
    });
    await assertNoSymlink(root, asset.file_path);
    const candidate = resolve(root, asset.file_path);
    const actual = await realpath(candidate).catch(() => {
      throw controlError("RESOURCE_NOT_FOUND");
    });
    if (!isWithin(actual, root)) throw controlError("RESOURCE_NOT_FOUND");
    const stat = await lstat(actual).catch(() => {
      throw controlError("RESOURCE_NOT_FOUND");
    });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATIC_ASSET_BYTES) {
      throw controlError("RESOURCE_NOT_FOUND");
    }
    const content = await readFile(actual);
    response.statusCode = 200;
    response.setHeader("Content-Type", asset.media_type);
    response.setHeader(
      "Cache-Control",
      asset.cache === "immutable" ? "public, max-age=31536000, immutable" : "no-store",
    );
    response.setHeader("Content-Length", content.byteLength);
    response.end(content);
  }

  private successEnvelope<T>(eventCursor: string, data: T): SuccessEnvelope<T> {
    return Object.freeze({
      schema_version: 1 as const,
      server_instance_id: this.options.server_instance_id,
      event_cursor: eventCursor,
      data,
    });
  }

  private errorEnvelope(code: string, requestId: string) {
    const classification = publicErrorClassification(code);
    return {
      schema_version: 1,
      server_instance_id: this.options.server_instance_id,
      event_cursor: this.lastEventCursor,
      error: {
        code,
        category: classification.category,
        message: classification.message,
        retryable: classification.retryable,
        request_id: requestId,
      },
    };
  }

  private requireOrigin(): string {
    if (this.origin === undefined) throw controlError("INTERNAL_ERROR");
    return this.origin;
  }
}

type Route =
  | { readonly kind: "static"; readonly template: "static" }
  | { readonly kind: "unknown"; readonly template: string }
  | {
      readonly kind: "internal";
      readonly name:
        | "session_exchange"
        | "session"
        | "dashboard"
        | "tasks"
        | "task_detail"
        | "approval_decision"
        | "run_preview"
        | "run_action";
      readonly template: string;
      readonly methods: readonly string[];
      readonly params: readonly string[];
    };

function classifyRoute(pathname: string): Route {
  if (!pathname.startsWith("/internal/")) return { kind: "static", template: "static" };
  const fixed: Readonly<Record<string, Omit<Extract<Route, { kind: "internal" }>, "params">>> = {
    "/internal/v1/session/exchange": {
      kind: "internal",
      name: "session_exchange",
      template: "/internal/v1/session/exchange",
      methods: ["POST"],
    },
    "/internal/v1/session": {
      kind: "internal",
      name: "session",
      template: "/internal/v1/session",
      methods: ["GET", "DELETE"],
    },
    "/internal/v1/dashboard": {
      kind: "internal",
      name: "dashboard",
      template: "/internal/v1/dashboard",
      methods: ["GET"],
    },
    "/internal/v1/tasks": {
      kind: "internal",
      name: "tasks",
      template: "/internal/v1/tasks",
      methods: ["GET"],
    },
  };
  const exact = fixed[pathname];
  if (exact !== undefined) return { ...exact, params: [] };
  let match = /^\/internal\/v1\/tasks\/([^/]+)$/u.exec(pathname);
  if (match?.[1] !== undefined) {
    return {
      kind: "internal",
      name: "task_detail",
      template: "/internal/v1/tasks/{task_id}",
      methods: ["GET"],
      params: [match[1]],
    };
  }
  match = /^\/internal\/v1\/approvals\/([^/]+)\/decision$/u.exec(pathname);
  if (match?.[1] !== undefined) {
    return {
      kind: "internal",
      name: "approval_decision",
      template: "/internal/v1/approvals/{approval_id}/decision",
      methods: ["POST"],
      params: [match[1]],
    };
  }
  match = /^\/internal\/v1\/runs\/([^/]+)\/actions\/(retry|cancel|cleanup)(\/preview)?$/u.exec(
    pathname,
  );
  if (match?.[1] !== undefined && match[2] !== undefined) {
    const preview = match[3] !== undefined;
    return {
      kind: "internal",
      name: preview ? "run_preview" : "run_action",
      template: preview
        ? "/internal/v1/runs/{run_id}/actions/{action}/preview"
        : "/internal/v1/runs/{run_id}/actions/{action}",
      methods: [preview ? "GET" : "POST"],
      params: [match[1], match[2]],
    };
  }
  return { kind: "unknown", template: "/internal/v1/unknown" };
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      server.off("error", onError);
      resolvePromise();
    });
  }).catch(() => {
    throw controlError("INTERNAL_ERROR");
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", CSP);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Length", body.byteLength);
  response.end(body);
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = header(request, "content-type");
  if (
    contentType === undefined ||
    !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentType)
  ) {
    throw controlError("UNSUPPORTED_MEDIA_TYPE");
  }
  const declaredLength = header(request, "content-length");
  if (declaredLength !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/u.test(declaredLength)) throw controlError("VALIDATION_ERROR");
    if (Number(declaredLength) > MANAGEMENT_JSON_BODY_LIMIT_BYTES) {
      throw controlError("REQUEST_BODY_TOO_LARGE");
    }
  }
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    byteLength += buffer.byteLength;
    if (byteLength > MANAGEMENT_JSON_BODY_LIMIT_BYTES) {
      request.resume();
      throw controlError("REQUEST_BODY_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  const source = Buffer.concat(chunks).toString("utf8");
  assertNoDuplicateJsonKeys(source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw controlError("VALIDATION_ERROR");
  }
  if (!isPlainRecord(parsed)) throw controlError("VALIDATION_ERROR");
  return parsed;
}

function assertNoDuplicateJsonKeys(source: string): void {
  let index = 0;
  const whitespace = () => {
    while (/\s/u.test(source[index] ?? "")) index += 1;
  };
  const string = (): string => {
    if (source[index] !== '"') throw new Error();
    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === "\\") {
        index += 2;
        continue;
      }
      if (source[index] === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index)) as string;
      }
      index += 1;
    }
    throw new Error();
  };
  const value = (): void => {
    whitespace();
    if (source[index] === "{") object();
    else if (source[index] === "[") array();
    else if (source[index] === '"') void string();
    else {
      const match =
        /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/u.exec(
          source.slice(index),
        );
      if (match === null) throw new Error();
      index += match[0].length;
    }
    whitespace();
  };
  const object = (): void => {
    index += 1;
    whitespace();
    const keys = new Set<string>();
    if (source[index] === "}") {
      index += 1;
      return;
    }
    for (;;) {
      const key = string();
      if (keys.has(key)) throw new Error();
      keys.add(key);
      whitespace();
      if (source[index] !== ":") throw new Error();
      index += 1;
      value();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      if (source[index] !== ",") throw new Error();
      index += 1;
      whitespace();
    }
  };
  const array = (): void => {
    index += 1;
    whitespace();
    if (source[index] === "]") {
      index += 1;
      return;
    }
    for (;;) {
      value();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      if (source[index] !== ",") throw new Error();
      index += 1;
    }
  };
  try {
    value();
    if (index !== source.length) throw new Error();
  } catch {
    throw controlError("VALIDATION_ERROR");
  }
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  if (Object.keys(value).some((key) => !allow.has(key))) throw controlError("VALIDATION_ERROR");
}

function onlyQueryKeys(url: URL, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!allow.has(key)) throw controlError("VALIDATION_ERROR");
  }
}

function assertMethod(method: string | undefined, allowed: readonly string[]): void {
  if (method === undefined || !allowed.includes(method)) throw controlError("METHOD_NOT_ALLOWED");
}

function assertFetchMetadata(request: IncomingMessage): void {
  if (header(request, "sec-fetch-site") !== "same-origin") {
    throw controlError("CLIENT_CONTEXT_REJECTED");
  }
}

function assertClientMarker(request: IncomingMessage): void {
  if (header(request, "x-agent-bridge-client") !== "dashboard") {
    throw controlError("CLIENT_CONTEXT_REJECTED");
  }
}

function assertOrigin(request: IncomingMessage, expected: string): void {
  if (header(request, "origin") !== expected) throw controlError("ORIGIN_REJECTED");
}

function assertCsrf(request: IncomingMessage, expected: string): void {
  const candidate = header(request, "x-agent-bridge-csrf");
  if (candidate === undefined || !safeTokenEqual(candidate, expected)) {
    throw controlError("CSRF_REJECTED");
  }
}

function readWritePreconditions(
  request: IncomingMessage,
  sessionId: string,
  targetKind: "approval" | "run",
  targetId: string,
): ManagementCommandPreconditions {
  const eventCursor = requiredHeader(
    request,
    "x-agent-bridge-event-cursor",
    "PRECONDITION_REQUIRED",
  );
  if (!EVENT_CURSOR_PATTERN.test(eventCursor)) throw controlError("VALIDATION_ERROR");
  const idempotencyKey = requiredHeader(request, "idempotency-key", "IDEMPOTENCY_KEY_REQUIRED");
  if (!IDENTIFIER_PATTERN.test(idempotencyKey)) throw controlError("VALIDATION_ERROR");
  const etag = requiredHeader(request, "if-match", "PRECONDITION_REQUIRED");
  const expectedPrefix = `"${targetKind}-${targetId}-r`;
  if (!etag.startsWith(expectedPrefix) || !etag.endsWith('"')) throw controlError("ETAG_MISMATCH");
  const revision = Number(etag.slice(expectedPrefix.length, -1));
  if (!Number.isSafeInteger(revision) || revision < 1) throw controlError("ETAG_MISMATCH");
  return Object.freeze({
    session_id: sessionId,
    event_cursor: eventCursor,
    target_revision: revision,
    idempotency_key: idempotencyKey,
  });
}

function ownCookieToken(request: IncomingMessage, cookieName: string): string {
  const raw = header(request, "cookie");
  if (raw === undefined) throw controlError("SESSION_REQUIRED");
  let ownToken: string | undefined;
  let hasAgentBridgeCookie = false;
  for (const pair of raw.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name.startsWith(SESSION_COOKIE_PREFIX)) hasAgentBridgeCookie = true;
    if (name === cookieName) {
      if (ownToken !== undefined) throw controlError("SESSION_EXPIRED");
      ownToken = value;
    }
  }
  if (ownToken === undefined || ownToken.length < 16) {
    throw controlError(hasAgentBridgeCookie ? "SESSION_EXPIRED" : "SESSION_REQUIRED");
  }
  return ownToken;
}

function sessionCookie(name: string, value: string): string {
  return `${name}=${value}; HttpOnly; SameSite=Strict; Path=/internal/v1`;
}

function clearSessionCookie(name: string): string {
  return `${name}=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/internal/v1`;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function requiredHeader(request: IncomingMessage, name: string, code: string): string {
  const value = header(request, name);
  if (value === undefined || value.length < 1 || value.length > 512) throw controlError(code);
  return value;
}

function strictInteger(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw controlError("VALIDATION_ERROR");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw controlError("VALIDATION_ERROR");
  return parsed;
}

function decodeIdentifier(raw: string, field: string): string {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    throw controlError("VALIDATION_ERROR", { field });
  }
  if (value.includes("%") || !IDENTIFIER_PATTERN.test(value)) {
    throw controlError("VALIDATION_ERROR", { field });
  }
  return value;
}

function readAction(value: string): ManagementRunAction {
  if (value !== "retry" && value !== "cancel" && value !== "cleanup") {
    throw controlError("VALIDATION_ERROR");
  }
  return value;
}

function decodeStaticPath(raw: string): string {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    throw controlError("RESOURCE_NOT_FOUND");
  }
  if (
    value.includes("%") ||
    value.includes("\0") ||
    value.includes("\\") ||
    value
      .split("/")
      .some((segment) => segment === "." || segment === ".." || segment.startsWith(".")) ||
    value.endsWith(".map")
  ) {
    throw controlError("RESOURCE_NOT_FOUND");
  }
  return value;
}

function validateStaticAsset(asset: ManagementStaticAsset): void {
  if (
    !asset.url_path.startsWith("/") ||
    asset.url_path.startsWith("/internal/") ||
    asset.url_path.includes("%") ||
    asset.url_path.includes("\\") ||
    asset.file_path.startsWith("/") ||
    asset.file_path.includes("\\") ||
    asset.file_path.split("/").some((segment) => segment === "" || segment.startsWith(".")) ||
    asset.file_path.endsWith(".map") ||
    (asset.cache === "immutable" && !/\.[A-Za-z0-9_-]{8,}\.(?:js|css)$/u.test(asset.file_path)) ||
    (asset.media_type === "text/html; charset=utf-8" && asset.cache !== "no-store")
  ) {
    throw controlError("MANAGEMENT_CONFIGURATION_INVALID");
  }
}

async function assertNoSymlink(root: string, filePath: string): Promise<void> {
  let current = root;
  for (const segment of filePath.split("/")) {
    current = resolve(current, segment);
    const stat = await lstat(current).catch(() => {
      throw controlError("RESOURCE_NOT_FOUND");
    });
    if (stat.isSymbolicLink()) throw controlError("RESOURCE_NOT_FOUND");
  }
}

function isWithin(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return (
    leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function safeTokenEqual(left: string, right: string): boolean {
  return safeHashEqual(hashToken(left), hashToken(right));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function publicErrorCode(error: unknown): string {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "INTERNAL_ERROR";
  if (code === "SENSITIVE_CONTENT_REJECTED") return "VALIDATION_ERROR";
  return HTTP_ERROR_CODES.has(code) ? code : "INTERNAL_ERROR";
}

const HTTP_ERROR_CODES = new Set([
  "VALIDATION_ERROR",
  "REQUEST_BODY_TOO_LARGE",
  "IDEMPOTENCY_KEY_REQUIRED",
  "LAUNCH_SECRET_INVALID",
  "SESSION_REQUIRED",
  "SESSION_EXPIRED",
  "HOST_REJECTED",
  "ORIGIN_REJECTED",
  "CLIENT_CONTEXT_REJECTED",
  "CSRF_REJECTED",
  "STREAM_NOT_CURRENT",
  "RESOURCE_NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "STALE_EVENT_CURSOR",
  "ETAG_MISMATCH",
  "IDEMPOTENCY_KEY_REUSED",
  "CONFIRMATION_EXPIRED",
  "ACTION_NOT_ALLOWED",
  "TASK_VERSION_REQUIRED",
  "BRIDGE_INSTANCE_CONFLICT",
  "UNSUPPORTED_MEDIA_TYPE",
  "PRECONDITION_REQUIRED",
  "SNAPSHOT_BUSY",
  "RECOVERY_IN_PROGRESS",
  "INTERNAL_ERROR",
]);

function httpStatus(code: string): number {
  if (["VALIDATION_ERROR", "REQUEST_BODY_TOO_LARGE", "IDEMPOTENCY_KEY_REQUIRED"].includes(code))
    return 400;
  if (["LAUNCH_SECRET_INVALID", "SESSION_REQUIRED", "SESSION_EXPIRED"].includes(code)) return 401;
  if (
    [
      "HOST_REJECTED",
      "ORIGIN_REJECTED",
      "CLIENT_CONTEXT_REJECTED",
      "CSRF_REJECTED",
      "STREAM_NOT_CURRENT",
    ].includes(code)
  )
    return 403;
  if (code === "RESOURCE_NOT_FOUND") return 404;
  if (code === "METHOD_NOT_ALLOWED") return 405;
  if (
    [
      "STALE_EVENT_CURSOR",
      "ETAG_MISMATCH",
      "IDEMPOTENCY_KEY_REUSED",
      "CONFIRMATION_EXPIRED",
      "ACTION_NOT_ALLOWED",
      "TASK_VERSION_REQUIRED",
      "BRIDGE_INSTANCE_CONFLICT",
    ].includes(code)
  )
    return 409;
  if (code === "UNSUPPORTED_MEDIA_TYPE") return 415;
  if (code === "PRECONDITION_REQUIRED") return 428;
  if (["SNAPSHOT_BUSY", "RECOVERY_IN_PROGRESS"].includes(code)) return 503;
  return 500;
}

function publicErrorClassification(code: string): {
  readonly category: string;
  readonly retryable: boolean;
  readonly message: string;
} {
  if (["LAUNCH_SECRET_INVALID", "SESSION_REQUIRED", "SESSION_EXPIRED"].includes(code)) {
    return {
      category: "authentication",
      retryable: code === "SESSION_EXPIRED",
      message: "本地会话无效，请重新打开管理页。",
    };
  }
  if (
    [
      "HOST_REJECTED",
      "ORIGIN_REJECTED",
      "CLIENT_CONTEXT_REJECTED",
      "CSRF_REJECTED",
      "STREAM_NOT_CURRENT",
    ].includes(code)
  ) {
    return {
      category: "security",
      retryable: code === "STREAM_NOT_CURRENT",
      message: "请求来源或页面状态不安全，已拒绝操作。",
    };
  }
  if (code === "RESOURCE_NOT_FOUND")
    return { category: "not_found", retryable: false, message: "请求的资源不存在。" };
  if (
    [
      "STALE_EVENT_CURSOR",
      "ETAG_MISMATCH",
      "CONFIRMATION_EXPIRED",
      "BRIDGE_INSTANCE_CONFLICT",
    ].includes(code)
  ) {
    return { category: "conflict", retryable: true, message: "页面状态已变化，请刷新后重试。" };
  }
  if (["IDEMPOTENCY_KEY_REUSED", "ACTION_NOT_ALLOWED", "TASK_VERSION_REQUIRED"].includes(code)) {
    return { category: "conflict", retryable: false, message: "当前状态不允许执行该操作。" };
  }
  if (["SNAPSHOT_BUSY", "RECOVERY_IN_PROGRESS"].includes(code)) {
    return {
      category: "availability",
      retryable: true,
      message: "服务正在恢复或更新，请稍后重试。",
    };
  }
  if (code === "INTERNAL_ERROR")
    return { category: "internal", retryable: false, message: "服务内部错误。" };
  return { category: "validation", retryable: false, message: "请求不符合接口合同。" };
}
