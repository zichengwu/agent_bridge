import { randomUUID } from "node:crypto";

import {
  DRIVER_PROTOCOL_VERSION,
  DriverProtocolError,
  type AgentDriver,
  type AgentEvent,
  type AgentResult,
  type CancelTaskRequest,
  type CancellationReceipt,
  type ContextUsage,
  type FeedbackRequest,
  type HealthStatus,
  type JsonObject,
  type PermissionResponse,
  type PrepareTaskRequest,
  type PreparedTask,
  type RespondToPermissionRequest,
  type ResumeTaskRequest,
  type RunHandle,
  type SessionHandle,
  type StartTaskRequest,
  type SuccessorSessionRequest,
  type TokenUsage,
} from "@agent-bridge/driver-protocol";

import { OPENCODE_DRIVER_ID, openCodeCapabilities } from "./capabilities.js";
import { OpenCodeDriverError } from "./errors.js";
import { OpenCodeEventMapper, type OpenCodeEventMapperRecoveryState } from "./event-mapper.js";
import {
  OpenCodeSdkRuntime,
  type OpenCodeRuntime,
  type OpenCodeRuntimeEvent,
  type OpenCodeSdkRuntimeOptions,
} from "./runtime.js";

interface PreparedRecord {
  readonly prepared: PreparedTask;
  readonly task: JsonObject;
}

interface RunRecord {
  handle: RunHandle;
  readonly preparedTaskId: string;
  readonly directory: string;
  readonly mapper: OpenCodeEventMapper;
  readonly events: EventBuffer;
  pumpController: AbortController;
  pumpTask?: Promise<void>;
  readonly output: string[];
  readonly sessionIds: Set<string>;
  readonly contextUsageBySession: Map<string, ContextUsage>;
  tokenUsage?: TokenUsage;
  result?: AgentResult;
}

export interface OpenCodeDriverOptions {
  readonly workDirectory: string;
  readonly now?: () => Date;
  readonly createRunId?: () => string;
  readonly recoveryStates?: readonly OpenCodeDriverRecoveryState[];
}

export interface CreateOpenCodeDriverOptions
  extends OpenCodeDriverOptions, OpenCodeSdkRuntimeOptions {}

export interface OpenCodeDriverRecoveryState {
  readonly protocolVersion: typeof DRIVER_PROTOCOL_VERSION;
  readonly runId: string;
  readonly preparedTaskId: string;
  readonly handle: RunHandle;
  readonly events: readonly AgentEvent[];
  readonly output: readonly string[];
  readonly sessionIds: readonly string[];
  readonly contextUsageBySession: readonly (readonly [sessionId: string, usage: ContextUsage])[];
  readonly tokenUsage?: TokenUsage;
  readonly mapper: OpenCodeEventMapperRecoveryState;
}

export class OpenCodeDriver implements AgentDriver {
  private readonly createRunId: () => string;
  private readonly now: () => Date;
  private readonly preparedTasks = new Map<string, PreparedRecord>();
  private readonly runs = new Map<string, RunRecord>();

  constructor(
    private readonly runtime: OpenCodeRuntime,
    private readonly options: OpenCodeDriverOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.createRunId = options.createRunId ?? randomUUID;
    for (const state of options.recoveryStates ?? []) {
      this.restoreRun(state);
    }
  }

  describeCapabilities() {
    return Promise.resolve(openCodeCapabilities());
  }

  prepareTask(request: PrepareTaskRequest): Promise<PreparedTask> {
    assertProtocolVersion(request.protocolVersion);
    const preparedTaskId = [
      OPENCODE_DRIVER_ID,
      request.taskId,
      String(request.taskVersion),
      request.idempotencyKey,
    ].join(":");
    const existing = this.preparedTasks.get(preparedTaskId);
    if (existing !== undefined) {
      return Promise.resolve(existing.prepared);
    }

    const prepared: PreparedTask = {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      preparedTaskId,
      taskId: request.taskId,
      taskVersion: request.taskVersion,
      driverId: OPENCODE_DRIVER_ID,
      preparedAt: this.now().toISOString(),
      data: {
        task: request.task,
      },
    };
    this.preparedTasks.set(preparedTaskId, {
      prepared,
      task: request.task,
    });
    return Promise.resolve(prepared);
  }

  async startTask(request: StartTaskRequest): Promise<RunHandle> {
    assertProtocolVersion(request.protocolVersion);
    const prepared = this.preparedTasks.get(request.preparedTask.preparedTaskId);
    if (prepared === undefined) {
      throw new OpenCodeDriverError(
        "OPENCODE_PREPARED_TASK_NOT_FOUND",
        "Prepared task is not owned by this OpenCode Driver",
        { preparedTaskId: request.preparedTask.preparedTaskId },
      );
    }
    assertProtocolVersion(request.preparedTask.protocolVersion);
    if (
      request.preparedTask.driverId !== OPENCODE_DRIVER_ID ||
      request.preparedTask.taskId !== prepared.prepared.taskId ||
      request.preparedTask.taskVersion !== prepared.prepared.taskVersion
    ) {
      throw new OpenCodeDriverError(
        "OPENCODE_PREPARED_TASK_NOT_FOUND",
        "Prepared task identity does not match the OpenCode Driver record",
        { preparedTaskId: request.preparedTask.preparedTaskId },
      );
    }

    const runId = this.createRunId();
    const runtimeSession = await this.runtime.createSession({
      directory: this.options.workDirectory,
      title: `${prepared.prepared.taskId} v${prepared.prepared.taskVersion}`,
    });
    const session = sessionHandle({
      runId,
      sessionId: runtimeSession.id,
      createdAt: this.now().toISOString(),
    });
    const mapper = new OpenCodeEventMapper(runId, session.sessionId, this.now);
    const record: RunRecord = {
      handle: {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        runId,
        state: "running",
        session,
        startedAt: this.now().toISOString(),
      },
      preparedTaskId: prepared.prepared.preparedTaskId,
      directory: this.options.workDirectory,
      mapper,
      events: new EventBuffer(),
      pumpController: new AbortController(),
      output: [],
      sessionIds: new Set([session.sessionId]),
      contextUsageBySession: new Map(),
    };
    this.runs.set(runId, record);
    this.append(record, [mapper.start(prepared.prepared.preparedTaskId)]);

    const stream = await this.runtime.subscribe(record.directory, record.pumpController.signal);
    record.pumpTask = this.pumpEvents(record, stream);
    void record.pumpTask;

    try {
      await this.runtime.prompt(
        session.sessionId,
        record.directory,
        renderPrompt(prepared.task, request.context),
      );
    } catch (error) {
      this.failRun(record, "OPENCODE_PROMPT_REJECTED", false);
      throw error;
    }

    return record.handle;
  }

  async resumeTask(request: ResumeTaskRequest): Promise<RunHandle> {
    assertProtocolVersion(request.protocolVersion);
    const record = this.requireRun(request.runId);
    assertRunActive(record);
    assertActiveSession(record, request.sessionId);
    await this.ensureEventPump(record);
    const session = await this.runtime.getSession(request.sessionId, record.directory);
    if (session.id !== request.sessionId) {
      throw new OpenCodeDriverError(
        "OPENCODE_SESSION_MISMATCH",
        "OpenCode returned a different Session during resume",
        { expected: request.sessionId, received: session.id },
      );
    }
    this.append(record, [record.mapper.resume(request.reason)]);
    record.handle = {
      ...record.handle,
      state: "running",
    };
    return record.handle;
  }

  exportRecoveryState(runId: string): OpenCodeDriverRecoveryState {
    const record = this.requireRun(runId);
    assertRunActive(record);
    record.mapper.assertSuccessorBoundary();
    return {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId,
      preparedTaskId: record.preparedTaskId,
      handle: structuredClone(record.handle),
      events: record.events.snapshot(),
      output: [...record.output],
      sessionIds: [...record.sessionIds],
      contextUsageBySession: [...record.contextUsageBySession.entries()].map(
        ([sessionId, usage]) => [sessionId, structuredClone(usage)] as const,
      ),
      ...(record.tokenUsage === undefined
        ? {}
        : { tokenUsage: structuredClone(record.tokenUsage) }),
      mapper: record.mapper.snapshotRecoveryState(),
    };
  }

  streamEvents(runId: string): AsyncIterable<AgentEvent> {
    return this.requireRun(runId).events.stream();
  }

  getContextUsage(sessionId: string): Promise<ContextUsage> {
    const record = [...this.runs.values()].find((candidate) => candidate.sessionIds.has(sessionId));
    if (record === undefined) {
      throw new OpenCodeDriverError(
        "OPENCODE_SESSION_NOT_FOUND",
        "OpenCode Session usage was requested for an unknown Session",
        { sessionId },
      );
    }
    const usage = record.contextUsageBySession.get(sessionId);
    if (usage !== undefined) {
      return Promise.resolve(usage);
    }
    return Promise.resolve({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      sessionId,
      source: "driver_exact",
      usedTokens: 0,
      measuredAt: this.now().toISOString(),
    });
  }

  async createSuccessorSession(request: SuccessorSessionRequest): Promise<SessionHandle> {
    assertProtocolVersion(request.protocolVersion);
    const record = this.requireRun(request.runId);
    assertRunActive(record);
    assertActiveSession(record, request.predecessorSessionId);
    record.mapper.assertSuccessorBoundary();
    const runtimeSession = await this.runtime.createSession({
      directory: record.directory,
      title: `Successor for ${record.preparedTaskId}`,
      parentSessionId: request.predecessorSessionId,
    });
    const successor = sessionHandle({
      runId: request.runId,
      sessionId: runtimeSession.id,
      predecessorSessionId: request.predecessorSessionId,
      createdAt: this.now().toISOString(),
    });
    record.sessionIds.add(successor.sessionId);
    this.append(record, [record.mapper.successor(successor.sessionId, request.reason)]);
    record.handle = {
      ...record.handle,
      session: successor,
    };
    return successor;
  }

  async sendFeedback(request: FeedbackRequest): Promise<void> {
    assertProtocolVersion(request.protocolVersion);
    const record = this.requireRun(request.runId);
    assertRunActive(record);
    assertActiveSession(record, request.sessionId);
    await this.runtime.prompt(
      request.sessionId,
      record.directory,
      JSON.stringify({
        kind: "review_feedback",
        feedbackId: request.feedbackId,
        feedback: request.feedback,
      }),
    );
  }

  async respondToPermission(request: RespondToPermissionRequest): Promise<PermissionResponse> {
    assertProtocolVersion(request.protocolVersion);
    const record = this.requireRun(request.runId);
    assertRunActive(record);
    assertActiveSession(record, request.sessionId);
    record.mapper.assertPermissionResponse(request.permissionId, request.toolCallId);
    await this.runtime.respondToPermission({
      sessionId: request.sessionId,
      permissionId: request.permissionId,
      directory: record.directory,
      decision: request.decision,
    });
    this.append(record, [
      record.mapper.permissionResponded({
        permissionId: request.permissionId,
        toolCallId: request.toolCallId,
        decision: request.decision,
        reason: request.reason,
      }),
    ]);
    return {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: request.runId,
      sessionId: request.sessionId,
      permissionId: request.permissionId,
      toolCallId: request.toolCallId,
      decision: request.decision,
      respondedAt: this.now().toISOString(),
    };
  }

  async cancelTask(request: CancelTaskRequest): Promise<CancellationReceipt> {
    assertProtocolVersion(request.protocolVersion);
    const record = this.requireRun(request.runId);
    assertActiveSession(record, request.sessionId);
    if (record.result !== undefined) {
      return {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        runId: request.runId,
        sessionId: request.sessionId,
        accepted: false,
        requestedAt: this.now().toISOString(),
      };
    }

    this.append(record, [record.mapper.cancellationRequested(request.reason)]);
    const accepted = await this.runtime.abortSession(request.sessionId, record.directory);
    if (!accepted) {
      this.failRun(record, "OPENCODE_CANCEL_REJECTED", false);
      throw new OpenCodeDriverError(
        "OPENCODE_RUNTIME_ERROR",
        "OpenCode did not accept cancellation",
        { runId: request.runId },
      );
    }
    record.pumpController.abort();
    this.append(record, [record.mapper.cancelled(request.reason)]);
    return {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: request.runId,
      sessionId: request.sessionId,
      accepted: true,
      requestedAt: this.now().toISOString(),
    };
  }

  collectResult(runId: string): Promise<AgentResult> {
    const result = this.requireRun(runId).result;
    if (result === undefined) {
      throw new OpenCodeDriverError("OPENCODE_RESULT_NOT_READY", "OpenCode result is not ready", {
        runId,
      });
    }
    return Promise.resolve(result);
  }

  async healthCheck(): Promise<HealthStatus> {
    const health = await this.runtime.healthCheck();
    return {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      driverId: OPENCODE_DRIVER_ID,
      status: health.healthy ? "healthy" : "unhealthy",
      checkedAt: this.now().toISOString(),
      message: `OpenCode runtime ${health.version}`,
    };
  }

  async close(): Promise<void> {
    for (const record of this.runs.values()) {
      record.pumpController.abort();
    }
    await Promise.allSettled(
      [...this.runs.values()]
        .map((record) => record.pumpTask)
        .filter((task): task is Promise<void> => task !== undefined),
    );
    await this.runtime.close();
  }

  private async pumpEvents(
    record: RunRecord,
    stream: AsyncIterable<OpenCodeRuntimeEvent>,
  ): Promise<void> {
    try {
      for await (const runtimeEvent of stream) {
        if (
          runtimeEvent.type !== "session.error" &&
          runtimeEvent.sessionId !== record.mapper.sessionId
        ) {
          continue;
        }
        if (
          runtimeEvent.type === "session.error" &&
          runtimeEvent.sessionId !== undefined &&
          runtimeEvent.sessionId !== record.mapper.sessionId
        ) {
          continue;
        }
        if (runtimeEvent.type === "usage") {
          record.tokenUsage = {
            inputTokens: runtimeEvent.inputTokens,
            outputTokens: runtimeEvent.outputTokens,
            cacheReadTokens: runtimeEvent.cacheReadTokens,
            cacheWriteTokens: runtimeEvent.cacheWriteTokens,
          };
        }
        this.append(record, record.mapper.map(runtimeEvent));
      }
      if (!record.pumpController.signal.aborted && !record.mapper.isTerminal) {
        this.failRun(record, "OPENCODE_EVENT_STREAM_CLOSED", true);
      }
    } catch (error) {
      if (!record.pumpController.signal.aborted && !record.mapper.isTerminal) {
        this.failRun(
          record,
          error instanceof Error ? error.name : "OPENCODE_EVENT_STREAM_ERROR",
          true,
        );
      }
    }
  }

  private async ensureEventPump(record: RunRecord): Promise<void> {
    if (record.pumpTask !== undefined) {
      return;
    }
    const stream = await this.runtime.subscribe(record.directory, record.pumpController.signal);
    record.pumpTask = this.pumpEvents(record, stream);
    void record.pumpTask;
  }

  private append(record: RunRecord, events: readonly AgentEvent[]): void {
    for (const event of events) {
      if (event.type === "output.delta") {
        record.output.push(event.delta);
      }
      if (event.type === "usage.updated") {
        record.contextUsageBySession.set(event.sessionId, event.usage);
      }
      if (event.type === "permission.requested") {
        record.handle = {
          ...record.handle,
          state: "waiting_permission",
        };
      }
      if (event.type === "permission.responded") {
        record.handle = {
          ...record.handle,
          state: "running",
        };
      }
      if (event.type === "run.cancellation_requested") {
        record.handle = {
          ...record.handle,
          state: "cancelling",
        };
      }
      record.events.append(event);

      if (
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.cancelled"
      ) {
        const status =
          event.type === "run.completed"
            ? "succeeded"
            : event.type === "run.cancelled"
              ? "cancelled"
              : "failed";
        record.handle = {
          ...record.handle,
          state: status,
        };
        record.result = {
          protocolVersion: DRIVER_PROTOCOL_VERSION,
          runId: record.handle.runId,
          sessionId: record.handle.session.sessionId,
          status,
          summary: record.output.join("").trim() || `OpenCode run ${status}`,
          output: {
            text: record.output.join(""),
          },
          artifacts: [],
          usage: record.tokenUsage,
          error: event.type === "run.failed" ? event.error : undefined,
          completedAt: event.occurredAt,
        };
        record.events.close();
      }
    }
  }

  private failRun(record: RunRecord, code: string, retryable: boolean): void {
    if (record.mapper.isTerminal) {
      return;
    }
    this.append(
      record,
      record.mapper.map({
        type: "session.error",
        sessionId: record.mapper.sessionId,
        code,
        retryable,
      }),
    );
  }

  private requireRun(runId: string): RunRecord {
    const record = this.runs.get(runId);
    if (record === undefined) {
      throw new OpenCodeDriverError("OPENCODE_RUN_NOT_FOUND", "OpenCode Run was not found", {
        runId,
      });
    }
    return record;
  }

  private restoreRun(state: OpenCodeDriverRecoveryState): void {
    assertProtocolVersion(state.protocolVersion);
    const firstEvent = state.events[0];
    const lastEvent = state.events.at(-1);
    if (
      state.handle.protocolVersion !== DRIVER_PROTOCOL_VERSION ||
      state.handle.session.protocolVersion !== DRIVER_PROTOCOL_VERSION ||
      state.runId !== state.handle.runId ||
      state.handle.session.runId !== state.runId ||
      state.handle.session.sessionId !== state.handle.session.externalSessionId ||
      !state.sessionIds.includes(state.handle.session.sessionId) ||
      state.events.length === 0 ||
      firstEvent?.type !== "run.started" ||
      firstEvent.preparedTaskId !== state.preparedTaskId ||
      lastEvent?.sessionId !== state.handle.session.sessionId ||
      state.events.some(
        (event) => event.runId !== state.runId || !state.sessionIds.includes(event.sessionId),
      ) ||
      state.contextUsageBySession.some(
        ([sessionId, usage]) =>
          !state.sessionIds.includes(sessionId) ||
          usage.sessionId !== sessionId ||
          usage.protocolVersion !== DRIVER_PROTOCOL_VERSION,
      ) ||
      state.handle.state === "succeeded" ||
      state.handle.state === "failed" ||
      state.handle.state === "cancelled"
    ) {
      throw new OpenCodeDriverError(
        "OPENCODE_RUN_NOT_FOUND",
        "OpenCode recovery state is inconsistent",
        { runId: state.runId },
      );
    }
    if (this.runs.has(state.runId)) {
      throw new OpenCodeDriverError(
        "OPENCODE_RUN_NOT_FOUND",
        "OpenCode recovery state contains a duplicate Run",
        { runId: state.runId },
      );
    }
    const events = state.events.map((event) => structuredClone(event));
    const mapper = new OpenCodeEventMapper(state.runId, state.handle.session.sessionId, this.now, {
      events,
      state: state.mapper,
    });
    this.runs.set(state.runId, {
      handle: structuredClone(state.handle),
      preparedTaskId: state.preparedTaskId,
      directory: this.options.workDirectory,
      mapper,
      events: new EventBuffer(events),
      pumpController: new AbortController(),
      output: [...state.output],
      sessionIds: new Set(state.sessionIds),
      contextUsageBySession: new Map(
        state.contextUsageBySession.map(([sessionId, usage]) => [
          sessionId,
          structuredClone(usage),
        ]),
      ),
      tokenUsage: state.tokenUsage === undefined ? undefined : structuredClone(state.tokenUsage),
    });
  }
}

export async function createOpenCodeDriver(
  options: CreateOpenCodeDriverOptions,
): Promise<OpenCodeDriver> {
  const runtime = await OpenCodeSdkRuntime.start({
    hostname: options.hostname,
    port: options.port,
    timeoutMs: options.timeoutMs,
    provider: options.provider,
    executablePath: options.executablePath,
  });
  try {
    return new OpenCodeDriver(runtime, options);
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

class EventBuffer {
  private closed = false;
  private readonly events: AgentEvent[];
  private readonly listeners = new Set<() => void>();

  constructor(events: readonly AgentEvent[] = []) {
    this.events = events.map((event) => structuredClone(event));
  }

  append(event: AgentEvent): void {
    if (this.closed) {
      return;
    }
    this.events.push(event);
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  snapshot(): AgentEvent[] {
    return this.events.map((event) => structuredClone(event));
  }

  async *stream(): AsyncIterable<AgentEvent> {
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

function assertProtocolVersion(value: unknown): void {
  if (value !== DRIVER_PROTOCOL_VERSION) {
    throw new DriverProtocolError(
      "DRIVER_PROTOCOL_VERSION_UNSUPPORTED",
      "OpenCode Driver received an unsupported protocol version",
      { expected: DRIVER_PROTOCOL_VERSION, received: value },
    );
  }
}

function assertActiveSession(record: RunRecord, sessionId: string): void {
  if (record.handle.session.sessionId !== sessionId) {
    throw new OpenCodeDriverError(
      "OPENCODE_SESSION_MISMATCH",
      "Request does not reference the active OpenCode Session",
      {
        expected: record.handle.session.sessionId,
        received: sessionId,
      },
    );
  }
}

function assertRunActive(record: RunRecord): void {
  if (record.result !== undefined) {
    throw new OpenCodeDriverError("OPENCODE_RUN_TERMINAL", "OpenCode Run is already terminal", {
      runId: record.handle.runId,
      state: record.handle.state,
    });
  }
}

function sessionHandle(input: {
  readonly runId: string;
  readonly sessionId: string;
  readonly predecessorSessionId?: string;
  readonly createdAt: string;
}): SessionHandle {
  return {
    protocolVersion: DRIVER_PROTOCOL_VERSION,
    sessionId: input.sessionId,
    externalSessionId: input.sessionId,
    runId: input.runId,
    state: "active",
    createdAt: input.createdAt,
    ...(input.predecessorSessionId === undefined
      ? {}
      : { predecessorSessionId: input.predecessorSessionId }),
  };
}

function renderPrompt(task: JsonObject, context: JsonObject): string {
  return JSON.stringify({
    task,
    context,
  });
}
