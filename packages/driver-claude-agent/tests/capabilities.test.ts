import { describe, expect, it } from "vitest";

import { assertAgentCapabilities } from "@agent-bridge/driver-protocol";

import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_VERSION,
  claudeAgentCapabilities,
} from "../src/capabilities.js";
import {
  CLAUDE_AGENT_DISALLOWED_TOOLS,
  buildClaudeAgentEnvironment,
  buildClaudeAgentQueryOptions,
} from "../src/config.js";
import { ClaudeAgentSdkRuntime } from "../src/runtime.js";

const isolation = {
  homeDirectory: "/isolated/home",
  tempDirectory: "/isolated/tmp",
  configDirectory: "/isolated/config",
  dataDirectory: "/isolated/data",
  cacheDirectory: "/isolated/cache",
  claudeConfigDirectory: "/isolated/claude",
  path: "/usr/bin:/bin",
};

describe("Claude Agent Driver 能力和安全配置", () => {
  it("声明已验证的固定版本、交互权限和估算用量", () => {
    const capabilities = claudeAgentCapabilities();

    assertAgentCapabilities(capabilities);
    expect(capabilities.driver.driverVersion).toBe(CLAUDE_AGENT_SDK_VERSION);
    expect(CLAUDE_CODE_VERSION).toBe("2.1.215");
    expect(capabilities.permissions).toEqual({
      mode: "interactive",
      decisions: ["allow", "deny"],
    });
    expect(capabilities.contextUsage.mode).toBe("estimated");
  });

  it("构造完全替换的隔离环境且不继承真实凭据", () => {
    const environment = buildClaudeAgentEnvironment({ isolation });

    expect(environment).toMatchObject({
      HOME: isolation.homeDirectory,
      TMPDIR: isolation.tempDirectory,
      XDG_CONFIG_HOME: isolation.configDirectory,
      XDG_DATA_HOME: isolation.dataDirectory,
      XDG_CACHE_HOME: isolation.cacheDirectory,
      CLAUDE_CONFIG_DIR: isolation.claudeConfigDirectory,
      CLAUDE_CODE_TMPDIR: isolation.tempDirectory,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
    });
    expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(environment).not.toHaveProperty("DEEPSEEK_API_KEY");
    expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });

  it("默认关闭设置源、扩展、子 Agent、Web 和计划外工具", () => {
    const environment = buildClaudeAgentEnvironment({ isolation });
    const options = buildClaudeAgentQueryOptions({
      environment,
      workDirectory: "/isolated/worktree",
      abortController: new AbortController(),
      canUseTool: () =>
        Promise.resolve({
          behavior: "deny",
          message: "fixture",
        }),
    });

    expect(options.settingSources).toEqual([]);
    expect(options.plugins).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.agents).toEqual({});
    expect(options.skills).toEqual([]);
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.disallowedTools).toEqual([...CLAUDE_AGENT_DISALLOWED_TOOLS]);
    expect(options.promptSuggestions).toBe(false);
    expect(options.agentProgressSummaries).toBe(false);
    expect(options.persistSession).toBe(true);
  });

  it("显式 Claude Code 组件缺失时无 Provider 地返回 degraded", async () => {
    const runtime = new ClaudeAgentSdkRuntime({
      isolation,
      pathToClaudeCodeExecutable: "/definitely/missing/claude-code",
    });

    await expect(runtime.healthCheck()).resolves.toMatchObject({
      status: "degraded",
      sdkVersion: CLAUDE_AGENT_SDK_VERSION,
      runtimeVersion: CLAUDE_CODE_VERSION,
    });
    await runtime.close();
  });

  it("缺少显式隔离 Provider 配置时在启动子进程前失败关闭", async () => {
    const runtime = new ClaudeAgentSdkRuntime({ isolation });

    await expect(
      runtime.startQuery({
        workDirectory: "/isolated/worktree",
        prompt: "This must not reach a Provider.",
      }),
    ).rejects.toMatchObject({
      code: "CLAUDE_RUNTIME_ERROR",
    });
    await runtime.close();
  });
});
