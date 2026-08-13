#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { bootstrapBridgeApplication } from "./bootstrap.js";
import { serveBridgeMcpStdio } from "./server.js";

export * from "./bootstrap.js";
export * from "./bridge-control-service.js";
export * from "./dashboard-startup.js";
export * from "./errors.js";
export * from "./instance-lock.js";
export * from "./local-runtime.js";
export * from "./management-http.js";
export * from "./management-sse.js";
export * from "./management-static-manifest.js";
export * from "./management-projection.js";
export * from "./management-command-service.js";
export * from "./outbox-pump.js";
export * from "./server.js";
export * from "./tool-contracts.js";
export * from "./usage-facts.js";

if (isMainModule()) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  const configPath = readConfigPath(process.argv.slice(2));
  const application = await bootstrapBridgeApplication(configPath);
  const server = await serveBridgeMcpStdio(application.service);
  const close = async () => {
    await server.close().catch(() => undefined);
    await application.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

function readConfigPath(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--config" || args[1] === undefined) {
    throw new Error("Usage: agent-bridge-mcp --config /absolute/path/to/agent-bridge.yaml");
  }
  return args[1];
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function safeError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return `Agent Bridge failed: ${error.code}`;
  }
  return "Agent Bridge failed: INTERNAL_ERROR";
}
