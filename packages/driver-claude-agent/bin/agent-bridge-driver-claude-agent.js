#!/usr/bin/env node
import process from "node:process";

import { runClaudeAgentWorker } from "../dist/worker-entry.js";

runClaudeAgentWorker().catch(() => {
  process.stderr.write("Claude Agent worker terminated with a protocol error\n");
  process.exitCode = 1;
});
