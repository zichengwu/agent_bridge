import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeApplication } from "../../src/bootstrap.js";
import { startBridgeDashboard } from "../../src/dashboard-startup.js";
import { acquireBridgeInstanceLock } from "../../src/instance-lock.js";
import type { StartedManagementHttpServer } from "../../src/management-http.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Slice C dashboard startup", () => {
  it.each(["preflight", "lock", "recovery"])(
    "OPS-001 %s 失败时不监听、不生成秘密、不打开浏览器",
    async (stage) => {
      const startHttp = vi.fn();
      const opener = vi.fn();
      await expect(
        startBridgeDashboard("/test/config.yaml", {
          bootstrap: () =>
            Promise.reject(Object.assign(new Error(stage), { code: "START_FAILED" })),
          start_http: startHttp,
          opener,
        }),
      ).rejects.toMatchObject({ code: "START_FAILED" });
      expect(startHttp).not.toHaveBeenCalled();
      expect(opener).not.toHaveBeenCalled();
    },
  );

  it("OPS-002 恢复、监听、秘密生成成功后才调用一次假 opener", async () => {
    const order: string[] = [];
    const application = fakeApplication(() => order.push("close"));
    const http = fakeHttp(order);
    const dashboard = await startBridgeDashboard("/test/config.yaml", {
      bootstrap: () => {
        order.push("recover");
        return Promise.resolve(application);
      },
      start_http: () => {
        order.push("listen");
        return Promise.resolve(http);
      },
      opener: () => {
        order.push("open");
        return Promise.resolve();
      },
    });
    expect(order).toEqual(["recover", "listen", "secret", "open"]);
    await dashboard.close();
    expect(order).toEqual(["recover", "listen", "secret", "open", "http-close", "close"]);
  });

  it("OPS-003 opener 失败会撤销秘密、停止 HTTP 和应用，错误不含秘密 URL", async () => {
    const order: string[] = [];
    const application = fakeApplication(() => order.push("application-close"));
    const http = fakeHttp(order);
    let capturedUrl = "";
    let thrown: unknown;
    try {
      await startBridgeDashboard("/test/config.yaml", {
        bootstrap: () => Promise.resolve(application),
        start_http: () => Promise.resolve(http),
        opener: (url) => {
          capturedUrl = url;
          return Promise.reject(new Error("fake opener failed"));
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(capturedUrl).toContain("#launch_secret=launch-secret-value");
    expect(thrown).toMatchObject({ code: "DASHBOARD_OPEN_FAILED" });
    expect(JSON.stringify(thrown)).not.toContain(capturedUrl);
    expect(order).toEqual(["secret", "revoke", "http-close", "application-close"]);
  });

  it("OPS-004 同 runtime_root 第二实例稳定冲突，不接管或终止第一实例", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-bridge-instance-lock-"));
    roots.push(root);
    const first = await acquireBridgeInstanceLock(root);
    await expect(acquireBridgeInstanceLock(root)).rejects.toMatchObject({
      code: "BRIDGE_INSTANCE_CONFLICT",
    });
    await first.release();
    const next = await acquireBridgeInstanceLock(root);
    await next.release();
  });
});

function fakeApplication(onClose: () => void): BridgeApplication {
  return {
    service: {},
    management_commands: {},
    management_projection: {},
    events: {},
    server_instance_id: "11111111-1111-4111-8111-111111111111",
    server_started_at: "2026-08-13T00:00:00.000Z",
    timezone: "Asia/Shanghai",
    close: () => {
      onClose();
      return Promise.resolve();
    },
  } as unknown as BridgeApplication;
}

function fakeHttp(order: string[]): StartedManagementHttpServer {
  return {
    origin: "http://127.0.0.1:41234",
    port: 41234,
    cookie_name: "agent_bridge_session_test",
    activateLaunchSecret: () => {
      order.push("secret");
      return "launch-secret-value";
    },
    revokeLaunchSecret: () => order.push("revoke"),
    close: () => {
      order.push("http-close");
      return Promise.resolve();
    },
  };
}
