import { randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { computeContentHash } from "@agent-bridge/core";
import {
  DOMAIN_SCHEMA_VERSION,
  parseProjectBaseline,
  type DomainJsonValue,
} from "@agent-bridge/schemas";
import { SqliteDomainRepository } from "@agent-bridge/storage-sqlite";
import { LocalArtifactRepository } from "@agent-bridge/artifacts-local";
import { PersistentEventFanout } from "@agent-bridge/observability";
import {
  ActiveRunRegistry,
  ContextHandoffRuntime,
  DefaultGitClient,
  loadRuntimeConfiguration,
} from "@agent-bridge/worker-runtime";

import { BridgeControlService } from "./bridge-control-service.js";
import { controlError } from "./errors.js";
import { LocalBridgeRuntime } from "./local-runtime.js";
import { OutboxPump } from "./outbox-pump.js";

export interface BridgeApplication {
  readonly service: BridgeControlService;
  readonly events: PersistentEventFanout;
  close(): Promise<void>;
}

export async function bootstrapBridgeApplication(configPath: string): Promise<BridgeApplication> {
  const configuration = await loadRuntimeConfiguration(configPath);
  await mkdir(configuration.project.runtime_root, { recursive: true });
  const repository = new SqliteDomainRepository({
    database_path: resolve(configuration.project.runtime_root, "agent-bridge.sqlite"),
  });
  const activeRuns = new ActiveRunRegistry();
  let outbox: OutboxPump | undefined;
  let events: PersistentEventFanout | undefined;
  try {
    await ensureProjectBaseline(
      repository,
      configuration.project.id,
      configuration.project.project_baseline_path,
    );
    const git = new DefaultGitClient({ executable: "/usr/bin/git" });
    const contexts = new ContextHandoffRuntime(repository, git);
    const artifacts = await LocalArtifactRepository.open({
      root_path: resolve(configuration.project.runtime_root, "artifacts"),
    });
    const runtime = new LocalBridgeRuntime(
      repository,
      activeRuns,
      configuration,
      repository.createLeaseManager(),
      artifacts,
    );
    const service = new BridgeControlService({
      repository,
      contexts,
      active_runs: activeRuns,
      runtime,
      project_id: configuration.project.id,
      repository_path: configuration.project.workspace_root,
      max_review_cycles: configuration.limits.max_review_cycles,
      timeout_seconds: configuration.limits.timeout_seconds,
      max_agent_count: configuration.limits.max_agent_count,
    });
    runtime.setEventListener((runId, event) => service.onAgentEvent(event, runId));
    await runtime.recoverPersistedRuns();
    events = new PersistentEventFanout(repository);
    outbox = new OutboxPump(
      repository.createOutboxDispatcher({ dispatcher_id: "bridge-mcp" }),
      async () => events?.pollOnce(),
    );
    await outbox.drain();
    outbox.start();
    return Object.freeze({
      service,
      events,
      close: async () => {
        await outbox?.stop();
        events?.stop();
        await activeRuns.closeAll();
        repository.close();
      },
    });
  } catch (error) {
    await outbox?.stop();
    events?.stop();
    await activeRuns.closeAll();
    repository.close();
    throw error;
  }
}

async function ensureProjectBaseline(
  repository: SqliteDomainRepository,
  projectId: string,
  path: string,
): Promise<void> {
  let source: unknown;
  try {
    source = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw controlError("PROJECT_BASELINE_FILE_INVALID", { path });
  }
  if (
    !isRecord(source) ||
    !Number.isInteger(source.baseline_version) ||
    source.content === undefined
  ) {
    throw controlError("PROJECT_BASELINE_FILE_INVALID", { path });
  }
  const version = source.baseline_version as number;
  if ((await repository.getProjectBaseline(projectId, version)) !== undefined) return;
  const occurredAt = new Date().toISOString();
  const base = {
    schema_version: DOMAIN_SCHEMA_VERSION,
    project_id: projectId,
    baseline_version: version,
    content: source.content as DomainJsonValue,
    created_at: occurredAt,
  };
  const baseline = parseProjectBaseline({
    ...base,
    content_hash: computeContentHash({
      project_id: projectId,
      baseline_version: version,
      baseline: source.content as DomainJsonValue,
    }),
  });
  const requestId = randomUUID();
  await repository.commit({
    change_id: requestId,
    idempotency: {
      operation: "bootstrap_project_baseline",
      key: `baseline:${projectId}:v${version}`,
      request_hash: computeContentHash({
        project_id: projectId,
        baseline_version: version,
        content_hash: baseline.content_hash,
      }),
    },
    records: [{ kind: "project_baseline", expected_revision: 0, value: baseline }],
    events: [
      {
        event_id: randomUUID(),
        event_version: 1,
        event_type: "project_baseline.recorded",
        aggregate: { kind: "project_baseline", id: `${projectId}:v${version}`, revision: 1 },
        occurred_at: occurredAt,
        audit: {
          actor: { kind: "system", id: "bridge-bootstrap" },
          operation: "bootstrap_project_baseline",
          request_id: requestId,
          correlation_id: requestId,
          idempotency_key: `baseline:${projectId}:v${version}`,
        },
        payload: { project_id: projectId, baseline_version: version },
      },
    ],
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
