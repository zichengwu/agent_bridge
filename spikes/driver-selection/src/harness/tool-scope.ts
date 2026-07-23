import { realpathSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

import type { BLayerScenarioResult } from "../contract.js";

export function isPathWithinRoot(root: string, candidate: string): boolean {
  if (candidate.length === 0 || candidate.includes("\0") || /^\w+:\/\//.test(candidate)) {
    return false;
  }
  const normalizedRoot = canonicalPath(resolve(root));
  const normalizedCandidate = canonicalPath(resolve(normalizedRoot, candidate));
  const relation = relative(normalizedRoot, normalizedCandidate);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith("/"));
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    const parent = dirname(value);
    try {
      return resolve(realpathSync(parent), basename(value));
    } catch {
      return value;
    }
  }
}

export function shouldAllowOpenCodePermission(input: {
  scenario: BLayerScenarioResult["scenario"];
  workDirectory: string;
  permission?: string;
  patterns?: unknown;
}): boolean {
  if (input.scenario !== "write" || input.permission !== "edit") return false;
  if (!Array.isArray(input.patterns) || input.patterns.length === 0) return false;
  return input.patterns.every(
    (pattern) => typeof pattern === "string" && isPathWithinRoot(input.workDirectory, pattern),
  );
}

export function shouldAllowClaudeTool(input: {
  scenario: BLayerScenarioResult["scenario"];
  workDirectory: string;
  toolName: string;
  toolInput: unknown;
}): boolean {
  const allowedTools =
    input.scenario === "write"
      ? new Set(["Read", "Write"])
      : input.scenario === "review"
        ? new Set(["Read"])
        : new Set<string>();
  if (!allowedTools.has(input.toolName)) return false;
  const record = asRecord(input.toolInput);
  const path = record?.file_path ?? record?.path;
  return typeof path === "string" && isPathWithinRoot(input.workDirectory, path);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
