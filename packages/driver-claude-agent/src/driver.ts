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

import { CLAUDE_AGENT_DRIVER_ID, claudeAgentCapabilities } from "./capabilities.js";
import { ClaudeAgentDriverError, redactClaudeText } from "./errors.js";
import { ClaudeEventMapper, type ClaudeEventMapperRecoveryState } from "./event-mapper.js";
import {
  ClaudeAgentSdkRuntime,
  type ClaudeAgentSdkRuntimeOptions,
  type ClaudeRuntime,
  type ClaudeRuntimeQuery,
} from "./runtime.js";

interface PreparedRecord {
  readonly prepared: PreparedTask;
  readonly task: JsonObject;
}

interface RunRecord {
  handle: RunHandle;
  readonly preparedTaskId: string;
  readonly directory: string;
  readonly mapper: ClaudeEventMapper;
  readonly events: EventBuffer;
  readonly output: string[];
  readonly sessionIds: Set<string>;
  readonly contextUsageBySession: Map<string, ContextUsage>;
  query?: ClaudeRuntimeQuery;
  pumpTask?: Promise<void>;
  tokenUsage?: TokenUsage;
  resultSummary?: string;
  result?: AgentResult;
}

export interface ClaudeAgentDriverOptions {
  readonly workDirectory: string;
  readonly now?: () => Date;
  readonly createRunId?: () => string;
  readonly recoveryStates?: readonly ClaudeAgentDriverRecoveryState[];
  readonly redact?: (value: string) => string;
}

export interface CreateClaudeAgentDriverOptions
  extends ClaudeAgentDriverOptions, ClaudeAgentSdkRuntimeOptions {}

export interface ClaudeAgentDriverRecoveryState {
  readonly protocolVersion: typeof DRIVER_PROTOCOL_VERSION;
  readonly runId: string;
  readonly preparedTaskId: string;
  readonly handle: RunHandle;
  readonly events: readonly AgentEvent[];
  readonly output: readonly string[];
  readonly sessionIds: readonly string[];
  readonly contextUsageBySession: readonly (readonly [sessionId: string, usage: ContextUsage])[];
  readonly tokenUsage?: TokenUsage;
  readonly resultSummary?: string;
  readonly mapper: ClaudeEventMapperRecoveryState;
}

export class ClaudeAgentDriver implements AgentDriver {
  private readonly createRunId: () => string;
  private readonly now: () => Date;
  private readonly redact: (value: string) => string;
  private readonly preparedTasks = new Map<string, PreparedRecord>();
  private readonly runs = new Map<string, RunRecord>();

  constructor(
    private readonly runtime: ClaudeRuntime,
    private readonly options: ClaudeAgentDriverOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.createRunId = options.createRunId ?? randomUUID;
    this.redact = options.redact ?? ((value) => value);
    for (const state of options.recoveryStates ?? []) {
      this.restoreRun(state);
    }
  }

  describeCapabilities() {
    return Promise.resolve(claudeAgentCapabilities());
  }

  prepareTask(request: PrepareTaskRequest): Promise<PreparedTask> {
    assertProtocolVersion(request.protocolVersion);
    const preparedTaskId = [
      CLAUDE_AGENT_DRIVER_ID,
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
      driverId: CLAUDE_AGENT_DRIVER_ID,
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
    const prepared = this.requirePreparedTask(request.preparedTask);
    const runId = this.createRunId();
    const runtimeQuery = await this.runtime.startQuery({
      workDirectory: this.options.workDirectory,
      prompt: renderPrompt(prepared.task, request.context),
    });
    const session = sessionHandle({
      runId,
      sessionId: runtimeQuery.sessionId,
      createdAt: this.now().toISOString(),
    });
    const mapper = new ClaudeEventMapper(runId, session.sessionId, this.now, this.redact);
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
      output: [],
      sessionIds: new Set([session.sessionId]),
      contextUsageBySession: new Map(),
      query: runtimeQuery,
    };
    this.runs.set(runId, record);
    this.append(record, [mapper.start(prepared.prepared.preparedTaskId)]);
    this.attachQuery(record, runtimeQuery);
    return record.handle;
  }

  async resumeTask(request: ResumeTaskRequest): Promise<RunHandle> {
    assertProtocolVersion(request.protocolVersion);
    const record = this.requireRun(request.runId);
    assertRunActive(record);
    assertActiveSession(record, request.sessionId);
    record.mapper.assertSafeBoundary();
    await this.stopActiveQuery(record);
    const runtimeQuery = await this.runtime.startQuery({
      workDirectory: record.directory,
      prompt: renderContinuation("resume", request.reason, request.context),
      resumeSessionId: request.sessionId,
      forkSession: false,
    });
    if (runtimeQuery.sessionId !== request.sessionId) {
      runtimeQuery.close();
      throw new ClaudeAgentDriverError(
        "CLAUDE_SESSION_MISMATCH",
        "Claude returned a different Session during resume",
        { expected: request.sessionId, received: runtimeQuery.sessionId },
      );
    }
    this.append(record, [record.mapper.resume(request.reason)]);
    record.handle = {
      ...record.handle,
      state: "running",
    };
    record.query = runtimeQuery;
    this.attachQuery(record, runtimeQuery);
    return record.handle;
  }

  exportRecoveryState(runId: string): ClaudeAgentDriverRecoveryState {
    const record = this.requireRun(runId);
    assertRunActive(record);
    record.mapper.assertSafeBoundary();
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
      tokenUsage: record.tokenUsage === undefined ? undefined : structuredClone(record.tokenUsage),
      resultSummary: record.resultSummary,
      mapper: record.mapper.snapshotRecoveryState(),
    };
  }

  streamEvents(runId: string): AsyncIterable<AgentEvent> {
    return this.requireRun(runId).events.stream();
  }

  getContextUsage(sessionId: string): Promise<ContextUsage> {
    const record = [...this.runs.values()].find((candidate) => candidate.sessionIds.has(sessionId));
    if (record === undefined) {
      throw new ClaudeAgentDriverError(
        "CLAUDE_SESSION_NOT_FOUND",
        "Claude Session usage was requested for an unknown Session",
        { sessionId },
      );
    }
    const usage = record.contextUsageBySession.get(sessionId);
    if (usage !== undefined) {
      return Promise.resolve(structuredClone(usage));
    }
    return Promise.resolve({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      sessionId,
      source: "driver_estimate",
      usedTokens: 0,
      measuredAt: this.now().toISOString(),
    });
  }

  async createSuccessorSession(request: SuccessorSessionRequest): Promise<SessionHandle> {
    assertProtocolVersion(request.protocolVersion);
    const record = this.requireRun(request.runId);
    assertRunActive(record);
    assertActiveSession(record, request.predecessorSessionId);
    record.mapper.assertSafeBoundary();
    await this.stopActiveQuery(record);
    const runtimeQuery = await this.runtime.startQuery({
      workDirectory: record.directory,
      prompt: renderContinuation("successor", request.reason, request.context),
      resumeSessionId: request.predecessorSessionId,
      forkSession: true,
    });
    if (runtimeQuery.sessionId === request.predecessorSessionId) {
      runtimeQuery.close();
      throw new ClaudeAgentDriverError(
        "CLAUDE_SESSION_MISMATCH",
        "Claude successor Session must use a new external Session ID",
        { predecessorSessionId: request.predecessorSessionId },
      );
    }
    const successor = sessionHandle({
      runId: request.runId,
      sessionId: runtimeQuery.sessionId,
      predecessorSessionId: request.predecessorSessionId,
      createdAt: this.now().toISOString(),
    });
    record.sessionIds.add(successor.sessionId);
    this.append(record, [record.mapper.successor(successor.sessionId, request.reason)]);
    record.handle = {
      ...record.handle,
      session: successor,
    };
    record.query = runtimeQuery;
    this.attachQuery(record, runtimeQuery);
    return successor;
  }

  async sendFeedback(request: FeedbackRequest): Promise<void> {
    assertProtocolVersion(request.protocolVersion);
    const record = this.requireRun(request.runId);
    assertRunActive(record);
    assertActiveSession(record, request.sessionId);
    record.mapper.assertSafeBoundary();
    await this.stopActiveQuery(record);
    const runtimeQuery = await this.runtime.startQuery({
      workDirectory: record.directory,
      prompt: JSON.stringify({
        kind: "review_feedback",
        feedbackId: request.feedbackId,
        feedback: request.feedback,
      }),
      resumeSessionId: request.sessionId,
      forkSession: false,
    });
    if (runtimeQuery.sessionId !== request.sessionId) {
      runtimeQuery.close();
      throw new ClaudeAgentDriverError(
        "CLAUDE_SESSION_MISMATCH",
        "Claude returned a different Session for review feedback",
        { expected: request.sessionId, received: runtimeQuery.sessionId },
      );
    }
    record.query = runtimeQuery;
    this.attachQuery(record, runtimeQuery);
  }

  async respondToPermission(request: RespondToPermissionRequest): Promise<PermissionResponse> {
    assertProtocolVersion(request.protocolVersion);
    const record = this.requireRun(request.runId);
    assertRunActive(record);
    assertActiveSession(record, request.sessionId);
    record.mapper.assertPermissionResponse(request.permissionId, request.toolCallId);
    const runtimeQuery = record.query;
    if (runtimeQuery === undefined) {
      throw new ClaudeAgentDriverError(
        "CLAUDE_PERMISSION_NOT_PENDING",
        "Claude permission request has no active Runtime query",
        { permissionId: request.permissionId },
      );
    }
    this.append(record, [
      record.mapper.permissionResponded({
        permissionId: request.permissionId,
        toolCallId: request.toolCallId,
        decision: request.decision,
        reason: request.reason,
      }),
    ]);
    try {
      await runtimeQuery.respondToPermission({
        permissionId: request.permissionId,
        toolCallId: request.toolCallId,
        decision: request.decision,
        reason: request.reason,
      });
    } catch {
      this.failRun(record, "CLAUDE_PERMISSION_RESPONSE_FAILED", false);
      throw new ClaudeAgentDriverError(
        "CLAUDE_RUNTIME_ERROR",
        "Claude Runtime rejected the permission response",
        { permissionId: request.permissionId },
      );
    }
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
    const runtimeQuery = record.query;
    record.query = undefined;
    if (runtimeQuery !== undefined) {
      await runtimeQuery.cancel().catch(() => false);
    }
    if (record.pumpTask !== undefined) {
      await record.pumpTask.catch(() => undefined);
      record.pumpTask = undefined;
    }
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
      throw new ClaudeAgentDriverError("CLAUDE_RESULT_NOT_READY", "Claude result is not ready", {
        runId,
      });
    }
    return Promise.resolve(structuredClone(result));
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const health = await this.runtime.healthCheck();
      return {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        driverId: CLAUDE_AGENT_DRIVER_ID,
        status: health.status,
        checkedAt: this.now().toISOString(),
        message: this.redact(health.message),
        details: {
          sdkVersion: health.sdkVersion,
          runtimeVersion: health.runtimeVersion,
        },
      };
    } catch {
      return {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        driverId: CLAUDE_AGENT_DRIVER_ID,
        status: "unhealthy",
        checkedAt: this.now().toISOString(),
        message: "Claude Agent fallback component is unavailable",
      };
    }
  }

  async close(): Promise<void> {
    for (const record of this.runs.values()) {
      await this.stopActiveQuery(record);
    }
    await this.runtime.close();
  }

  private attachQuery(record: RunRecord, runtimeQuery: ClaudeRuntimeQuery): void {
    record.query = runtimeQuery;
    record.pumpTask = this.pumpEvents(record, runtimeQuery);
    void record.pumpTask;
  }

  private async pumpEvents(record: RunRecord, runtimeQuery: ClaudeRuntimeQuery): Promise<void> {
    try {
      for await (const runtimeEvent of runtimeQuery.events) {
        if (runtimeQuery !== record.query || record.mapper.isTerminal) {
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
        if (runtimeEvent.type === "result") {
          record.resultSummary = this.redact(runtimeEvent.summary);
        }
        this.append(record, record.mapper.map(runtimeEvent));
      }
      if (runtimeQuery === record.query && !record.mapper.isTerminal) {
        this.failRun(record, "CLAUDE_EVENT_STREAM_CLOSED", true);
      }
    } catch (error) {
      if (runtimeQuery === record.query && !record.mapper.isTerminal) {
        this.failRun(
          record,
          error instanceof ClaudeAgentDriverError ? error.code : "CLAUDE_EVENT_STREAM_ERROR",
          false,
        );
      }
    }
  }

  private async stopActiveQuery(record: RunRecord): Promise<void> {
    const runtimeQuery = record.query;
    record.query = undefined;
    if (runtimeQuery !== undefined) {
      runtimeQuery.close();
    }
    if (record.pumpTask !== undefined) {
      await record.pumpTask.catch(() => undefined);
      record.pumpTask = undefined;
    }
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
        const output = record.output.join("");
        record.result = {
          protocolVersion: DRIVER_PROTOCOL_VERSION,
          runId: record.handle.runId,
          sessionId: record.handle.session.sessionId,
          status,
          summary: output.trim() || record.resultSummary || `Claude Agent run ${status}`,
          output: {
            text: output,
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
        type: "runtime.error",
        sessionId: record.mapper.sessionId,
        code,
        message: "Claude Agent Runtime failed",
        retryable,
      }),
    );
  }

  private requirePreparedTask(preparedTask: PreparedTask): PreparedRecord {
    assertProtocolVersion(preparedTask.protocolVersion);
    const prepared = this.preparedTasks.get(preparedTask.preparedTaskId);
    if (
      prepared === undefined ||
      preparedTask.driverId !== CLAUDE_AGENT_DRIVER_ID ||
      preparedTask.taskId !== prepared.prepared.taskId ||
      preparedTask.taskVersion !== prepared.prepared.taskVersion
    ) {
      throw new ClaudeAgentDriverError(
        "CLAUDE_PREPARED_TASK_NOT_FOUND",
        "Prepared task is not owned by this Claude Agent Driver",
        { preparedTaskId: preparedTask.preparedTaskId },
      );
    }
    return prepared;
  }

  private requireRun(runId: string): RunRecord {
    const record = this.runs.get(runId);
    if (record === undefined) {
      throw new ClaudeAgentDriverError("CLAUDE_RUN_NOT_FOUND", "Claude Agent Run was not found", {
        runId,
      });
    }
    return record;
  }

  private restoreRun(state: ClaudeAgentDriverRecoveryState): void {
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
          usage.protocolVersion !== DRIVER_PROTOCOL_VERSION ||
          usage.source !== "driver_estimate",
      ) ||
      state.handle.state === "succeeded" ||
      state.handle.state === "failed" ||
      state.handle.state === "cancelled" ||
      this.runs.has(state.runId)
    ) {
      throw new ClaudeAgentDriverError(
        "CLAUDE_RECOVERY_STATE_INVALID",
        "Claude Agent recovery state is inconsistent",
        { runId: state.runId },
      );
    }
    const events = state.events.map((event) => structuredClone(event));
    const mapper = new ClaudeEventMapper(
      state.runId,
      state.handle.session.sessionId,
      this.now,
      this.redact,
      {
        events,
        state: state.mapper,
      },
    );
    this.runs.set(state.runId, {
      handle: structuredClone(state.handle),
      preparedTaskId: state.preparedTaskId,
      directory: this.options.workDirectory,
      mapper,
      events: new EventBuffer(events),
      output: [...state.output],
      sessionIds: new Set(state.sessionIds),
      contextUsageBySession: new Map(
        state.contextUsageBySession.map(([sessionId, usage]) => [
          sessionId,
          structuredClone(usage),
        ]),
      ),
      tokenUsage: state.tokenUsage === undefined ? undefined : structuredClone(state.tokenUsage),
      resultSummary: state.resultSummary,
    });
  }
}

export function createClaudeAgentDriver(
  options: CreateClaudeAgentDriverOptions,
): ClaudeAgentDriver {
  const runtime = new ClaudeAgentSdkRuntime({
    isolation: options.isolation,
    provider: options.provider,
    security: options.security,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
    sessionReadyTimeoutMs: options.sessionReadyTimeoutMs,
  });
  const privatePaths = [
    options.workDirectory,
    options.isolation.homeDirectory,
    options.isolation.tempDirectory,
    options.isolation.configDirectory,
    options.isolation.dataDirectory,
    options.isolation.cacheDirectory,
    options.isolation.claudeConfigDirectory,
  ];
  const privateValues = [options.provider?.authToken, options.provider?.apiKey].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  return new ClaudeAgentDriver(runtime, {
    workDirectory: options.workDirectory,
    now: options.now,
    createRunId: options.createRunId,
    recoveryStates: options.recoveryStates,
    redact: options.redact ?? ((value) => redactClaudeText(value, privatePaths, privateValues)),
  });
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
      "Claude Agent Driver received an unsupported protocol version",
      { expected: DRIVER_PROTOCOL_VERSION, received: value },
    );
  }
}

function assertActiveSession(record: RunRecord, sessionId: string): void {
  if (record.handle.session.sessionId !== sessionId) {
    throw new ClaudeAgentDriverError(
      "CLAUDE_SESSION_MISMATCH",
      "Request does not reference the active Claude Session",
      {
        expected: record.handle.session.sessionId,
        received: sessionId,
      },
    );
  }
}

function assertRunActive(record: RunRecord): void {
  if (record.result !== undefined) {
    throw new ClaudeAgentDriverError(
      "CLAUDE_RUN_TERMINAL",
      "Claude Agent Run is already terminal",
      {
        runId: record.handle.runId,
        state: record.handle.state,
      },
    );
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
    predecessorSessionId: input.predecessorSessionId,
  };
}

function renderPrompt(task: JsonObject, context: JsonObject): string {
  return JSON.stringify({
    task,
    context,
  });
}

function renderContinuation(
  kind: "resume" | "successor",
  reason: string,
  context: JsonObject | undefined,
): string {
  return JSON.stringify({
    kind,
    reason,
    context: context ?? {},
  });
}
