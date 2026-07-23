import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { RealProviderUsage } from "../contract.js";
import { assertRealGatewayPolicy, type RealGatewayPolicy } from "./provider-policy.js";
import { redactText } from "./redaction.js";

export interface RealProviderGateway {
  url: string;
  audit(): Promise<RealProviderUsage>;
  close(): Promise<RealProviderUsage>;
}

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const LOCAL_CHILD_PATH = join(MODULE_DIRECTORY, "real-provider-gateway-child.js");
const CHILD_PATH = existsSync(LOCAL_CHILD_PATH)
  ? LOCAL_CHILD_PATH
  : join(MODULE_DIRECTORY, "../../dist/harness/real-provider-gateway-child.js");

export async function startRealProviderGateway(input: {
  policy: RealGatewayPolicy;
  credential: Buffer;
}): Promise<RealProviderGateway> {
  assertRealGatewayPolicy(input.policy);
  const child = fork(CHILD_PATH, [], {
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "ignore", "pipe", "pipe", "ipc"],
    serialization: "advanced",
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 4_096) stderr += chunk.toString("utf8");
  });
  const secretPipe = child.stdio[3];
  if (!(secretPipe instanceof Writable)) {
    child.kill("SIGKILL");
    throw new Error("REAL_GATEWAY_SECRET_PIPE_UNAVAILABLE");
  }
  const ready = waitForMessage(child, "ready", 10_000);
  child.send({ type: "start", policy: input.policy });
  secretPipe.end(input.credential);
  const readyMessage = await ready.catch((error: unknown) => {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}:${redactText(stderr, [], [input.credential.toString("utf8")]).slice(0, 1_000)}`,
    );
  });
  const url = typeof readyMessage.url === "string" ? readyMessage.url : undefined;
  if (url === undefined || !url.startsWith("http://127.0.0.1:")) {
    child.kill("SIGKILL");
    throw new Error("REAL_GATEWAY_READY_INVALID");
  }
  return {
    url,
    audit: async () => {
      const result = waitForMessage(child, "audit", 5_000);
      child.send({ type: "audit" });
      return (await result).audit as RealProviderUsage;
    },
    close: async () => {
      const result = waitForMessage(child, "closed", 10_000);
      child.send({ type: "close" });
      const message = await result;
      await waitForExit(child, 5_000);
      return message.audit as RealProviderUsage;
    },
  };
}

function waitForMessage(
  child: ChildProcess,
  type: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error(`REAL_GATEWAY_${type.toUpperCase()}_TIMEOUT`)),
      timeoutMs,
    );
    const onMessage = (message: unknown) => {
      const record = asRecord(message);
      if (record?.type === type) finish(undefined, record);
    };
    const onExit = (code: number | null) =>
      finish(new Error(`REAL_GATEWAY_EXITED:${String(code)}`));
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error !== undefined) reject(error);
      else resolve(value ?? {});
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("REAL_GATEWAY_EXIT_TIMEOUT")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
