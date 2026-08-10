import { isAbsolute } from "node:path";

import {
  DriverTransportError,
  type DriverHostFactory,
  type DriverWorkerInitialization,
  type JsonObject,
} from "@agent-bridge/driver-protocol";

import type {
  ClaudeAgentIsolationConfiguration,
  ClaudeAgentProviderConfiguration,
  ClaudeAgentSecurityConfiguration,
} from "./config.js";
import { createClaudeAgentDriver, type ClaudeAgentDriverRecoveryState } from "./driver.js";

const CLAUDE_CREDENTIAL_ENV = "AGENT_BRIDGE_CLAUDE_AUTH_TOKEN";

export interface ClaudeWorkerConfiguration {
  readonly isolation: ClaudeAgentIsolationConfiguration;
  readonly provider?: Pick<ClaudeAgentProviderConfiguration, "baseUrl" | "model">;
  readonly security?: ClaudeAgentSecurityConfiguration;
  readonly pathToClaudeCodeExecutable?: string;
  readonly sessionReadyTimeoutMs?: number;
}

export function createClaudeWorkerFactory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DriverHostFactory {
  return {
    create(initialization) {
      const configuration = readClaudeWorkerConfiguration(initialization.configuration);
      const secret = environment[CLAUDE_CREDENTIAL_ENV];
      if (
        (configuration.provider === undefined) !==
        (secret === undefined || secret.length === 0)
      ) {
        throw invalidConfiguration();
      }
      const provider: ClaudeAgentProviderConfiguration | undefined =
        configuration.provider === undefined && secret === undefined
          ? undefined
          : {
              ...configuration.provider,
              ...(secret === undefined ? {} : { authToken: secret }),
            };
      return Promise.resolve(
        createClaudeAgentDriver({
          workDirectory: initialization.workDirectory,
          isolation: configuration.isolation,
          provider,
          security: configuration.security,
          pathToClaudeCodeExecutable: configuration.pathToClaudeCodeExecutable,
          sessionReadyTimeoutMs: configuration.sessionReadyTimeoutMs,
          recoveryStates: readRecoveryStates(initialization),
        }),
      );
    },
  };
}

export function readClaudeWorkerConfiguration(
  value: JsonObject | undefined,
): ClaudeWorkerConfiguration {
  if (value === undefined) {
    throw invalidConfiguration();
  }
  const allowed = new Set([
    "isolation",
    "provider",
    "security",
    "pathToClaudeCodeExecutable",
    "sessionReadyTimeoutMs",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    !isPlainRecord(value.isolation) ||
    (value.provider !== undefined && !isPlainRecord(value.provider)) ||
    (value.security !== undefined && !isPlainRecord(value.security)) ||
    (value.pathToClaudeCodeExecutable !== undefined &&
      (typeof value.pathToClaudeCodeExecutable !== "string" ||
        !isAbsolute(value.pathToClaudeCodeExecutable))) ||
    (value.sessionReadyTimeoutMs !== undefined && !isPositiveInteger(value.sessionReadyTimeoutMs))
  ) {
    throw invalidConfiguration();
  }
  const isolation = readIsolation(value.isolation);
  const provider = value.provider === undefined ? undefined : readProvider(value.provider);
  const security = value.security === undefined ? undefined : readSecurity(value.security);
  return Object.freeze({
    isolation,
    ...(provider === undefined ? {} : { provider }),
    ...(security === undefined ? {} : { security }),
    ...(value.pathToClaudeCodeExecutable === undefined
      ? {}
      : { pathToClaudeCodeExecutable: value.pathToClaudeCodeExecutable }),
    ...(value.sessionReadyTimeoutMs === undefined
      ? {}
      : { sessionReadyTimeoutMs: value.sessionReadyTimeoutMs }),
  });
}

function readIsolation(
  value: Readonly<Record<string, unknown>>,
): ClaudeAgentIsolationConfiguration {
  const required = [
    "homeDirectory",
    "tempDirectory",
    "configDirectory",
    "dataDirectory",
    "cacheDirectory",
    "claudeConfigDirectory",
  ] as const;
  const allowed = new Set([...required, "path", "lang"]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    required.some((key) => typeof value[key] !== "string" || !isAbsolute(value[key])) ||
    (value.path !== undefined && typeof value.path !== "string") ||
    (value.lang !== undefined && typeof value.lang !== "string")
  ) {
    throw invalidConfiguration();
  }
  return Object.freeze({
    homeDirectory: value.homeDirectory as string,
    tempDirectory: value.tempDirectory as string,
    configDirectory: value.configDirectory as string,
    dataDirectory: value.dataDirectory as string,
    cacheDirectory: value.cacheDirectory as string,
    claudeConfigDirectory: value.claudeConfigDirectory as string,
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.lang === undefined ? {} : { lang: value.lang }),
  });
}

function readProvider(
  value: Readonly<Record<string, unknown>>,
): Pick<ClaudeAgentProviderConfiguration, "baseUrl" | "model"> {
  if (
    Object.keys(value).some((key) => key !== "baseUrl" && key !== "model") ||
    (value.baseUrl !== undefined && typeof value.baseUrl !== "string") ||
    (value.model !== undefined && typeof value.model !== "string")
  ) {
    throw new DriverTransportError(
      "DRIVER_TRANSPORT_MESSAGE_INVALID",
      "Claude worker credentials must not be sent over JSONL",
    );
  }
  return Object.freeze({
    ...(value.baseUrl === undefined ? {} : { baseUrl: value.baseUrl }),
    ...(value.model === undefined ? {} : { model: value.model }),
  });
}

function readSecurity(value: Readonly<Record<string, unknown>>): ClaudeAgentSecurityConfiguration {
  if (
    Object.keys(value).some((key) => !["tools", "maxTurns", "maxBudgetUsd"].includes(key)) ||
    (value.tools !== undefined &&
      (!Array.isArray(value.tools) || !value.tools.every((tool) => typeof tool === "string"))) ||
    (value.maxTurns !== undefined && !isPositiveInteger(value.maxTurns)) ||
    (value.maxBudgetUsd !== undefined &&
      (typeof value.maxBudgetUsd !== "number" ||
        !Number.isFinite(value.maxBudgetUsd) ||
        value.maxBudgetUsd < 0))
  ) {
    throw invalidConfiguration();
  }
  return Object.freeze({
    ...(value.tools === undefined ? {} : { tools: Object.freeze([...value.tools]) }),
    ...(value.maxTurns === undefined ? {} : { maxTurns: value.maxTurns }),
    ...(value.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: value.maxBudgetUsd }),
  });
}

function readRecoveryStates(
  initialization: DriverWorkerInitialization,
): readonly ClaudeAgentDriverRecoveryState[] {
  return (initialization.recoveryStates ?? []).map(
    (state) => structuredClone(state) as unknown as ClaudeAgentDriverRecoveryState,
  );
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function invalidConfiguration(): DriverTransportError {
  return new DriverTransportError(
    "DRIVER_TRANSPORT_MESSAGE_INVALID",
    "Claude worker configuration is invalid",
  );
}
