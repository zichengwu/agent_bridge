import { createHash } from "node:crypto";

import type { DomainJsonValue } from "@agent-bridge/schemas";

const CREDENTIAL_FIELD_NAMES = new Set([
  "access_token",
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "password",
  "passwd",
  "private_key",
  "refresh_token",
  "secret",
]);

const FULL_TRANSCRIPT_FIELD_NAMES = new Set([
  "chat_history",
  "conversation_history",
  "full_transcript",
  "messages",
  "transcript",
]);

const INTERNAL_REASONING_FIELD_NAMES = new Set([
  "chain_of_thought",
  "internal_reasoning",
  "model_reasoning",
]);

const CREDENTIAL_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
] as const;

export type SensitiveContentRule =
  "CREDENTIAL_FIELD" | "CREDENTIAL_PATTERN" | "FULL_TRANSCRIPT_FIELD" | "INTERNAL_REASONING_FIELD";

export interface SensitiveContentFinding {
  readonly path: string;
  readonly rule: SensitiveContentRule;
}

export function canonicalizeDomainJson(value: DomainJsonValue): string {
  return canonicalize(value);
}

export function computeContentHash(value: DomainJsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalizeDomainJson(value)).digest("hex")}`;
}

export function computeDocumentContentHash(
  value: Readonly<Record<string, unknown>> & { readonly content_hash?: unknown },
): string {
  const payload = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "content_hash"),
  );
  if (!isDomainJsonValue(payload)) {
    throw new TypeError("Document content must be pure JSON");
  }
  return computeContentHash(payload);
}

export function hasValidDocumentContentHash(
  value: Readonly<Record<string, unknown>> & { readonly content_hash?: unknown },
): boolean {
  return (
    typeof value.content_hash === "string" &&
    value.content_hash === computeDocumentContentHash(value)
  );
}

export function scanSensitiveContent(value: DomainJsonValue): readonly SensitiveContentFinding[] {
  const findings: SensitiveContentFinding[] = [];
  scanValue(value, "", findings);
  findings.sort((left, right) => {
    const pathOrder = compareText(left.path, right.path);
    return pathOrder === 0 ? compareText(left.rule, right.rule) : pathOrder;
  });
  return Object.freeze(findings.map((finding) => Object.freeze({ ...finding })));
}

/** Produces a persistence-safe JSON value without credential or transcript fields. */
export function redactSensitiveContent(value: DomainJsonValue): DomainJsonValue {
  return redactValue(value);
}

export function isDomainJsonValue(value: unknown): value is DomainJsonValue {
  return isJsonValue(value, new Set<object>());
}

function canonicalize(value: DomainJsonValue): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Domain JSON numbers must be finite");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const items = value as readonly DomainJsonValue[];
        return `[${items.map((item) => canonicalize(item)).join(",")}]`;
      }
      const record = value as { readonly [key: string]: DomainJsonValue };
      return `{${Object.keys(record)
        .sort()
        .map((key) => {
          const item = record[key];
          if (item === undefined) {
            throw new TypeError("Domain JSON objects cannot contain undefined");
          }
          return `${JSON.stringify(key)}:${canonicalize(item)}`;
        })
        .join(",")}}`;
    }
  }
}

function scanValue(
  value: DomainJsonValue,
  path: string,
  findings: SensitiveContentFinding[],
): void {
  if (typeof value === "string") {
    if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))) {
      findings.push({ path: path || "/", rule: "CREDENTIAL_PATTERN" });
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    const items = value as readonly DomainJsonValue[];
    items.forEach((item, index) => scanValue(item, `${path}/${index}`, findings));
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}/${escapeJsonPointer(key)}`;
    const normalizedKey = normalizeFieldName(key);
    if (isCredentialFieldName(normalizedKey)) {
      findings.push({ path: itemPath, rule: "CREDENTIAL_FIELD" });
    }
    if (FULL_TRANSCRIPT_FIELD_NAMES.has(normalizedKey)) {
      findings.push({ path: itemPath, rule: "FULL_TRANSCRIPT_FIELD" });
    }
    if (INTERNAL_REASONING_FIELD_NAMES.has(normalizedKey)) {
      findings.push({ path: itemPath, rule: "INTERNAL_REASONING_FIELD" });
    }
    scanValue(item, itemPath, findings);
  }
}

function redactValue(value: DomainJsonValue): DomainJsonValue {
  if (typeof value === "string") {
    return CREDENTIAL_PATTERNS.reduce(
      (redacted, pattern) => redacted.replace(new RegExp(pattern.source, "gu"), "[REDACTED]"),
      value,
    );
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const items = value as readonly DomainJsonValue[];
    return items.map((item) => redactValue(item));
  }

  const redacted: Record<string, DomainJsonValue> = {};
  const removed: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = normalizeFieldName(key);
    if (
      isCredentialFieldName(normalizedKey) ||
      FULL_TRANSCRIPT_FIELD_NAMES.has(normalizedKey) ||
      INTERNAL_REASONING_FIELD_NAMES.has(normalizedKey)
    ) {
      removed.push(key);
      continue;
    }
    redacted[key] = redactValue(item);
  }
  if (removed.length > 0) redacted.redacted_fields = removed.sort();
  return redacted;
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function normalizeFieldName(value: string): string {
  return value
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");
}

function isCredentialFieldName(value: string): boolean {
  if (CREDENTIAL_FIELD_NAMES.has(value)) {
    return true;
  }
  const segments = value.split("_");
  return segments.some((segment) =>
    ["credential", "password", "passwd", "secret", "token"].includes(segment),
  );
}

function isJsonValue(value: unknown, ancestors: Set<object>): value is DomainJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== "object") {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    const valid = value.every((item) => isJsonValue(item, ancestors));
    ancestors.delete(value);
    return valid;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    ancestors.delete(value);
    return false;
  }
  const valid = Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
