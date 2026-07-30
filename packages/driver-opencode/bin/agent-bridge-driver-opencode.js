#!/usr/bin/env node
import process from "node:process";

import { runOpenCodeWorker } from "../dist/worker-entry.js";

runOpenCodeWorker().catch(() => {
  process.stderr.write("OpenCode worker terminated with a protocol error\n");
  process.exitCode = 1;
});
