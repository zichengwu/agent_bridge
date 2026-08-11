import { describe, expect, it } from "vitest";

import { BridgeControlError } from "../../../src/errors.js";
import { taskResultUsageFromAgentResult } from "../../../src/usage-facts.js";

describe("Slice A AgentResult usage 持久事实", () => {
  it("READ-007 将 Driver usage 转成不会被凭据扫描器误删的冻结单位字段", () => {
    const usage = taskResultUsageFromAgentResult({
      usage: {
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 100,
        cacheWriteTokens: 20,
      },
      completedAt: "2026-08-11T10:00:00.000Z",
    });

    expect(usage).toEqual({
      unit: "token",
      input_units: 1200,
      output_units: 300,
      cache_read_units: 100,
      cache_write_units: 20,
      total_units: 1620,
      source: "driver_exact",
      measured_at: "2026-08-11T10:00:00.000Z",
    });
    expect(Object.isFrozen(usage)).toBe(true);
  });

  it("缺少整条 usage 时保持未上报，缺少缓存分量时仅缓存按零求和", () => {
    expect(
      taskResultUsageFromAgentResult({
        completedAt: "2026-08-11T10:00:00.000Z",
      }),
    ).toBeUndefined();
    expect(
      taskResultUsageFromAgentResult({
        usage: { inputTokens: 7, outputTokens: 3 },
        completedAt: "2026-08-11T10:00:00.000Z",
      }),
    ).toMatchObject({ cache_read_units: 0, cache_write_units: 0, total_units: 10 });
  });

  it("非法或溢出的 Driver 计数在持久化前 fail closed", () => {
    expect(() =>
      taskResultUsageFromAgentResult({
        usage: { inputTokens: -1, outputTokens: 3 },
        completedAt: "2026-08-11T10:00:00.000Z",
      }),
    ).toThrowError(BridgeControlError);
    expect(() =>
      taskResultUsageFromAgentResult({
        usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
        completedAt: "2026-08-11T10:00:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "DRIVER_RESULT_USAGE_INVALID" }));
  });
});
