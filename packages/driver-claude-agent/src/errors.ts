import type { JsonValue } from "@agent-bridge/driver-protocol";

export const CLAUDE_AGENT_DRIVER_ERROR_CODES = [
  "CLAUDE_RUNTIME_ERROR",
  "CLAUDE_PREPARED_TASK_NOT_FOUND",
  "CLAUDE_RUN_NOT_FOUND",
  "CLAUDE_SESSION_MISMATCH",
  "CLAUDE_SESSION_NOT_FOUND",
  "CLAUDE_PERMISSION_MISMATCH",
  "CLAUDE_PERMISSION_NOT_PENDING",
  "CLAUDE_SUCCESSOR_NOT_SAFE",
  "CLAUDE_RUN_TERMINAL",
  "CLAUDE_RESULT_NOT_READY",
  "CLAUDE_EVENT_CORRELATION_MISSING",
  "CLAUDE_EVENT_AFTER_TERMINAL",
  "CLAUDE_RECOVERY_STATE_INVALID",
] as const;

export type ClaudeAgentDriverErrorCode = (typeof CLAUDE_AGENT_DRIVER_ERROR_CODES)[number];

export class ClaudeAgentDriverError extends Error {
  readonly code: ClaudeAgentDriverErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ClaudeAgentDriverErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ClaudeAgentDriverError";
    this.code = code;
    this.details = details;
  }
}

const SECRET_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /(Bearer\s+)[^\s,;]+/gi,
  /((?:api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie)["'\s:=]+)[^\s,"'}]+/gi,
  /([?&](?:key|token|api_key)=)[^&\s]+/gi,
];

export function redactClaudeText(
  value: string,
  privatePaths: readonly string[] = [],
  privateValues: readonly string[] = [],
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

export function redactClaudeJson(
  value: unknown,
  redact: (value: string) => string,
): JsonValue | undefined {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return redact(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => redactClaudeJson(item, redact))
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const json = redactClaudeJson(item, redact);
      if (json !== undefined) {
        result[key] = json;
      }
    }
    return result;
  }
  return undefined;
}
