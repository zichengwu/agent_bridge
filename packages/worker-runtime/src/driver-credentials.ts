import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { WorkerRuntimeError } from "./errors.js";
import type { RuntimeDriverConfiguration } from "./runtime-config.js";

export const DRIVER_CREDENTIAL_ENVIRONMENT = Object.freeze({
  opencode: "AGENT_BRIDGE_OPENCODE_API_KEY",
  "claude-agent": "AGENT_BRIDGE_CLAUDE_AUTH_TOKEN",
} as const);

export interface CredentialPathBoundaries {
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
  readonly runtimeRoot: string;
}

export async function resolveDriverCredentialEnvironment(
  driver: RuntimeDriverConfiguration,
  boundaries: CredentialPathBoundaries,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Readonly<Record<string, string>>> {
  if (driver.provider === undefined || driver.credentials === undefined) {
    return Object.freeze({});
  }
  const variable = DRIVER_CREDENTIAL_ENVIRONMENT[driver.id];
  const environmentValue = environment[variable];
  if (driver.credentials.source === "environment") {
    if (environmentValue === undefined || environmentValue.length === 0) {
      throw credentialError("CREDENTIAL_ENVIRONMENT_MISSING", driver.id);
    }
    return Object.freeze({ [variable]: environmentValue });
  }
  if (environmentValue !== undefined) {
    throw credentialError("CREDENTIAL_SOURCE_CONFLICT", driver.id);
  }
  const value = await readCredentialFile(driver, driver.credentials.path, boundaries);
  return Object.freeze({ [variable]: value });
}

async function readCredentialFile(
  driver: RuntimeDriverConfiguration,
  path: string,
  boundaries: CredentialPathBoundaries,
): Promise<string> {
  if (
    !isAbsolute(path) ||
    isWithin(path, boundaries.repositoryRoot) ||
    isWithin(path, boundaries.workspaceRoot) ||
    isWithin(path, boundaries.runtimeRoot)
  ) {
    throw credentialError("CREDENTIAL_FILE_LOCATION_FORBIDDEN", driver.id);
  }
  let canonicalPath: string;
  let canonicalParent: string;
  let canonicalWorkspace: string;
  let canonicalRepository: string;
  let canonicalRuntime: string;
  try {
    [canonicalPath, canonicalParent, canonicalRepository, canonicalWorkspace, canonicalRuntime] =
      await Promise.all([
        realpath(path),
        realpath(dirname(path)),
        realpath(boundaries.repositoryRoot),
        realpath(boundaries.workspaceRoot),
        realpath(boundaries.runtimeRoot).catch(() => resolve(boundaries.runtimeRoot)),
      ]);
  } catch {
    throw credentialError("CREDENTIAL_FILE_UNAVAILABLE", driver.id);
  }
  if (
    canonicalPath !== resolve(canonicalParent, basename(path)) ||
    isWithin(canonicalPath, canonicalRepository) ||
    isWithin(canonicalPath, canonicalWorkspace) ||
    isWithin(canonicalPath, canonicalRuntime)
  ) {
    throw credentialError("CREDENTIAL_FILE_LOCATION_FORBIDDEN", driver.id);
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw credentialError("CREDENTIAL_FILE_NOT_REGULAR", driver.id);
    }
    if (process.platform !== "win32") {
      const currentUid = process.getuid?.();
      if (currentUid !== undefined && stat.uid !== currentUid) {
        throw credentialError("CREDENTIAL_FILE_OWNER_INVALID", driver.id);
      }
      if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0) {
        throw credentialError("CREDENTIAL_FILE_MODE_INVALID", driver.id);
      }
    }
    const source = await handle.readFile({ encoding: "utf8" });
    return parseCredentialDocument(driver.id, source);
  } catch (error) {
    if (error instanceof WorkerRuntimeError) throw error;
    throw credentialError("CREDENTIAL_FILE_UNAVAILABLE", driver.id);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseCredentialDocument(
  driverId: RuntimeDriverConfiguration["id"],
  source: string,
): string {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw credentialError("CREDENTIAL_FILE_SCHEMA_INVALID", driverId);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw credentialError("CREDENTIAL_FILE_SCHEMA_INVALID", driverId);
  }
  const record = value as Readonly<Record<string, unknown>>;
  const secretField = driverId === "opencode" ? "api_key" : "auth_token";
  const expected = new Set(["schema_version", "driver_id", secretField]);
  if (
    Object.keys(record).length !== expected.size ||
    Object.keys(record).some((key) => !expected.has(key)) ||
    record.schema_version !== 1 ||
    record.driver_id !== driverId ||
    typeof record[secretField] !== "string" ||
    record[secretField].length === 0 ||
    record[secretField].length > 16_384
  ) {
    throw credentialError("CREDENTIAL_FILE_SCHEMA_INVALID", driverId);
  }
  return record[secretField];
}

function isWithin(candidate: string, root: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function credentialError(
  reason: string,
  driverId: RuntimeDriverConfiguration["id"],
): WorkerRuntimeError {
  return new WorkerRuntimeError(
    "RUNTIME_CONFIG_INVALID",
    "Driver credential configuration is invalid",
    { reason, driver_id: driverId, retryable: false },
  );
}
