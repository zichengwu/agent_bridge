export const OBSERVABILITY_ERROR_CODES = [
  "EVENT_FANOUT_CONFIGURATION_INVALID",
  "EVENT_SUBSCRIPTION_INVALID",
  "EVENT_SUBSCRIPTION_CONFLICT",
] as const;

export type ObservabilityErrorCode = (typeof OBSERVABILITY_ERROR_CODES)[number];

export class ObservabilityError extends Error {
  readonly code: ObservabilityErrorCode;

  constructor(code: ObservabilityErrorCode) {
    super(messageFor(code));
    this.name = "ObservabilityError";
    this.code = code;
  }
}

function messageFor(code: ObservabilityErrorCode): string {
  switch (code) {
    case "EVENT_FANOUT_CONFIGURATION_INVALID":
      return "The event fanout configuration is invalid";
    case "EVENT_SUBSCRIPTION_INVALID":
      return "The event subscription is invalid";
    case "EVENT_SUBSCRIPTION_CONFLICT":
      return "The event subscription identifier is already active";
  }
}
