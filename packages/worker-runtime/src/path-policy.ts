import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";

import type { AgentRole, TaskScope } from "@agent-bridge/schemas";

import { WorkerRuntimeError } from "./errors.js";
import { assertRoleCanWritePath, type WritablePathKind } from "./role-templates.js";

export interface PathAuthorizationRequest {
  readonly worktreeRoot: string;
  readonly requestedPath: string;
  readonly access: "read" | "write";
  readonly role: AgentRole;
  readonly scope: TaskScope;
}

export interface AuthorizedWorkspacePath {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly kind: WritablePathKind;
}

export async function authorizeWorkspacePath(
  request: PathAuthorizationRequest,
): Promise<AuthorizedWorkspacePath> {
  const relativePath = normalizeWorkspacePath(request.requestedPath);
  const root = await realpath(request.worktreeRoot).catch(() => {
    throw new WorkerRuntimeError("PATH_POLICY_DENIED", "Worktree root is unavailable");
  });
  const target = resolve(root, ...relativePath.split("/"));
  assertContained(root, target, "PATH_TRAVERSAL");
  const canonicalBoundary = await resolveExistingBoundary(target);
  assertContained(root, canonicalBoundary, "PATH_SYMLINK_ESCAPE");

  if (request.scope.deny.some((pattern) => matchesWorkspacePattern(relativePath, pattern))) {
    throw denied(relativePath, "DENY_PATTERN_MATCHED");
  }

  const allowedPatterns = request.access === "read" ? request.scope.read : request.scope.write;
  if (!allowedPatterns.some((pattern) => matchesWorkspacePattern(relativePath, pattern))) {
    throw denied(relativePath, "ALLOW_PATTERN_MISSING");
  }

  const kind = classifyWorkspacePath(relativePath);
  if (request.access === "write") {
    assertRoleCanWritePath(request.role, kind);
  }
  return Object.freeze({ absolutePath: target, relativePath, kind });
}

export function normalizeWorkspacePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    isAbsolute(value) ||
    win32.isAbsolute(value)
  ) {
    throw new WorkerRuntimeError("PATH_TRAVERSAL", "Workspace path is not a safe relative path");
  }
  const normalized = value
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part !== "");
  if (normalized.length === 0 || normalized.some((part) => part === "." || part === "..")) {
    throw new WorkerRuntimeError("PATH_TRAVERSAL", "Workspace path traversal is not allowed");
  }
  return normalized.join("/");
}

export function matchesWorkspacePattern(relativePath: string, rawPattern: string): boolean {
  let pattern: string;
  try {
    pattern = normalizeWorkspacePath(rawPattern);
  } catch {
    return false;
  }
  return globToRegExp(pattern).test(relativePath);
}

export function classifyWorkspacePath(relativePath: string): WritablePathKind {
  const path = normalizeWorkspacePath(relativePath);
  if (
    matchesWorkspacePattern(path, "tests/**") ||
    matchesWorkspacePattern(path, "test/**") ||
    matchesWorkspacePattern(path, "**/__tests__/**") ||
    matchesWorkspacePattern(path, "**/*.test.*") ||
    matchesWorkspacePattern(path, "**/*.spec.*")
  ) {
    return "test";
  }
  if (
    matchesWorkspacePattern(path, "docs/**") ||
    matchesWorkspacePattern(path, "*.md") ||
    matchesWorkspacePattern(path, "**/*.md") ||
    matchesWorkspacePattern(path, "**/*.mdx")
  ) {
    return "docs";
  }
  return "product";
}

async function resolveExistingBoundary(target: string): Promise<string> {
  let candidate = target;
  while (true) {
    try {
      await lstat(candidate);
      return await realpath(candidate);
    } catch (error) {
      if (!isMissing(error)) {
        throw new WorkerRuntimeError("PATH_POLICY_DENIED", "Workspace path cannot be inspected");
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new WorkerRuntimeError("PATH_POLICY_DENIED", "Workspace path has no existing parent");
      }
      candidate = parent;
    }
  }
}

function assertContained(
  root: string,
  target: string,
  code: "PATH_TRAVERSAL" | "PATH_SYMLINK_ESCAPE",
): void {
  const fromRoot = relative(root, target);
  if (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  ) {
    return;
  }
  throw new WorkerRuntimeError(code, "Workspace path escapes the authorized worktree");
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  }
  if (pattern.endsWith("/**")) {
    source = `${source.slice(0, -2)}(?:.*)?`;
  }
  return new RegExp(`${source}$`, "u");
}

function denied(path: string, reason: string): WorkerRuntimeError {
  return new WorkerRuntimeError("PATH_POLICY_DENIED", "Workspace path is not authorized", {
    path,
    reason,
  });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
