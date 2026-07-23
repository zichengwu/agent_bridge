import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { OpenCodeSdkRuntime, type OpenCodeRuntimeEvent } from "../src/runtime.js";

const safeConfig = {
  autoupdate: false,
  share: "disabled",
  snapshot: false,
  plugin: [],
  mcp: {},
  formatter: false,
  lsp: false,
  enabled_providers: [],
  permission: {
    edit: "deny",
    bash: "deny",
    webfetch: "deny",
    doom_loop: "deny",
    external_directory: "deny",
  },
};

describe("OpenCode 1.18.3 无 Provider 控制面兼容性", () => {
  it("完成健康检查、Session、事件、取消和 Server 重启恢复", async () => {
    const originalCwd = process.cwd();
    const originalEnvironment = { ...process.env };
    const root = await mkdtemp(join(tmpdir(), "agent-bridge-opencode-compat-"));
    const home = join(root, "home");
    const workDirectory = join(root, "workspace");
    const configDirectory = join(root, "config");
    const dataDirectory = join(root, "data");
    const cacheDirectory = join(root, "cache");
    const tempDirectory = join(root, "tmp");
    const openCodeConfigDirectory = join(configDirectory, "opencode");
    const openCodeConfigPath = join(openCodeConfigDirectory, "opencode.json");
    let first: OpenCodeSdkRuntime | undefined;
    let second: OpenCodeSdkRuntime | undefined;
    const eventController = new AbortController();

    try {
      await Promise.all(
        [
          home,
          workDirectory,
          configDirectory,
          dataDirectory,
          cacheDirectory,
          tempDirectory,
          openCodeConfigDirectory,
        ].map((directory) => mkdir(directory, { recursive: true })),
      );
      await writeFile(openCodeConfigPath, `${JSON.stringify(safeConfig, null, 2)}\n`, "utf8");
      replaceEnvironment({
        PATH: originalEnvironment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: home,
        TMPDIR: tempDirectory,
        LANG: originalEnvironment.LANG ?? "C.UTF-8",
        LC_ALL: originalEnvironment.LC_ALL ?? "C.UTF-8",
        CI: "1",
        NO_COLOR: "1",
        XDG_CONFIG_HOME: configDirectory,
        XDG_DATA_HOME: dataDirectory,
        XDG_CACHE_HOME: cacheDirectory,
        OPENCODE_CONFIG: openCodeConfigPath,
        OPENCODE_CONFIG_DIR: openCodeConfigDirectory,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(safeConfig),
      });
      process.chdir(workDirectory);

      first = await OpenCodeSdkRuntime.start();
      const health = await first.healthCheck();
      const stream = await first.subscribe(workDirectory, eventController.signal);
      const iterator = stream[Symbol.asyncIterator]();
      const eventPromise = nextEventWithTimeout(iterator, 5_000);
      const created = await first.createSession({
        directory: workDirectory,
        title: "Provider-free compatibility session",
      });
      const observed = await eventPromise;
      const retrieved = await first.getSession(created.id, workDirectory);
      const cancelled = await first.abortSession(created.id, workDirectory);

      expect(health).toMatchObject({
        healthy: true,
        version: "1.18.3",
      });
      expect(observed).toEqual({
        type: "session.created",
        sessionId: created.id,
      });
      expect(retrieved.id).toBe(created.id);
      expect(cancelled).toBe(true);

      eventController.abort();
      await first.close();
      first = undefined;
      await delay(300);

      second = await OpenCodeSdkRuntime.start();
      const resumed = await second.getSession(created.id, workDirectory);
      expect(resumed.id).toBe(created.id);
    } finally {
      eventController.abort();
      await first?.close();
      await second?.close();
      await delay(300);
      process.chdir(originalCwd);
      replaceEnvironment(originalEnvironment);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function nextEventWithTimeout(
  iterator: AsyncIterator<OpenCodeRuntimeEvent>,
  timeoutMs: number,
): Promise<OpenCodeRuntimeEvent> {
  const result = await Promise.race([
    iterator.next(),
    delay(timeoutMs).then(() => {
      throw new Error("Timed out waiting for OpenCode event");
    }),
  ]);
  if (result.done) {
    throw new Error("OpenCode event stream ended before an event");
  }
  return result.value;
}

function replaceEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, environment);
}
