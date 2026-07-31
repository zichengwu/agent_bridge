import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeContentHash,
  type AgentRunRecord,
  type AuthoritativeDomainEvent,
  type DomainRecordWrite,
  type DomainRepository,
} from "@agent-bridge/core";
import { DOMAIN_SCHEMA_VERSION, type TaskResult, type TaskVersion } from "@agent-bridge/schemas";
import { LocalArtifactRepository } from "@agent-bridge/artifacts-local";
import { SqliteDomainRepository } from "@agent-bridge/storage-sqlite";
import {
  ContextHandoffRuntime,
  DefaultGitClient,
  ExplicitDriverSelector,
  GitWorktreeManager,
  IndependentVerificationRunner,
  InMemoryLeaseManager,
  ProcessSupervisor,
  RunOrchestrator,
  type DriverProbe,
  type IndependentVerificationResult,
  type RuntimeAuditInput,
} from "@agent-bridge/worker-runtime";
import { afterEach, describe, expect, it } from "vitest";

import { Phase2GFakeDriver } from "./fixtures/fake-driver.js";

const t0 = "2026-07-31T10:00:00.000Z";
const t1 = "2026-07-31T10:01:00.000Z";
const t2 = "2026-07-31T10:02:00.000Z";
const t3 = "2026-07-31T10:03:00.000Z";
const t4 = "2026-07-31T10:04:00.000Z";
const t5 = "2026-07-31T10:05:00.000Z";
const roots: string[] = [];
const repositories: SqliteDomainRepository[] = [];

afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    repository.close();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Phase 2G Fake Driver + 临时 Git 集成", () => {
  it("串联 Context、Run、独立验证、Artifact、Handoff 与 SQLite 重启读取", async () => {
    const fixture = await gitFixture();
    const databasePath = join(fixture.root, "bridge.sqlite");
    const repository = new SqliteDomainRepository({ database_path: databasePath });
    repositories.push(repository);
    const artifacts = await LocalArtifactRepository.open({
      root_path: join(fixture.root, "artifacts"),
      now: () => new Date(t3),
    });
    const taskVersion = version(fixture.baseCommit);
    await recordCreation(
      repository,
      {
        kind: "task_version",
        expected_revision: 0,
        value: taskVersion,
      },
      "task_version.recorded",
      "task-version",
    );

    const worktreesRoot = join(fixture.root, "worktrees");
    await mkdir(worktreesRoot);
    const manager = new GitWorktreeManager(
      fixture.git,
      new InMemoryLeaseManager({
        now: () => new Date(t0),
      }),
    );
    const ownership = await manager.create({
      repositoryPath: fixture.repositoryPath,
      worktreesRoot,
      worktreeName: "run-primary",
      branch: taskVersion.git.branch,
      sourceRef: "HEAD",
      baseCommit: fixture.baseCommit,
      taskId: taskVersion.task_id,
      taskVersion: taskVersion.task_version,
      runId: "run-primary",
      leaseTtlMs: 60_000,
    });

    const contextRuntime = new ContextHandoffRuntime(repository, fixture.git);
    const context = await contextRuntime.prepareContext({
      task: { task_id: taskVersion.task_id, task_version: taskVersion.task_version },
      run_id: "run-primary",
      target_session_id: "session-primary",
      scenario: "NEW_TASK",
      context_package_id: "context-primary",
      project_baseline: baseline(),
      repository_id: "repository-1",
      repository_path: fixture.repositoryPath,
      selected_handoffs: [],
      audit: audit("prepare-context", "event-context-primary", t0),
    });

    const fake = new Phase2GFakeDriver({
      driver_id: "opencode",
      worktree_path: ownership.worktreePath,
      git: fixture.git,
      now: () => new Date(t2),
    });
    const selector = selectorFor(fake, undefined, t1);
    const selection = await selector.assessNewRun({
      task_id: taskVersion.task_id,
      task_version: taskVersion.task_version,
      planned_run_id: "run-primary",
    });
    if (selection.action !== "USE_PRIMARY") {
      throw new Error("primary selection expected");
    }
    const started = await new RunOrchestrator(repository, [
      { driver_id: "opencode", create: () => Promise.resolve(fake) },
    ]).start({
      run_id: "run-primary",
      session_id: "session-primary",
      binding_id: "binding-primary",
      task_version: taskVersion,
      context_package: context.context_package,
      role: "developer",
      selection,
      prepare_idempotency_key: "prepare-primary",
      create_audit: audit("create-run", "event-run-created", t1),
      outcome_audit: audit("start-run", "event-run-running", t2),
      session_event_id: "event-session-primary",
    });
    expect(started.status).toBe("RUNNING");

    const diff = await manager.validateDiff({
      worktreePath: ownership.worktreePath,
      baseCommit: fixture.baseCommit,
      ownerId: "run-primary",
      role: "developer",
      scope: taskVersion.scope,
    });
    const headCommit = text(
      (await fixture.git.run(ownership.worktreePath, ["rev-parse", "HEAD"])).stdout,
    );
    const verification = await new IndependentVerificationRunner(
      new ProcessSupervisor(),
      artifacts,
      () => new Date(t3),
    ).start({
      verification_id: "verification-primary",
      run_id: "run-primary",
      worktree_path: ownership.worktreePath,
      acceptance_commands: taskVersion.acceptance_commands,
      command_catalog: {
        phase2g: {
          contract: "node verify-phase2g",
          executable: process.execPath,
          args: [
            "-e",
            "require('node:fs').accessSync('src/phase-2g-output.ts'); process.stdout.write('verified')",
          ],
          timeout_seconds: 5,
        },
      },
      initiator: { kind: "bridge", id: "bridge-test" },
      environment: { PATH: process.env.PATH ?? "", CI: "1", NO_COLOR: "1" },
      max_output_bytes: 4096,
      termination_grace_ms: 100,
    }).result;
    expect(verification.status).toBe("passed");

    const reportMetadata = await artifacts.getMetadata(verification.report_artifact_id);
    if (reportMetadata === undefined) {
      throw new Error("verification report missing");
    }
    const running = await repository.getAgentRun("run-primary");
    if (running === undefined) {
      throw new Error("run missing");
    }
    const taskResult = resultValue(
      taskVersion,
      fixture.baseCommit,
      headCommit,
      diff.changedFiles,
      verification,
      reportMetadata.content_hash,
    );
    await recordCompletion(repository, running.value, taskResult);

    const handoff = await contextRuntime.generateHandoff({
      handoff_id: "handoff-primary",
      handoff_version: 1,
      source_task: { task_id: taskVersion.task_id, task_version: taskVersion.task_version },
      final_run_id: "run-primary",
      repository_id: "repository-1",
      completed: ["Fake Driver 已完成受限写入"],
      decisions: ["保持 Bridge Run 与外部 Driver Run 映射"],
      contracts: ["ContextPackage 1.0"],
      known_issues: [],
      downstream_notes: ["下游只引用验证 Artifact"],
      field_sources: {
        completed: "agent",
        decisions: "human",
        contracts: "bridge",
        known_issues: "agent",
        downstream_notes: "agent",
      },
      generated_at: t5,
      audit: audit("generate-handoff", "event-handoff-primary", t5),
    });
    expect(handoff.verification.status).toBe("passed");
    manager.release(ownership.worktreePath, "run-primary");

    repository.close();
    repositories.splice(repositories.indexOf(repository), 1);
    const reopened = new SqliteDomainRepository({ database_path: databasePath });
    repositories.push(reopened);

    expect(await reopened.getContextPackage("context-primary")).toBeDefined();
    expect(await reopened.getAgentRun("run-primary")).toMatchObject({
      value: { status: "succeeded", metadata: { external_driver_run_id: "external-run-opencode" } },
    });
    expect(await reopened.getHandoffPackage("handoff-primary", 1)).toMatchObject({
      value: { content_hash: handoff.content_hash },
    });
    expect(await reopened.listArtifactReferences({ source_kind: "task_result" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifact_id: verification.report_artifact_id }),
      ]),
    );
    const reportChunks: Buffer[] = [];
    for await (const chunk of await artifacts.read(verification.report_artifact_id)) {
      reportChunks.push(Buffer.from(chunk));
    }
    expect(JSON.parse(Buffer.concat(reportChunks).toString("utf8"))).toMatchObject({
      status: "passed",
      run_id: "run-primary",
    });
  });

  it("OpenCode 启动失败后，经显式确认用新 Run 选择 Claude，绝不原 Run 换 Driver", async () => {
    const fixture = await gitFixture();
    const repository = new SqliteDomainRepository({
      database_path: join(fixture.root, "fallback.sqlite"),
    });
    repositories.push(repository);
    const taskVersion = version(fixture.baseCommit);
    await recordCreation(
      repository,
      {
        kind: "task_version",
        expected_revision: 0,
        value: taskVersion,
      },
      "task_version.recorded",
      "fallback-task-version",
    );
    const contextRuntime = new ContextHandoffRuntime(repository, fixture.git);
    const primaryContext = await contextRuntime.prepareContext({
      task: { task_id: taskVersion.task_id, task_version: 1 },
      run_id: "run-opencode-failed",
      target_session_id: "session-opencode",
      scenario: "NEW_TASK",
      context_package_id: "context-opencode",
      project_baseline: baseline(),
      repository_id: "repository-1",
      repository_path: fixture.repositoryPath,
      selected_handoffs: [],
      audit: audit("context-opencode", "event-context-opencode", t0),
    });
    const primary = new Phase2GFakeDriver({
      driver_id: "opencode",
      worktree_path: fixture.repositoryPath,
      git: fixture.git,
      fail_start: true,
      now: () => new Date(t2),
    });
    const fallback = new Phase2GFakeDriver({
      driver_id: "claude-agent",
      worktree_path: fixture.repositoryPath,
      git: fixture.git,
      write_on_start: false,
      now: () => new Date(t4),
    });
    const selector = selectorFor(primary, fallback, t1);
    const primarySelection = await selector.assessNewRun({
      task_id: taskVersion.task_id,
      task_version: 1,
      planned_run_id: "run-opencode-failed",
    });
    if (primarySelection.action !== "USE_PRIMARY") {
      throw new Error("primary selection expected");
    }
    const failed = await new RunOrchestrator(repository, [
      { driver_id: "opencode", create: () => Promise.resolve(primary) },
    ]).start({
      run_id: "run-opencode-failed",
      session_id: "session-opencode",
      binding_id: "binding-opencode",
      task_version: taskVersion,
      context_package: primaryContext.context_package,
      role: "developer",
      selection: primarySelection,
      prepare_idempotency_key: "prepare-opencode",
      create_audit: audit("create-opencode", "event-create-opencode", t1),
      outcome_audit: audit("start-opencode", "event-fail-opencode", t2),
      session_event_id: "event-session-unused",
    });
    expect(failed.status).toBe("START_FAILED");

    const proposal = await selector.assessAfterPrimaryStartFailure(
      {
        task_id: taskVersion.task_id,
        task_version: 1,
        planned_run_id: "run-claude-new",
      },
      failed.status === "START_FAILED" ? failed.failure_code : "UNKNOWN",
    );
    if (proposal.action !== "FALLBACK_CONFIRMATION_REQUIRED") {
      throw new Error("fallback proposal expected");
    }
    const confirmed = selector.confirmFallback(proposal, {
      decision_id: proposal.decision_id,
      task_id: taskVersion.task_id,
      task_version: 1,
      planned_run_id: "run-claude-new",
      actor: { kind: "codex", id: "codex-test" },
      reason: "确认在新 Run 使用 Claude Driver",
      confirmed_at: t3,
    });
    const fallbackContext = await contextRuntime.prepareContext({
      task: { task_id: taskVersion.task_id, task_version: 1 },
      run_id: "run-claude-new",
      target_session_id: "session-claude",
      scenario: "NEW_TASK",
      context_package_id: "context-claude",
      project_baseline: baseline(),
      repository_id: "repository-1",
      repository_path: fixture.repositoryPath,
      selected_handoffs: [],
      audit: audit("context-claude", "event-context-claude", t3),
    });
    const started = await new RunOrchestrator(repository, [
      { driver_id: "claude-agent", create: () => Promise.resolve(fallback) },
    ]).start({
      run_id: "run-claude-new",
      session_id: "session-claude",
      binding_id: "binding-claude",
      task_version: taskVersion,
      context_package: fallbackContext.context_package,
      role: "developer",
      selection: confirmed,
      prepare_idempotency_key: "prepare-claude",
      create_audit: audit("create-claude", "event-create-claude", t3),
      outcome_audit: audit("start-claude", "event-start-claude", t4),
      session_event_id: "event-session-claude",
    });

    expect(started.status).toBe("RUNNING");
    expect(await repository.getAgentRun("run-opencode-failed")).toMatchObject({
      value: { status: "failed", driver_id: "opencode" },
    });
    expect(await repository.getAgentRun("run-claude-new")).toMatchObject({
      value: {
        status: "running",
        driver_id: "claude-agent",
        metadata: {
          driver_selection: {
            action: "USE_FALLBACK",
            decision_id: proposal.decision_id,
          },
        },
      },
    });
  });
});

async function gitFixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-phase-2g-"));
  roots.push(root);
  const repositoryPath = join(root, "repository");
  await mkdir(repositoryPath);
  const git = new DefaultGitClient({ executable: "/usr/bin/git" });
  await git.run(repositoryPath, ["init"]);
  await writeFile(join(repositoryPath, "README.md"), "# Fixture\n", "utf8");
  await git.run(repositoryPath, ["add", "--", "README.md"]);
  await git.run(repositoryPath, [
    "-c",
    "user.name=Agent Bridge Test",
    "-c",
    "user.email=agent-bridge@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  const baseCommit = text((await git.run(repositoryPath, ["rev-parse", "HEAD"])).stdout);
  return { root, repositoryPath, git, baseCommit };
}

function version(baseCommit: string): TaskVersion {
  const withoutHash = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "phase2g-task",
    task_version: 1,
    project_id: "project-1",
    base_commit: baseCommit,
    policy_version: "1.0",
    objective: "验证 Phase 2G 集成",
    role: "developer" as const,
    business_rules: [],
    scope: { read: ["**"], write: ["src/**"], deny: [".git/**"] },
    acceptance_commands: ["node verify-phase2g"],
    git: { branch: "agent/phase2g-task" },
    context_policy: {
      project_baseline_version: 1,
      rollover_ratio: 0.7,
      inherit_full_transcript: false as const,
    },
    limits: { timeout_seconds: 3600, max_review_cycles: 3, max_agent_count: 4 },
    required_output: ["commit_sha", "test_results"],
    created_at: t0,
  };
  return {
    ...withoutHash,
    content_hash: computeContentHash(withoutHash),
  };
}

function baseline() {
  const content = {
    constraints: ["不读取凭据", "不调用真实 Provider", "保持 Driver 中立"],
  };
  return {
    component_id: "baseline-phase2g",
    project_id: "project-1",
    baseline_version: 1,
    content,
    content_hash: computeContentHash({
      project_id: "project-1",
      baseline_version: 1,
      baseline: content,
    }),
  };
}

function selectorFor(
  primary: Phase2GFakeDriver,
  fallback: Phase2GFakeDriver | undefined,
  now: string,
) {
  const probe = (driver: Phase2GFakeDriver): DriverProbe => ({
    driver_id: driver.capabilities.driver.id,
    inspect: async () => ({
      health: await driver.healthCheck(),
      capabilities: await driver.describeCapabilities(),
    }),
  });
  return new ExplicitDriverSelector({
    primary: probe(primary),
    ...(fallback === undefined ? {} : { fallback: probe(fallback) }),
    fallback_enabled: fallback !== undefined,
    create_decision_id: () => "decision-fallback-1",
    now: () => new Date(now),
  });
}

function resultValue(
  taskVersion: TaskVersion,
  baseCommit: string,
  headCommit: string,
  changedFiles: readonly string[],
  verification: IndependentVerificationResult,
  reportHash: string,
): TaskResult {
  return {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: taskVersion.task_id,
    task_version: taskVersion.task_version,
    run_id: "run-primary",
    session_ids: ["session-primary"],
    status: "submitted",
    base_commit: baseCommit,
    commit_sha: headCommit,
    changed_files: changedFiles,
    acceptance_results: verification.commands.flatMap((command) =>
      command.exit_code === undefined
        ? []
        : [
            {
              command: command.contract,
              exit_code: command.exit_code,
              duration_ms: command.duration_ms,
              ...(command.log_artifact_id === undefined
                ? {}
                : { log_artifact_id: command.log_artifact_id }),
            },
          ],
    ),
    review_findings: [],
    known_risks: [],
    unresolved_items: [],
    artifacts: [
      {
        artifact_id: verification.report_artifact_id,
        kind: "verification.report",
        content_hash: reportHash,
      },
    ],
    started_at: t2,
    finished_at: t4,
  };
}

async function recordCompletion(
  repository: DomainRepository,
  currentRun: AgentRunRecord,
  result: TaskResult,
): Promise<void> {
  const succeeded: AgentRunRecord = {
    ...currentRun,
    status: "succeeded",
    updated_at: t4,
    finished_at: t4,
  };
  const requestId = "request-complete-run";
  const operation = "complete-run";
  const key = "key-complete-run";
  const audit = {
    actor: { kind: "bridge" as const, id: "bridge-test" },
    operation,
    request_id: requestId,
    correlation_id: "correlation-phase2g",
    idempotency_key: key,
    task_id: result.task_id,
    task_version: result.task_version,
    run_id: result.run_id,
    verification: {
      status: "passed" as const,
      artifact_ids: result.artifacts?.map((artifact) => artifact.artifact_id) ?? [],
    },
  };
  await repository.commit({
    change_id: requestId,
    idempotency: {
      operation,
      key,
      request_hash: computeContentHash({ operation, run_id: result.run_id }),
    },
    records: [
      { kind: "agent_run", expected_revision: 2, value: succeeded },
      { kind: "task_result", expected_revision: 0, value: result },
    ],
    events: [
      {
        event_id: "event-run-succeeded",
        event_version: 1,
        event_type: "agent_run.status_changed",
        aggregate: { kind: "agent_run", id: result.run_id, revision: 3 },
        occurred_at: t4,
        audit,
        payload: { status: "succeeded" },
      },
      {
        event_id: "event-result-recorded",
        event_version: 1,
        event_type: "task_result.recorded",
        aggregate: { kind: "task_result", id: result.run_id, revision: 1 },
        occurred_at: t4,
        audit,
        payload: { status: result.status },
      },
    ],
  });
}

async function recordCreation(
  repository: DomainRepository,
  write: DomainRecordWrite,
  eventType: AuthoritativeDomainEvent["event_type"],
  suffix: string,
): Promise<void> {
  const taskVersion = write.value as TaskVersion;
  const recordId = `${taskVersion.task_id}:v${taskVersion.task_version}`;
  const requestId = `request-${suffix}`;
  await repository.commit({
    change_id: requestId,
    idempotency: {
      operation: "integration-seed",
      key: `key-${suffix}`,
      request_hash: computeContentHash({ suffix }),
    },
    records: [write],
    events: [
      {
        event_id: `event-${suffix}`,
        event_version: 1,
        event_type: eventType,
        aggregate: { kind: write.kind, id: recordId, revision: 1 },
        occurred_at: t0,
        audit: {
          actor: { kind: "bridge", id: "bridge-test" },
          operation: "integration-seed",
          request_id: requestId,
          correlation_id: "correlation-seed",
          idempotency_key: `key-${suffix}`,
        },
        payload: { seeded: write.kind },
      },
    ],
  });
}

function audit(operation: string, eventId: string, occurredAt: string): RuntimeAuditInput {
  return {
    actor: { kind: "bridge", id: "bridge-test" },
    operation,
    request_id: `request-${operation}`,
    correlation_id: "correlation-phase2g",
    idempotency_key: `key-${operation}`,
    event_id: eventId,
    occurred_at: occurredAt,
  };
}

function text(value: Buffer): string {
  return value.toString("utf8").trim();
}
