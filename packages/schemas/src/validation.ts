import { DOMAIN_SCHEMA_IDS, DOMAIN_SCHEMA_VERSION, type DomainSchemaKind } from "./constants.js";
import { DomainSchemaError, type DomainSchemaIssue } from "./errors.js";
import { DOMAIN_SCHEMA_REGISTRY, type JsonSchema } from "./schema-definitions.js";
import type { DomainSchemaTypeMap } from "./types.js";

export type DomainValidationResult<T> =
  | {
      readonly success: true;
      readonly value: T;
    }
  | {
      readonly success: false;
      readonly error: DomainSchemaError;
    };

export function parseDomainObject<K extends DomainSchemaKind>(
  kind: K,
  value: unknown,
): DomainSchemaTypeMap[K] {
  assertSupportedVersion(kind, value);
  const issues = collectIssues(DOMAIN_SCHEMA_REGISTRY[kind], value);
  if (issues.length > 0) {
    throw new DomainSchemaError("DOMAIN_SCHEMA_INVALID", "Domain schema validation failed", {
      schema_kind: kind,
      schema_id: DOMAIN_SCHEMA_IDS[kind],
      expected_version: DOMAIN_SCHEMA_VERSION,
      issues,
    });
  }

  return freezeJson(cloneJson(value)) as DomainSchemaTypeMap[K];
}

export function validateDomainObject<K extends DomainSchemaKind>(
  kind: K,
  value: unknown,
): DomainValidationResult<DomainSchemaTypeMap[K]> {
  try {
    return {
      success: true,
      value: parseDomainObject(kind, value),
    };
  } catch (error) {
    if (error instanceof DomainSchemaError) {
      return {
        success: false,
        error,
      };
    }
    throw error;
  }
}

export function assertDomainObject<K extends DomainSchemaKind>(
  kind: K,
  value: unknown,
): asserts value is DomainSchemaTypeMap[K] {
  assertSupportedVersion(kind, value);
  const issues = collectIssues(DOMAIN_SCHEMA_REGISTRY[kind], value);
  if (issues.length > 0) {
    throw new DomainSchemaError("DOMAIN_SCHEMA_INVALID", "Domain schema validation failed", {
      schema_kind: kind,
      schema_id: DOMAIN_SCHEMA_IDS[kind],
      expected_version: DOMAIN_SCHEMA_VERSION,
      issues,
    });
  }
}

export function parseTask(value: unknown): DomainSchemaTypeMap["task"] {
  return parseDomainObject("task", value);
}

export function parseTaskVersion(value: unknown): DomainSchemaTypeMap["taskVersion"] {
  return parseDomainObject("taskVersion", value);
}

export function parseTaskResult(value: unknown): DomainSchemaTypeMap["taskResult"] {
  return parseDomainObject("taskResult", value);
}

export function parseTaskRelation(value: unknown): DomainSchemaTypeMap["taskRelation"] {
  return parseDomainObject("taskRelation", value);
}

export function parseAgentSessionBinding(
  value: unknown,
): DomainSchemaTypeMap["agentSessionBinding"] {
  return parseDomainObject("agentSessionBinding", value);
}

export function parseContextPackage(value: unknown): DomainSchemaTypeMap["contextPackage"] {
  return parseDomainObject("contextPackage", value);
}

export function parseHandoffPackage(value: unknown): DomainSchemaTypeMap["handoffPackage"] {
  return parseDomainObject("handoffPackage", value);
}

export function parseContinuationSnapshot(
  value: unknown,
): DomainSchemaTypeMap["continuationSnapshot"] {
  return parseDomainObject("continuationSnapshot", value);
}

export function assertTask(value: unknown): asserts value is DomainSchemaTypeMap["task"] {
  assertDomainObject("task", value);
}

export function assertTaskVersion(
  value: unknown,
): asserts value is DomainSchemaTypeMap["taskVersion"] {
  assertDomainObject("taskVersion", value);
}

export function assertTaskResult(
  value: unknown,
): asserts value is DomainSchemaTypeMap["taskResult"] {
  assertDomainObject("taskResult", value);
}

export function assertTaskRelation(
  value: unknown,
): asserts value is DomainSchemaTypeMap["taskRelation"] {
  assertDomainObject("taskRelation", value);
}

export function assertAgentSessionBinding(
  value: unknown,
): asserts value is DomainSchemaTypeMap["agentSessionBinding"] {
  assertDomainObject("agentSessionBinding", value);
}

export function assertContextPackage(
  value: unknown,
): asserts value is DomainSchemaTypeMap["contextPackage"] {
  assertDomainObject("contextPackage", value);
}

export function assertHandoffPackage(
  value: unknown,
): asserts value is DomainSchemaTypeMap["handoffPackage"] {
  assertDomainObject("handoffPackage", value);
}

export function assertContinuationSnapshot(
  value: unknown,
): asserts value is DomainSchemaTypeMap["continuationSnapshot"] {
  assertDomainObject("continuationSnapshot", value);
}

function assertSupportedVersion(kind: DomainSchemaKind, value: unknown): void {
  if (
    isPlainRecord(value) &&
    Object.hasOwn(value, "schema_version") &&
    value.schema_version !== DOMAIN_SCHEMA_VERSION
  ) {
    throw new DomainSchemaError(
      "DOMAIN_SCHEMA_VERSION_UNSUPPORTED",
      "Unsupported domain schema version",
      {
        schema_kind: kind,
        schema_id: DOMAIN_SCHEMA_IDS[kind],
        expected_version: DOMAIN_SCHEMA_VERSION,
        received_version: value.schema_version,
      },
    );
  }
}

function collectIssues(schema: JsonSchema, value: unknown): readonly DomainSchemaIssue[] {
  const issues: DomainSchemaIssue[] = [];
  validateSchema(schema, value, "", schema, issues, new WeakSet<object>());
  return issues;
}

function validateSchema(
  schema: JsonSchema,
  value: unknown,
  path: string,
  rootSchema: JsonSchema,
  issues: DomainSchemaIssue[],
  ancestors: WeakSet<object>,
): void {
  if (schema.$ref !== undefined) {
    validateSchema(
      resolveReference(schema.$ref, rootSchema),
      value,
      path,
      rootSchema,
      issues,
      ancestors,
    );
    return;
  }

  if (schema.anyOf !== undefined) {
    const matched = schema.anyOf.some((candidate) => {
      const candidateIssues: DomainSchemaIssue[] = [];
      validateSchema(candidate, value, path, rootSchema, candidateIssues, ancestors);
      return candidateIssues.length === 0;
    });
    if (!matched) {
      addIssue(issues, path, "anyOf", "must be a JSON value matching one allowed shape");
      return;
    }
  }

  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    addIssue(issues, path, "type", `must be ${article(schema.type)} ${schema.type}`);
    return;
  }

  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    addIssue(issues, path, "const", "must equal the required constant");
  }

  if (schema.enum !== undefined && !schema.enum.some((candidate) => Object.is(value, candidate))) {
    addIssue(issues, path, "enum", "must be one of the supported values");
  }

  if (typeof value === "string") {
    validateString(schema, value, path, issues);
  }

  if (typeof value === "number") {
    validateNumber(schema, value, path, issues);
  }

  if (Array.isArray(value)) {
    validateArray(schema, value, path, rootSchema, issues, ancestors);
  } else if (isPlainRecord(value)) {
    validateObject(schema, value, path, rootSchema, issues, ancestors);
  }
}

function validateString(
  schema: JsonSchema,
  value: string,
  path: string,
  issues: DomainSchemaIssue[],
): void {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    addIssue(issues, path, "minLength", "must not be empty or shorter than the minimum length");
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    addIssue(issues, path, "maxLength", "must not exceed the maximum length");
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
    addIssue(issues, path, "pattern", "must match the required format");
  }
  if (schema.format === "date-time" && !isRfc3339Timestamp(value)) {
    addIssue(issues, path, "format", "must be an RFC 3339 date-time");
  }
}

function validateNumber(
  schema: JsonSchema,
  value: number,
  path: string,
  issues: DomainSchemaIssue[],
): void {
  if (!Number.isFinite(value)) {
    addIssue(issues, path, "type", "must be a finite JSON number");
    return;
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    addIssue(issues, path, "minimum", "must be greater than or equal to the minimum");
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    addIssue(issues, path, "maximum", "must be less than or equal to the maximum");
  }
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    addIssue(issues, path, "exclusiveMinimum", "must be greater than the exclusive minimum");
  }
}

function validateArray(
  schema: JsonSchema,
  value: readonly unknown[],
  path: string,
  rootSchema: JsonSchema,
  issues: DomainSchemaIssue[],
  ancestors: WeakSet<object>,
): void {
  if (ancestors.has(value)) {
    addIssue(issues, path, "json", "must be acyclic JSON data");
    return;
  }
  ancestors.add(value);

  if (schema.minItems !== undefined && value.length < schema.minItems) {
    addIssue(issues, path, "minItems", "must contain at least the minimum number of items");
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    addIssue(issues, path, "maxItems", "must not exceed the maximum number of items");
  }
  if (schema.items !== undefined) {
    value.forEach((item, index) => {
      validateSchema(
        schema.items!,
        item,
        joinPath(path, String(index)),
        rootSchema,
        issues,
        ancestors,
      );
    });
  }
  if (schema.uniqueItems === true) {
    const seen = new Set<string>();
    for (const item of value) {
      const key = canonicalValue(item);
      if (seen.has(key)) {
        addIssue(issues, path, "uniqueItems", "must not contain duplicate items");
        break;
      }
      seen.add(key);
    }
  }

  ancestors.delete(value);
}

function validateObject(
  schema: JsonSchema,
  value: Readonly<Record<string, unknown>>,
  path: string,
  rootSchema: JsonSchema,
  issues: DomainSchemaIssue[],
  ancestors: WeakSet<object>,
): void {
  if (ancestors.has(value)) {
    addIssue(issues, path, "json", "must be acyclic JSON data");
    return;
  }
  ancestors.add(value);

  for (const requiredProperty of schema.required ?? []) {
    if (!Object.hasOwn(value, requiredProperty)) {
      addIssue(issues, joinPath(path, requiredProperty), "required", "is required");
    }
  }

  const properties = schema.properties ?? {};
  for (const [property, propertySchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, property)) {
      validateSchema(
        propertySchema,
        value[property],
        joinPath(path, property),
        rootSchema,
        issues,
        ancestors,
      );
    }
  }

  const unknownProperties = Object.keys(value)
    .filter((property) => !Object.hasOwn(properties, property))
    .sort();
  if (schema.additionalProperties === false) {
    for (const property of unknownProperties) {
      addIssue(
        issues,
        joinPath(path, property),
        "additionalProperties",
        "is not an allowed property",
      );
    }
  } else if (typeof schema.additionalProperties === "object") {
    for (const property of unknownProperties) {
      validateSchema(
        schema.additionalProperties,
        value[property],
        joinPath(path, property),
        rootSchema,
        issues,
        ancestors,
      );
    }
  }

  ancestors.delete(value);
}

function resolveReference(reference: string, rootSchema: JsonSchema): JsonSchema {
  const prefix = "#/$defs/";
  if (!reference.startsWith(prefix)) {
    throw new Error(`Unsupported internal schema reference: ${reference}`);
  }
  const definition = rootSchema.$defs?.[reference.slice(prefix.length)];
  if (definition === undefined) {
    throw new Error(`Unknown internal schema reference: ${reference}`);
  }
  return definition;
}

function matchesType(type: JsonSchema["type"], value: unknown): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isPlainRecord(value);
    case "string":
      return typeof value === "string";
    case undefined:
      return true;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRfc3339Timestamp(value: string): boolean {
  const match =
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(
      value,
    );
  if (match?.groups === undefined || Number.isNaN(Date.parse(value))) {
    return false;
  }

  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return (
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day
  );
}

function addIssue(
  issues: DomainSchemaIssue[],
  path: string,
  keyword: string,
  message: string,
): void {
  issues.push({
    path: path.length === 0 ? "/" : path,
    keyword,
    message,
  });
}

function joinPath(path: string, segment: string): string {
  const escaped = segment.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${escaped}`;
}

function article(type: Exclude<JsonSchema["type"], undefined>): "a" | "an" {
  return type === "array" || type === "integer" || type === "object" ? "an" : "a";
}

function canonicalValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalValue(item)).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
      .join(",")}}`;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return `${typeof value}:${value}`;
  }
  if (typeof value === "symbol") {
    return `symbol:${value.description ?? ""}`;
  }
  if (typeof value === "function") {
    return `function:${value.name}`;
  }
  return `${typeof value}:unsupported`;
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item));
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
  }
  return value;
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    value.forEach((item) => freezeJson(item));
    return Object.freeze(value);
  }
  if (isPlainRecord(value)) {
    Object.values(value).forEach((item) => freezeJson(item));
    return Object.freeze(value);
  }
  return value;
}
