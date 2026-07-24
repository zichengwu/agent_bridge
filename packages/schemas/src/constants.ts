export const DOMAIN_SCHEMA_VERSION = "1.0" as const;

export type DomainSchemaVersion = typeof DOMAIN_SCHEMA_VERSION;

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema" as const;

export const DOMAIN_SCHEMA_KINDS = [
  "task",
  "taskVersion",
  "taskResult",
  "taskRelation",
  "agentSessionBinding",
  "contextPackage",
  "handoffPackage",
  "continuationSnapshot",
] as const;

export type DomainSchemaKind = (typeof DOMAIN_SCHEMA_KINDS)[number];

export const DOMAIN_SCHEMA_IDS = {
  task: "urn:agent-bridge:schema:domain:task:1.0",
  taskVersion: "urn:agent-bridge:schema:domain:task-version:1.0",
  taskResult: "urn:agent-bridge:schema:domain:task-result:1.0",
  taskRelation: "urn:agent-bridge:schema:domain:task-relation:1.0",
  agentSessionBinding: "urn:agent-bridge:schema:domain:agent-session-binding:1.0",
  contextPackage: "urn:agent-bridge:schema:domain:context-package:1.0",
  handoffPackage: "urn:agent-bridge:schema:domain:handoff-package:1.0",
  continuationSnapshot: "urn:agent-bridge:schema:domain:continuation-snapshot:1.0",
} as const satisfies Readonly<Record<DomainSchemaKind, string>>;
