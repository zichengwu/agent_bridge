import { describe, expect, it } from "vitest";

import {
  assertFreshPriceSnapshot,
  assertRealGatewayPolicy,
  calculateProviderCostMicros,
  realGatewayPolicy,
  VERIFIED_PRICE_SNAPSHOT,
} from "../src/harness/provider-policy.js";

describe("B-real Provider 策略", () => {
  it("固定域名、路径、模型和官方美元价格", () => {
    const policy = realGatewayPolicy("opencode", "synthetic-token");
    expect(() => assertRealGatewayPolicy(policy)).not.toThrow();
    expect(policy).toMatchObject({
      upstreamOrigin: "https://api.deepseek.com",
      localPath: "/v1/chat/completions",
      upstreamPath: "/chat/completions",
      allowedModel: "deepseek-v4-pro",
    });
    expect(calculateProviderCostMicros(1_000_000, 1_000_000, VERIFIED_PRICE_SNAPSHOT)).toBe(
      1_305_000,
    );
  });

  it("拒绝过期价格快照和错误上游", () => {
    expect(() =>
      assertFreshPriceSnapshot(VERIFIED_PRICE_SNAPSHOT, Date.parse("2026-07-24T00:00:01+08:00")),
    ).toThrow("B_LAYER_PRICE_SNAPSHOT_STALE");
    const policy = realGatewayPolicy("opencode", "synthetic-token");
    expect(() =>
      assertRealGatewayPolicy({
        ...policy,
        upstreamOrigin: "https://example.invalid" as "https://api.deepseek.com",
      }),
    ).toThrow("PROVIDER_DOMAIN_NOT_ALLOWED");
  });
});
