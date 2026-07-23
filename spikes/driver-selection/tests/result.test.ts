import { describe, expect, it } from "vitest";

import { finalizeReport, normalizeReport, probe } from "../src/harness/result.js";

describe("driver-selection 结果归一化", () => {
  it("B 层待验证项不导致 A 层失败，证据文本不影响重复性", () => {
    const base = {
      candidate: "codex" as const,
      layer: "A" as const,
      packageName: "@openai/codex-sdk",
      packageVersion: "0.144.6",
      probes: [probe("session", "b-layer-required", "first evidence")],
      residualProcessCount: 0,
    };
    const first = finalizeReport(base);
    const second = finalizeReport({
      ...base,
      probes: [probe("session", "b-layer-required", "different evidence")],
    });

    expect(first.passed).toBe(true);
    expect(normalizeReport(first)).toBe(normalizeReport(second));
  });
});
