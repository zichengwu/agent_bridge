import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DRIVER_PROTOCOL_VERSION } from "@agent-bridge/driver-protocol";

import { ProcessSupervisor, StdioAgentDriverClient } from "../src/index.js";

describe("stdio Driver Client", () => {
  it("通过受监督子进程完成生命周期、事件、checkpoint 和关闭", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/driver-child.mjs", import.meta.url));
    const client = await StdioAgentDriverClient.start({
      supervisor: new ProcessSupervisor(),
      process: {
        processId: "fixture-worker",
        command: process.execPath,
        args: [fixture],
        cwd: process.cwd(),
        environment: { PATH: process.env.PATH ?? "" },
        timeoutMs: 5_000,
        terminationGraceMs: 100,
      },
      initialization: { workDirectory: process.cwd() },
      requestTimeoutMs: 1_000,
    });

    expect(await client.describeCapabilities()).toMatchObject({ driver: { id: "fixture" } });
    const prepared = await client.prepareTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      taskId: "task-1",
      taskVersion: 1,
      idempotencyKey: "prepare-1",
      task: {},
    });
    const run = await client.startTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      preparedTask: prepared,
      context: {},
    });
    const events = [];
    for await (const event of client.streamEvents(run.runId)) {
      events.push(event.type);
    }

    expect(events).toEqual(["run.completed"]);
    expect(await client.exportRecoveryState(run.runId)).toEqual({
      runId: "run-fixture",
      checkpoint: "fixture",
    });
    expect(await client.collectResult(run.runId)).toMatchObject({ status: "succeeded" });
    await expect(client.close()).resolves.toMatchObject({ outcome: "exited", exitCode: 0 });
  });
});
