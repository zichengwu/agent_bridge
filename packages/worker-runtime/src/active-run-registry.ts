import {
  DRIVER_PROTOCOL_VERSION,
  type AgentEvent,
  type AgentResult,
} from "@agent-bridge/driver-protocol";
import type { AgentSessionBinding } from "@agent-bridge/schemas";

import { WorkerRuntimeError } from "./errors.js";
import type { RuntimeDriverHandle } from "./run-orchestrator.js";

export interface ActiveRunHandle {
  readonly run_id: string;
  readonly binding: AgentSessionBinding;
  readonly external_run_id: string;
  readonly external_session_id: string;
  readonly driver: RuntimeDriverHandle;
}

export type ActiveRunEventListener = (run: ActiveRunHandle, event: AgentEvent) => Promise<void>;

export class ActiveRunRegistry {
  private readonly runs = new Map<string, ActiveRunHandle>();
  private readonly eventTasks = new Map<string, Promise<void>>();

  register(value: ActiveRunHandle, listener?: ActiveRunEventListener): void {
    if (this.runs.has(value.run_id)) {
      throw invalidActiveRun("RUN_ALREADY_ACTIVE");
    }
    const handle = Object.freeze({ ...value });
    this.runs.set(value.run_id, handle);
    if (listener !== undefined) {
      const task = this.consumeEvents(handle, listener);
      this.eventTasks.set(value.run_id, task);
      void task.finally(() => this.eventTasks.delete(value.run_id)).catch(() => undefined);
    }
  }

  get(runId: string): ActiveRunHandle | undefined {
    return this.runs.get(runId);
  }

  require(runId: string): ActiveRunHandle {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw invalidActiveRun("ACTIVE_RUN_NOT_FOUND");
    }
    return run;
  }

  replaceBinding(
    runId: string,
    binding: AgentSessionBinding,
    externalSessionId: string,
  ): ActiveRunHandle {
    const current = this.require(runId);
    if (binding.run_id !== runId || binding.status !== "ACTIVE") {
      throw invalidActiveRun("ACTIVE_BINDING_INVALID");
    }
    const updated = Object.freeze({
      ...current,
      binding,
      external_session_id: externalSessionId,
    });
    this.runs.set(runId, updated);
    return updated;
  }

  async sendFeedback(
    runId: string,
    feedbackId: string,
    feedback: Readonly<Record<string, import("@agent-bridge/driver-protocol").JsonValue>>,
  ): Promise<void> {
    const run = this.require(runId);
    await run.driver.sendFeedback({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: run.external_run_id,
      sessionId: run.external_session_id,
      feedbackId,
      feedback,
    });
  }

  async respondToPermission(
    runId: string,
    permissionId: string,
    toolCallId: string,
    decision: "allow" | "deny",
    reason: string,
  ): Promise<void> {
    const run = this.require(runId);
    await run.driver.respondToPermission({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: run.external_run_id,
      sessionId: run.external_session_id,
      permissionId,
      toolCallId,
      decision,
      reason,
    });
  }

  async cancel(runId: string, reason: string): Promise<void> {
    const run = this.require(runId);
    await run.driver.cancelTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: run.external_run_id,
      sessionId: run.external_session_id,
      reason,
    });
  }

  async collectResult(runId: string): Promise<AgentResult> {
    const run = this.require(runId);
    return run.driver.collectResult(run.external_run_id);
  }

  async close(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      return;
    }
    this.runs.delete(runId);
    await run.driver.close?.();
    await this.eventTasks.get(runId)?.catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.runs.keys()].map((runId) => this.close(runId)));
  }

  private async consumeEvents(
    run: ActiveRunHandle,
    listener: ActiveRunEventListener,
  ): Promise<void> {
    for await (const event of run.driver.streamEvents(run.external_run_id)) {
      await listener(run, event);
    }
  }
}

function invalidActiveRun(reason: string): WorkerRuntimeError {
  return new WorkerRuntimeError("RECOVERY_NOT_ALLOWED", "Active run is unavailable", { reason });
}
