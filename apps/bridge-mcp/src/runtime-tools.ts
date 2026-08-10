#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

import { computeDocumentContentHash } from "@agent-bridge/core";
import {
  WorkerRuntimeError,
  loadRuntimeConfiguration,
  runRuntimePreflight,
} from "@agent-bridge/worker-runtime";

export async function runRuntimeTool(argv: readonly string[]): Promise<string> {
  const [command, path] = argv;
  if ((command !== "preflight" && command !== "content-hash") || path === undefined) {
    throw new Error("USAGE: runtime-tools <preflight|content-hash> <absolute-path>");
  }
  if (command === "preflight") {
    const configuration = await loadRuntimeConfiguration(path);
    return `${JSON.stringify(await runRuntimePreflight(configuration), null, 2)}\n`;
  }
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("CONTENT_HASH_INPUT_INVALID");
  }
  return `${computeDocumentContentHash(value as Readonly<Record<string, unknown>>)}\n`;
}

if (process.argv[1]?.endsWith("runtime-tools.js")) {
  runRuntimeTool(process.argv.slice(2)).then(
    (output) => process.stdout.write(output),
    (error: unknown) => {
      const payload =
        error instanceof WorkerRuntimeError
          ? { code: error.code, message: error.message, details: error.details }
          : {
              code: "RUNTIME_TOOL_FAILED",
              message: error instanceof Error ? error.message : "Unknown error",
            };
      process.stderr.write(`${JSON.stringify(payload)}\n`);
      process.exitCode = 1;
    },
  );
}
