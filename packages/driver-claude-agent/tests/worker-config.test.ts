import { describe, expect, it } from "vitest";

import { readClaudeWorkerConfiguration } from "../src/worker-config.js";

const isolation = {
  homeDirectory: "/isolated/home",
  tempDirectory: "/isolated/tmp",
  configDirectory: "/isolated/config",
  dataDirectory: "/isolated/data",
  cacheDirectory: "/isolated/cache",
  claudeConfigDirectory: "/isolated/claude",
};

describe("Claude Agent Worker 配置边界", () => {
  it("只接受隔离目录、非敏感 Provider 字段与固定安全参数", () => {
    expect(
      readClaudeWorkerConfiguration({
        isolation,
        provider: { baseUrl: "http://127.0.0.1:9", model: "fixture-model" },
        security: { tools: [], maxTurns: 2, maxBudgetUsd: 0 },
        pathToClaudeCodeExecutable: "/opt/claude/bin/claude",
        sessionReadyTimeoutMs: 1_000,
      }),
    ).toMatchObject({
      isolation,
      provider: { model: "fixture-model" },
      security: { maxBudgetUsd: 0 },
    });
  });

  it.each([
    [undefined],
    [{ isolation: { ...isolation, homeDirectory: "relative" } }],
    [{ isolation, provider: { apiKey: "must-not-cross-stdio" } }],
    [{ isolation, provider: { authToken: "must-not-cross-stdio" } }],
    [{ isolation, security: { tools: [1] } }],
  ])("拒绝缺失隔离或包含凭据的配置 %#", (configuration) => {
    expect(() => readClaudeWorkerConfiguration(configuration)).toThrowError(
      expect.objectContaining({ code: "DRIVER_TRANSPORT_MESSAGE_INVALID" }),
    );
  });
});
