export const DRIVER_PROTOCOL_ERROR_CODES = [
  "DRIVER_PROTOCOL_VERSION_UNSUPPORTED",
  "DRIVER_CAPABILITIES_INVALID",
  "DRIVER_CAPABILITY_NOT_SUPPORTED",
  "DRIVER_EVENT_INVALID",
  "DRIVER_EVENT_CORRELATION_MISSING",
  "DRIVER_EVENT_SEQUENCE_VIOLATION",
] as const;

export type DriverProtocolErrorCode = (typeof DRIVER_PROTOCOL_ERROR_CODES)[number];

export class DriverProtocolError extends Error {
  readonly code: DriverProtocolErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: DriverProtocolErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DriverProtocolError";
    this.code = code;
    this.details = details;
  }
}
