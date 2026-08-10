import { describe, expect, it } from "vitest";

import { readOpenCodeWorkerConfiguration } from "../src/worker-config.js";

describe("OpenCode Worker 配置边界", () => {
  it("只接受无凭据的运行参数", () => {
    expect(
      readOpenCodeWorkerConfiguration({
        hostname: "127.0.0.1",
        port: 4_321,
        timeoutMs: 1_000,
        executablePath: "/opt/opencode/bin/opencode",
        provider: {
          id: "fixture",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "fixture-model",
          permissions: { edit: "ask" },
        },
      }),
    ).toEqual({
      hostname: "127.0.0.1",
      port: 4_321,
      timeoutMs: 1_000,
      executablePath: "/opt/opencode/bin/opencode",
      provider: {
        id: "fixture",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "fixture-model",
        permissions: { edit: "ask" },
      },
    });
  });

  it.each([
    [{ provider: { apiKey: "must-not-cross-stdio" } }],
    [{ provider: { nested: { authorization: "must-not-cross-stdio" } } }],
    [{ executablePath: "opencode" }],
    [{ unknown: true }],
  ])("拒绝凭据或未知配置 %#", (configuration) => {
    expect(() => readOpenCodeWorkerConfiguration(configuration)).toThrowError(
      expect.objectContaining({ code: "DRIVER_TRANSPORT_MESSAGE_INVALID" }),
    );
  });
});
