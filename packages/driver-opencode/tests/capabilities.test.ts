import { describe, expect, it } from "vitest";

import { assertAgentCapabilities } from "@agent-bridge/driver-protocol";

import { OPENCODE_DRIVER_VERSION, openCodeCapabilities } from "../src/capabilities.js";
import { buildOpenCodeConfig } from "../src/config.js";

describe("OpenCode Driver 能力和安全配置", () => {
  it("声明固定版本和完整 Contract 能力", () => {
    const capabilities = openCodeCapabilities();

    assertAgentCapabilities(capabilities);
    expect(capabilities.driver.driverVersion).toBe(OPENCODE_DRIVER_VERSION);
    expect(capabilities.sessions).toEqual({
      persistentIds: true,
      resume: true,
      successorSessions: true,
    });
  });

  it("默认关闭外部扩展、分享、更新和所有高风险权限", () => {
    const config = buildOpenCodeConfig();

    expect(config).toMatchObject({
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
    });
  });
});
