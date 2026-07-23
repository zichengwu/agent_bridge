import { access, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createIsolationEnvironment,
  replaceProcessEnvironment,
} from "../src/harness/environment.js";

describe("driver-selection 隔离环境", () => {
  it("使用临时 HOME、配置、数据、缓存和 Codex 目录", async () => {
    const isolation = await createIsolationEnvironment("test");
    try {
      expect(isolation.environment.HOME).toBe(isolation.home);
      expect(isolation.environment.CODEX_HOME).toBe(isolation.codexHome);
      expect(isolation.environment.CLAUDE_CONFIG_DIR).toBe(isolation.claudeConfigDirectory);
      expect(isolation.environment.TMPDIR).toBe(isolation.tempDirectory);
      expect(isolation.environment.XDG_CONFIG_HOME).toBe(isolation.configDirectory);
      expect(isolation.environment.XDG_DATA_HOME).toBe(isolation.dataDirectory);
      expect(isolation.environment).not.toHaveProperty("OPENAI_API_KEY");
      expect(isolation.environment).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(isolation.environment).not.toHaveProperty("GEMINI_API_KEY");
      expect(isolation.environment).not.toHaveProperty("DEEPSEEK_API_KEY");

      const configPath = isolation.environment.OPENCODE_CONFIG;
      expect(configPath).toBeDefined();
      const config = JSON.parse(await readFile(configPath ?? "", "utf8")) as Record<
        string,
        unknown
      >;
      expect(config.autoupdate).toBe(false);
      expect(config.permission).toMatchObject({ edit: "deny", bash: "deny" });
      expect(config.plugin).toEqual([]);
    } finally {
      await isolation.cleanup();
    }
    await expect(access(isolation.root)).rejects.toThrow();
  });

  it("替换环境后可以恢复父进程环境", () => {
    const original = { ...process.env } as Record<string, string>;
    try {
      replaceProcessEnvironment({ AGENT_BRIDGE_ISOLATION_TEST: "1" });
      expect(process.env.AGENT_BRIDGE_ISOLATION_TEST).toBe("1");
      expect(Object.keys(process.env)).toEqual(["AGENT_BRIDGE_ISOLATION_TEST"]);
    } finally {
      replaceProcessEnvironment(original);
    }
    expect(process.env.AGENT_BRIDGE_ISOLATION_TEST).toBeUndefined();
  });
});
