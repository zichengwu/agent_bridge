import { execFile } from "node:child_process";
import { chmod, readFile, readdir, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

import { computeDocumentContentHash } from "@agent-bridge/core";
import { DOMAIN_SCHEMA_VERSION } from "@agent-bridge/schemas";
import { afterEach, describe, expect, it } from "vitest";

import { bootstrapBridgeApplication } from "../../apps/bridge-mcp/dist/bootstrap.js";
const exec = promisify(execFile);
const roots: string[] = [];

describe("Phase 4.1 正式 stdio Driver loopback E2E", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("从 Service 经 Bridge、正式 Worker/Runtime 和模拟 Provider 完成修改、审批、验证与收口", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-bridge-phase41-e2e-"));
    roots.push(root);
    const workspace = resolve(root, "workspace");
    const runtime = resolve(root, "runtime");
    const baseline = resolve(root, "baseline.json");
    const config = resolve(root, "agent-bridge.yaml");
    const syntheticToken = "phase41-synthetic-loopback-token";
    const provider = await startLoopbackProvider("write", syntheticToken);
    delete process.env.AGENT_BRIDGE_OPENCODE_API_KEY;
    process.env.AGENT_BRIDGE_OPENCODE_API_KEY = syntheticToken;
    let application: Awaited<ReturnType<typeof bootstrapBridgeApplication>> | undefined;
    try {
      const baseCommit = await createWorkspace(workspace);
      await writeFile(
        baseline,
        JSON.stringify({ baseline_version: 1, content: { policy: "loopback-only" } }),
      );
      await writeFile(config, configuration(workspace, runtime, baseline, provider.url));
      application = await bootstrapBridgeApplication(config);

      const contract = taskContract(baseCommit);
      await application.service.createTask({ contract, idempotency_key: "phase41-create" });
      await application.service.validateTask({
        task_id: contract.task_id,
        task_version: 1,
        idempotency_key: "phase41-validate",
      });
      const prepared = (await application.service.prepareContext({
        task_id: contract.task_id,
        task_version: 1,
        selected_handoff_ids: [],
        idempotency_key: "phase41-context",
      })) as { context_package: { context_package_id: string; run_id: string } };
      await application.service.startTask({
        task_id: contract.task_id,
        task_version: 1,
        context_package_id: prepared.context_package.context_package_id,
        idempotency_key: "phase41-start",
      });

      await waitForTaskStatus(application, contract.task_id, "WAITING_APPROVAL");
      const approval = pendingApproval(runtime, prepared.context_package.run_id);
      await application.service.respondToApproval({
        approval_id: approval.approval_id,
        decision: "approve",
        reason: "Only src/sum.ts is in scope",
        event_cursor: eventCursor(runtime),
        target_revision: approval.revision,
        idempotency_key: "phase41-approve",
      });
      await waitForTaskStatus(application, contract.task_id, "REVIEW_REQUIRED");

      const result = (await application.service.getResult({ task_id: contract.task_id })) as {
        value: {
          commit_sha: string;
          changed_files: readonly string[];
          acceptance_results: readonly { exit_code: number }[];
        };
      };
      expect(result.value.changed_files).toEqual(["src/sum.ts"]);
      expect(result.value.acceptance_results.every((item) => item.exit_code === 0)).toBe(true);
      await application.service.markCompleted({
        task_id: contract.task_id,
        merge_commit: result.value.commit_sha,
        idempotency_key: "phase41-complete",
      });
      await waitForTaskStatus(application, contract.task_id, "COMPLETED");

      const audit = provider.audit();
      expect(audit).toMatchObject({ rejectedRequests: 0, realProviderRequests: 0 });
      expect(audit.requests).toBeGreaterThan(0);
      expect(await persistedText(runtime)).not.toContain(syntheticToken);
      expect(await artifactText(runtime)).not.toContain(syntheticToken);
    } finally {
      await application?.close();
      await provider.close();
      delete process.env.AGENT_BRIDGE_OPENCODE_API_KEY;
    }
  }, 60_000);

  it("正式 Runtime 在 Bridge 重启后恢复同一 Run，并可确定取消和清理", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-bridge-phase41-recovery-"));
    roots.push(root);
    const workspace = resolve(root, "workspace");
    const runtime = resolve(root, "runtime");
    const baseline = resolve(root, "baseline.json");
    const config = resolve(root, "agent-bridge.yaml");
    const credentialRoot = await mkdtemp(resolve(tmpdir(), "agent-bridge-phase41-credential-"));
    roots.push(credentialRoot);
    const credentialPath = resolve(credentialRoot, "opencode.json");
    const syntheticToken = "phase41-synthetic-recovery-token";
    const provider = await startLoopbackProvider("resume", syntheticToken);
    delete process.env.AGENT_BRIDGE_OPENCODE_API_KEY;
    let application: Awaited<ReturnType<typeof bootstrapBridgeApplication>> | undefined;
    try {
      const baseCommit = await createWorkspace(workspace);
      await writeFile(
        baseline,
        JSON.stringify({ baseline_version: 1, content: { policy: "loopback-only" } }),
      );
      await writeFile(
        credentialPath,
        JSON.stringify({
          schema_version: 1,
          driver_id: "opencode",
          api_key: syntheticToken,
        }),
        { mode: 0o600 },
      );
      await chmod(credentialPath, 0o600);
      await writeFile(
        config,
        configuration(workspace, runtime, baseline, provider.url, credentialPath),
      );
      application = await bootstrapBridgeApplication(config);
      const contract = taskContract(baseCommit);
      await application.service.createTask({
        contract,
        idempotency_key: "phase41-recovery-create",
      });
      await application.service.validateTask({
        task_id: contract.task_id,
        task_version: 1,
        idempotency_key: "phase41-recovery-validate",
      });
      const prepared = (await application.service.prepareContext({
        task_id: contract.task_id,
        task_version: 1,
        selected_handoff_ids: [],
        idempotency_key: "phase41-recovery-context",
      })) as { context_package: { context_package_id: string; run_id: string } };
      await application.service.startTask({
        task_id: contract.task_id,
        task_version: 1,
        context_package_id: prepared.context_package.context_package_id,
        idempotency_key: "phase41-recovery-start",
      });
      await waitForTaskStatus(application, contract.task_id, "WAITING_APPROVAL");
      const approval = pendingApproval(runtime, prepared.context_package.run_id);
      await application.service.respondToApproval({
        approval_id: approval.approval_id,
        decision: "approve",
        reason: "Allow the scoped fixture edit",
        event_cursor: eventCursor(runtime),
        target_revision: approval.revision,
        idempotency_key: "phase41-recovery-approve",
      });
      await provider.waitForRequests(2);
      const before = runSnapshot(runtime, prepared.context_package.run_id);
      await application.close();
      application = await bootstrapBridgeApplication(config);
      await waitForRecoveryAttempt(runtime, prepared.context_package.run_id);
      const after = runSnapshot(runtime, prepared.context_package.run_id);
      expect(after.metadata.external_driver_run_id).toBe(before.metadata.external_driver_run_id);
      expect(after.metadata.recovery_attempt).toBe(1);

      const cancel = (await application.service.previewRunAction({
        action: "cancel",
        run_id: prepared.context_package.run_id,
      })) as {
        confirmation_token: string;
        event_cursor: string;
        target_revision: number;
      };
      await application.service.cancelTask({
        run_id: prepared.context_package.run_id,
        confirmation_token: cancel.confirmation_token,
        event_cursor: cancel.event_cursor,
        target_revision: cancel.target_revision,
        reason: "Phase 4.1 recovered-run cancellation",
        idempotency_key: "phase41-recovery-cancel",
      });
      await waitForTaskStatus(application, contract.task_id, "CANCELLED");
      expect(provider.audit().realProviderRequests).toBe(0);
      expect(await persistedText(runtime)).not.toContain(syntheticToken);
    } finally {
      await application?.close();
      await provider.close();
      delete process.env.AGENT_BRIDGE_OPENCODE_API_KEY;
    }
  }, 60_000);
});

async function startLoopbackProvider(
  scenario: "write" | "resume",
  syntheticToken: string,
): Promise<{
  readonly url: string;
  audit(): {
    readonly requests: number;
    readonly rejectedRequests: number;
    readonly realProviderRequests: 0;
  };
  waitForRequests(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}> {
  const modulePath = "../../packages/driver-opencode/tests/fixtures/b-simulated/mock-provider.js";
  const fixture = (await import(modulePath)) as {
    startFormalMockProvider(input: {
      scenario: "write" | "resume";
      syntheticToken: string;
    }): Promise<{
      readonly url: string;
      audit(): {
        readonly requests: number;
        readonly rejectedRequests: number;
        readonly realProviderRequests: 0;
      };
      waitForRequests(count: number, timeoutMs?: number): Promise<void>;
      close(): Promise<void>;
    }>;
  };
  return fixture.startFormalMockProvider({ scenario, syntheticToken });
}

async function createWorkspace(workspace: string): Promise<string> {
  await Promise.all([
    mkdir(resolve(workspace, "src"), { recursive: true }),
    mkdir(resolve(workspace, "test"), { recursive: true }),
  ]);
  await writeFile(resolve(workspace, "src/sum.ts"), "export const sum = (a, b) => a - b;\n");
  await writeFile(
    resolve(workspace, "test/sum.test.mjs"),
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { sum } from "../src/sum.ts";\ntest("sum", () => assert.equal(sum(2, 3), 5));\n',
  );
  await writeFile(
    resolve(workspace, "package.json"),
    JSON.stringify({ name: "phase41-fixture", private: true, type: "module" }),
  );
  await git(workspace, ["init"]);
  await git(workspace, ["add", "."]);
  await git(workspace, [
    "-c",
    "user.name=Agent Bridge",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  return (await git(workspace, ["rev-parse", "HEAD"])).trim();
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("/usr/bin/git", args, { cwd })).stdout;
}

async function waitForTaskStatus(
  application: Awaited<ReturnType<typeof bootstrapBridgeApplication>>,
  taskId: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = (await application.service.getTask({ task_id: taskId })) as {
      task: { status: string };
    };
    if (value.task.status === status) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  const final = await application.service.getTask({ task_id: taskId });
  const events = await application.service.getEvents({ task_id: taskId, limit: 100 });
  throw new Error(`Timed out waiting for ${status}: ${JSON.stringify({ final, events })}`);
}

function pendingApproval(
  runtime: string,
  runId: string,
): {
  approval_id: string;
  revision: number;
} {
  const database = new DatabaseSync(resolve(runtime, "agent-bridge.sqlite"));
  const row = database
    .prepare(
      "SELECT value_json, revision FROM approval_requests WHERE run_id = ? AND status = 'pending'",
    )
    .get(runId) as { value_json: string; revision: number };
  database.close();
  return {
    approval_id: (JSON.parse(row.value_json) as { approval_id: string }).approval_id,
    revision: row.revision,
  };
}

function eventCursor(runtime: string): string {
  const database = new DatabaseSync(resolve(runtime, "agent-bridge.sqlite"));
  const row = database
    .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM domain_events")
    .get() as { sequence: number };
  database.close();
  return `event-cursor:${row.sequence}`;
}

function runSnapshot(
  runtime: string,
  runId: string,
): {
  status: string;
  metadata: Record<string, unknown>;
} {
  const database = new DatabaseSync(resolve(runtime, "agent-bridge.sqlite"));
  const row = database.prepare("SELECT value_json FROM agent_runs WHERE run_id = ?").get(runId) as {
    value_json: string;
  };
  database.close();
  return JSON.parse(row.value_json) as { status: string; metadata: Record<string, unknown> };
}

async function waitForRecoveryAttempt(runtime: string, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (runSnapshot(runtime, runId).metadata.recovery_attempt === 1) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("Timed out waiting for formal Driver recovery");
}

async function persistedText(runtime: string): Promise<string> {
  return (await readFile(resolve(runtime, "agent-bridge.sqlite"))).toString("utf8");
}

async function artifactText(runtime: string): Promise<string> {
  const root = resolve(runtime, "artifacts");
  const paths = await collectFiles(root);
  return (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n");
}

async function collectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(root, entry.name);
      return entry.isDirectory() ? collectFiles(path) : Promise.resolve([path]);
    }),
  );
  return nested.flat();
}

function configuration(
  workspace: string,
  runtime: string,
  baseline: string,
  providerUrl: string,
  credentialPath?: string,
): string {
  const repositoryRoot = process.cwd();
  return `schema_version: 2
project:
  id: phase41-project
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
    executable: ${resolve(repositoryRoot, "packages/driver-opencode/bin/agent-bridge-driver-opencode.js")}
    runtime_executable: ${resolve(repositoryRoot, "packages/driver-opencode/node_modules/.bin/opencode")}
    args:
      - --stdio
    startup_timeout_ms: 30000
    request_timeout_ms: 10000
    provider:
      id: deepseek
      base_url: ${providerUrl}/v1
      model: deepseek-v4-pro
      permissions:
        edit: ask
        bash: deny
        webfetch: deny
        external_directory: deny
    credentials:
      source: ${credentialPath === undefined ? "environment" : "json_file"}${credentialPath === undefined ? "" : `\n      path: ${credentialPath}`}
  fallback:
    id: claude-agent
    enabled: false
    args:
      - --stdio
    startup_timeout_ms: 30000
    request_timeout_ms: 10000
verification:
  max_output_bytes: 1048576
  termination_grace_ms: 1000
  commands:
    verify:
      contract: node --test test/sum.test.mjs
      executable: ${process.execPath}
      args:
        - --test
        - test/sum.test.mjs
      timeout_seconds: 30
`;
}

function taskContract(baseCommit: string) {
  const base = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "task-phase41-loopback",
    task_version: 1,
    project_id: "phase41-project",
    base_commit: baseCommit,
    policy_version: "1.0",
    objective: "Correct the allowed sum fixture.",
    role: "developer",
    business_rules: [{ id: "BR-PHASE41-001", description: "Only modify src/sum.ts." }],
    scope: { read: ["**"], write: ["src/**"], deny: [".git/**", ".env*"] },
    acceptance_commands: ["node --test test/sum.test.mjs"],
    git: { branch: "agent-bridge/task-phase41-loopback" },
    context_policy: {
      project_baseline_version: 1,
      rollover_ratio: 0.7,
      inherit_full_transcript: false,
    },
    limits: { timeout_seconds: 60, max_review_cycles: 3, max_agent_count: 1 },
    required_output: ["commit"],
    created_at: new Date().toISOString(),
  } as const;
  return { ...base, content_hash: computeDocumentContentHash(base) };
}
