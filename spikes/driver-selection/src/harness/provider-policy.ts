import type { BLayerCandidateId } from "../contract.js";

export type ProviderProtocol = "openai" | "anthropic";

export interface ProviderPriceSnapshot {
  source: "https://api-docs.deepseek.com/quick_start/pricing/";
  checkedAt: string;
  currency: "USD";
  model: "deepseek-v4-pro";
  cacheHitInputUsdPerMillion: 0.003625;
  cacheMissInputUsdPerMillion: 0.435;
  outputUsdPerMillion: 0.87;
}

export interface RealGatewayLimits {
  maxRequests: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostMicros: number;
  maxBodyBytes: number;
  maxResponseBytes: number;
  maxWallClockMs: 600_000;
  maxRequestMs: 180_000;
}

export interface RealGatewayPolicy {
  candidate: BLayerCandidateId;
  protocol: ProviderProtocol;
  syntheticToken: string;
  localPath: "/v1/chat/completions" | "/anthropic/v1/messages";
  upstreamPath: "/chat/completions" | "/anthropic/v1/messages";
  allowedModel: "deepseek-v4-pro";
  upstreamOrigin: "https://api.deepseek.com";
  price: ProviderPriceSnapshot;
  limits: RealGatewayLimits;
}

export const VERIFIED_PRICE_SNAPSHOT: ProviderPriceSnapshot = {
  source: "https://api-docs.deepseek.com/quick_start/pricing/",
  checkedAt: "2026-07-22T00:00:00+08:00",
  currency: "USD",
  model: "deepseek-v4-pro",
  cacheHitInputUsdPerMillion: 0.003625,
  cacheMissInputUsdPerMillion: 0.435,
  outputUsdPerMillion: 0.87,
};

export function defaultRealGatewayLimits(): RealGatewayLimits {
  return {
    maxRequests: 12,
    maxInputTokens: 200_000,
    maxOutputTokens: 16_000,
    maxCostMicros: 120_000,
    maxBodyBytes: 2 * 1024 * 1024,
    maxResponseBytes: 8 * 1024 * 1024,
    maxWallClockMs: 600_000,
    maxRequestMs: 180_000,
  };
}

export function realGatewayPolicy(
  candidate: BLayerCandidateId,
  syntheticToken: string,
  price = VERIFIED_PRICE_SNAPSHOT,
): RealGatewayPolicy {
  const anthropic = candidate === "claude-agent";
  return {
    candidate,
    protocol: anthropic ? "anthropic" : "openai",
    syntheticToken,
    localPath: anthropic ? "/anthropic/v1/messages" : "/v1/chat/completions",
    upstreamPath: anthropic ? "/anthropic/v1/messages" : "/chat/completions",
    allowedModel: "deepseek-v4-pro",
    upstreamOrigin: "https://api.deepseek.com",
    price,
    limits: defaultRealGatewayLimits(),
  };
}

export function assertFreshPriceSnapshot(
  snapshot: ProviderPriceSnapshot,
  now = Date.now(),
  maxAgeMs = 24 * 60 * 60 * 1000,
): void {
  const checkedAt = Date.parse(snapshot.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt > maxAgeMs) {
    throw new Error("B_LAYER_PRICE_SNAPSHOT_STALE");
  }
  if (
    snapshot.source !== "https://api-docs.deepseek.com/quick_start/pricing/" ||
    snapshot.currency !== "USD" ||
    snapshot.model !== "deepseek-v4-pro"
  ) {
    throw new Error("B_LAYER_PRICE_SNAPSHOT_INVALID");
  }
}

export function calculateProviderCostMicros(
  inputTokens: number,
  outputTokens: number,
  snapshot: ProviderPriceSnapshot,
): number {
  return Math.ceil(
    (inputTokens * snapshot.cacheMissInputUsdPerMillion * 1_000_000 +
      outputTokens * snapshot.outputUsdPerMillion * 1_000_000) /
      1_000_000,
  );
}

export function assertRealGatewayPolicy(policy: RealGatewayPolicy): void {
  if (policy.upstreamOrigin !== "https://api.deepseek.com") {
    throw new Error("PROVIDER_DOMAIN_NOT_ALLOWED");
  }
  if (policy.allowedModel !== "deepseek-v4-pro") {
    throw new Error("PROVIDER_MODEL_NOT_ALLOWED");
  }
  const expected =
    policy.protocol === "openai"
      ? ["/v1/chat/completions", "/chat/completions"]
      : ["/anthropic/v1/messages", "/anthropic/v1/messages"];
  if (policy.localPath !== expected[0] || policy.upstreamPath !== expected[1]) {
    throw new Error("PROVIDER_PATH_NOT_ALLOWED");
  }
}
