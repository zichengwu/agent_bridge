import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessRow {
  pid: number;
  parentPid: number;
  command: string;
}

export interface ProcessCleanupResult {
  observedPids: number[];
  terminatedPids: number[];
  residualPids: number[];
  residualCommands: string[];
}

export function parseProcessTable(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (match === null) {
      continue;
    }
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      command: match[3] ?? "",
    });
  }
  return rows;
}

export function findDescendantPids(rows: ProcessRow[], rootPid: number): number[] {
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (
        row.pid !== rootPid &&
        (row.parentPid === rootPid || descendants.has(row.parentPid)) &&
        !descendants.has(row.pid)
      ) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return [...descendants].sort((a, b) => a - b);
}

export class DescendantProcessTracker {
  readonly #rootPid: number;
  readonly #observed = new Set<number>();
  readonly #commands = new Map<number, string>();
  #timer: NodeJS.Timeout | undefined;
  #sampling = false;

  constructor(rootPid = process.pid) {
    this.#rootPid = rootPid;
  }

  async start(): Promise<void> {
    await this.sample();
    this.#timer = setInterval(() => void this.sample(), 50);
    this.#timer.unref();
  }

  async sample(): Promise<void> {
    if (this.#sampling) {
      return;
    }
    this.#sampling = true;
    try {
      const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,command="]);
      const rows = parseProcessTable(stdout).filter(
        (row) => !row.command.includes("/bin/ps -axo pid=,ppid=,command="),
      );
      const descendants = findDescendantPids(rows, this.#rootPid);
      for (const pid of descendants) {
        this.#observed.add(pid);
        const row = rows.find((candidate) => candidate.pid === pid);
        if (row !== undefined) {
          this.#commands.set(pid, row.command);
        }
      }
    } finally {
      this.#sampling = false;
    }
  }

  async stopAndCleanup(): Promise<ProcessCleanupResult> {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
    }
    await this.sample();
    let alivePids = [...this.#observed].filter(isProcessAlive);
    for (let attempt = 0; attempt < 20 && alivePids.length > 0; attempt += 1) {
      await delay(100);
      alivePids = alivePids.filter(isProcessAlive);
    }
    const terminatedPids = [...alivePids];
    for (const pid of alivePids) {
      safelyKill(pid, "SIGTERM");
    }
    if (alivePids.length > 0) {
      await delay(500);
      for (const pid of alivePids.filter(isProcessAlive)) {
        safelyKill(pid, "SIGKILL");
      }
    }
    await delay(100);
    const residualPids = [...this.#observed].filter(isProcessAlive);

    return {
      observedPids: [...this.#observed].sort((a, b) => a - b),
      terminatedPids,
      residualPids,
      residualCommands: residualPids.map((pid) => this.#commands.get(pid) ?? `pid:${pid}`),
    };
  }
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
    // The process may exit between the liveness check and the signal.
  }
}
