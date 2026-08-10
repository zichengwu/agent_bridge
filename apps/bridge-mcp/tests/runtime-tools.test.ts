import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { computeDocumentContentHash } from "@agent-bridge/core";
import { describe, expect, it } from "vitest";

import { runRuntimeTool } from "../src/runtime-tools.js";

const exec = promisify(execFile);

describe("Phase 4.1 启动诊断与 content_hash 工具", () => {
  it("只读检查配置、Git、目录和 Driver 可执行权限", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-bridge-preflight-"));
    const workspace = resolve(root, "workspace");
    const runtime = resolve(root, "runtime");
    const baseline = resolve(root, "baseline.json");
    const config = resolve(root, "agent-bridge.yaml");
    await mkdir(workspace);
    await exec("/usr/bin/git", ["init"], { cwd: workspace });
    await writeFile(baseline, JSON.stringify({ baseline_version: 1, content: {} }));
    await writeFile(config, configuration(workspace, runtime, baseline));

    const report = JSON.parse(await runRuntimeTool(["preflight", config])) as {
      passed: boolean;
      checks: readonly { id: string }[];
    };
    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      "workspace",
      "git",
      "baseline",
      "runtime_root",
      "driver.opencode",
      "driver.claude-agent",
    ]);
  });

  it("按 canonical JSON 生成确定性 content_hash，并排除旧 hash 字段", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-bridge-hash-"));
    const first = resolve(root, "first.json");
    const second = resolve(root, "second.json");
    await writeFile(first, JSON.stringify({ z: 1, a: { b: true } }));
    await writeFile(second, JSON.stringify({ content_hash: "stale", a: { b: true }, z: 1 }));

    const expected = computeDocumentContentHash({ z: 1, a: { b: true } });
    await expect(runRuntimeTool(["content-hash", first])).resolves.toBe(`${expected}\n`);
    await expect(runRuntimeTool(["content-hash", second])).resolves.toBe(`${expected}\n`);
  });
});

function configuration(workspace: string, runtime: string, baseline: string): string {
  return `schema_version: 1
project:
  id: preflight-fixture
  workspace_root: ${workspace}
  runtime_root: ${runtime}
  project_baseline_path: ${baseline}
limits:
  timeout_seconds: 60
  max_review_cycles: 1
  max_agent_count: 1
context:
  rollover_ratio: 0.7
drivers:
  primary:
    id: opencode
    executable: ${process.execPath}
    args:
      - --version
    startup_timeout_ms: 1000
    request_timeout_ms: 1000
  fallback:
    id: claude-agent
    enabled: false
    args:
      - --stdio
    startup_timeout_ms: 1000
    request_timeout_ms: 1000
verification:
  max_output_bytes: 1024
  termination_grace_ms: 100
  commands:
    verify:
      contract: test verify
      executable: /usr/bin/true
      args:
        - verify
      timeout_seconds: 30
`;
}
