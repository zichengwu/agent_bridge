import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  DRIVER_PROTOCOL_VERSION,
  type AgentCapabilities,
  type AgentEvent,
  type AgentResult,
  type CancelTaskRequest,
  type CancellationReceipt,
  type ContextUsage,
  type HealthStatus,
  type PermissionResponse,
  type PrepareTaskRequest,
  type PreparedTask,
  type RespondToPermissionRequest,
  type RunHandle,
  type SessionHandle,
} from "@agent-bridge/driver-protocol";
import type { GitClient, RuntimeDriverHandle } from "@agent-bridge/worker-runtime";

export interface Phase2GFakeDriverOptions {
  readonly driver_id: "opencode" | "claude-agent";
  readonly worktree_path: string;
  readonly git: GitClient;
  readonly fail_start?: boolean;
  readonly write_on_start?: boolean;
  readonly now?: () => Date;
}

export class Phase2GFakeDriver implements RuntimeDriverHandle {
  readonly capabilities: AgentCapabilities;
  closed = false;
  private prepared?: PreparedTask;
  private handle?: RunHandle;

  constructor(private readonly options: Phase2GFakeDriverOptions) {
    this.capabilities = {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      driver: {
        id: options.driver_id,
        displayName: `Fake ${options.driver_id}`,
        driverVersion: "phase-2g",
      },
      sessions: { persistentIds: true, resume: true, successorSessions: true },
      events: { streaming: true, strictOrdering: true },
      permissions: { mode: "interactive", decisions: ["allow", "deny"] },
      cancellation: { supported: true, terminalEvent: true },
      contextUsage: { mode: "estimated" },
    };
  }

  describeCapabilities(): Promise<AgentCapabilities> {
    return Promise.resolve(structuredClone(this.capabilities));
  }

  prepareTask(request: PrepareTaskRequest): Promise<PreparedTask> {
    this.prepared = {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      preparedTaskId: `prepared-${this.options.driver_id}`,
      taskId: request.taskId,
      taskVersion: request.taskVersion,
      driverId: this.options.driver_id,
      preparedAt: this.now().toISOString(),
    };
    return Promise.resolve(this.prepared);
  }

  async startTask(): Promise<RunHandle> {
    if (this.options.fail_start === true) {
      throw Object.assign(new Error("synthetic start failure"), {
        code: "FAKE_DRIVER_START_FAILED",
      });
    }
    if (this.prepared === undefined) {
      throw new Error("task was not prepared");
    }
    if (this.options.write_on_start !== false) {
      const outputPath = `${this.options.worktree_path}/src/phase-2g-output.ts`;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, 'export const phase2g = "verified";\n', "utf8");
      await this.options.git.run(this.options.worktree_path, [
        "add",
        "--",
        "src/phase-2g-output.ts",
      ]);
      await this.options.git.run(this.options.worktree_path, [
        "-c",
        "user.name=Agent Bridge Test",
        "-c",
        "user.email=agent-bridge@example.invalid",
        "commit",
        "-m",
        `fake ${this.options.driver_id} output`,
      ]);
    }
    const runId = `external-run-${this.options.driver_id}`;
    const sessionId = `external-session-${this.options.driver_id}`;
    this.handle = {
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId,
      state: "running",
      session: {
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        sessionId,
        externalSessionId: sessionId,
        runId,
        state: "active",
        createdAt: this.now().toISOString(),
      },
      startedAt: this.now().toISOString(),
    };
    return structuredClone(this.handle);
  }

  resumeTask(): Promise<RunHandle> {
    return this.requireHandle();
  }

  streamEvents(): AsyncIterable<AgentEvent> {
    return (async function* () {})();
  }

  getContextUsage(sessionId: string): Promise<ContextUsage> {
    return Promise.resolve({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      sessionId,
      source: "bridge_estimate",
      usedTokens: 0,
      measuredAt: this.now().toISOString(),
    });
  }

  createSuccessorSession(): Promise<SessionHandle> {
    return Promise.reject(new Error("unused"));
  }

  sendFeedback(): Promise<void> {
    return Promise.resolve();
  }

  respondToPermission(request: RespondToPermissionRequest): Promise<PermissionResponse> {
    return Promise.resolve({
      ...request,
      respondedAt: this.now().toISOString(),
    });
  }

  cancelTask(request: CancelTaskRequest): Promise<CancellationReceipt> {
    return Promise.resolve({
      ...request,
      accepted: true,
      requestedAt: this.now().toISOString(),
    });
  }

  collectResult(runId: string): Promise<AgentResult> {
    const handle = this.handle;
    if (handle === undefined || handle.runId !== runId) {
      return Promise.reject(new Error("unknown run"));
    }
    return Promise.resolve({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId,
      sessionId: handle.session.sessionId,
      status: "succeeded",
      summary: "fake driver completed",
      output: {},
      artifacts: [],
      completedAt: this.now().toISOString(),
    });
  }

  healthCheck(): Promise<HealthStatus> {
    return Promise.resolve({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      driverId: this.options.driver_id,
      status: "healthy",
      checkedAt: this.now().toISOString(),
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  private requireHandle(): Promise<RunHandle> {
    return this.handle === undefined
      ? Promise.reject(new Error("run not started"))
      : Promise.resolve(structuredClone(this.handle));
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
