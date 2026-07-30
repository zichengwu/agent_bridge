import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProcessSupervisor, WorkerRuntimeError } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("进程监督", () => {
  it.each([
    ["正常退出", "process.stdout.write('ok')", 0, "ok"],
    ["非零退出码", "process.stderr.write('failed'); process.exit(7)", 7, ""],
  ] as const)("记录%s及输出", async (_label, source, exitCode, stdout) => {
    const process = await new ProcessSupervisor().start(await spec(source));

    await expect(process.wait()).resolves.toMatchObject({
      outcome: "exited",
      exitCode,
      stdout,
      descendantsCleaned: true,
    });
  });

  it("超时后清理进程组", async () => {
    const process = await new ProcessSupervisor().start(
      await spec("setInterval(() => {}, 1_000)", { timeoutMs: 80, terminationGraceMs: 80 }),
    );

    await expect(process.wait()).resolves.toMatchObject({
      outcome: "timed_out",
      descendantsCleaned: true,
    });
  });

  it("取消后清理子进程树", async () => {
    const source = [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "process.stdout.write(String(child.pid))",
      "setInterval(() => {}, 1000)",
    ].join(";");
    const process = await new ProcessSupervisor().start(
      await spec(source, { timeoutMs: 5_000, terminationGraceMs: 80 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await process.cancel("test cancellation");

    expect(result).toMatchObject({ outcome: "cancelled", descendantsCleaned: true });
    const descendantPid = Number(result.stdout);
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(() => globalThis.process.kill(descendantPid, 0)).toThrow();
  });

  it("默认拒绝相对可执行文件", async () => {
    await expect(
      new ProcessSupervisor().start({
        ...(await spec("process.exit(0)")),
        command: "node",
      }),
    ).rejects.toMatchObject({
      code: "WORKER_CONFIGURATION_INVALID",
    } satisfies Partial<WorkerRuntimeError>);
  });
});

async function spec(
  source: string,
  overrides: Partial<{ timeoutMs: number; terminationGraceMs: number }> = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "agent-bridge-process-"));
  temporaryDirectories.push(cwd);
  return {
    processId: `process-${temporaryDirectories.length}`,
    command: process.execPath,
    args: ["-e", source],
    cwd,
    environment: { PATH: process.env.PATH ?? "" },
    timeoutMs: overrides.timeoutMs ?? 2_000,
    terminationGraceMs: overrides.terminationGraceMs ?? 100,
  };
}
