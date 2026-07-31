import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { WorkerRuntimeError } from "./errors.js";

export interface RuntimeDriverConfiguration {
  readonly id: "opencode" | "claude-agent";
  readonly executable?: string;
  readonly args: readonly string[];
  readonly startup_timeout_ms: number;
  readonly request_timeout_ms: number;
}

export interface VerificationCommandConfiguration {
  readonly contract: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeout_seconds: number;
}

export interface AgentBridgeRuntimeConfiguration {
  readonly schema_version: 1;
  readonly project: {
    readonly id: string;
    readonly workspace_root: string;
    readonly runtime_root: string;
  };
  readonly limits: {
    readonly timeout_seconds: number;
    readonly max_review_cycles: number;
    readonly max_agent_count: number;
  };
  readonly context: {
    readonly rollover_ratio: number;
  };
  readonly drivers: {
    readonly primary: RuntimeDriverConfiguration & { readonly id: "opencode" };
    readonly fallback: RuntimeDriverConfiguration & {
      readonly id: "claude-agent";
      readonly enabled: boolean;
    };
  };
  readonly verification: {
    readonly max_output_bytes: number;
    readonly termination_grace_ms: number;
    readonly commands: Readonly<Record<string, VerificationCommandConfiguration>>;
  };
}

export async function loadRuntimeConfiguration(
  path: string,
): Promise<AgentBridgeRuntimeConfiguration> {
  if (!isAbsolute(path)) {
    throw invalidConfig("CONFIG_PATH_NOT_ABSOLUTE");
  }
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw invalidConfig("CONFIG_FILE_UNAVAILABLE");
  }
  return parseRuntimeConfiguration(parseStrictYaml(source));
}

export function parseRuntimeConfiguration(value: unknown): AgentBridgeRuntimeConfiguration {
  const root = record(value, "CONFIG_ROOT_INVALID");
  onlyKeys(root, ["schema_version", "project", "limits", "context", "drivers", "verification"]);
  rejectSensitiveKeys(root);
  rejectCredentialValues(root);
  if (root.schema_version !== 1) {
    throw invalidConfig("CONFIG_VERSION_UNSUPPORTED");
  }

  const project = record(root.project, "PROJECT_CONFIG_INVALID");
  onlyKeys(project, ["id", "workspace_root", "runtime_root"]);
  const projectId = identifier(project.id, "PROJECT_CONFIG_INVALID");
  const workspaceRoot = absolutePath(project.workspace_root, "PROJECT_CONFIG_INVALID");
  const runtimeRoot = absolutePath(project.runtime_root, "PROJECT_CONFIG_INVALID");

  const limits = record(root.limits, "LIMITS_CONFIG_INVALID");
  onlyKeys(limits, ["timeout_seconds", "max_review_cycles", "max_agent_count"]);
  const timeoutSeconds = boundedInteger(limits.timeout_seconds, 1, 3_600, "LIMITS_CONFIG_INVALID");
  const maxReviewCycles = boundedInteger(limits.max_review_cycles, 1, 3, "LIMITS_CONFIG_INVALID");
  const maxAgentCount = boundedInteger(limits.max_agent_count, 1, 4, "LIMITS_CONFIG_INVALID");

  const context = record(root.context, "CONTEXT_CONFIG_INVALID");
  onlyKeys(context, ["rollover_ratio"]);
  if (
    typeof context.rollover_ratio !== "number" ||
    !Number.isFinite(context.rollover_ratio) ||
    context.rollover_ratio <= 0 ||
    context.rollover_ratio > 0.7
  ) {
    throw invalidConfig("CONTEXT_CONFIG_INVALID");
  }

  const drivers = record(root.drivers, "DRIVERS_CONFIG_INVALID");
  onlyKeys(drivers, ["primary", "fallback"]);
  const primary = driverConfiguration(drivers.primary, "opencode", false);
  if (primary.executable === undefined) {
    throw invalidConfig("PRIMARY_EXECUTABLE_REQUIRED");
  }
  const fallbackRecord = record(drivers.fallback, "DRIVER_CONFIG_INVALID");
  const fallbackEnabled = booleanValue(fallbackRecord.enabled, "DRIVER_CONFIG_INVALID");
  const fallback = driverConfiguration(fallbackRecord, "claude-agent", true);

  const verification = record(root.verification, "VERIFICATION_CONFIG_INVALID");
  onlyKeys(verification, ["max_output_bytes", "termination_grace_ms", "commands"]);
  const maxOutputBytes = boundedInteger(
    verification.max_output_bytes,
    1,
    16 * 1024 * 1024,
    "VERIFICATION_CONFIG_INVALID",
  );
  const terminationGraceMs = boundedInteger(
    verification.termination_grace_ms,
    1,
    60_000,
    "VERIFICATION_CONFIG_INVALID",
  );
  const commandsRecord = record(verification.commands, "VERIFICATION_COMMANDS_INVALID");
  const commands: Record<string, VerificationCommandConfiguration> = {};
  const contracts = new Set<string>();
  for (const [commandId, commandValue] of Object.entries(commandsRecord)) {
    identifier(commandId, "VERIFICATION_COMMANDS_INVALID");
    const command = record(commandValue, "VERIFICATION_COMMAND_INVALID");
    onlyKeys(command, ["contract", "executable", "args", "timeout_seconds"]);
    const contract = nonEmptyString(command.contract, "VERIFICATION_COMMAND_INVALID");
    if (contracts.has(contract)) {
      throw invalidConfig("VERIFICATION_CONTRACT_DUPLICATE");
    }
    contracts.add(contract);
    commands[commandId] = Object.freeze({
      contract,
      executable: absolutePath(command.executable, "VERIFICATION_COMMAND_INVALID"),
      args: stringArray(command.args, "VERIFICATION_COMMAND_INVALID"),
      timeout_seconds: boundedInteger(
        command.timeout_seconds,
        1,
        timeoutSeconds,
        "VERIFICATION_COMMAND_INVALID",
      ),
    });
  }
  if (Object.keys(commands).length === 0) {
    throw invalidConfig("VERIFICATION_COMMANDS_REQUIRED");
  }

  return Object.freeze({
    schema_version: 1 as const,
    project: Object.freeze({
      id: projectId,
      workspace_root: workspaceRoot,
      runtime_root: runtimeRoot,
    }),
    limits: Object.freeze({
      timeout_seconds: timeoutSeconds,
      max_review_cycles: maxReviewCycles,
      max_agent_count: maxAgentCount,
    }),
    context: Object.freeze({ rollover_ratio: context.rollover_ratio }),
    drivers: Object.freeze({
      primary: Object.freeze(primary as RuntimeDriverConfiguration & { readonly id: "opencode" }),
      fallback: Object.freeze({
        ...fallback,
        id: "claude-agent" as const,
        enabled: fallbackEnabled,
      }),
    }),
    verification: Object.freeze({
      max_output_bytes: maxOutputBytes,
      termination_grace_ms: terminationGraceMs,
      commands: Object.freeze(commands),
    }),
  });
}

function driverConfiguration(
  value: unknown,
  expectedId: RuntimeDriverConfiguration["id"],
  allowEnabled: boolean,
): RuntimeDriverConfiguration {
  const driver = record(value, "DRIVER_CONFIG_INVALID");
  onlyKeys(driver, [
    "id",
    "executable",
    "args",
    "startup_timeout_ms",
    "request_timeout_ms",
    ...(allowEnabled ? ["enabled"] : []),
  ]);
  if (driver.id !== expectedId) {
    throw invalidConfig("DRIVER_ID_INVALID");
  }
  return Object.freeze({
    id: expectedId,
    ...(driver.executable === undefined
      ? {}
      : { executable: absolutePath(driver.executable, "DRIVER_CONFIG_INVALID") }),
    args: stringArray(driver.args, "DRIVER_CONFIG_INVALID"),
    startup_timeout_ms: boundedInteger(
      driver.startup_timeout_ms,
      1,
      120_000,
      "DRIVER_CONFIG_INVALID",
    ),
    request_timeout_ms: boundedInteger(
      driver.request_timeout_ms,
      1,
      120_000,
      "DRIVER_CONFIG_INVALID",
    ),
  });
}

function parseStrictYaml(source: string): unknown {
  if (source.includes("\t") || /(^|[\s:[{,])(?:[&*!]|<<:)/mu.test(source)) {
    throw invalidConfig("YAML_FEATURE_FORBIDDEN");
  }
  const lines = source
    .split(/\r?\n/u)
    .map((raw, index) => ({ raw, line: index + 1 }))
    .filter(({ raw }) => raw.trim().length > 0 && !raw.trimStart().startsWith("#"));
  if (lines.length === 0) {
    throw invalidConfig("YAML_EMPTY");
  }

  const root: Record<string, unknown> = {};
  const stack: Array<{
    readonly indent: number;
    readonly value: Record<string, unknown> | unknown[];
  }> = [{ indent: -2, value: root }];

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index]!;
    const indent = current.raw.length - current.raw.trimStart().length;
    if (indent % 2 !== 0) {
      throw invalidConfig("YAML_INDENT_INVALID");
    }
    const text = current.raw.trim();
    while (stack.length > 1 && indent <= stack.at(-1)!.indent) {
      stack.pop();
    }
    const parent = stack.at(-1)!;
    if (indent !== parent.indent + 2) {
      throw invalidConfig("YAML_INDENT_INVALID");
    }

    if (text.startsWith("- ")) {
      if (!Array.isArray(parent.value)) {
        throw invalidConfig("YAML_SEQUENCE_INVALID");
      }
      parent.value.push(parseYamlScalar(text.slice(2)));
      continue;
    }
    if (Array.isArray(parent.value)) {
      throw invalidConfig("YAML_SEQUENCE_INVALID");
    }
    const match = /^(?<key>[A-Za-z_][A-Za-z0-9_-]*):(?:\s+(?<value>.*))?$/u.exec(text);
    if (match?.groups === undefined) {
      throw invalidConfig("YAML_MAPPING_INVALID");
    }
    const key = match.groups.key!;
    if (Object.hasOwn(parent.value, key)) {
      throw invalidConfig("YAML_DUPLICATE_KEY");
    }
    const scalar = match.groups.value;
    if (scalar !== undefined) {
      parent.value[key] = parseYamlScalar(scalar);
      continue;
    }

    const next = lines[index + 1];
    if (next === undefined) {
      throw invalidConfig("YAML_EMPTY_MAPPING_VALUE");
    }
    const nextIndent = next.raw.length - next.raw.trimStart().length;
    if (nextIndent !== indent + 2) {
      throw invalidConfig("YAML_INDENT_INVALID");
    }
    const child: Record<string, unknown> | unknown[] = next.raw.trim().startsWith("- ") ? [] : {};
    parent.value[key] = child;
    stack.push({ indent, value: child });
  }
  return root;
}

function parseYamlScalar(value: string): unknown {
  if (value.includes(" #") || value.startsWith("|") || value.startsWith(">")) {
    throw invalidConfig("YAML_FEATURE_FORBIDDEN");
  }
  if (value === "true" || value === "false") {
    return value === "true";
  }
  if (value === "null" || value === "~") {
    return null;
  }
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw invalidConfig("YAML_SCALAR_INVALID");
    }
    return number;
  }
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "string") {
        throw new Error("not a string");
      }
      return parsed;
    } catch {
      throw invalidConfig("YAML_SCALAR_INVALID");
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (/^[^\s#[\]{},&*!|>'"](?:[^#[\]{},&*!|>]*[^\s])?$/u.test(value)) {
    return value;
  }
  throw invalidConfig("YAML_SCALAR_INVALID");
}

function onlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw invalidConfig("CONFIG_UNKNOWN_KEY");
  }
}

function rejectSensitiveKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach((item) => rejectSensitiveKeys(item));
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:api[_-]?key|token|secret|password|authorization|credential)/iu.test(key)) {
      throw invalidConfig("CONFIG_CREDENTIAL_FIELD_FORBIDDEN");
    }
    rejectSensitiveKeys(nested);
  }
}

function rejectCredentialValues(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach((item) => rejectCredentialValues(item));
    return;
  }
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach((item) => rejectCredentialValues(item));
    return;
  }
  if (
    typeof value === "string" &&
    (/(?:^|\s)--?(?:api[-_]?key|access[-_]?token|token|secret|password|authorization|credential)(?:=|\s|$)/iu.test(
      value,
    ) ||
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
      /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/u.test(value) ||
      /\bsk-[A-Za-z0-9_-]{16,}\b/u.test(value) ||
      /\bAKIA[0-9A-Z]{16}\b/u.test(value))
  ) {
    throw invalidConfig("CONFIG_CREDENTIAL_VALUE_FORBIDDEN");
  }
}

function record(value: unknown, reason: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidConfig(reason);
  }
  return value as Readonly<Record<string, unknown>>;
}

function identifier(value: unknown, reason: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw invalidConfig(reason);
  }
  return value;
}

function nonEmptyString(value: unknown, reason: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw invalidConfig(reason);
  }
  return value;
}

function absolutePath(value: unknown, reason: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw invalidConfig(reason);
  }
  return value;
}

function stringArray(value: unknown, reason: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw invalidConfig(reason);
  }
  const strings: string[] = [];
  for (const item of value as readonly unknown[]) {
    if (typeof item !== "string" || item.includes("\0")) {
      throw invalidConfig(reason);
    }
    strings.push(item);
  }
  return Object.freeze(strings);
}

function booleanValue(value: unknown, reason: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidConfig(reason);
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, reason: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidConfig(reason);
  }
  return value;
}

function invalidConfig(reason: string): WorkerRuntimeError {
  return new WorkerRuntimeError(
    "RUNTIME_CONFIG_INVALID",
    "Agent Bridge runtime configuration is invalid",
    { reason },
  );
}
