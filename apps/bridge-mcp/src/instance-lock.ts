import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { controlError } from "./errors.js";

const INSTANCE_LOCK_FILE = ".agent-bridge.instance.lock";

export interface BridgeInstanceLock {
  readonly instance_id: string;
  release(): Promise<void>;
}

interface LockRecord {
  readonly schema_version: 1;
  readonly instance_id: string;
  readonly pid: number;
}

export async function acquireBridgeInstanceLock(runtimeRoot: string): Promise<BridgeInstanceLock> {
  const lockPath = resolve(runtimeRoot, INSTANCE_LOCK_FILE);
  const instanceId = randomUUID();
  const record: LockRecord = { schema_version: 1, instance_id: instanceId, pid: process.pid };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      let released = false;
      return Object.freeze({
        instance_id: instanceId,
        release: async () => {
          if (released) return;
          released = true;
          const current = await readLockRecord(lockPath).catch(() => undefined);
          if (current?.instance_id !== instanceId) return;
          await unlink(lockPath).catch((error: unknown) => {
            if (!hasCode(error, "ENOENT")) throw error;
          });
        },
      });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw controlError("INTERNAL_ERROR");
      const existing = await readLockRecord(lockPath).catch(() => undefined);
      if (existing === undefined || processExists(existing.pid)) {
        throw controlError("BRIDGE_INSTANCE_CONFLICT");
      }
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await rename(lockPath, stalePath);
        await unlink(stalePath).catch(() => undefined);
      } catch (staleError) {
        if (hasCode(staleError, "ENOENT")) continue;
        throw controlError("BRIDGE_INSTANCE_CONFLICT");
      }
    }
  }
  throw controlError("BRIDGE_INSTANCE_CONFLICT");
}

async function readLockRecord(path: string): Promise<LockRecord> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { schema_version?: unknown }).schema_version !== 1 ||
    typeof (value as { instance_id?: unknown }).instance_id !== "string" ||
    !Number.isSafeInteger((value as { pid?: unknown }).pid) ||
    (value as { pid: number }).pid < 1
  ) {
    throw new Error("invalid instance lock");
  }
  return value as LockRecord;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
