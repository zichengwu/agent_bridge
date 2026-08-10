import { chmod, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DRIVER_CREDENTIAL_ENVIRONMENT,
  resolveDriverCredentialEnvironment,
  type RuntimeDriverConfiguration,
} from "../src/index.js";

describe("Phase 4.1 Driver 专属凭据注入", () => {
  it("只从固定 allowlist 环境变量返回对应 Driver 的最小环境", async () => {
    const root = await fixtureRoot();
    await expect(
      resolveDriverCredentialEnvironment(driver("environment"), root, {
        [DRIVER_CREDENTIAL_ENVIRONMENT.opencode]: "synthetic-secret",
        UNRELATED_SECRET: "must-not-pass",
      }),
    ).resolves.toEqual({ AGENT_BRIDGE_OPENCODE_API_KEY: "synthetic-secret" });
  });

  it("读取仓库和运行根之外的严格 0600 JSON 文件", async () => {
    const root = await fixtureRoot();
    const path = resolve(root.repositoryRoot, "..", "opencode-credentials.json");
    await writeFile(
      path,
      JSON.stringify({ schema_version: 1, driver_id: "opencode", api_key: "file-secret" }),
      { mode: 0o600 },
    );
    await chmod(path, 0o600);

    await expect(
      resolveDriverCredentialEnvironment(driver("json_file", path), root, {}),
    ).resolves.toEqual({ AGENT_BRIDGE_OPENCODE_API_KEY: "file-secret" });
  });

  it.each(["conflict", "mode", "symlink", "inside", "repository"])(
    "对 %s fail closed 且错误不包含秘密",
    async (scenario) => {
      const root = await fixtureRoot();
      const outside = resolve(root.repositoryRoot, "..", `${scenario}.json`);
      await writeFile(
        outside,
        JSON.stringify({ schema_version: 1, driver_id: "opencode", api_key: "never-log-me" }),
        { mode: 0o600 },
      );
      let path = outside;
      let environment: Record<string, string> = {};
      if (scenario === "conflict") environment = { AGENT_BRIDGE_OPENCODE_API_KEY: "env-secret" };
      if (scenario === "mode") await chmod(outside, 0o644);
      if (scenario === "symlink") {
        path = resolve(root.repositoryRoot, "..", "link.json");
        await symlink(outside, path);
      }
      if (scenario === "inside") {
        path = resolve(root.workspaceRoot, "credential.json");
        await writeFile(path, "{}", { mode: 0o600 });
      }
      if (scenario === "repository") {
        path = resolve(root.repositoryRoot, "credential.json");
        await writeFile(path, "{}", { mode: 0o600 });
      }

      const error = await resolveDriverCredentialEnvironment(
        driver("json_file", path),
        root,
        environment,
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "RUNTIME_CONFIG_INVALID" });
      expect(JSON.stringify(error)).not.toMatch(/never-log-me|env-secret/u);
    },
  );
});

async function fixtureRoot() {
  const base = await mkdtemp(resolve(tmpdir(), "agent-bridge-credentials-"));
  const repositoryRoot = resolve(base, "repository");
  const workspaceRoot = resolve(repositoryRoot, "worktree");
  const runtimeRoot = resolve(base, "runtime");
  await mkdir(repositoryRoot);
  await Promise.all([mkdir(workspaceRoot), mkdir(runtimeRoot)]);
  return { repositoryRoot, workspaceRoot, runtimeRoot };
}

function driver(source: "environment" | "json_file", path?: string): RuntimeDriverConfiguration {
  return {
    id: "opencode",
    executable: "/driver",
    args: [],
    startup_timeout_ms: 1_000,
    request_timeout_ms: 1_000,
    provider: { id: "fixture", base_url: "http://127.0.0.1:9", model: "fixture" },
    credentials: source === "environment" ? { source } : { source, path: path! },
  };
}
