import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  buildLoopbackSandboxProfile,
  sensitiveAgentConfigurationPaths,
} from "../src/harness/network-sandbox.js";

describe("B 层网络沙箱", () => {
  it("拒绝一般网络，仅允许 loopback 并记录独立工作目录边界", () => {
    const profile = buildLoopbackSandboxProfile(
      ["/tmp/one", "/tmp/two"],
      ["/Users/example/.codex"],
    );
    expect(profile).toContain("(deny network-outbound");
    expect(profile).toContain('remote ip "localhost:*"');
    expect(profile).toContain("(deny file-write*");
    expect(profile).toContain('(deny file-read* (subpath "/Users/example/.codex"))');
    expect(profile).toContain("isolated-root /tmp/one");
    expect(profile).toContain("isolated-root /tmp/two");
  });

  it("列出真实 Agent 配置路径但不访问路径内容", () => {
    expect(
      sensitiveAgentConfigurationPaths({
        HOME: "/Users/example",
        CODEX_HOME: "/private/codex-home",
        XDG_CONFIG_HOME: "/private/config",
      }),
    ).toEqual([
      "/private/codex-home",
      "/Users/example/.codex",
      "/Users/example/.claude",
      "/Users/example/.config/opencode",
      "/Users/example/.local/share/opencode",
      "/private/config/opencode",
    ]);
  });

  it.runIf(process.platform === "darwin")("系统沙箱只允许在白名单根内写入", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-bridge-sandbox-test-"));
    const allowedRoot = join(root, "allowed");
    const profilePath = join(root, "profile.sb");
    await mkdir(allowedRoot);
    await writeFile(profilePath, buildLoopbackSandboxProfile(allowedRoot), "utf8");
    try {
      await promisify(execFile)("/usr/bin/sandbox-exec", [
        "-f",
        profilePath,
        "/usr/bin/touch",
        join(allowedRoot, "inside"),
      ]);
      await expect(access(join(allowedRoot, "inside"))).resolves.toBeUndefined();
      await expect(
        promisify(execFile)("/usr/bin/sandbox-exec", [
          "-f",
          profilePath,
          "/usr/bin/touch",
          join(root, "outside"),
        ]),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
