import type { Readable, Writable } from "node:stream";

import {
  assertDriverTransportMessage,
  isJsonObject,
  isJsonValue,
  readDriverWorkerInitialization,
} from "./transport-assertions.js";
import { readJsonLines, writeJsonLine } from "./jsonl-codec.js";
import {
  DRIVER_TRANSPORT_VERSION,
  DriverTransportError,
  type DriverHostFactory,
  type DriverTransportRequestMessage,
  type ManagedAgentDriver,
} from "./transport-types.js";
import type { JsonObject, JsonValue } from "./types.js";

export interface StdioDriverHostOptions {
  readonly hostId: string;
  readonly input: Readable;
  readonly output: Writable;
  readonly diagnostics?: Writable;
  readonly factory: DriverHostFactory;
  readonly redactError?: (value: string) => string;
  readonly maxLineBytes?: number;
}

interface SubscriptionState {
  readonly iterator: AsyncIterator<unknown>;
  readonly task: Promise<void>;
}

export async function runStdioDriverHost(options: StdioDriverHostOptions): Promise<void> {
  const requestIds = new Set<string>();
  const subscriptions = new Map<string, SubscriptionState>();
  let driver: ManagedAgentDriver | undefined;
  let stopping = false;

  await writeJsonLine(options.output, {
    kind: "ready",
    transportVersion: DRIVER_TRANSPORT_VERSION,
    hostId: options.hostId,
  });

  try {
    for await (const value of readJsonLines(options.input, options.maxLineBytes)) {
      assertDriverTransportMessage(value);
      if (value.kind !== "request") {
        throw new DriverTransportError(
          "DRIVER_TRANSPORT_MESSAGE_INVALID",
          "Driver host accepts request messages only",
        );
      }
      if (requestIds.has(value.requestId)) {
        await writeFailure(
          options.output,
          value.requestId,
          new DriverTransportError(
            "DRIVER_TRANSPORT_REQUEST_DUPLICATE",
            "Driver transport request ID was already used",
          ),
          options.redactError,
        );
        continue;
      }
      requestIds.add(value.requestId);

      try {
        if (value.method === "initialize") {
          if (driver !== undefined) {
            throw new DriverTransportError(
              "DRIVER_TRANSPORT_REQUEST_DUPLICATE",
              "Driver host is already initialized",
            );
          }
          driver = await options.factory.create(readDriverWorkerInitialization(value.params));
          await writeSuccess(options.output, value.requestId, null);
          continue;
        }
        if (driver === undefined) {
          throw new DriverTransportError(
            "DRIVER_TRANSPORT_CLOSED",
            "Driver host has not been initialized",
          );
        }

        const result = await dispatch(driver, value, subscriptions, options.output);
        await writeSuccess(options.output, value.requestId, result);
        if (value.method === "shutdown") {
          stopping = true;
          break;
        }
      } catch (error) {
        await writeFailure(options.output, value.requestId, error, options.redactError);
      }
    }
  } finally {
    for (const subscription of subscriptions.values()) {
      await subscription.iterator.return?.();
    }
    await Promise.allSettled([...subscriptions.values()].map((state) => state.task));
    if (!stopping) {
      await driver?.close?.();
    }
  }
}

async function dispatch(
  driver: ManagedAgentDriver,
  request: DriverTransportRequestMessage,
  subscriptions: Map<string, SubscriptionState>,
  output: Writable,
): Promise<JsonValue> {
  switch (request.method) {
    case "describeCapabilities":
      return toJsonValue(await driver.describeCapabilities());
    case "prepareTask":
      return toJsonValue(await driver.prepareTask(request.params as never));
    case "startTask":
      return toJsonValue(await driver.startTask(request.params as never));
    case "resumeTask":
      return toJsonValue(await driver.resumeTask(request.params as never));
    case "getContextUsage":
      return toJsonValue(await driver.getContextUsage(readString(request.params, "sessionId")));
    case "createSuccessorSession":
      return toJsonValue(await driver.createSuccessorSession(request.params as never));
    case "sendFeedback":
      await driver.sendFeedback(request.params as never);
      return null;
    case "respondToPermission":
      return toJsonValue(await driver.respondToPermission(request.params as never));
    case "cancelTask":
      return toJsonValue(await driver.cancelTask(request.params as never));
    case "collectResult":
      return toJsonValue(await driver.collectResult(readString(request.params, "runId")));
    case "healthCheck":
      return toJsonValue(await driver.healthCheck());
    case "exportRecoveryState": {
      if (driver.exportRecoveryState === undefined) {
        throw new DriverTransportError(
          "DRIVER_TRANSPORT_METHOD_UNSUPPORTED",
          "Driver does not export recovery state",
        );
      }
      return toJsonValue(await driver.exportRecoveryState(readString(request.params, "runId")));
    }
    case "subscribeEvents": {
      const runId = readString(request.params, "runId");
      const subscriptionId = readString(request.params, "subscriptionId");
      if (subscriptions.has(subscriptionId)) {
        throw new DriverTransportError(
          "DRIVER_TRANSPORT_REQUEST_DUPLICATE",
          "Driver event subscription already exists",
        );
      }
      const iterator = driver.streamEvents(runId)[Symbol.asyncIterator]();
      const task = pumpEvents(iterator, subscriptionId, output).finally(() => {
        subscriptions.delete(subscriptionId);
      });
      subscriptions.set(subscriptionId, { iterator, task });
      return null;
    }
    case "unsubscribeEvents": {
      const subscriptionId = readString(request.params, "subscriptionId");
      const subscription = subscriptions.get(subscriptionId);
      await subscription?.iterator.return?.();
      return null;
    }
    case "shutdown":
      await driver.close?.();
      return null;
    case "initialize":
      throw new DriverTransportError(
        "DRIVER_TRANSPORT_REQUEST_DUPLICATE",
        "Driver host is already initialized",
      );
  }
}

async function pumpEvents(
  iterator: AsyncIterator<unknown>,
  subscriptionId: string,
  output: Writable,
): Promise<void> {
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      await writeJsonLine(output, {
        kind: "event",
        transportVersion: DRIVER_TRANSPORT_VERSION,
        subscriptionId,
        event: next.value,
      });
    }
  } finally {
    await writeJsonLine(output, {
      kind: "stream_closed",
      transportVersion: DRIVER_TRANSPORT_VERSION,
      subscriptionId,
    });
  }
}

async function writeSuccess(output: Writable, requestId: string, result: JsonValue): Promise<void> {
  await writeJsonLine(output, {
    kind: "response",
    transportVersion: DRIVER_TRANSPORT_VERSION,
    requestId,
    ok: true,
    result,
  });
}

async function writeFailure(
  output: Writable,
  requestId: string,
  error: unknown,
  redact: (value: string) => string = (value) => value,
): Promise<void> {
  const code = readErrorCode(error);
  const message = redact(error instanceof Error ? error.message : "Driver request failed");
  await writeJsonLine(output, {
    kind: "response",
    transportVersion: DRIVER_TRANSPORT_VERSION,
    requestId,
    ok: false,
    error: {
      code,
      message,
      retryable: readRetryable(error),
    },
  });
}

function readString(value: JsonObject, field: string): string {
  const selected = value[field];
  if (typeof selected !== "string" || selected.length === 0) {
    throw new DriverTransportError(
      "DRIVER_TRANSPORT_MESSAGE_INVALID",
      "Driver request parameter is invalid",
      { field },
    );
  }
  return selected;
}

function toJsonValue(value: unknown): JsonValue {
  if (!isJsonValue(value)) {
    throw new DriverTransportError(
      "DRIVER_TRANSPORT_MESSAGE_INVALID",
      "Driver result is not JSON serializable",
    );
  }
  return structuredClone(value);
}

function readErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length > 0
  ) {
    return error.code;
  }
  return "DRIVER_REQUEST_FAILED";
}

function readRetryable(error: unknown): boolean {
  return Boolean(
    typeof error === "object" && error !== null && "retryable" in error && error.retryable === true,
  );
}

export function asJsonObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    throw new DriverTransportError(
      "DRIVER_TRANSPORT_MESSAGE_INVALID",
      "Driver recovery state is not a JSON object",
    );
  }
  return structuredClone(value);
}
