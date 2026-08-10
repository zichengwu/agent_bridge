import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  WorkerRuntimeError,
  loadRuntimeConfiguration,
  parseRuntimeConfiguration,
} from "../src/index.js";

describe("Phase 2G 严格运行时配置", () => {
  it("加载无凭据示例并固定 OpenCode 主 Driver 与 Claude 降级 Driver", async () => {
    const path = resolve("config/agent-bridge.example.yaml");
    await expect(readFile(path, "utf8")).resolves.not.toContain("cline:");

    const config = await loadRuntimeConfiguration(path);

    expect(config.drivers.primary.id).toBe("opencode");
    expect(config.drivers.fallback).toMatchObject({ id: "claude-agent", enabled: true });
    expect(config.context.rollover_ratio).toBe(0.7);
    expect(config.verification.commands.verify).toMatchObject({
      contract: "pnpm verify",
      args: ["verify"],
    });
  });

  it.each([
    ["历史 Cline 字段", { ...configuration(), cline: { backend_mode: "hub" } }],
    ["未知字段", { ...configuration(), extra: true }],
    [
      "凭据字段",
      {
        ...configuration(),
        drivers: {
          ...configuration().drivers,
          primary: { ...configuration().drivers.primary, api_key: "do-not-log" },
        },
      },
    ],
    [
      "错误主 Driver",
      {
        ...configuration(),
        drivers: {
          ...configuration().drivers,
          primary: { ...configuration().drivers.primary, id: "claude-agent" },
        },
      },
    ],
    [
      "Driver 参数中的凭据开关",
      {
        ...configuration(),
        drivers: {
          ...configuration().drivers,
          primary: {
            ...configuration().drivers.primary,
            args: ["--api-key", "must-not-appear"],
          },
        },
      },
    ],
  ])("拒绝%s", (_label, value) => {
    expect(() => parseRuntimeConfiguration(value)).toThrowError(
      expect.objectContaining({
        code: "RUNTIME_CONFIG_INVALID",
      } satisfies Partial<WorkerRuntimeError>),
    );
  });

  it("允许 Claude 可执行组件路径在运行期缺失而不读取文件系统", () => {
    const config = configuration();
    config.drivers.fallback.executable = "/definitely/missing/claude-driver";

    expect(parseRuntimeConfiguration(config).drivers.fallback.executable).toBe(
      "/definitely/missing/claude-driver",
    );
  });

  it("接受 schema v2 的严格非敏感 Provider 与凭据来源合同", () => {
    const config = configuration();
    Object.assign(config, { schema_version: 2 });
    Object.assign(config.drivers.primary, {
      runtime_executable: "/drivers/opencode-runtime",
      provider: {
        id: "deepseek",
        base_url: "http://127.0.0.1:8080/v1",
        model: "deepseek-v4-pro",
        permissions: { edit: "ask", bash: "deny" },
      },
      credentials: { source: "environment" },
    });

    expect(parseRuntimeConfiguration(config).drivers.primary).toMatchObject({
      runtime_executable: "/drivers/opencode-runtime",
      provider: { id: "deepseek", model: "deepseek-v4-pro" },
      credentials: { source: "environment" },
    });
  });

  it("拒绝 Provider 与凭据来源不完整或 Provider 中的秘密字段", () => {
    const missingCredentials = configuration();
    Object.assign(missingCredentials.drivers.primary, {
      provider: {
        id: "deepseek",
        base_url: "https://api.example.invalid/v1",
        model: "model",
      },
    });
    expect(() => parseRuntimeConfiguration(missingCredentials)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_CONFIG_INVALID" }),
    );

    const secret = configuration();
    Object.assign(secret.drivers.primary, {
      provider: {
        id: "deepseek",
        base_url: "https://api.example.invalid/v1",
        model: "model",
        api_key: "forbidden",
      },
      credentials: { source: "environment" },
    });
    expect(() => parseRuntimeConfiguration(secret)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_CONFIG_INVALID" }),
    );
  });
});

function configuration() {
  return {
    schema_version: 1,
    project: {
      id: "project-1",
      workspace_root: "/workspace/project",
      runtime_root: "/workspace/runtime",
      project_baseline_path: "/workspace/project-baseline.json",
    },
    limits: {
      timeout_seconds: 3_600,
      max_review_cycles: 3,
      max_agent_count: 4,
    },
    context: { rollover_ratio: 0.7 },
    drivers: {
      primary: {
        id: "opencode",
        executable: "/drivers/opencode",
        args: ["--stdio"],
        startup_timeout_ms: 30_000,
        request_timeout_ms: 10_000,
      },
      fallback: {
        id: "claude-agent",
        enabled: true,
        executable: "/drivers/claude",
        args: ["--stdio"],
        startup_timeout_ms: 30_000,
        request_timeout_ms: 10_000,
      },
    },
    verification: {
      max_output_bytes: 1_048_576,
      termination_grace_ms: 1_000,
      commands: {
        verify: {
          contract: "pnpm verify",
          executable: "/bin/pnpm",
          args: ["verify"],
          timeout_seconds: 3_600,
        },
      },
    },
  };
}
