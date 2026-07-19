import { describe, expect, it } from "vitest";

import { ClineCore } from "../sdk-public-surface.js";
import { inspectSdkSurface, REQUIRED_CLINE_CORE_METHODS } from "./capabilities.js";

describe("Cline SDK 静态能力面", () => {
  it("导出 ClineCore.create", () => {
    expect(typeof ClineCore.create).toBe("function");
  });

  it("固定 Driver 需要验证的核心生命周期能力清单", () => {
    const report = inspectSdkSurface();

    expect(report.requiredMethods).toEqual(REQUIRED_CLINE_CORE_METHODS);
    expect(report.requiredMethods).toContain("getAccumulatedUsage");
    expect(report.requiredMethods).toContain("restore");
  });
});
