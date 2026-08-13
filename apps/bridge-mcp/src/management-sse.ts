import { randomBytes, randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

import type { AuthoritativeDomainEvent } from "@agent-bridge/core";
import type {
  EventSubscription,
  ObservedDomainEvent,
  PersistentEventFanout,
} from "@agent-bridge/observability";

import { controlError } from "./errors.js";

const EVENT_CURSOR_PATTERN = /^event-cursor:(0|[1-9][0-9]*)$/u;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_CATCH_UP_INTERVAL_MS = 50;
const MAX_CONNECTIONS_PER_SESSION = 2;

export interface ManagementStreamGate {
  assertCurrent(input: {
    readonly session_id: string;
    readonly stream_id: string;
    readonly event_cursor?: string;
  }): Promise<void>;
  noteSnapshot?(sessionId: string, eventCursor: string): Promise<void>;
  revokeSession?(sessionId: string): void;
  stop?(): void;
}

export interface ManagementEventStream extends ManagementStreamGate {
  open(input: {
    readonly session_id: string;
    readonly after_cursor?: string;
    readonly response: ServerResponse;
  }): Promise<void>;
}

export interface ManagementSseServiceOptions {
  readonly fanout: Pick<PersistentEventFanout, "subscribe" | "pollOnce">;
  readonly get_current_cursor: () => Promise<string>;
  readonly server_instance_id: string;
  readonly heartbeat_interval_ms?: number;
  readonly catch_up_interval_ms?: number;
  readonly random_bytes?: (size: number) => Buffer;
}

interface StreamState {
  readonly stream_id: string;
  readonly session_id: string;
  readonly response: ServerResponse;
  subscription?: EventSubscription;
  heartbeat?: ReturnType<typeof setInterval>;
  last_delivered_cursor: string;
  snapshot_cursor?: string;
  heartbeat_pending: boolean;
  closed: boolean;
}

/**
 * Adapts persisted authoritative events to the deliberately tiny browser SSE contract.
 * Raw events never cross this boundary.
 */
export class ManagementSseService implements ManagementEventStream {
  private readonly streams = new Map<string, StreamState>();
  private readonly streamIdsBySession = new Map<string, Set<string>>();
  private readonly heartbeatIntervalMs: number;
  private readonly catchUpIntervalMs: number;
  private readonly randomBytes: (size: number) => Buffer;
  private catchUpTimer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(private readonly options: ManagementSseServiceOptions) {
    this.heartbeatIntervalMs = boundedInterval(
      options.heartbeat_interval_ms,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    this.catchUpIntervalMs = boundedInterval(
      options.catch_up_interval_ms,
      DEFAULT_CATCH_UP_INTERVAL_MS,
    );
    this.randomBytes = options.random_bytes ?? randomBytes;
  }

  async open(input: {
    readonly session_id: string;
    readonly after_cursor?: string;
    readonly response: ServerResponse;
  }): Promise<void> {
    if (this.stopped) throw controlError("STREAM_NOT_CURRENT");
    if ((this.streamIdsBySession.get(input.session_id)?.size ?? 0) >= MAX_CONNECTIONS_PER_SESSION) {
      throw controlError("SSE_CONNECTION_LIMIT");
    }

    const headCursor = await this.currentCursor();
    const afterCursor = input.after_cursor ?? headCursor;
    if (!isAvailableCursor(afterCursor, headCursor)) {
      beginSse(input.response);
      await writeSse(
        input.response,
        sseEvent(headCursor, "bridge.reset", {
          schema_version: 1,
          server_instance_id: this.options.server_instance_id,
          reason: "cursor_unavailable",
          head_cursor: headCursor,
        }),
      ).catch(() => undefined);
      input.response.end();
      return;
    }

    const streamId = this.randomBytes(32).toString("base64url");
    const state: StreamState = {
      stream_id: streamId,
      session_id: input.session_id,
      response: input.response,
      last_delivered_cursor: afterCursor,
      heartbeat_pending: false,
      closed: false,
    };
    this.add(state);
    input.response.once("close", () => this.disconnect(state));
    input.response.once("error", () => this.disconnect(state));
    beginSse(input.response);

    try {
      // The ready id is the resume point. head_cursor declares how far the stream must catch up.
      await writeSse(
        input.response,
        sseEvent(afterCursor, "bridge.ready", {
          schema_version: 1,
          server_instance_id: this.options.server_instance_id,
          stream_id: streamId,
          head_cursor: headCursor,
        }),
      );
      if (state.closed) return;
      state.subscription = this.options.fanout.subscribe({
        subscription_id: `management-sse-${randomUUID()}`,
        after_cursor: afterCursor,
        observer: {
          onEvent: (delivery) => this.deliver(state, delivery),
          onDisconnect: (reason) => this.disconnect(state, reason === "SLOW_CONSUMER"),
        },
      });
      state.heartbeat = setInterval(() => this.heartbeat(state), this.heartbeatIntervalMs);
      state.heartbeat.unref?.();
      this.ensureCatchUpPump();
      await this.options.fanout.pollOnce();
    } catch {
      this.disconnect(state);
    }
  }

  async assertCurrent(input: {
    readonly session_id: string;
    readonly stream_id: string;
    readonly event_cursor?: string;
  }): Promise<void> {
    const state = this.streams.get(input.stream_id);
    if (state === undefined || state.closed || state.session_id !== input.session_id) {
      throw controlError("STREAM_NOT_CURRENT");
    }
    const headCursor = await this.currentCursor();
    if (
      state.last_delivered_cursor !== headCursor ||
      state.snapshot_cursor !== headCursor ||
      (input.event_cursor !== undefined && !EVENT_CURSOR_PATTERN.test(input.event_cursor))
    ) {
      throw controlError("STREAM_NOT_CURRENT");
    }
  }

  async noteSnapshot(sessionId: string, eventCursor: string): Promise<void> {
    if (!EVENT_CURSOR_PATTERN.test(eventCursor)) return;
    const headCursor = await this.currentCursor();
    if (eventCursor !== headCursor) return;
    for (const streamId of this.streamIdsBySession.get(sessionId) ?? []) {
      const state = this.streams.get(streamId);
      if (state !== undefined && !state.closed && state.last_delivered_cursor === headCursor) {
        state.snapshot_cursor = headCursor;
      }
    }
  }

  revokeSession(sessionId: string): void {
    for (const streamId of [...(this.streamIdsBySession.get(sessionId) ?? [])]) {
      const state = this.streams.get(streamId);
      if (state !== undefined) this.disconnect(state);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.catchUpTimer !== undefined) clearInterval(this.catchUpTimer);
    this.catchUpTimer = undefined;
    for (const state of [...this.streams.values()]) this.disconnect(state);
  }

  private async deliver(state: StreamState, delivery: ObservedDomainEvent): Promise<void> {
    if (state.closed) throw new Error("stream closed");
    if (compareCursor(delivery.cursor, state.last_delivered_cursor) < 0) {
      throw new Error("event cursor regressed");
    }
    state.snapshot_cursor = undefined;
    await writeSse(
      state.response,
      sseEvent(delivery.cursor, "bridge.invalidate", {
        schema_version: 1,
        server_instance_id: this.options.server_instance_id,
        resources: invalidatedResources(delivery.event),
        head_cursor: delivery.cursor,
      }),
    );
    state.last_delivered_cursor = delivery.cursor;
  }

  private heartbeat(state: StreamState): void {
    if (state.closed || state.heartbeat_pending) return;
    state.heartbeat_pending = true;
    void writeSse(state.response, ": heartbeat\n\n")
      .catch(() => this.disconnect(state))
      .finally(() => {
        state.heartbeat_pending = false;
      });
  }

  private add(state: StreamState): void {
    this.streams.set(state.stream_id, state);
    const sessionStreams = this.streamIdsBySession.get(state.session_id) ?? new Set<string>();
    sessionStreams.add(state.stream_id);
    this.streamIdsBySession.set(state.session_id, sessionStreams);
  }

  private disconnect(state: StreamState, force = false): void {
    if (state.closed) return;
    state.closed = true;
    state.snapshot_cursor = undefined;
    if (state.heartbeat !== undefined) clearInterval(state.heartbeat);
    state.subscription?.close();
    this.streams.delete(state.stream_id);
    const sessionStreams = this.streamIdsBySession.get(state.session_id);
    sessionStreams?.delete(state.stream_id);
    if (sessionStreams?.size === 0) this.streamIdsBySession.delete(state.session_id);
    if (force && !state.response.destroyed) state.response.destroy();
    else if (!state.response.writableEnded && !state.response.destroyed) state.response.end();
    if (this.streams.size === 0 && this.catchUpTimer !== undefined) {
      clearInterval(this.catchUpTimer);
      this.catchUpTimer = undefined;
    }
  }

  private ensureCatchUpPump(): void {
    if (this.catchUpTimer !== undefined) return;
    this.catchUpTimer = setInterval(() => {
      void this.options.fanout.pollOnce().catch(() => undefined);
    }, this.catchUpIntervalMs);
    this.catchUpTimer.unref?.();
  }

  private async currentCursor(): Promise<string> {
    const cursor = await this.options.get_current_cursor();
    if (!EVENT_CURSOR_PATTERN.test(cursor)) throw controlError("INTERNAL_ERROR");
    return cursor;
  }
}

export function invalidatedResources(event: AuthoritativeDomainEvent): readonly string[] {
  const resources = new Set<string>(["dashboard", "tasks"]);
  const taskId =
    event.audit.task_id ?? (event.aggregate.kind === "task" ? event.aggregate.id : null);
  if (taskId !== null) resources.add(`task:${taskId}`);
  return Object.freeze([...resources].sort());
}

function beginSse(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Accel-Buffering", "no");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
}

function sseEvent(id: string, event: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function writeSse(response: ServerResponse, chunk: string): Promise<void> {
  if (response.destroyed || response.writableEnded) return Promise.reject(new Error("closed"));
  if (response.write(chunk)) return Promise.resolve();
  return new Promise<void>((resolvePromise, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClosed);
      response.off("error", onClosed);
    };
    const onDrain = () => {
      cleanup();
      resolvePromise();
    };
    const onClosed = () => {
      cleanup();
      reject(new Error("closed"));
    };
    response.once("drain", onDrain);
    response.once("close", onClosed);
    response.once("error", onClosed);
  });
}

function isAvailableCursor(candidate: string, head: string): boolean {
  return EVENT_CURSOR_PATTERN.test(candidate) && compareCursor(candidate, head) <= 0;
}

function compareCursor(left: string, right: string): number {
  return cursorSequence(left) - cursorSequence(right);
}

function cursorSequence(cursor: string): number {
  const value = Number(EVENT_CURSOR_PATTERN.exec(cursor)?.[1]);
  if (!Number.isSafeInteger(value)) throw controlError("INTERNAL_ERROR");
  return value;
}

function boundedInterval(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1 || selected > 60_000) {
    throw controlError("MANAGEMENT_CONFIGURATION_INVALID");
  }
  return selected;
}
