import type { AgentDriver, AgentEvent, JsonObject, JsonValue } from "./types.js";

export const DRIVER_TRANSPORT_VERSION = "1.0" as const;

export type DriverTransportVersion = typeof DRIVER_TRANSPORT_VERSION;

export const DRIVER_TRANSPORT_METHODS = [
  "initialize",
  "describeCapabilities",
  "prepareTask",
  "startTask",
  "resumeTask",
  "subscribeEvents",
  "unsubscribeEvents",
  "getContextUsage",
  "createSuccessorSession",
  "sendFeedback",
  "respondToPermission",
  "cancelTask",
  "collectResult",
  "healthCheck",
  "exportRecoveryState",
  "shutdown",
] as const;

export type DriverTransportMethod = (typeof DRIVER_TRANSPORT_METHODS)[number];

export interface DriverWorkerInitialization {
  readonly workDirectory: string;
  readonly configuration?: JsonObject;
  readonly recoveryStates?: readonly JsonObject[];
}

export interface DriverTransportReadyMessage {
  readonly kind: "ready";
  readonly transportVersion: DriverTransportVersion;
  readonly hostId: string;
}

export interface DriverTransportRequestMessage {
  readonly kind: "request";
  readonly transportVersion: DriverTransportVersion;
  readonly requestId: string;
  readonly method: DriverTransportMethod;
  readonly params: JsonObject;
}

export interface DriverTransportErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type DriverTransportResponseMessage =
  | {
      readonly kind: "response";
      readonly transportVersion: DriverTransportVersion;
      readonly requestId: string;
      readonly ok: true;
      readonly result: JsonValue;
    }
  | {
      readonly kind: "response";
      readonly transportVersion: DriverTransportVersion;
      readonly requestId: string;
      readonly ok: false;
      readonly error: DriverTransportErrorPayload;
    };

export interface DriverTransportEventMessage {
  readonly kind: "event";
  readonly transportVersion: DriverTransportVersion;
  readonly subscriptionId: string;
  readonly event: AgentEvent;
}

export interface DriverTransportStreamClosedMessage {
  readonly kind: "stream_closed";
  readonly transportVersion: DriverTransportVersion;
  readonly subscriptionId: string;
}

export type DriverTransportMessage =
  | DriverTransportReadyMessage
  | DriverTransportRequestMessage
  | DriverTransportResponseMessage
  | DriverTransportEventMessage
  | DriverTransportStreamClosedMessage;

export const DRIVER_TRANSPORT_ERROR_CODES = [
  "DRIVER_TRANSPORT_VERSION_UNSUPPORTED",
  "DRIVER_TRANSPORT_MESSAGE_INVALID",
  "DRIVER_TRANSPORT_LINE_TOO_LARGE",
  "DRIVER_TRANSPORT_REQUEST_DUPLICATE",
  "DRIVER_TRANSPORT_CORRELATION_MISSING",
  "DRIVER_TRANSPORT_METHOD_UNSUPPORTED",
  "DRIVER_TRANSPORT_CLOSED",
] as const;

export type DriverTransportErrorCode = (typeof DRIVER_TRANSPORT_ERROR_CODES)[number];

export class DriverTransportError extends Error {
  readonly code: DriverTransportErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: DriverTransportErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DriverTransportError";
    this.code = code;
    this.details = details;
  }
}

export interface ManagedAgentDriver extends AgentDriver {
  exportRecoveryState?(runId: string): unknown;
  close?(): Promise<void>;
}

export interface DriverHostFactory {
  create(initialization: DriverWorkerInitialization): Promise<ManagedAgentDriver>;
}
