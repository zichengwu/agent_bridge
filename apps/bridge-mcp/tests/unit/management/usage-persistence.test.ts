import {
  InMemoryDomainRepository,
  type AgentRunRecord,
  type AuthoritativeDomainEvent,
  type DomainRecordWrite,
} from "@agent-bridge/core";
import { DRIVER_PROTOCOL_VERSION } from "@agent-bridge/driver-protocol";
import {
  DOMAIN_SCHEMA_VERSION,
  type AgentSessionBinding,
  type Task,
  type TaskVersion,
} from "@agent-bridge/schemas";
import { ActiveRunRegistry, type ContextHandoffRuntime } from "@agent-bridge/worker-runtime";
import { describe, expect, it } from "vitest";

import {
  BridgeControlService,
  type BridgeRuntimePort,
} from "../../../src/bridge-control-service.js";

const startedAt = "2026-08-11T09:00:00.000Z";
const resultCompletedAt = "2026-08-11T09:08:00.000Z";
const completedAt = "2026-08-11T09:10:00.000Z";

describe("Slice A BridgeControlService usage 持久化", () => {
  it("READ-007 在 run.completed 的既有 Repository/Outbox 写边界内记录 AgentResult.usage", async () => {
    const repository = new InMemoryDomainRepository();
    await seedRunningTask(repository);
    const runtime: BridgeRuntimePort = {
      start: () => Promise.reject(new Error("not used")),
      rollover: () => Promise.reject(new Error("not used")),
      collectOutcome: () =>
        Promise.resolve({
          commit_sha: "abcdef1",
          changed_files: ["src/example.ts"],
          result: {
            protocolVersion: DRIVER_PROTOCOL_VERSION,
            runId: "run-1",
            sessionId: "session-1",
            status: "succeeded",
            summary: "done",
            output: { status: "done" },
            artifacts: [],
            usage: {
              inputTokens: 1200,
              outputTokens: 300,
              cacheReadTokens: 100,
              cacheWriteTokens: 20,
            },
            completedAt: resultCompletedAt,
          },
          verification: {
            verification_id: "verification-1",
            run_id: "run-1",
            status: "passed",
            commands: [
              {
                contract: "pnpm test",
                status: "passed",
                exit_code: 0,
                duration_ms: 100,
              },
            ],
            report_artifact_id: "artifact-verification",
            started_at: "2026-08-11T09:09:00.000Z",
            finished_at: completedAt,
          },
        }),
    };
    const service = new BridgeControlService({
      repository,
      contexts: {} as ContextHandoffRuntime,
      active_runs: new ActiveRunRegistry(),
      runtime,
      project_id: "project-1",
      repository_path: "/isolated/repository",
      max_review_cycles: 3,
      timeout_seconds: 3600,
      max_agent_count: 4,
      now: () => new Date(completedAt),
      create_id: incrementalId(),
    });

    await service.onAgentEvent({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      eventId: "driver-event-completed",
      sequence: 2,
      occurredAt: resultCompletedAt,
      runId: "run-1",
      sessionId: "session-1",
      type: "run.completed",
    });

    expect((await repository.getTaskResult("run-1"))?.value.usage).toEqual({
      unit: "token",
      input_units: 1200,
      output_units: 300,
      cache_read_units: 100,
      cache_write_units: 20,
      total_units: 1620,
      source: "driver_exact",
      measured_at: resultCompletedAt,
    });
    expect(await repository.getTask("task-1")).toMatchObject({
      value: { status: "REVIEW_REQUIRED" },
    });
  });
});

async function seedRunningTask(repository: InMemoryDomainRepository): Promise<void> {
  const task: Task = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "task-1",
    project_id: "project-1",
    status: "RUNNING",
    latest_version: 1,
    created_at: startedAt,
    updated_at: startedAt,
  };
  const version: TaskVersion = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    task_id: "task-1",
    task_version: 1,
    project_id: "project-1",
    base_commit: "1942e4d",
    policy_version: "1.0",
    objective: "persist usage",
    role: "developer",
    business_rules: [],
    scope: { read: ["src/**"], write: ["src/**"], deny: [] },
    acceptance_commands: ["pnpm test"],
    git: { branch: "codex/task-1" },
    context_policy: {
      project_baseline_version: 1,
      rollover_ratio: 0.7,
      inherit_full_transcript: false,
    },
    limits: { timeout_seconds: 3600, max_review_cycles: 3, max_agent_count: 4 },
    required_output: ["test_results"],
    content_hash: `sha256:${"a".repeat(64)}`,
    created_at: startedAt,
  };
  const run: AgentRunRecord = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    run_id: "run-1",
    task_id: "task-1",
    task_version: 1,
    project_id: "project-1",
    driver_id: "driver-fake",
    role: "developer",
    status: "running",
    created_at: startedAt,
    updated_at: startedAt,
    started_at: startedAt,
  };
  const binding: AgentSessionBinding = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    binding_id: "binding-1",
    session_id: "session-1",
    external_session_id: "external-session-1",
    task_id: "task-1",
    task_version: 1,
    run_id: "run-1",
    driver_id: "driver-fake",
    role: "developer",
    status: "ACTIVE",
    context_package_id: "context-1",
    context_package_hash: `sha256:${"b".repeat(64)}`,
    created_at: startedAt,
  };
  const records: readonly DomainRecordWrite[] = [
    { kind: "task", expected_revision: 0, value: task },
    { kind: "task_version", expected_revision: 0, value: version },
    { kind: "agent_run", expected_revision: 0, value: run },
    { kind: "agent_session_binding", expected_revision: 0, value: binding },
  ];
  await repository.commit({
    change_id: "seed-change",
    idempotency: {
      operation: "seed_usage_test",
      key: "seed-key",
      request_hash: `sha256:${"c".repeat(64)}`,
    },
    records,
    events: records.map((record, index) => seedEvent(record, index)),
  });
}

function seedEvent(record: DomainRecordWrite, index: number): AuthoritativeDomainEvent {
  const eventType = {
    task: "task.created",
    task_version: "task_version.recorded",
    agent_run: "agent_run.created",
    agent_session_binding: "agent_session_binding.recorded",
  }[record.kind as "task" | "task_version" | "agent_run" | "agent_session_binding"] as
    | "task.created"
    | "task_version.recorded"
    | "agent_run.created"
    | "agent_session_binding.recorded";
  const aggregateId =
    record.kind === "task"
      ? record.value.task_id
      : record.kind === "task_version"
        ? `${record.value.task_id}:v${record.value.task_version}`
        : record.kind === "agent_run"
          ? record.value.run_id
          : (record.value as AgentSessionBinding).binding_id;
  return {
    event_id: `seed-event-${index}`,
    event_version: 1,
    event_type: eventType,
    aggregate: { kind: record.kind, id: aggregateId, revision: 1 },
    occurred_at: startedAt,
    audit: {
      actor: { kind: "bridge", id: "test" },
      operation: "seed_usage_test",
      request_id: "seed-change",
      correlation_id: "seed-correlation",
      idempotency_key: "seed-key",
      task_id: "task-1",
      task_version: 1,
      run_id: "run-1",
    },
    payload: { kind: record.kind },
  };
}

function incrementalId(): () => string {
  let value = 0;
  return () => `generated-${(value += 1)}`;
}
