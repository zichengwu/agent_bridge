import type {
  AuthoritativeDomainEvent,
  DomainEventQuery,
  DomainRepository,
} from "@agent-bridge/core";

import { NOOP_LOGGER, type StructuredLogger } from "./contracts.js";
import { ObservabilityError } from "./errors.js";

export interface ObservedDomainEvent {
  readonly cursor: string;
  readonly event: AuthoritativeDomainEvent;
}

export const OBSERVER_DISCONNECT_REASONS = [
  "CLIENT_CLOSED",
  "OBSERVER_FAILED",
  "SLOW_CONSUMER",
  "SERVICE_STOPPED",
] as const;

export type ObserverDisconnectReason = (typeof OBSERVER_DISCONNECT_REASONS)[number];

export interface EventObserver {
  onEvent(event: ObservedDomainEvent): Promise<void> | void;
  onDisconnect?(reason: ObserverDisconnectReason, resumeCursor: string): Promise<void> | void;
}

export interface EventSubscriptionOptions {
  readonly subscription_id: string;
  readonly observer: EventObserver;
  readonly after_cursor?: string;
  readonly task_id?: string;
  readonly run_id?: string;
}

export interface EventSubscription {
  readonly subscription_id: string;
  readonly closed: boolean;
  readonly resume_cursor: string;
  close(): void;
}

export interface PersistentEventFanoutOptions {
  readonly queue_capacity?: number;
  readonly prefetch_per_poll?: number;
  readonly logger?: StructuredLogger;
}

interface QueuedEvent {
  readonly cursor: string;
  readonly event: AuthoritativeDomainEvent;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CURSOR_PATTERN = /^event-cursor:(0|[1-9][0-9]*)$/u;
const DEFAULT_QUEUE_CAPACITY = 64;
const DEFAULT_PREFETCH_PER_POLL = 16;

export class PersistentEventFanout {
  private readonly subscriptions = new Map<string, SubscriptionState>();
  private readonly queueCapacity: number;
  private readonly prefetchPerPoll: number;
  private readonly logger: StructuredLogger;
  private stopped = false;

  constructor(
    private readonly repository: Pick<DomainRepository, "listDomainEvents">,
    options: PersistentEventFanoutOptions = {},
  ) {
    this.queueCapacity = readBoundedPositiveInteger(
      options.queue_capacity,
      DEFAULT_QUEUE_CAPACITY,
      10_000,
    );
    this.prefetchPerPoll = readBoundedPositiveInteger(
      options.prefetch_per_poll,
      DEFAULT_PREFETCH_PER_POLL,
      this.queueCapacity,
    );
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  subscribe(value: EventSubscriptionOptions): EventSubscription {
    if (this.stopped || !isSubscriptionOptions(value)) {
      throw new ObservabilityError("EVENT_SUBSCRIPTION_INVALID");
    }
    if (this.subscriptions.has(value.subscription_id)) {
      throw new ObservabilityError("EVENT_SUBSCRIPTION_CONFLICT");
    }
    const state = new SubscriptionState(
      value,
      this.repository,
      this.queueCapacity,
      this.prefetchPerPoll,
      this.logger,
      () => this.subscriptions.delete(value.subscription_id),
    );
    this.subscriptions.set(value.subscription_id, state);
    return state;
  }

  async pollOnce(): Promise<void> {
    if (this.stopped) {
      return;
    }
    await Promise.allSettled(
      [...this.subscriptions.values()].map((subscription) => subscription.prefetch()),
    );
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    for (const subscription of [...this.subscriptions.values()]) {
      subscription.disconnect("SERVICE_STOPPED");
    }
    this.subscriptions.clear();
  }
}

class SubscriptionState implements EventSubscription {
  private readonly queue: QueuedEvent[] = [];
  private fetchingCursor: string;
  private deliveredCursor: string;
  private draining = false;
  private prefetching = false;
  private isClosed = false;

  constructor(
    private readonly options: EventSubscriptionOptions,
    private readonly repository: Pick<DomainRepository, "listDomainEvents">,
    private readonly queueCapacity: number,
    private readonly prefetchPerPoll: number,
    private readonly logger: StructuredLogger,
    private readonly onClosed: () => void,
  ) {
    this.fetchingCursor = options.after_cursor ?? "event-cursor:0";
    this.deliveredCursor = this.fetchingCursor;
  }

  get subscription_id(): string {
    return this.options.subscription_id;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  get resume_cursor(): string {
    return this.deliveredCursor;
  }

  close(): void {
    this.disconnect("CLIENT_CLOSED");
  }

  async prefetch(): Promise<void> {
    if (this.isClosed || this.prefetching) {
      return;
    }
    if (this.draining && this.queue.length >= this.queueCapacity) {
      this.disconnect("SLOW_CONSUMER");
      return;
    }
    this.prefetching = true;
    try {
      let fetched = 0;
      while (
        !this.isClosed &&
        fetched < this.prefetchPerPoll &&
        this.queue.length < this.queueCapacity
      ) {
        const query: DomainEventQuery = {
          after_cursor: this.fetchingCursor,
          limit: 1,
          ...(this.options.task_id === undefined ? {} : { task_id: this.options.task_id }),
          ...(this.options.run_id === undefined ? {} : { run_id: this.options.run_id }),
        };
        const page = await this.repository.listDomainEvents(query);
        if (page.events.length === 0) {
          this.fetchingCursor = page.next_cursor;
          break;
        }
        const event = page.events[0]!;
        this.fetchingCursor = page.next_cursor;
        if (this.queue.length >= this.queueCapacity) {
          this.disconnect("SLOW_CONSUMER");
          return;
        }
        this.queue.push(Object.freeze({ cursor: page.next_cursor, event }));
        fetched += 1;
        this.startDrain();
      }
      if (
        !this.isClosed &&
        this.queue.length >= this.queueCapacity &&
        fetched === this.prefetchPerPoll
      ) {
        this.logger.log("warn", "event_observer_queue_full", {
          subscription_id: this.subscription_id,
          queue_capacity: this.queueCapacity,
        });
      }
    } catch {
      this.logger.log("warn", "event_observer_source_unavailable", {
        subscription_id: this.subscription_id,
      });
    } finally {
      this.prefetching = false;
    }
  }

  disconnect(reason: ObserverDisconnectReason): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.queue.length = 0;
    this.onClosed();
    try {
      void Promise.resolve(
        this.options.observer.onDisconnect?.(reason, this.deliveredCursor),
      ).catch(() => undefined);
    } catch {
      // An observer disconnect callback is never authoritative.
    }
  }

  private startDrain(): void {
    if (this.draining || this.isClosed) {
      return;
    }
    this.draining = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (!this.isClosed) {
        const queued = this.queue.shift();
        if (queued === undefined) {
          return;
        }
        try {
          await this.options.observer.onEvent(
            Object.freeze({ cursor: queued.cursor, event: queued.event }),
          );
          this.deliveredCursor = queued.cursor;
        } catch {
          this.disconnect("OBSERVER_FAILED");
          return;
        }
      }
    } finally {
      this.draining = false;
      if (!this.isClosed && this.queue.length > 0) {
        this.startDrain();
      }
    }
  }
}

function isSubscriptionOptions(value: unknown): value is EventSubscriptionOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    IDENTIFIER_PATTERN.test(String((value as EventSubscriptionOptions).subscription_id)) &&
    typeof (value as EventSubscriptionOptions).observer === "object" &&
    (value as EventSubscriptionOptions).observer !== null &&
    typeof (value as EventSubscriptionOptions).observer.onEvent === "function" &&
    ((value as EventSubscriptionOptions).after_cursor === undefined ||
      CURSOR_PATTERN.test((value as EventSubscriptionOptions).after_cursor!)) &&
    ((value as EventSubscriptionOptions).task_id === undefined ||
      IDENTIFIER_PATTERN.test((value as EventSubscriptionOptions).task_id!)) &&
    ((value as EventSubscriptionOptions).run_id === undefined ||
      IDENTIFIER_PATTERN.test((value as EventSubscriptionOptions).run_id!))
  );
}

function readBoundedPositiveInteger(value: unknown, fallback: number, maximum: number): number {
  const candidate = value ?? fallback;
  if (
    typeof candidate !== "number" ||
    !Number.isInteger(candidate) ||
    candidate <= 0 ||
    candidate > maximum
  ) {
    throw new ObservabilityError("EVENT_FANOUT_CONFIGURATION_INVALID");
  }
  return candidate;
}
