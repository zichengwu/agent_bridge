import type { AgentResult, TokenUsage } from "@agent-bridge/driver-protocol";
import type { TaskResultUsage } from "@agent-bridge/schemas";

import { controlError } from "./errors.js";

export function taskResultUsageFromAgentResult(
  result: Pick<AgentResult, "usage" | "completedAt">,
): TaskResultUsage | undefined {
  if (result.usage === undefined) {
    return undefined;
  }

  const inputUnits = readUsageComponent(result.usage, "inputTokens");
  const outputUnits = readUsageComponent(result.usage, "outputTokens");
  const cacheReadUnits = readUsageComponent(result.usage, "cacheReadTokens", 0);
  const cacheWriteUnits = readUsageComponent(result.usage, "cacheWriteTokens", 0);
  const totalUnits = inputUnits + outputUnits + cacheReadUnits + cacheWriteUnits;
  if (!Number.isSafeInteger(totalUnits)) {
    throw controlError("DRIVER_RESULT_USAGE_INVALID");
  }

  return Object.freeze({
    unit: "token",
    input_units: inputUnits,
    output_units: outputUnits,
    cache_read_units: cacheReadUnits,
    cache_write_units: cacheWriteUnits,
    total_units: totalUnits,
    source: "driver_exact",
    measured_at: result.completedAt,
  });
}

function readUsageComponent<K extends keyof TokenUsage>(
  usage: TokenUsage,
  field: K,
  fallback?: number,
): number {
  const value = usage[field] ?? fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw controlError("DRIVER_RESULT_USAGE_INVALID", { field });
  }
  return value;
}
