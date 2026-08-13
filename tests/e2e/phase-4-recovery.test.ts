import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

import { computeDocumentContentHash } from "@agent-bridge/core";
import { DOMAIN_SCHEMA_VERSION } from "@agent-bridge/schemas";
import { describe, expect, it } from "vitest";

import { bootstrapBridgeApplication } from "../../apps/bridge-mcp/dist/bootstrap.js";

const exec = promisify(execFile);

describe("Phase 4 Bridge 崩溃恢复 E2E", () => {
  it("从 Artifact checkpoint、SQLite 租约和保留 worktree 恢复同一非终态 Run", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-bridge-phase4-e2e-"));
    const workspace = resolve(root, "workspace");
    const runtime = resolve(root, "runtime");
    const baseline = resolve(root, "baseline.json");
    const config = resolve(root, "agent-bridge.yaml");
    await mkdir(workspace);
    await writeFile(resolve(workspace, "README.md"), "fixture\n");
    await git(workspace, ["init"]);
    await git(workspace, ["add", "README.md"]);
    await git(workspace, [
      "-c",
      "user.name=Agent Bridge",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "base",
    ]);
    const baseCommit = (await git(workspace, ["rev-parse", "HEAD"])).trim();
    await writeFile(baseline, JSON.stringify({ baseline_version: 1, content: { policy: "test" } }));
    await writeFile(config, configuration(workspace, runtime, baseline));

    const first = await bootstrapBridgeApplication(config);
    const contract = taskContract(baseCommit);
    await first.service.createTask({ contract, idempotency_key: "create-e2e" });
    await first.service.validateTask({
      task_id: "task-e2e",
      task_version: 1,
      idempotency_key: "validate-e2e",
    });
    let prepared: { context_package: { context_package_id: string; run_id: string } };
    try {
      prepared = (await first.service.prepareContext({
        task_id: "task-e2e",
        task_version: 1,
        selected_handoff_ids: [],
        idempotency_key: "context-e2e",
      })) as typeof prepared;
    } catch (error) {
      throw new Error(JSON.stringify((error as { details?: unknown }).details), { cause: error });
    }
    await first.service.startTask({
      task_id: "task-e2e",
      task_version: 1,
      context_package_id: prepared.context_package.context_package_id,
      idempotency_key: "start-e2e",
    });
    await waitForCheckpoint(runtime, prepared.context_package.run_id);
    await first.close();

    const second = await bootstrapBridgeApplication(config);
    await waitForRecoveryAttempt(runtime, prepared.context_package.run_id, 1);
    await second.close();

    const third = await bootstrapBridgeApplication(config);
    await waitForRecoveryAttempt(runtime, prepared.context_package.run_id, 2);
    await waitForOutboxDrain(runtime);
    const database = new DatabaseSync(resolve(runtime, "agent-bridge.sqlite"));
    const row = database
      .prepare("SELECT value_json FROM agent_runs WHERE run_id = ?")
      .get(prepared.context_package.run_id) as { value_json: string };
    const recovered = JSON.parse(row.value_json) as {
      status: string;
      metadata: Record<string, unknown>;
    };
    expect(recovered.status).toBe("running");
    expect(recovered.metadata.recovery_checkpoint).toBeDefined();
    expect(recovered.metadata.recovery_attempt).toBe(2);
    expect(
      (database.prepare("SELECT COUNT(*) AS count FROM runtime_leases").get() as { count: number })
        .count,
    ).toBe(1);
    expect(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM artifact_references WHERE source_kind = 'agent_run'",
          )
          .get() as { count: number }
      ).count,
    ).toBeGreaterThan(0);
    expect(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM outbox WHERE status != 'published'")
          .get() as { count: number }
      ).count,
    ).toBe(0);
    database.close();

    const cancel = (await third.service.previewRunAction({
      action: "cancel",
      run_id: prepared.context_package.run_id,
    })) as {
      confirmation_token: string;
      event_cursor: string;
      target_revision: number;
    };
    await third.service.cancelTask({
      run_id: prepared.context_package.run_id,
      confirmation_token: cancel.confirmation_token,
      event_cursor: cancel.event_cursor,
      target_revision: cancel.target_revision,
      reason: "Phase 4 cleanup audit",
      idempotency_key: "cancel-e2e",
    });
    await waitForCleanup(runtime, prepared.context_package.run_id);
    await waitForOutboxDrain(runtime);
    const cleanupDatabase = new DatabaseSync(resolve(runtime, "agent-bridge.sqlite"));
    const cleaned = JSON.parse(
      (
        cleanupDatabase
          .prepare("SELECT value_json FROM agent_runs WHERE run_id = ?")
          .get(prepared.context_package.run_id) as { value_json: string }
      ).value_json,
    ) as {
      status: string;
      metadata: {
        worktree_path?: string;
        resource_cleanup?: Record<string, unknown>;
      };
    };
    expect(cleaned.status).toBe("cancelled");
    expect(cleaned.metadata.resource_cleanup).toMatchObject({
      driver_closed: true,
      lease_released: true,
      worktree_retained: true,
      isolation_retained: false,
      reason: "management.cancelled",
    });
    expect(
      (
        cleanupDatabase.prepare("SELECT COUNT(*) AS count FROM runtime_leases").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    cleanupDatabase.close();
    expect(cleaned.metadata.worktree_path).toBeDefined();
    await expect(access(cleaned.metadata.worktree_path!)).resolves.toBeUndefined();
    await third.close();
  }, 20_000);
});

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("/usr/bin/git", args, { cwd })).stdout;
}

async function waitForCheckpoint(runtime: string, runId: string): Promise<void> {
  await waitForRow(
    runtime,
    "SELECT 1 FROM agent_runs WHERE run_id = ? AND value_json LIKE '%recovery_checkpoint%'",
    runId,
  );
}

async function waitForRecoveryAttempt(
  runtime: string,
  runId: string,
  attempt: number,
): Promise<void> {
  await waitForRow(
    runtime,
    `SELECT 1 FROM domain_events WHERE run_id = ? AND event_json LIKE '%"recovery_attempt":${attempt}%' AND event_json LIKE '%bridge_resume_persisted_run%'`,
    runId,
  );
}

async function waitForRow(runtime: string, query: string, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const database = new DatabaseSync(resolve(runtime, "agent-bridge.sqlite"));
    const found = database.prepare(query).get(runId);
    database.close();
    if (found !== undefined) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("Timed out waiting for persisted recovery evidence");
}

async function waitForOutboxDrain(runtime: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const database = new DatabaseSync(resolve(runtime, "agent-bridge.sqlite"));
    const pending = database
      .prepare("SELECT COUNT(*) AS count FROM outbox WHERE status != 'published'")
      .get() as { count: number };
    database.close();
    if (pending.count === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("Timed out waiting for Outbox replay");
}

async function waitForCleanup(runtime: string, runId: string): Promise<void> {
  await waitForRow(
    runtime,
    "SELECT 1 FROM agent_runs WHERE run_id = ? AND value_json LIKE '%resource_cleanup%'",
    runId,
  );
}

function configuration(workspace: string, runtime: string, baseline: string): string {
  return `schema_version: 1
project:
  id: project-e2e
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
    executable: ${process.execPath}
    args:
      - ${resolve(process.cwd(), "tests/e2e/fixtures/recoverable-driver-child.mjs")}
    startup_timeout_ms: 3000
    request_timeout_ms: 3000
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

function taskContract(baseCommit: string) {
  const base = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "task-e2e",
    task_version: 1,
    project_id: "project-e2e",
    base_commit: baseCommit,
    policy_version: "1.0",
    objective: "Verify persistent crash recovery.",
    role: "developer",
    business_rules: [],
    scope: { read: ["**"], write: ["**"], deny: [".git/**"] },
    acceptance_commands: ["test verify"],
    git: { branch: "agent-bridge/task-e2e" },
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
