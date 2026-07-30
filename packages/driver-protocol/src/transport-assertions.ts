import { isAbsolute } from "node:path";

import { assertAgentEvent } from "./assertions.js";
import {
  DRIVER_TRANSPORT_METHODS,
  DRIVER_TRANSPORT_VERSION,
  DriverTransportError,
  type DriverTransportErrorPayload,
  type DriverTransportMessage,
  type DriverTransportMethod,
  type DriverWorkerInitialization,
} from "./transport-types.js";
import type { JsonObject, JsonValue } from "./types.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function assertDriverTransportMessage(
  value: unknown,
): asserts value is DriverTransportMessage {
  if (!isPlainRecord(value) || typeof value.kind !== "string") {
    throw invalidMessage("MESSAGE_SHAPE_INVALID");
  }
  assertTransportVersion(value.transportVersion);

  switch (value.kind) {
    case "ready":
      assertOnlyKeys(value, ["kind", "transportVersion", "hostId"]);
      assertIdentifier(value.hostId, "HOST_ID_INVALID");
      return;
    case "request":
      assertOnlyKeys(value, ["kind", "transportVersion", "requestId", "method", "params"]);
      assertIdentifier(value.requestId, "REQUEST_ID_INVALID");
      if (!isDriverTransportMethod(value.method) || !isJsonObject(value.params)) {
        throw invalidMessage("REQUEST_INVALID");
      }
      return;
    case "response":
      assertIdentifier(value.requestId, "REQUEST_ID_INVALID");
      if (value.ok === true) {
        assertOnlyKeys(value, ["kind", "transportVersion", "requestId", "ok", "result"]);
        if (!isJsonValue(value.result)) {
          throw invalidMessage("RESPONSE_RESULT_INVALID");
        }
        return;
      }
      if (value.ok === false) {
        assertOnlyKeys(value, ["kind", "transportVersion", "requestId", "ok", "error"]);
        assertErrorPayload(value.error);
        return;
      }
      throw invalidMessage("RESPONSE_INVALID");
    case "event":
      assertOnlyKeys(value, ["kind", "transportVersion", "subscriptionId", "event"]);
      assertIdentifier(value.subscriptionId, "SUBSCRIPTION_ID_INVALID");
      assertAgentEvent(value.event);
      return;
    case "stream_closed":
      assertOnlyKeys(value, ["kind", "transportVersion", "subscriptionId"]);
      assertIdentifier(value.subscriptionId, "SUBSCRIPTION_ID_INVALID");
      return;
    default:
      throw invalidMessage("MESSAGE_KIND_INVALID");
  }
}

export function readDriverWorkerInitialization(value: unknown): DriverWorkerInitialization {
  if (!isPlainRecord(value)) {
    throw invalidMessage("INITIALIZATION_INVALID");
  }
  assertOnlyKeys(value, ["workDirectory", "configuration", "recoveryStates"]);
  if (
    typeof value.workDirectory !== "string" ||
    value.workDirectory.length === 0 ||
    !isAbsolute(value.workDirectory) ||
    (value.configuration !== undefined && !isJsonObject(value.configuration)) ||
    (value.recoveryStates !== undefined &&
      (!Array.isArray(value.recoveryStates) || !value.recoveryStates.every(isJsonObject)))
  ) {
    throw invalidMessage("INITIALIZATION_INVALID");
  }
  return Object.freeze({
    workDirectory: value.workDirectory,
    ...(value.configuration === undefined
      ? {}
      : { configuration: structuredClone(value.configuration) }),
    ...(value.recoveryStates === undefined
      ? {}
      : {
          recoveryStates: Object.freeze(
            value.recoveryStates.map((state) => structuredClone(state)),
          ),
        }),
  });
}

export function isDriverTransportMethod(value: unknown): value is DriverTransportMethod {
  return DRIVER_TRANSPORT_METHODS.some((method) => method === value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isPlainRecord(value) && Object.values(value).every(isJsonValue);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isJsonObject(value);
}

function assertTransportVersion(value: unknown): void {
  if (value !== DRIVER_TRANSPORT_VERSION) {
    throw new DriverTransportError(
      "DRIVER_TRANSPORT_VERSION_UNSUPPORTED",
      "Driver transport version is unsupported",
      { expected: DRIVER_TRANSPORT_VERSION },
    );
  }
}

function assertErrorPayload(value: unknown): asserts value is DriverTransportErrorPayload {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some((key) => !["code", "message", "retryable"].includes(key)) ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    typeof value.retryable !== "boolean"
  ) {
    throw invalidMessage("ERROR_PAYLOAD_INVALID");
  }
}

function assertIdentifier(value: unknown, reason: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw invalidMessage(reason);
  }
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw invalidMessage("UNKNOWN_FIELD");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function invalidMessage(reason: string): DriverTransportError {
  return new DriverTransportError(
    "DRIVER_TRANSPORT_MESSAGE_INVALID",
    "Driver transport message is invalid",
    { reason },
  );
}
