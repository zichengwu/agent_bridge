import { randomUUID } from "node:crypto";

import {
  DRIVER_TRANSPORT_VERSION,
  assertAgentCapabilities,
  assertDriverTransportMessage,
  asJsonObject,
  readJsonLines,
  writeJsonLine,
  type AgentCapabilities,
  type AgentDriver,
  type AgentEvent,
  type AgentResult,
  type CancelTaskRequest,
  type CancellationReceipt,
  type ContextUsage,
  type DriverTransportMessage,
  type DriverTransportMethod,
  type DriverWorkerInitialization,
  type FeedbackRequest,
  type HealthStatus,
  type JsonObject,
  type JsonValue,
  type PermissionResponse,
  type PrepareTaskRequest,
  type PreparedTask,
  type RespondToPermissionRequest,
  type ResumeTaskRequest,
  type RunHandle,
  type SessionHandle,
  type StartTaskRequest,
  type SuccessorSessionRequest,
} from "@agent-bridge/driver-protocol";

import { WorkerRuntimeError } from "./errors.js";
import {
  ProcessSupervisor,
  type DriverProcessSpec,
  type ManagedProcess,
  type ManagedProcessExit,
} from "./process-supervisor.js";

export interface StdioAgentDriverClientOptions {
  readonly supervisor: ProcessSupervisor;
  readonly process: DriverProcessSpec;
  readonly initialization: DriverWorkerInitialization;
  readonly requestTimeoutMs?: number;
  readonly createRequestId?: () => string;
  readonly createSubscriptionId?: () => string;
}

interface PendingRequest {
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: unknown) => void;
  readonly timeout: NodeJS.Timeout;
}

export class StdioAgentDriverClient implements AgentDriver {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscriptions = new Map<string, EventQueue>();
  private readonly ready = new Deferred<void>();
  private readonly requestTimeoutMs: number;
  private readonly createRequestId: () => string;
  private readonly createSubscriptionId: () => string;
  private readerTask: Promise<void>;
  private closeTask?: Promise<ManagedProcessExit>;
  private isClosed = false;

  private constructor(
    private readonly process: ManagedProcess,
    options: StdioAgentDriverClientOptions,
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.createRequestId = options.createRequestId ?? randomUUID;
    this.createSubscriptionId = options.createSubscriptionId ?? randomUUID;
    this.readerTask = this.readMessages();
    void this.readerTask.catch(() => undefined);
    void this.process.wait().then(
      () => this.handleTransportClosed(),
      (error) => this.handleTransportClosed(error),
    );
  }

  static async start(options: StdioAgentDriverClientOptions): Promise<StdioAgentDriverClient> {
    const process = await options.supervisor.start({
      ...options.process,
      captureStdout: false,
    });
    const client = new StdioAgentDriverClient(process, options);
    try {
      await client.ready.promise;
      await client.request("initialize", asJsonObject(options.initialization));
      return client;
    } catch (error) {
      await process.cancel("Driver transport initialization failed").catch(() => undefined);
      throw error;
    }
  }

  async describeCapabilities(): Promise<AgentCapabilities> {
    const result = await this.request("describeCapabilities", {});
    assertAgentCapabilities(result);
    return result;
  }

  async prepareTask(request: PrepareTaskRequest): Promise<PreparedTask> {
    return (await this.request("prepareTask", asJsonObject(request))) as unknown as PreparedTask;
  }

  async startTask(request: StartTaskRequest): Promise<RunHandle> {
    return (await this.request("startTask", asJsonObject(request))) as unknown as RunHandle;
  }

  async resumeTask(request: ResumeTaskRequest): Promise<RunHandle> {
    return (await this.request("resumeTask", asJsonObject(request))) as unknown as RunHandle;
  }

  streamEvents(runId: string): AsyncIterable<AgentEvent> {
    const subscriptionId = this.createSubscriptionId();
    const queue = new EventQueue();
    this.subscriptions.set(subscriptionId, queue);
    void this.request("subscribeEvents", { runId, subscriptionId }).catch((error) => {
      this.subscriptions.delete(subscriptionId);
      queue.fail(error);
    });
    return queue.stream(async () => {
      this.subscriptions.delete(subscriptionId);
      await this.request("unsubscribeEvents", { subscriptionId }).catch(() => undefined);
    });
  }

  async getContextUsage(sessionId: string): Promise<ContextUsage> {
    return (await this.request("getContextUsage", { sessionId })) as unknown as ContextUsage;
  }

  async createSuccessorSession(request: SuccessorSessionRequest): Promise<SessionHandle> {
    return (await this.request(
      "createSuccessorSession",
      asJsonObject(request),
    )) as unknown as SessionHandle;
  }

  async sendFeedback(request: FeedbackRequest): Promise<void> {
    await this.request("sendFeedback", asJsonObject(request));
  }

  async respondToPermission(request: RespondToPermissionRequest): Promise<PermissionResponse> {
    return (await this.request(
      "respondToPermission",
      asJsonObject(request),
    )) as unknown as PermissionResponse;
  }

  async cancelTask(request: CancelTaskRequest): Promise<CancellationReceipt> {
    try {
      return (await this.request(
        "cancelTask",
        asJsonObject(request),
      )) as unknown as CancellationReceipt;
    } catch (error) {
      await this.process.cancel("Driver cancellation RPC failed").catch(() => undefined);
      throw error;
    }
  }

  async collectResult(runId: string): Promise<AgentResult> {
    return (await this.request("collectResult", { runId })) as unknown as AgentResult;
  }

  async healthCheck(): Promise<HealthStatus> {
    return (await this.request("healthCheck", {})) as unknown as HealthStatus;
  }

  async exportRecoveryState(runId: string): Promise<JsonObject> {
    const value = await this.request("exportRecoveryState", { runId });
    return asJsonObject(value);
  }

  async close(): Promise<ManagedProcessExit> {
    this.closeTask ??= this.closeOnce();
    return this.closeTask;
  }

  wait(): Promise<ManagedProcessExit> {
    return this.process.wait();
  }

  private async closeOnce(): Promise<ManagedProcessExit> {
    if (!this.isClosed) {
      await this.request("shutdown", {}).catch(async () => {
        await this.process.cancel("Driver shutdown RPC failed");
      });
      this.process.stdin.end();
    }
    const result = await this.process.wait();
    await this.readerTask.catch(() => undefined);
    return result;
  }

  private async request(method: DriverTransportMethod, params: JsonObject): Promise<JsonValue> {
    if (this.isClosed) {
      throw transportClosed();
    }
    const requestId = this.createRequestId();
    if (this.pending.has(requestId)) {
      throw new WorkerRuntimeError(
        "WORKER_CONFIGURATION_INVALID",
        "Driver request ID factory returned a duplicate identifier",
      );
    }
    const deferred = new Deferred<JsonValue>();
    const timeout = setTimeout(() => {
      this.pending.delete(requestId);
      deferred.reject(
        new WorkerRuntimeError("DRIVER_REQUEST_FAILED", "Driver request timed out", {
          method,
        }),
      );
    }, this.requestTimeoutMs);
    timeout.unref();
    this.pending.set(requestId, {
      resolve: deferred.resolve,
      reject: deferred.reject,
      timeout,
    });

    try {
      await writeJsonLine(this.process.stdin, {
        kind: "request",
        transportVersion: DRIVER_TRANSPORT_VERSION,
        requestId,
        method,
        params,
      });
    } catch (error) {
      clearTimeout(timeout);
      this.pending.delete(requestId);
      throw error;
    }
    return deferred.promise;
  }

  private async readMessages(): Promise<void> {
    try {
      for await (const value of readJsonLines(this.process.stdout)) {
        assertDriverTransportMessage(value);
        this.acceptMessage(value);
      }
      this.handleTransportClosed();
    } catch (error) {
      this.handleTransportClosed(error);
      throw error;
    }
  }

  private acceptMessage(message: DriverTransportMessage): void {
    switch (message.kind) {
      case "ready":
        this.ready.resolve();
        return;
      case "response": {
        const pending = this.pending.get(message.requestId);
        if (pending === undefined) {
          throw new WorkerRuntimeError(
            "DRIVER_REQUEST_FAILED",
            "Driver response has no pending request",
            { request_id: message.requestId },
          );
        }
        clearTimeout(pending.timeout);
        this.pending.delete(message.requestId);
        if (message.ok) {
          pending.resolve(message.result);
        } else {
          pending.reject(
            new WorkerRuntimeError("DRIVER_REQUEST_FAILED", message.error.message, {
              remote_code: message.error.code,
              retryable: message.error.retryable,
            }),
          );
        }
        return;
      }
      case "event":
        this.requireSubscription(message.subscriptionId).push(message.event);
        return;
      case "stream_closed":
        this.requireSubscription(message.subscriptionId).close();
        this.subscriptions.delete(message.subscriptionId);
        return;
      case "request":
        throw new WorkerRuntimeError(
          "DRIVER_REQUEST_FAILED",
          "Driver client received an unexpected request message",
        );
    }
  }

  private handleTransportClosed(error: unknown = transportClosed()): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.ready.reject(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const subscription of this.subscriptions.values()) {
      subscription.fail(error);
    }
    this.subscriptions.clear();
  }

  private requireSubscription(subscriptionId: string): EventQueue {
    const subscription = this.subscriptions.get(subscriptionId);
    if (subscription === undefined) {
      throw new WorkerRuntimeError(
        "DRIVER_REQUEST_FAILED",
        "Driver event has no pending subscription",
        { subscription_id: subscriptionId },
      );
    }
    return subscription;
  }
}

class EventQueue {
  private readonly values: AgentEvent[] = [];
  private readonly waiters: Array<Deferred<IteratorResult<AgentEvent>>> = [];
  private ended = false;
  private error?: Error;

  push(value: AgentEvent): void {
    if (this.ended) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.values.push(structuredClone(value));
    } else {
      waiter.resolve({ done: false, value: structuredClone(value) });
    }
  }

  close(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    this.error = asError(error);
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  stream(onReturn: () => Promise<void>): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<AgentEvent> => ({
        next: (): Promise<IteratorResult<AgentEvent>> => {
          if (this.values.length > 0) {
            return Promise.resolve({ done: false, value: this.values.shift()! });
          }
          if (this.error !== undefined) {
            return Promise.reject(this.error);
          }
          if (this.ended) {
            return Promise.resolve({ done: true, value: undefined });
          }
          const deferred = new Deferred<IteratorResult<AgentEvent>>();
          this.waiters.push(deferred);
          return deferred.promise;
        },
        return: async (): Promise<IteratorResult<AgentEvent>> => {
          this.close();
          await onReturn();
          return { done: true, value: undefined };
        },
      }),
    };
  }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;

  constructor() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    this.promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.resolve = resolve;
    this.reject = reject;
  }
}

function transportClosed(): WorkerRuntimeError {
  return new WorkerRuntimeError("DRIVER_REQUEST_FAILED", "Driver transport is closed");
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Driver event stream failed", { cause: value });
}
