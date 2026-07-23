import { describe, expect, it } from "vitest";

import { findDescendantPids, parseProcessTable } from "../src/harness/process-tracker.js";

describe("driver-selection 进程追踪", () => {
  it("解析进程表并递归查找后代进程", () => {
    const rows = parseProcessTable(`
      10     1 root
      11    10 child
      12    11 grandchild
      20     1 unrelated
    `);

    expect(findDescendantPids(rows, 10)).toEqual([11, 12]);
  });
});
