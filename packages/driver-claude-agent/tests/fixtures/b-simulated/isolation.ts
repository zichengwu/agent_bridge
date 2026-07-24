import { execFile } from "node:child_process";
import { access, chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import type { ClaudeAgentIsolationConfiguration } from "../../../src/config.js";

const execFileAsync = promisify(execFile);

const SECRET_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /(Bearer\s+)[^\s,;]+/gi,
  /((?:api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie)["'\s:=]+)[^\s,"'}]+/gi,
];

export interface IsolatedClaudeEnvironment {
  readonly root: string;
  readonly isolation: ClaudeAgentIsolationConfiguration;
  readonly executablePath: string;
  readonly privatePaths: readonly string[];
}

export async function createIsolatedClaudeEnvironment(input: {
  readonly root: string;
  readonly workDirectory: string;
  readonly originalEnvironment: NodeJS.ProcessEnv;
}): Promise<IsolatedClaudeEnvironment> {
  if (process.platform !== "darwin") {
    throw new Error("CLAUDE_B_SIMULATED_REQUIRES_MACOS_SANDBOX");
  }
  await access("/usr/bin/sandbox-exec");

  const isolationRoot = join(input.root, "isolation");
  const home = join(isolationRoot, "home");
  const tempDirectory = join(isolationRoot, "tmp");
  const configDirectory = join(isolationRoot, "config");
  const dataDirectory = join(isolationRoot, "data");
  const cacheDirectory = join(isolationRoot, "cache");
  const claudeConfigDirectory = join(isolationRoot, "claude-config");
  const binDirectory = join(isolationRoot, "bin");
  const profilePath = join(isolationRoot, "sandbox.sb");
  await Promise.all(
    [
      home,
      tempDirectory,
      configDirectory,
      dataDirectory,
      cacheDirectory,
      claudeConfigDirectory,
      binDirectory,
    ].map((directory) => mkdir(directory, { recursive: true })),
  );

  const deniedReadRoots = sensitiveConfigurationPaths(input.originalEnvironment);
  const writableRoots = await Promise.all(
    [isolationRoot, input.workDirectory].map((path) => realpath(path)),
  );
  await writeFile(profilePath, buildSandboxProfile(writableRoots, deniedReadRoots), "utf8");
  const realExecutable = await resolveClaudeExecutable();
  const executablePath = join(binDirectory, "claude");
  await writeFile(
    executablePath,
    [
      "#!/bin/sh",
      `exec /usr/bin/sandbox-exec -f ${shellQuote(profilePath)} ${shellQuote(realExecutable)} "$@"`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(executablePath, 0o700);

  return {
    root: isolationRoot,
    isolation: {
      homeDirectory: home,
      tempDirectory,
      configDirectory,
      dataDirectory,
      cacheDirectory,
      claudeConfigDirectory,
      path: `${binDirectory}${delimiter}${input.originalEnvironment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
      lang: input.originalEnvironment.LANG ?? "C.UTF-8",
    },
    executablePath,
    privatePaths: [
      input.root,
      isolationRoot,
      input.workDirectory,
      home,
      tempDirectory,
      configDirectory,
      dataDirectory,
      cacheDirectory,
      claudeConfigDirectory,
      ...deniedReadRoots,
    ],
  };
}

export function isolatedProcessEnvironment(
  isolation: ClaudeAgentIsolationConfiguration,
): Record<string, string> {
  return {
    PATH: isolation.path ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: isolation.homeDirectory,
    TMPDIR: isolation.tempDirectory,
    LANG: isolation.lang ?? "C.UTF-8",
    LC_ALL: isolation.lang ?? "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    XDG_CONFIG_HOME: isolation.configDirectory,
    XDG_DATA_HOME: isolation.dataDirectory,
    XDG_CACHE_HOME: isolation.cacheDirectory,
    CLAUDE_CONFIG_DIR: isolation.claudeConfigDirectory,
    CLAUDE_CODE_TMPDIR: isolation.tempDirectory,
  };
}

export function replaceProcessEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, environment);
}

export function redactText(
  value: string,
  privatePaths: readonly string[],
  privateValues: readonly string[],
): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, prefix?: string) =>
      prefix === undefined ? "[REDACTED]" : `${prefix}[REDACTED]`,
    );
  }
  for (const path of [...privatePaths].filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.replaceAll(path, "[ISOLATED_PATH]");
  }
  for (const secret of [...privateValues].filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

export function safeError(
  error: unknown,
  privatePaths: readonly string[],
  privateValues: readonly string[],
): string {
  const details =
    typeof error === "object" &&
    error !== null &&
    "details" in error &&
    typeof error.details === "object"
      ? ` ${JSON.stringify(error.details)}`
      : "";
  const message =
    error instanceof Error ? `${error.name}: ${error.message}${details}` : String(error);
  return redactText(message, privatePaths, privateValues);
}

export async function assertRootRemoved(root: string): Promise<void> {
  await access(root).then(
    () => {
      throw new Error("CLAUDE_B_SIMULATED_TEMP_ROOT_REMAINS");
    },
    () => undefined,
  );
}

interface ProcessRow {
  readonly pid: number;
  readonly parentPid: number;
}

export class DescendantProcessTracker {
  private readonly observed = new Set<number>();
  private timer?: NodeJS.Timeout;

  async start(): Promise<void> {
    await this.sample();
    this.timer = setInterval(() => void this.sample(), 50);
    this.timer.unref();
  }

  async stopAndCleanup(): Promise<{ readonly residualProcessCount: number }> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
    }
    await this.sample();
    let alive = [...this.observed].filter(isProcessAlive);
    for (let attempt = 0; attempt < 20 && alive.length > 0; attempt += 1) {
      await delay(100);
      alive = alive.filter(isProcessAlive);
    }
    for (const pid of alive) {
      safelyKill(pid, "SIGTERM");
    }
    if (alive.length > 0) {
      await delay(500);
      for (const pid of alive.filter(isProcessAlive)) {
        safelyKill(pid, "SIGKILL");
      }
    }
    await delay(100);
    return {
      residualProcessCount: [...this.observed].filter(isProcessAlive).length,
    };
  }

  private async sample(): Promise<void> {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid="]);
    const rows = stdout.split("\n").flatMap((line): ProcessRow[] => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
      return match === null ? [] : [{ pid: Number(match[1]), parentPid: Number(match[2]) }];
    });
    const descendants = new Set<number>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (
          row.pid !== process.pid &&
          (row.parentPid === process.pid || descendants.has(row.parentPid)) &&
          !descendants.has(row.pid)
        ) {
          descendants.add(row.pid);
          changed = true;
        }
      }
    }
    for (const pid of descendants) {
      this.observed.add(pid);
    }
  }
}

function sensitiveConfigurationPaths(environment: NodeJS.ProcessEnv): string[] {
  const home = environment.HOME;
  return [
    environment.CODEX_HOME,
    environment.CLAUDE_CONFIG_DIR,
    home === undefined ? undefined : join(home, ".codex"),
    home === undefined ? undefined : join(home, ".claude"),
    home === undefined ? undefined : join(home, "Library", "Keychains"),
    environment.XDG_CONFIG_HOME === undefined
      ? undefined
      : join(environment.XDG_CONFIG_HOME, "claude"),
    "/Library/Keychains",
  ].filter((path): path is string => path !== undefined && path !== "");
}

function buildSandboxProfile(writableRoots: readonly string[], deniedReadRoots: readonly string[]) {
  const roots = writableRoots.map((root) => resolve(root));
  return [
    "(version 1)",
    "(allow default)",
    '(deny network-inbound (require-not (local ip "localhost:*")))',
    '(deny network-outbound (require-not (remote ip "localhost:*")))',
    `(deny file-write* (require-not (regex #"^(${[...roots, "/dev/null"]
      .map(escapeRegex)
      .join("|")})(/|$)")))`,
    ...deniedReadRoots.map(
      (root) => `(deny file-read* (subpath "${escapeSandboxString(resolve(root))}"))`,
    ),
  ].join("\n");
}

async function resolveClaudeExecutable(): Promise<string> {
  const sdkEntry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const scopeDirectory = dirname(dirname(sdkEntry));
  return realpath(
    join(
      scopeDirectory,
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      process.platform === "win32" ? "claude.exe" : "claude",
    ),
  );
}

function escapeSandboxString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeRegex(value: string): string {
  return escapeSandboxString(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safelyKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // 进程可能在存活检查与信号发送之间自然退出。
  }
}
