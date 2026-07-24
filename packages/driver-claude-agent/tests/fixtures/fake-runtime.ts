import type {
  ClaudeRuntime,
  ClaudeRuntimeEvent,
  ClaudeRuntimeHealth,
  ClaudeRuntimeQuery,
} from "../../src/runtime.js";

export class FakeClaudeRuntime implements ClaudeRuntime {
  readonly sdkVersion = "0.3.215";
  readonly runtimeVersion = "2.1.215";
  readonly startInputs: Array<{
    readonly workDirectory: string;
    readonly prompt: string;
    readonly resumeSessionId?: string;
    readonly forkSession?: boolean;
  }> = [];
  readonly permissionResponses: Array<{
    readonly permissionId: string;
    readonly toolCallId: string;
    readonly decision: "allow" | "deny";
  }> = [];
  readonly cancelledSessions: string[] = [];

  health: ClaudeRuntimeHealth = {
    status: "healthy",
    sdkVersion: this.sdkVersion,
    runtimeVersion: this.runtimeVersion,
    message: "Fake Claude Runtime is healthy",
  };

  private nextSession = 1;
  private readonly queries: FakeRuntimeQuery[] = [];
  private readonly sessions = new Set<string>();

  healthCheck(): Promise<ClaudeRuntimeHealth> {
    return Promise.resolve(structuredClone(this.health));
  }

  startQuery(input: {
    readonly workDirectory: string;
    readonly prompt: string;
    readonly resumeSessionId?: string;
    readonly forkSession?: boolean;
  }): Promise<ClaudeRuntimeQuery> {
    this.startInputs.push(structuredClone(input));
    let sessionId: string;
    if (input.resumeSessionId !== undefined && input.forkSession !== true) {
      if (!this.sessions.has(input.resumeSessionId)) {
        throw new Error(`Unknown Fake Claude Session ${input.resumeSessionId}`);
      }
      sessionId = input.resumeSessionId;
    } else {
      sessionId = `session-${this.nextSession++}`;
      this.sessions.add(sessionId);
    }
    const query = new FakeRuntimeQuery(
      sessionId,
      (response) => this.permissionResponses.push(response),
      () => this.cancelledSessions.push(sessionId),
    );
    this.queries.push(query);
    return Promise.resolve(query);
  }

  close(): Promise<void> {
    for (const query of this.queries) {
      query.close();
    }
    return Promise.resolve();
  }

  emit(event: ClaudeRuntimeEvent, queryIndex = this.queries.length - 1): void {
    const query = this.queries[queryIndex];
    if (query === undefined) {
      throw new Error(`Unknown Fake Claude query ${queryIndex}`);
    }
    query.emit(event);
  }

  closeQuery(queryIndex = this.queries.length - 1): void {
    const query = this.queries[queryIndex];
    if (query === undefined) {
      throw new Error(`Unknown Fake Claude query ${queryIndex}`);
    }
    query.close();
  }
}

class FakeRuntimeQuery implements ClaudeRuntimeQuery {
  readonly events: AsyncIterable<ClaudeRuntimeEvent>;
  private readonly queue = new EventQueue();

  constructor(
    readonly sessionId: string,
    private readonly recordPermission: (response: {
      readonly permissionId: string;
      readonly toolCallId: string;
      readonly decision: "allow" | "deny";
    }) => void,
    private readonly recordCancellation: () => void,
  ) {
    this.events = this.queue.stream();
  }

  respondToPermission(input: {
    readonly permissionId: string;
    readonly toolCallId: string;
    readonly decision: "allow" | "deny";
  }): Promise<void> {
    this.recordPermission({
      permissionId: input.permissionId,
      toolCallId: input.toolCallId,
      decision: input.decision,
    });
    return Promise.resolve();
  }

  cancel(): Promise<boolean> {
    this.recordCancellation();
    this.close();
    return Promise.resolve(true);
  }

  close(): void {
    this.queue.close();
  }

  emit(event: ClaudeRuntimeEvent): void {
    this.queue.push(event);
  }
}

class EventQueue {
  private closed = false;
  private readonly events: ClaudeRuntimeEvent[] = [];
  private readonly listeners = new Set<() => void>();

  push(event: ClaudeRuntimeEvent): void {
    if (this.closed) {
      throw new Error("Cannot emit into a closed Fake Claude query");
    }
    this.events.push(event);
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  async *stream(): AsyncIterable<ClaudeRuntimeEvent> {
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
