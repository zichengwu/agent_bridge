export const DRIVER_PROTOCOL_VERSION = "1.0" as const;

export type DriverProtocolVersion = typeof DRIVER_PROTOCOL_VERSION;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export interface DriverIdentity {
  readonly id: string;
  readonly displayName: string;
  readonly driverVersion: string;
}

export type PermissionDecisionKind = "allow" | "deny";
export type ContextUsageMode = "exact" | "estimated" | "unavailable";

export interface AgentCapabilities {
  readonly protocolVersion: DriverProtocolVersion;
  readonly driver: DriverIdentity;
  readonly sessions: {
    readonly persistentIds: boolean;
    readonly resume: boolean;
    readonly successorSessions: boolean;
  };
  readonly events: {
    readonly streaming: boolean;
    readonly strictOrdering: boolean;
  };
  readonly permissions:
    | {
        readonly mode: "none";
        readonly decisions: readonly [];
      }
    | {
        readonly mode: "interactive";
        readonly decisions: readonly PermissionDecisionKind[];
      };
  readonly cancellation: {
    readonly supported: boolean;
    readonly terminalEvent: boolean;
  };
  readonly contextUsage: {
    readonly mode: ContextUsageMode;
  };
}

export interface PrepareTaskRequest<TTask extends JsonObject = JsonObject> {
  readonly protocolVersion: DriverProtocolVersion;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly idempotencyKey: string;
  readonly task: TTask;
}

export interface PreparedTask {
  readonly protocolVersion: DriverProtocolVersion;
  readonly preparedTaskId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly driverId: string;
  readonly preparedAt: string;
  readonly data?: JsonObject;
}

export interface StartTaskRequest<TContext extends JsonObject = JsonObject> {
  readonly protocolVersion: DriverProtocolVersion;
  readonly preparedTask: PreparedTask;
  readonly context: TContext;
}

export type SessionState = "created" | "active" | "superseded" | "closed" | "failed";

export interface SessionHandle {
  readonly protocolVersion: DriverProtocolVersion;
  readonly sessionId: string;
  readonly externalSessionId: string;
  readonly runId: string;
  readonly state: SessionState;
  readonly createdAt: string;
  readonly predecessorSessionId?: string;
}

export type RunState =
  | "running"
  | "waiting_permission"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface RunHandle {
  readonly protocolVersion: DriverProtocolVersion;
  readonly runId: string;
  readonly state: RunState;
  readonly session: SessionHandle;
  readonly startedAt: string;
}

export interface ResumeTaskRequest<TContext extends JsonObject = JsonObject> {
  readonly protocolVersion: DriverProtocolVersion;
  readonly runId: string;
  readonly sessionId: string;
  readonly reason: string;
  readonly context?: TContext;
}

export interface SuccessorSessionRequest<TContext extends JsonObject = JsonObject> {
  readonly protocolVersion: DriverProtocolVersion;
  readonly runId: string;
  readonly predecessorSessionId: string;
  readonly reason: string;
  readonly context: TContext;
}

export interface FeedbackRequest<TFeedback extends JsonObject = JsonObject> {
  readonly protocolVersion: DriverProtocolVersion;
  readonly runId: string;
  readonly sessionId: string;
  readonly feedbackId: string;
  readonly feedback: TFeedback;
}

export type PermissionKind =
  | "filesystem.read"
  | "filesystem.write"
  | "process.execute"
  | "network.access"
  | "tool.use"
  | "other";

export interface PermissionRequest {
  readonly permissionId: string;
  readonly toolCallId: string;
  readonly kind: PermissionKind;
  readonly title: string;
  readonly description?: string;
  readonly details?: JsonObject;
}

export interface RespondToPermissionRequest {
  readonly protocolVersion: DriverProtocolVersion;
  readonly runId: string;
  readonly sessionId: string;
  readonly permissionId: string;
  readonly toolCallId: string;
  readonly decision: PermissionDecisionKind;
  readonly reason?: string;
}

export interface PermissionResponse {
  readonly protocolVersion: DriverProtocolVersion;
  readonly runId: string;
  readonly sessionId: string;
  readonly permissionId: string;
  readonly toolCallId: string;
  readonly decision: PermissionDecisionKind;
  readonly respondedAt: string;
}

export interface CancelTaskRequest {
  readonly protocolVersion: DriverProtocolVersion;
  readonly runId: string;
  readonly sessionId: string;
  readonly reason: string;
}

export interface CancellationReceipt {
  readonly protocolVersion: DriverProtocolVersion;
  readonly runId: string;
  readonly sessionId: string;
  readonly accepted: boolean;
  readonly requestedAt: string;
}

export interface ContextUsage {
  readonly protocolVersion: DriverProtocolVersion;
  readonly sessionId: string;
  readonly source: "driver_exact" | "driver_estimate" | "bridge_estimate";
  readonly usedTokens: number;
  readonly maxTokens?: number;
  readonly measuredAt: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface DriverError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonObject;
}

export interface AgentArtifact {
  readonly artifactId: string;
  readonly kind: string;
  readonly label: string;
  readonly uri?: string;
  readonly metadata?: JsonObject;
}

export interface AgentResult {
  readonly protocolVersion: DriverProtocolVersion;
  readonly runId: string;
  readonly sessionId: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly summary: string;
  readonly output: JsonObject;
  readonly artifacts: readonly AgentArtifact[];
  readonly usage?: TokenUsage;
  readonly error?: DriverError;
  readonly completedAt: string;
}

export interface HealthStatus {
  readonly protocolVersion: DriverProtocolVersion;
  readonly driverId: string;
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly checkedAt: string;
  readonly message?: string;
  readonly details?: JsonObject;
}

export interface AgentEventBase {
  readonly protocolVersion: DriverProtocolVersion;
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly runId: string;
  readonly sessionId: string;
}

export interface RunStartedEvent extends AgentEventBase {
  readonly type: "run.started";
  readonly preparedTaskId: string;
}

export interface RunResumedEvent extends AgentEventBase {
  readonly type: "run.resumed";
  readonly reason: string;
}

export interface OutputDeltaEvent extends AgentEventBase {
  readonly type: "output.delta";
  readonly messageId: string;
  readonly channel: "assistant" | "system";
  readonly delta: string;
}

export interface ToolStartedEvent extends AgentEventBase {
  readonly type: "tool.started";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input?: JsonObject;
}

export interface ToolCompletedEvent extends AgentEventBase {
  readonly type: "tool.completed";
  readonly toolCallId: string;
  readonly outcome: "succeeded" | "failed" | "denied" | "cancelled";
  readonly output?: JsonValue;
  readonly error?: DriverError;
}

export interface PermissionRequestedEvent extends AgentEventBase {
  readonly type: "permission.requested";
  readonly permission: PermissionRequest;
}

export interface PermissionRespondedEvent extends AgentEventBase {
  readonly type: "permission.responded";
  readonly permissionId: string;
  readonly toolCallId: string;
  readonly decision: PermissionDecisionKind;
  readonly reason?: string;
}

export interface UsageUpdatedEvent extends AgentEventBase {
  readonly type: "usage.updated";
  readonly usage: ContextUsage;
}

export interface SessionSuccessorCreatedEvent extends AgentEventBase {
  readonly type: "session.successor_created";
  readonly predecessorSessionId: string;
  readonly reason: string;
}

export interface RunCancellationRequestedEvent extends AgentEventBase {
  readonly type: "run.cancellation_requested";
  readonly reason: string;
}

export interface RunCompletedEvent extends AgentEventBase {
  readonly type: "run.completed";
}

export interface RunFailedEvent extends AgentEventBase {
  readonly type: "run.failed";
  readonly error: DriverError;
}

export interface RunCancelledEvent extends AgentEventBase {
  readonly type: "run.cancelled";
  readonly reason: string;
}

export type AgentEvent =
  | RunStartedEvent
  | RunResumedEvent
  | OutputDeltaEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | PermissionRequestedEvent
  | PermissionRespondedEvent
  | UsageUpdatedEvent
  | SessionSuccessorCreatedEvent
  | RunCancellationRequestedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent;

export interface AgentDriver<
  TTask extends JsonObject = JsonObject,
  TContext extends JsonObject = JsonObject,
  TFeedback extends JsonObject = JsonObject,
> {
  describeCapabilities(): Promise<AgentCapabilities>;
  prepareTask(request: PrepareTaskRequest<TTask>): Promise<PreparedTask>;
  startTask(request: StartTaskRequest<TContext>): Promise<RunHandle>;
  resumeTask(request: ResumeTaskRequest<TContext>): Promise<RunHandle>;
  streamEvents(runId: string): AsyncIterable<AgentEvent>;
  getContextUsage(sessionId: string): Promise<ContextUsage>;
  createSuccessorSession(request: SuccessorSessionRequest<TContext>): Promise<SessionHandle>;
  sendFeedback(request: FeedbackRequest<TFeedback>): Promise<void>;
  respondToPermission(request: RespondToPermissionRequest): Promise<PermissionResponse>;
  cancelTask(request: CancelTaskRequest): Promise<CancellationReceipt>;
  collectResult(runId: string): Promise<AgentResult>;
  healthCheck(): Promise<HealthStatus>;
}
