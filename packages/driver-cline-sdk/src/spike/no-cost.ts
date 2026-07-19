import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { ClineCore, type ClineCoreRuntime } from "../sdk-public-surface.js";
import { findMissingRuntimeMethods, inspectSdkSurface } from "./capabilities.js";

type SpikeMode = "hub" | "local";

interface HubDiscovery {
  authToken: string;
  pid?: number;
  url: string;
}

interface ManagedHub {
  child: ChildProcess;
  diagnostics: string[];
  discovery: HubDiscovery;
}

interface RuntimeCheck {
  mode: SpikeMode;
  passed: boolean;
  runtimeAddressPresent: boolean;
  historyCount: number;
  missingRuntimeMethods: string[];
  secondClientHistoryCount?: number;
  secondClientSameRuntime?: boolean;
  missingSessionUsage?: "undefined" | "error";
  autoStartPassed?: boolean;
  autoStartError?: {
    name: string;
    message: string;
  };
  hubBootstrapMode?: "managed-daemon-entry" | "sdk-detached";
  createdDataEntries: string[];
  diagnostics?: string[];
  error?: {
    name: string;
    message: string;
  };
}

function normalizeError(error: unknown): RuntimeCheck["error"] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
        .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
        .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]"),
    };
  }

  return { name: "UnknownError", message: String(error) };
}

function redactText(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replaceAll(process.env.HOME ?? "", "[TEMP_HOME]");
}

async function readDiagnosticTail(dataRoot: string): Promise<string[]> {
  const candidates = [join(dataRoot, "logs", "hub-daemon.log")];
  const diagnostics: string[] = [];

  for (const candidate of candidates) {
    const content = await readFile(candidate, "utf8").catch(() => undefined);
    if (content !== undefined) {
      diagnostics.push(...redactText(content).split("\n").filter(Boolean).slice(-40));
    }
  }

  return diagnostics;
}

function parseHubDiscovery(value: unknown): HubDiscovery | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.authToken !== "string" || typeof record.url !== "string") {
    return undefined;
  }

  return {
    authToken: record.authToken,
    pid: typeof record.pid === "number" ? record.pid : undefined,
    url: record.url,
  };
}

async function findHubDiscovery(root: string): Promise<HubDiscovery | undefined> {
  const entries = await listTree(root).catch(() => []);

  for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
    const content = await readFile(join(root, entry), "utf8").catch(() => undefined);
    if (content === undefined) {
      continue;
    }

    try {
      const discovery = parseHubDiscovery(JSON.parse(content) as unknown);
      if (discovery !== undefined) {
        return discovery;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

async function waitForHubDiscovery(root: string, child: ChildProcess): Promise<HubDiscovery> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const discovery = await findHubDiscovery(root);
    if (discovery !== undefined) {
      return discovery;
    }
    if (child.exitCode !== null) {
      throw new Error(`Managed Hub daemon exited before discovery: ${child.exitCode}`);
    }
    await delay(100);
  }

  throw new Error("Timed out waiting for managed Hub discovery record");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  const timedOut = delay(3_000).then(() => "timeout" as const);
  const result = await Promise.race([exited.then(() => "exited" as const), timedOut]);

  if (result === "timeout" && child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

async function startManagedHub(dataRoot: string): Promise<ManagedHub> {
  const daemonEntry = fileURLToPath(import.meta.resolve("@cline/core/hub/daemon-entry"));
  const diagnostics: string[] = [];
  const child = spawn(
    process.execPath,
    [daemonEntry, "--cwd", process.cwd(), "--host", "127.0.0.1", "--port", "25463"],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const capture = (chunk: Buffer | string): void => {
    diagnostics.push(...redactText(String(chunk)).split("\n").filter(Boolean));
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  try {
    const discovery = await waitForHubDiscovery(dataRoot, child);
    return { child, diagnostics, discovery };
  } catch (error) {
    await stopChild(child);
    const reason = error instanceof Error ? error.message : String(error);
    const diagnosticTail = diagnostics.slice(-40).join("\n");
    throw new Error(`${reason}${diagnosticTail ? `\n${diagnosticTail}` : ""}`, { cause: error });
  }
}

async function stopDiscoveredHub(dataRoot: string): Promise<void> {
  const discovery = await findHubDiscovery(dataRoot);
  if (discovery?.pid !== undefined && discovery.pid > 0 && discovery.pid !== process.pid) {
    try {
      process.kill(discovery.pid, "SIGTERM");
    } catch {
      return;
    }
  }
}

async function listTree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  return entries.map(String).sort();
}

async function checkLocal(dataRoot: string): Promise<RuntimeCheck> {
  const cline = await ClineCore.create({
    backendMode: "local",
    clientName: "agent-bridge-spike-local",
    distinctId: "agent-bridge-spike",
  });

  try {
    const history = await cline.list(5);
    let missingSessionUsage: RuntimeCheck["missingSessionUsage"] = "undefined";

    try {
      const usage = await cline.getAccumulatedUsage("agent-bridge-missing-session");
      missingSessionUsage = usage === undefined ? "undefined" : "error";
    } catch {
      missingSessionUsage = "error";
    }

    return {
      mode: "local",
      passed: findMissingRuntimeMethods(cline).length === 0,
      runtimeAddressPresent: cline.runtimeAddress !== undefined,
      historyCount: history.length,
      missingRuntimeMethods: findMissingRuntimeMethods(cline),
      missingSessionUsage,
      createdDataEntries: await listTree(dataRoot),
    };
  } finally {
    await cline.dispose("Agent Bridge no-cost local spike complete");
  }
}

async function checkHub(dataRoot: string): Promise<RuntimeCheck> {
  let autoStartPassed = false;
  let autoStartError: RuntimeCheck["autoStartError"];

  try {
    const autoClient = await ClineCore.create({
      backendMode: "hub",
      clientName: "agent-bridge-spike-hub-autostart",
      distinctId: "agent-bridge-spike",
      hub: {
        cwd: process.cwd(),
        strategy: "require-hub",
        workspaceRoot: process.cwd(),
      },
    });
    autoStartPassed = true;
    await autoClient.dispose("Agent Bridge detached hub auto-start check complete");
    await stopDiscoveredHub(dataRoot);
  } catch (error) {
    autoStartError = normalizeError(error);
  }

  const managedHub = await startManagedHub(dataRoot);
  let first: ClineCoreRuntime | undefined;
  let second: ClineCoreRuntime | undefined;

  try {
    first = await ClineCore.create({
      backendMode: "hub",
      clientName: "agent-bridge-spike-hub-primary",
      distinctId: "agent-bridge-spike",
      hub: {
        authToken: managedHub.discovery.authToken,
        cwd: process.cwd(),
        endpoint: managedHub.discovery.url,
        strategy: "require-hub",
        workspaceRoot: process.cwd(),
      },
    });
    second = await ClineCore.create({
      backendMode: "hub",
      clientName: "agent-bridge-spike-hub-secondary",
      distinctId: "agent-bridge-spike",
      hub: {
        authToken: managedHub.discovery.authToken,
        cwd: process.cwd(),
        endpoint: managedHub.discovery.url,
        strategy: "require-hub",
        workspaceRoot: process.cwd(),
      },
    });

    const [firstHistory, secondHistory] = await Promise.all([first.list(5), second.list(5)]);
    const unsubscribe = second.subscribe(() => undefined);
    unsubscribe();

    return {
      mode: "hub",
      passed: findMissingRuntimeMethods(first).length === 0,
      autoStartError,
      autoStartPassed,
      hubBootstrapMode: autoStartPassed ? "sdk-detached" : "managed-daemon-entry",
      runtimeAddressPresent: first.runtimeAddress !== undefined,
      historyCount: firstHistory.length,
      missingRuntimeMethods: findMissingRuntimeMethods(first),
      secondClientHistoryCount: secondHistory.length,
      secondClientSameRuntime:
        first.runtimeAddress !== undefined && first.runtimeAddress === second.runtimeAddress,
      createdDataEntries: await listTree(dataRoot),
      diagnostics: managedHub.diagnostics.slice(-40),
    };
  } finally {
    if (second !== undefined) {
      await second.dispose("Agent Bridge no-cost secondary hub client complete");
    }
    if (first !== undefined) {
      await first.dispose("Agent Bridge no-cost primary hub client complete");
    }
    await stopChild(managedHub.child);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "local" && mode !== "hub") {
    throw new Error("Usage: no-cost.ts <local|hub>");
  }

  const tempHome = await mkdtemp(join(tmpdir(), `agent-bridge-cline-${mode}-`));
  const dataRoot = join(tempHome, "cline-data");
  process.env.CLINE_DATA_DIR = dataRoot;
  process.env.HOME = tempHome;

  let runtime: RuntimeCheck;
  try {
    runtime = mode === "local" ? await checkLocal(dataRoot) : await checkHub(dataRoot);
  } catch (error) {
    runtime = {
      mode,
      passed: false,
      runtimeAddressPresent: false,
      historyCount: 0,
      missingRuntimeMethods: [],
      createdDataEntries: await listTree(tempHome).catch(() => []),
      diagnostics: await readDiagnosticTail(dataRoot),
      error: normalizeError(error),
    };
    process.exitCode = 1;
  } finally {
    await stopDiscoveredHub(dataRoot);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        sdk: inspectSdkSurface(),
        runtime,
      },
      null,
      2,
    )}\n`,
  );

  await rm(tempHome, { force: true, recursive: true });
}

await main();
