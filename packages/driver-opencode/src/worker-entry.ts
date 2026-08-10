#!/usr/bin/env node
import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { runStdioDriverHost, type DriverHostFactory } from "@agent-bridge/driver-protocol";

import { createOpenCodeWorkerFactory } from "./worker-config.js";

export interface OpenCodeWorkerEntryOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly diagnostics?: Writable;
  readonly factory?: DriverHostFactory;
}

export function runOpenCodeWorker(options: OpenCodeWorkerEntryOptions = {}): Promise<void> {
  const secret = process.env.AGENT_BRIDGE_OPENCODE_API_KEY;
  return runStdioDriverHost({
    hostId: "opencode-worker",
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    diagnostics: options.diagnostics ?? process.stderr,
    factory: options.factory ?? createOpenCodeWorkerFactory(),
    redactError: (value) => redactPrivateValue(value, secret),
  });
}

function redactPrivateValue(value: string, secret: string | undefined): string {
  return secret === undefined || secret.length === 0
    ? value
    : value.replaceAll(secret, "[REDACTED]");
}

if (isMainModule()) {
  runOpenCodeWorker().catch(() => {
    process.stderr.write("OpenCode worker terminated with a protocol error\n");
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}
