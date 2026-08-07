export class BridgeControlError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "BridgeControlError";
  }
}

export function controlError(
  code: string,
  details: Readonly<Record<string, unknown>> = {},
): BridgeControlError {
  return new BridgeControlError(code, "Agent Bridge control request failed", details);
}
