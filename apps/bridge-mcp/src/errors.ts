export const BRIDGE_ERROR_CATEGORIES = [
  "INPUT",
  "NOT_FOUND",
  "CONFLICT",
  "POLICY",
  "RECOVERY",
  "TRANSIENT",
  "INTERNAL",
] as const;

export type BridgeErrorCategory = (typeof BRIDGE_ERROR_CATEGORIES)[number];

export class BridgeControlError extends Error {
  public readonly category: BridgeErrorCategory;
  public readonly retryable: boolean;

  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "BridgeControlError";
    const classification = classifyBridgeError(code);
    this.category = classification.category;
    this.retryable = classification.retryable;
  }
}

export function controlError(
  code: string,
  details: Readonly<Record<string, unknown>> = {},
): BridgeControlError {
  return new BridgeControlError(code, "Agent Bridge control request failed", details);
}

export function classifyBridgeError(code: string): {
  readonly category: BridgeErrorCategory;
  readonly retryable: boolean;
} {
  if (code === "INTERNAL_ERROR") return { category: "INTERNAL", retryable: false };
  if (code.includes("NOT_FOUND") || code.includes("MISSING")) {
    return { category: "NOT_FOUND", retryable: false };
  }
  if (code.includes("RECOVERY") || code.includes("INTERRUPT") || code.includes("LEASE")) {
    return { category: "RECOVERY", retryable: false };
  }
  if (code.includes("CONFLICT") || code.includes("ALREADY") || code.includes("REVISION")) {
    return { category: "CONFLICT", retryable: false };
  }
  if (code.includes("TIMEOUT") || code.includes("UNAVAILABLE") || code.includes("TRANSPORT")) {
    return { category: "TRANSIENT", retryable: true };
  }
  if (code.includes("BUSY")) return { category: "TRANSIENT", retryable: true };
  if (
    code.includes("POLICY") ||
    code.includes("APPROVAL") ||
    code.includes("PERMISSION") ||
    code.includes("SENSITIVE")
  ) {
    return { category: "POLICY", retryable: false };
  }
  return { category: "INPUT", retryable: false };
}
