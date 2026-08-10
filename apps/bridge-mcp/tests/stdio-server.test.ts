import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { computeDocumentContentHash } from "@agent-bridge/core";
import { DOMAIN_SCHEMA_VERSION } from "@agent-bridge/schemas";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const transports: StdioClientTransport[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.allSettled(transports.splice(0).map((transport) => transport.close()));
});

describe("Agent Bridge MCP stdio Server", () => {
  it("通过真实 stdio 握手暴露严格工具，并可在没有 UI/IDE 时查询持久化任务", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-bridge-mcp-"));
    const workspace = resolve(root, "workspace");
    const runtimeRoot = resolve(root, "runtime");
    const baselinePath = resolve(root, "baseline.json");
    const configPath = resolve(root, "agent-bridge.yaml");
    await mkdir(workspace);
    await execFileAsync("/usr/bin/git", ["init", workspace]);
    await writeFile(
      baselinePath,
      JSON.stringify({ baseline_version: 1, content: { policy: "test-only" } }),
    );
    await writeFile(configPath, configuration(workspace, runtimeRoot, baselinePath));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(process.cwd(), "apps/bridge-mcp/dist/index.js"), "--config", configPath],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    transports.push(transport);
    const client = new Client({ name: "bridge-test", version: "1.0.0" });
    await client.connect(transport);

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(17);
    expect(listed.tools.map((tool) => tool.name)).toContain("bridge_respond_to_approval");
    expect(listed.tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(
      true,
    );

    const contract = taskContract();
    const first = await client.callTool({
      name: "bridge_create_task",
      arguments: { contract, idempotency_key: "create-task-1" },
    });
    const replay = await client.callTool({
      name: "bridge_create_task",
      arguments: { contract, idempotency_key: "create-task-1" },
    });
    expect(first.isError, JSON.stringify(first)).not.toBe(true);
    expect(replay.structuredContent).toEqual(first.structuredContent);

    const tasks = await client.callTool({ name: "bridge_list_tasks", arguments: {} });
    expect(tasks.isError).not.toBe(true);
    expect(tasks.structuredContent).toMatchObject({ value: [{ value: { task_id: "task-1" } }] });
    await client.close();

    const database = new DatabaseSync(resolve(runtimeRoot, "agent-bridge.sqlite"));
    expect(
      (
        database.prepare("SELECT COUNT(*) AS count FROM control_invocations").get() as {
          count: number;
        }
      ).count,
    ).toBe(3);
    database.close();
  }, 15_000);
});

function configuration(workspace: string, runtime: string, baseline: string): string {
  return `schema_version: 1
project:
  id: project-test
  workspace_root: ${workspace}
  runtime_root: ${runtime}
  project_baseline_path: ${baseline}
limits:
  timeout_seconds: 60
  max_review_cycles: 3
  max_agent_count: 1
context:
  rollover_ratio: 0.7
drivers:
  primary:
    id: opencode
    executable: /usr/bin/false
    args:
      - --stdio
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

function taskContract() {
  const base = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "task-1",
    task_version: 1,
    project_id: "project-test",
    base_commit: "abcdef1",
    policy_version: "1.0",
    objective: "Verify MCP task persistence.",
    role: "developer",
    business_rules: [],
    scope: { read: ["src/**"], write: ["src/**"], deny: [".git/**"] },
    acceptance_commands: ["test verify"],
    git: { branch: "agent-bridge/task-1" },
    context_policy: {
      project_baseline_version: 1,
      rollover_ratio: 0.7,
      inherit_full_transcript: false,
    },
    limits: { timeout_seconds: 60, max_review_cycles: 3, max_agent_count: 1 },
    required_output: ["commit"],
    created_at: "2026-07-31T00:00:00.000Z",
  } as const;
  return { ...base, content_hash: computeDocumentContentHash(base) };
}
