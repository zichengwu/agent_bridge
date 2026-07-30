import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import { WorkerRuntimeError } from "./errors.js";

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface GitClient {
  run(
    cwd: string,
    args: readonly string[],
    allowedExitCodes?: readonly number[],
  ): Promise<GitCommandResult>;
}

export interface DefaultGitClientOptions {
  readonly executable: string;
  readonly maxOutputBytes?: number;
}

export class DefaultGitClient implements GitClient {
  private readonly maxOutputBytes: number;

  constructor(private readonly options: DefaultGitClientOptions) {
    const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
    if (
      !isAbsolute(options.executable) ||
      !Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes <= 0
    ) {
      throw new WorkerRuntimeError(
        "WORKER_CONFIGURATION_INVALID",
        "Git client configuration is invalid",
      );
    }
    this.maxOutputBytes = maxOutputBytes;
  }

  run(
    cwd: string,
    args: readonly string[],
    allowedExitCodes: readonly number[] = [0],
  ): Promise<GitCommandResult> {
    const commandArguments = readArguments(args);
    const acceptedExitCodes = readExitCodes(allowedExitCodes);
    if (!isAbsolute(cwd) || commandArguments === undefined || acceptedExitCodes === undefined) {
      return Promise.reject(
        new WorkerRuntimeError("WORKER_CONFIGURATION_INVALID", "Git command is invalid"),
      );
    }
    return new Promise((resolve, reject) => {
      const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
      const child = spawn(this.options.executable, commandArguments, {
        cwd,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LC_ALL: "C",
          GIT_CONFIG_GLOBAL: nullDevice,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "core.hooksPath",
          GIT_CONFIG_VALUE_0: nullDevice,
          GIT_CONFIG_KEY_1: "core.fsmonitor",
          GIT_CONFIG_VALUE_1: "false",
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let exceeded = false;
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= this.maxOutputBytes) {
          stdout.push(chunk);
        } else {
          exceeded = true;
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= this.maxOutputBytes) {
          stderr.push(chunk);
        } else {
          exceeded = true;
        }
      });
      child.once("error", () => {
        reject(new WorkerRuntimeError("GIT_REPOSITORY_INVALID", "Git command could not start"));
      });
      child.once("close", (code) => {
        if (exceeded) {
          reject(
            new WorkerRuntimeError(
              "GIT_REPOSITORY_INVALID",
              "Git command output exceeded the limit",
            ),
          );
          return;
        }
        const exitCode = code ?? -1;
        if (!acceptedExitCodes.includes(exitCode)) {
          reject(
            new WorkerRuntimeError("GIT_REPOSITORY_INVALID", "Git command failed", {
              exit_code: exitCode,
            }),
          );
          return;
        }
        resolve({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
    });
  }
}

function readArguments(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    !value.every(
      (argument: unknown): argument is string =>
        typeof argument === "string" && !argument.includes("\0"),
    )
  ) {
    return undefined;
  }
  return value.map((argument) => argument);
}

function readExitCodes(value: unknown): number[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((code: unknown): code is number => Number.isSafeInteger(code) && Number(code) >= 0)
  ) {
    return undefined;
  }
  return value.map((code) => code);
}
