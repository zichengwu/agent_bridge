import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Readable, Writable } from "node:stream";

import { WorkerRuntimeError } from "./errors.js";

export type ManagedProcessOutcome = "exited" | "cancelled" | "timed_out";

export interface DriverProcessSpec {
  readonly processId: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly terminationGraceMs?: number;
  readonly maxOutputBytes?: number;
  readonly captureStdout?: boolean;
}

export interface ManagedProcessExit {
  readonly processId: string;
  readonly pid: number;
  readonly outcome: ManagedProcessOutcome;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly descendantsCleaned: true;
}

export interface ManagedProcess {
  readonly processId: string;
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  wait(): Promise<ManagedProcessExit>;
  cancel(reason: string): Promise<ManagedProcessExit>;
}

export interface ProcessTreeController {
  terminate(pid: number, graceMs: number): Promise<void>;
}

export interface ProcessSupervisorOptions {
  readonly now?: () => Date;
  readonly treeController?: ProcessTreeController;
}

export class ProcessSupervisor {
  private readonly now: () => Date;
  private readonly treeController: ProcessTreeController;

  constructor(options: ProcessSupervisorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.treeController = options.treeController ?? new DefaultProcessTreeController();
  }

  async start(spec: DriverProcessSpec): Promise<ManagedProcess> {
    const normalized = readProcessSpec(spec);
    const startedAt = this.now().toISOString();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(normalized.command, [...normalized.args], {
        cwd: normalized.cwd,
        env: { ...normalized.environment },
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      await waitForSpawn(child);
    } catch {
      throw new WorkerRuntimeError("PROCESS_START_FAILED", "Driver process could not be started", {
        process_id: normalized.processId,
      });
    }

    const pid = child.pid;
    if (pid === undefined) {
      throw new WorkerRuntimeError(
        "PROCESS_START_FAILED",
        "Driver process did not expose a process identifier",
        { process_id: normalized.processId },
      );
    }

    const stdoutCapture = normalized.captureStdout
      ? captureStream(child.stdout, normalized.maxOutputBytes)
      : emptyCapture();
    const stderrCapture = captureStream(child.stderr, normalized.maxOutputBytes);
    let requestedOutcome: ManagedProcessOutcome = "exited";
    let termination: Promise<void> | undefined;

    const close = new Promise<readonly [number | null, NodeJS.Signals | null]>((resolve) => {
      child.once("close", (code, signal) => resolve([code, signal]));
    });

    const requestTermination = (outcome: ManagedProcessOutcome): Promise<void> => {
      if (requestedOutcome === "exited") {
        requestedOutcome = outcome;
      }
      termination ??= this.treeController.terminate(pid, normalized.terminationGraceMs);
      return termination;
    };

    const timeout = setTimeout(() => {
      void requestTermination("timed_out");
    }, normalized.timeoutMs);
    timeout.unref();

    const completion = close.then(async ([exitCode, signal]) => {
      clearTimeout(timeout);
      try {
        await (termination ?? this.treeController.terminate(pid, normalized.terminationGraceMs));
      } catch {
        throw new WorkerRuntimeError(
          "PROCESS_TREE_CLEANUP_FAILED",
          "Driver process tree cleanup could not be confirmed",
          { process_id: normalized.processId },
        );
      }
      const stdout = stdoutCapture.read();
      const stderr = stderrCapture.read();
      return Object.freeze({
        processId: normalized.processId,
        pid,
        outcome: requestedOutcome,
        exitCode,
        signal,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        startedAt,
        finishedAt: this.now().toISOString(),
        descendantsCleaned: true as const,
      });
    });

    return Object.freeze({
      processId: normalized.processId,
      pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      wait: () => completion,
      cancel: async (reason: string) => {
        void reason;
        await requestTermination("cancelled");
        return completion;
      },
    });
  }
}

export class DefaultProcessTreeController implements ProcessTreeController {
  async terminate(pid: number, graceMs: number): Promise<void> {
    if (process.platform === "win32") {
      await terminateWindowsTree(pid);
      return;
    }
    signalGroup(pid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (isGroupAlive(pid) && Date.now() < deadline) {
      await delay(20);
    }
    if (isGroupAlive(pid)) {
      signalGroup(pid, "SIGKILL");
    }
    const hardDeadline = Date.now() + Math.max(graceMs, 250);
    while (isGroupAlive(pid) && Date.now() < hardDeadline) {
      await delay(20);
    }
    if (isGroupAlive(pid)) {
      throw new Error("PROCESS_GROUP_STILL_ALIVE");
    }
  }
}

interface NormalizedProcessSpec {
  readonly processId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly terminationGraceMs: number;
  readonly maxOutputBytes: number;
  readonly captureStdout: boolean;
}

function readProcessSpec(value: DriverProcessSpec): NormalizedProcessSpec {
  if (
    typeof value !== "object" ||
    value === null ||
    !isIdentifier(value.processId) ||
    typeof value.command !== "string" ||
    !isAbsolute(value.command) ||
    typeof value.cwd !== "string" ||
    !isAbsolute(value.cwd) ||
    !Array.isArray(value.args ?? []) ||
    !(value.args ?? []).every(
      (argument) => typeof argument === "string" && !argument.includes("\0"),
    ) ||
    !isEnvironment(value.environment) ||
    !isPositiveInteger(value.timeoutMs)
  ) {
    throw new WorkerRuntimeError(
      "WORKER_CONFIGURATION_INVALID",
      "Driver process configuration is invalid",
    );
  }
  const terminationGraceMs = value.terminationGraceMs ?? 1_000;
  const maxOutputBytes = value.maxOutputBytes ?? 1024 * 1024;
  if (!isPositiveInteger(terminationGraceMs) || !isPositiveInteger(maxOutputBytes)) {
    throw new WorkerRuntimeError(
      "WORKER_CONFIGURATION_INVALID",
      "Driver process limits are invalid",
    );
  }
  return Object.freeze({
    processId: value.processId,
    command: value.command,
    args: Object.freeze([...(value.args ?? [])]),
    cwd: value.cwd,
    environment: Object.freeze({ ...value.environment }),
    timeoutMs: value.timeoutMs,
    terminationGraceMs,
    maxOutputBytes,
    captureStdout: value.captureStdout ?? true,
  });
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function captureStream(
  stream: Readable,
  limit: number,
): { read(): { text: string; truncated: boolean } } {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  stream.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = limit - size;
    if (remaining > 0) {
      const selected = bytes.subarray(0, remaining);
      chunks.push(selected);
      size += selected.length;
    }
    if (bytes.length > remaining) {
      truncated = true;
    }
  });
  return {
    read: () => ({ text: Buffer.concat(chunks).toString("utf8"), truncated }),
  };
}

function emptyCapture(): { read(): { text: string; truncated: boolean } } {
  return { read: () => ({ text: "", truncated: false }) };
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error)) {
      throw error;
    }
  }
}

function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) {
      return false;
    }
    throw error;
  }
}

async function terminateWindowsTree(pid: number): Promise<void> {
  const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  const [code] = (await once(child, "close")) as [number | null];
  if (code !== 0 && code !== 128) {
    throw new Error("TASKKILL_FAILED");
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ESRCH" || error.code === "EINVAL")
  );
}

function isEnvironment(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, entry]) => key.length > 0 && !key.includes("=") && typeof entry === "string",
    )
  );
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
