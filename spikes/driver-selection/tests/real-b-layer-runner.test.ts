import { describe, expect, it } from "vitest";

import { runRealBLayer } from "../src/harness/real-b-layer-runner.js";

describe("B-real Runner 门禁", () => {
  it("在创建临时仓库和网关前校验凭据数量", async () => {
    await expect(
      runRealBLayer("b:collaboration", { credentials: [], totalBudgetUsd: 0.24 }),
    ).rejects.toThrow("B_LAYER_CREDENTIAL_COUNT_INVALID");
  });

  it("在创建临时仓库和网关前二次校验总预算", async () => {
    const credentials = [Buffer.from("temporary-key-one"), Buffer.from("temporary-key-two")];
    await expect(
      runRealBLayer("b:collaboration", { credentials, totalBudgetUsd: 0.12 }),
    ).rejects.toThrow("B_LAYER_TOTAL_BUDGET_INVALID");
    for (const credential of credentials) credential.fill(0);
  });
});
