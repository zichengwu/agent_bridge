import { isAbsolute } from "node:path";

import {
  DriverTransportError,
  type DriverHostFactory,
  type DriverWorkerInitialization,
  type JsonObject,
} from "@agent-bridge/driver-protocol";

import { createOpenCodeDriver, type OpenCodeDriverRecoveryState } from "./driver.js";
import type { OpenCodeProviderConfiguration } from "./config.js";

export interface OpenCodeWorkerConfiguration {
  readonly hostname?: string;
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly executablePath?: string;
  readonly provider?: OpenCodeProviderConfiguration;
}

export function createOpenCodeWorkerFactory(): DriverHostFactory {
  return {
    create(initialization) {
      const configuration = readOpenCodeWorkerConfiguration(initialization.configuration);
      return Promise.resolve(
        createOpenCodeDriver({
          workDirectory: initialization.workDirectory,
          recoveryStates: readRecoveryStates(initialization),
          ...configuration,
        }),
      );
    },
  };
}

export function readOpenCodeWorkerConfiguration(
  value: JsonObject | undefined,
): OpenCodeWorkerConfiguration {
  if (value === undefined) {
    return Object.freeze({});
  }
  const allowed = new Set(["hostname", "port", "timeoutMs", "executablePath", "provider"]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    (value.hostname !== undefined && typeof value.hostname !== "string") ||
    (value.port !== undefined && !isPort(value.port)) ||
    (value.timeoutMs !== undefined && !isPositiveInteger(value.timeoutMs)) ||
    (value.executablePath !== undefined &&
      (typeof value.executablePath !== "string" || !isAbsolute(value.executablePath))) ||
    (value.provider !== undefined && !isPlainRecord(value.provider))
  ) {
    throw invalidConfiguration();
  }
  if (value.provider !== undefined && containsSensitiveKey(value.provider)) {
    throw new DriverTransportError(
      "DRIVER_TRANSPORT_MESSAGE_INVALID",
      "OpenCode worker configuration must not contain credentials",
    );
  }
  return Object.freeze({
    ...(value.hostname === undefined ? {} : { hostname: value.hostname }),
    ...(value.port === undefined ? {} : { port: value.port }),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
    ...(value.executablePath === undefined ? {} : { executablePath: value.executablePath }),
    ...(value.provider === undefined ? {} : { provider: structuredClone(value.provider) }),
  });
}

function readRecoveryStates(
  initialization: DriverWorkerInitialization,
): readonly OpenCodeDriverRecoveryState[] {
  return (initialization.recoveryStates ?? []).map(
    (state) => structuredClone(state) as unknown as OpenCodeDriverRecoveryState,
  );
}

function containsSensitiveKey(value: Readonly<Record<string, unknown>>): boolean {
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:api[_-]?key|token|secret|password|authorization)/iu.test(key)) {
      return true;
    }
    if (isPlainRecord(nested) && containsSensitiveKey(nested)) {
      return true;
    }
    if (
      Array.isArray(nested) &&
      nested.some((item) => isPlainRecord(item) && containsSensitiveKey(item))
    ) {
      return true;
    }
  }
  return false;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPort(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 65_535;
}

function invalidConfiguration(): DriverTransportError {
  return new DriverTransportError(
    "DRIVER_TRANSPORT_MESSAGE_INVALID",
    "OpenCode worker configuration is invalid",
  );
}
