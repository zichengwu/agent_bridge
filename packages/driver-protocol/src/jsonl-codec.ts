import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

import { DriverTransportError } from "./transport-types.js";

export const DEFAULT_DRIVER_TRANSPORT_MAX_LINE_BYTES = 1024 * 1024;

export async function* readJsonLines(
  stream: Readable,
  maxLineBytes = DEFAULT_DRIVER_TRANSPORT_MAX_LINE_BYTES,
): AsyncIterable<unknown> {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw invalidLine("LINE_LIMIT_INVALID");
  }

  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
    if (pending.length > maxLineBytes && pending.indexOf(0x0a) === -1) {
      throw lineTooLarge();
    }

    let newlineIndex = pending.indexOf(0x0a);
    while (newlineIndex !== -1) {
      let line = pending.subarray(0, newlineIndex);
      pending = pending.subarray(newlineIndex + 1);
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, -1);
      }
      yield parseLine(line, maxLineBytes);
      newlineIndex = pending.indexOf(0x0a);
    }
    if (pending.length > maxLineBytes) {
      throw lineTooLarge();
    }
  }

  if (pending.length > 0) {
    yield parseLine(pending, maxLineBytes);
  }
}

export async function writeJsonLine(stream: Writable, value: unknown): Promise<void> {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalidLine("MESSAGE_NOT_SERIALIZABLE");
  }
  if (serialized === undefined) {
    throw invalidLine("MESSAGE_NOT_SERIALIZABLE");
  }
  const encoded = `${serialized}\n`;
  if (!stream.write(encoded, "utf8")) {
    await once(stream, "drain");
  }
}

function parseLine(line: Buffer, maxLineBytes: number): unknown {
  if (line.length === 0) {
    throw invalidLine("EMPTY_LINE");
  }
  if (line.length > maxLineBytes) {
    throw lineTooLarge();
  }
  try {
    return JSON.parse(line.toString("utf8")) as unknown;
  } catch {
    throw invalidLine("JSON_INVALID");
  }
}

function lineTooLarge(): DriverTransportError {
  return new DriverTransportError(
    "DRIVER_TRANSPORT_LINE_TOO_LARGE",
    "Driver transport line exceeds the configured limit",
  );
}

function invalidLine(reason: string): DriverTransportError {
  return new DriverTransportError(
    "DRIVER_TRANSPORT_MESSAGE_INVALID",
    "Driver transport JSONL input is invalid",
    { reason },
  );
}
