import { describe, expect, it } from "vitest";

describe("工程运行时基线", () => {
  it("使用 Node.js 22 或更高版本", () => {
    const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

    expect(major).toBeGreaterThanOrEqual(22);
  });
});
