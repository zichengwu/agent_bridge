import { isAbsolute } from "node:path";

import {
  DriverTransportError,
  type DriverHostFactory,
  type DriverWorkerInitialization,
  type JsonObject,
} from "@agent-bridge/driver-protocol";

import { createOpenCodeDriver, type OpenCodeDriverRecoveryState } from "./driver.js";
import type { OpenCodeProviderConfiguration } from "./config.js";

const OPENCODE_CREDENTIAL_ENV = "AGENT_BRIDGE_OPENCODE_API_KEY";

export interface OpenCodeWorkerProviderConfiguration {
  readonly id: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly smallModel?: string;
  readonly permissions?: OpenCodeProviderConfiguration["permissions"];
}

export interface OpenCodeWorkerConfiguration {
  readonly hostname?: string;
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly executablePath?: string;
  readonly provider?: OpenCodeWorkerProviderConfiguration;
}

export function createOpenCodeWorkerFactory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DriverHostFactory {
  return {
    create(initialization) {
      const configuration = readOpenCodeWorkerConfiguration(initialization.configuration);
      const secret = environment[OPENCODE_CREDENTIAL_ENV];
      if (
        (configuration.provider === undefined) !==
        (secret === undefined || secret.length === 0)
      ) {
        throw invalidConfiguration();
      }
      const provider =
        configuration.provider === undefined || secret === undefined
          ? undefined
          : buildProvider(configuration.provider, secret);
      return Promise.resolve(
        createOpenCodeDriver({
          workDirectory: initialization.workDirectory,
          recoveryStates: readRecoveryStates(initialization),
          ...configuration,
          provider,
          privateValues: secret === undefined ? [] : [secret],
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
  const provider = value.provider === undefined ? undefined : readProvider(value.provider);
  return Object.freeze({
    ...(value.hostname === undefined ? {} : { hostname: value.hostname }),
    ...(value.port === undefined ? {} : { port: value.port }),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
    ...(value.executablePath === undefined ? {} : { executablePath: value.executablePath }),
    ...(provider === undefined ? {} : { provider }),
  });
}

function readProvider(
  value: Readonly<Record<string, unknown>>,
): OpenCodeWorkerProviderConfiguration {
  const allowed = new Set(["id", "baseUrl", "model", "smallModel", "permissions"]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    typeof value.id !== "string" ||
    typeof value.baseUrl !== "string" ||
    typeof value.model !== "string" ||
    (value.smallModel !== undefined && typeof value.smallModel !== "string") ||
    (value.permissions !== undefined && !isPlainRecord(value.permissions))
  ) {
    throw new DriverTransportError(
      "DRIVER_TRANSPORT_MESSAGE_INVALID",
      "OpenCode worker credentials must not be sent over JSONL",
    );
  }
  const permissions = value.permissions as OpenCodeProviderConfiguration["permissions"] | undefined;
  return Object.freeze({
    id: value.id,
    baseUrl: value.baseUrl,
    model: value.model,
    ...(value.smallModel === undefined ? {} : { smallModel: value.smallModel }),
    ...(permissions === undefined ? {} : { permissions: structuredClone(permissions) }),
  });
}

function buildProvider(
  provider: OpenCodeWorkerProviderConfiguration,
  apiKey: string,
): OpenCodeProviderConfiguration {
  const selector = `${provider.id}/${provider.model}`;
  return {
    enabledProviders: [provider.id],
    model: selector,
    smallModel:
      provider.smallModel === undefined ? selector : `${provider.id}/${provider.smallModel}`,
    providers: {
      [provider.id]: {
        name: `Agent Bridge ${provider.id}`,
        options: { apiKey, baseURL: provider.baseUrl },
        models: {
          [provider.model]: {
            id: provider.model,
            name: provider.model,
            tool_call: true,
            limit: { context: 1_000_000, output: 16_000 },
          },
          ...(provider.smallModel === undefined || provider.smallModel === provider.model
            ? {}
            : {
                [provider.smallModel]: {
                  id: provider.smallModel,
                  name: provider.smallModel,
                  tool_call: true,
                  limit: { context: 1_000_000, output: 16_000 },
                },
              }),
        },
      },
    },
    permissions: provider.permissions,
  };
}

function readRecoveryStates(
  initialization: DriverWorkerInitialization,
): readonly OpenCodeDriverRecoveryState[] {
  return (initialization.recoveryStates ?? []).map(
    (state) => structuredClone(state) as unknown as OpenCodeDriverRecoveryState,
  );
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
