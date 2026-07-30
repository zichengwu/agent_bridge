#!/usr/bin/env node
import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { runStdioDriverHost, type DriverHostFactory } from "@agent-bridge/driver-protocol";

import { createClaudeWorkerFactory } from "./worker-config.js";

export interface ClaudeAgentWorkerEntryOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly diagnostics?: Writable;
  readonly factory?: DriverHostFactory;
}

export function runClaudeAgentWorker(options: ClaudeAgentWorkerEntryOptions = {}): Promise<void> {
  return runStdioDriverHost({
    hostId: "claude-agent-worker",
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    diagnostics: options.diagnostics ?? process.stderr,
    factory: options.factory ?? createClaudeWorkerFactory(),
  });
}

if (isMainModule()) {
  runClaudeAgentWorker().catch(() => {
    process.stderr.write("Claude Agent worker terminated with a protocol error\n");
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}
