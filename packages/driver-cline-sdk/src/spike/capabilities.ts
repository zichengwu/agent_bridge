import { ClineCore, CORE_BUILD_VERSION } from "../sdk-public-surface.js";

export const REQUIRED_CLINE_CORE_METHODS = [
  "start",
  "send",
  "subscribe",
  "get",
  "list",
  "listHistory",
  "readMessages",
  "getAccumulatedUsage",
  "abort",
  "stop",
  "dispose",
  "restore",
  "compareCheckpoint",
  "updateSessionCompactionState",
  "readSessionCompactionState",
] as const;

export interface SdkSurfaceReport {
  buildVersion: string;
  createAvailable: boolean;
  requiredMethods: readonly string[];
}

export function inspectSdkSurface(): SdkSurfaceReport {
  return {
    buildVersion: CORE_BUILD_VERSION,
    createAvailable: typeof ClineCore.create === "function",
    requiredMethods: REQUIRED_CLINE_CORE_METHODS,
  };
}

export function findMissingRuntimeMethods(runtime: unknown): string[] {
  const methodSurface = runtime as Record<string, unknown>;
  return REQUIRED_CLINE_CORE_METHODS.filter(
    (method) => typeof methodSurface[method] !== "function",
  );
}
