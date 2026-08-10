import type {
  OutboxDispatchResult,
  OutboxPublisher,
  SqliteOutboxDispatcher,
} from "@agent-bridge/storage-sqlite";

export interface OutboxPumpOptions {
  readonly poll_interval_ms?: number;
}

/** Serial lifecycle pump for the durable SQLite outbox. */
export class OutboxPump {
  private timer?: ReturnType<typeof setTimeout>;
  private draining?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly dispatcher: Pick<SqliteOutboxDispatcher, "dispatchNext">,
    private readonly publish: OutboxPublisher,
    private readonly options: OutboxPumpOptions = {},
  ) {}

  start(): void {
    if (this.stopped || this.timer !== undefined) return;
    this.schedule(0);
  }

  async drain(): Promise<void> {
    this.draining ??= this.drainOnce().finally(() => {
      this.draining = undefined;
    });
    await this.draining;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.draining;
  }

  private async drainOnce(): Promise<void> {
    while (!this.stopped) {
      const result = await this.dispatcher.dispatchNext(this.publish);
      if (!shouldContinue(result)) return;
    }
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain()
        .catch(() => undefined)
        .finally(() => {
          if (!this.stopped) this.schedule(this.options.poll_interval_ms ?? 250);
        });
    }, delay);
    this.timer.unref?.();
  }
}

function shouldContinue(result: OutboxDispatchResult): boolean {
  return result.outcome === "PUBLISHED";
}
