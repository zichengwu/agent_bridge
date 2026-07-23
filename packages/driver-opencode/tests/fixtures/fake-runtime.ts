import type {
  OpenCodeRuntime,
  OpenCodeRuntimeEvent,
  OpenCodeRuntimeHealth,
  OpenCodeRuntimeSession,
} from "../../src/runtime.js";

export class FakeOpenCodeRuntime implements OpenCodeRuntime {
  readonly version = "1.18.3";
  readonly abortedSessions: string[] = [];
  readonly permissionResponses: Array<{
    readonly sessionId: string;
    readonly permissionId: string;
    readonly decision: "allow" | "deny";
  }> = [];
  readonly prompts: Array<{
    readonly sessionId: string;
    readonly prompt: string;
  }> = [];

  private nextSession = 1;
  private readonly sessions = new Set<string>();
  private readonly subscriptions = new Set<EventQueue>();

  healthCheck(): Promise<OpenCodeRuntimeHealth> {
    return Promise.resolve({
      healthy: true,
      version: this.version,
    });
  }

  createSession(): Promise<OpenCodeRuntimeSession> {
    const id = `session-${this.nextSession++}`;
    this.sessions.add(id);
    return Promise.resolve({ id });
  }

  getSession(sessionId: string, directory: string): Promise<OpenCodeRuntimeSession> {
    void directory;
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Unknown Fake OpenCode Session ${sessionId}`);
    }
    return Promise.resolve({ id: sessionId });
  }

  subscribe(directory: string, signal: AbortSignal): Promise<AsyncIterable<OpenCodeRuntimeEvent>> {
    void directory;
    const queue = new EventQueue();
    this.subscriptions.add(queue);
    signal.addEventListener(
      "abort",
      () => {
        queue.close();
        this.subscriptions.delete(queue);
      },
      { once: true },
    );
    return Promise.resolve(queue.stream());
  }

  prompt(sessionId: string, directory: string, prompt: string): Promise<void> {
    void directory;
    this.prompts.push({ sessionId, prompt });
    return Promise.resolve();
  }

  respondToPermission(input: {
    readonly sessionId: string;
    readonly permissionId: string;
    readonly directory: string;
    readonly decision: "allow" | "deny";
  }): Promise<void> {
    this.permissionResponses.push({
      sessionId: input.sessionId,
      permissionId: input.permissionId,
      decision: input.decision,
    });
    return Promise.resolve();
  }

  abortSession(sessionId: string, directory: string): Promise<boolean> {
    void directory;
    this.abortedSessions.push(sessionId);
    return Promise.resolve(this.sessions.has(sessionId));
  }

  close(): Promise<void> {
    for (const subscription of this.subscriptions) {
      subscription.close();
    }
    this.subscriptions.clear();
    return Promise.resolve();
  }

  emit(event: OpenCodeRuntimeEvent): void {
    for (const subscription of this.subscriptions) {
      subscription.push(event);
    }
  }
}

class EventQueue {
  private closed = false;
  private readonly events: OpenCodeRuntimeEvent[] = [];
  private readonly listeners = new Set<() => void>();

  push(event: OpenCodeRuntimeEvent): void {
    this.events.push(event);
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  async *stream(): AsyncIterable<OpenCodeRuntimeEvent> {
    let cursor = 0;
    while (true) {
      while (cursor < this.events.length) {
        yield this.events[cursor++]!;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.listeners.add(resolve);
      });
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
    this.listeners.clear();
  }
}
