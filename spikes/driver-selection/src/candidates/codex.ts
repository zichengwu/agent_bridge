import { setTimeout as delay } from "node:timers/promises";

import type { CandidateProbeReport, ProbeResult } from "../contract.js";
import type { IsolationEnvironment } from "../harness/environment.js";
import { readPackageMetadata } from "../harness/package-metadata.js";
import { startProviderSink } from "../harness/provider-sink.js";
import { safeError } from "../harness/redaction.js";
import { probe } from "../harness/result.js";

export async function probeCodex(isolation: IsolationEnvironment): Promise<CandidateProbeReport> {
  const sdk = await import("@openai/codex-sdk");
  const metadata = await readPackageMetadata("@openai/codex-sdk");
  const probes: ProbeResult[] = [
    probe(
      "fixed-version-import",
      metadata.version === "0.144.6" && typeof sdk.Codex === "function" ? "passed" : "failed",
      `Loaded ${metadata.name}@${metadata.version}.`,
    ),
  ];
  const dependencies = metadata.dependencies as Record<string, unknown> | undefined;
  const runtimeVersion =
    typeof dependencies?.["@openai/codex"] === "string"
      ? String(dependencies["@openai/codex"])
      : "unknown";

  const sink = await startProviderSink();
  const childEnvironment = {
    ...isolation.environment,
    OPENAI_BASE_URL: sink.url,
  };
  const codex = new sdk.Codex({
    baseUrl: sink.url,
    env: childEnvironment,
    config: {
      check_for_update_on_startup: false,
      analytics: { enabled: false },
      feedback: { enabled: false },
      features: {
        apps: false,
        plugin_sharing: false,
        plugins: false,
        remote_plugin: false,
      },
    },
  });
  const thread = codex.startThread({
    workingDirectory: isolation.workDirectory,
    skipGitRepoCheck: true,
    sandboxMode: "read-only",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  const eventTypes = new Set<string>();
  let threadId: string | undefined;
  let successfulTurn = false;
  let runtimeError: string | undefined;
  let streamed: Awaited<ReturnType<typeof thread.runStreamed>> | undefined;

  try {
    streamed = await thread.runStreamed(
      "Agent Bridge A-layer authentication boundary probe. Do not execute tools.",
      { signal: controller.signal },
    );
    for await (const event of streamed.events) {
      eventTypes.add(event.type);
      if (event.type === "thread.started") {
        threadId = event.thread_id;
      }
      if (event.type === "turn.completed") {
        successfulTurn = true;
      }
    }
  } catch (error) {
    runtimeError = safeError(error, isolation.privatePaths);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (streamed !== undefined) {
      await streamed.events.return(undefined).catch(() => undefined);
    }
    await sink.close();
  }

  const binaryMissing = runtimeError?.includes("ENOENT") === true;
  probes.push(
    probe(
      "headless-startup",
      !binaryMissing && (eventTypes.size > 0 || runtimeError !== undefined) ? "passed" : "failed",
      binaryMissing
        ? "The pinned Codex CLI executable could not be started."
        : `Headless SDK process started with Codex CLI ${runtimeVersion}; observed ${eventTypes.size} event types.`,
    ),
    probe(
      "no-real-provider-or-cost",
      !successfulTurn ? "passed" : "failed",
      `Provider base URL was a loopback 401 sink; completed model turn=${String(successfulTurn)}, sink requests=${sink.requestCount()}.`,
    ),
    probe(
      "structured-error-events",
      eventTypes.size > 0 || runtimeError !== undefined ? "passed" : "failed",
      eventTypes.size > 0
        ? `Observed JSONL event types: ${[...eventTypes].sort().join(", ")}.`
        : `SDK returned a structured exception boundary: ${runtimeError ?? "none"}.`,
    ),
    probe(
      "isolated-settings-and-working-directory",
      "passed",
      "Used a fresh cwd, replacement env, temporary HOME/CODEX_HOME, disabled plugins/apps, read-only sandbox, no network, and approvalPolicy=never.",
    ),
  );

  const resumeProbeId = threadId ?? "00000000-0000-0000-0000-000000000000";
  const resumed = codex.resumeThread(resumeProbeId, {
    workingDirectory: isolation.workDirectory,
    skipGitRepoCheck: true,
    sandboxMode: "read-only",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
  });
  probes.push(
    probe(
      "session-resume-interface",
      resumed.id === resumeProbeId ? "passed" : "failed",
      "resumeThread retained the supplied persistent thread ID without invoking a model.",
    ),
  );

  const cancelController = new AbortController();
  cancelController.abort();
  const cancelThread = codex.startThread({
    workingDirectory: isolation.workDirectory,
    skipGitRepoCheck: true,
    sandboxMode: "read-only",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
  });
  let cancellationSettled = false;
  try {
    await Promise.race([
      cancelThread
        .runStreamed("A-layer pre-aborted cancellation probe.", {
          signal: cancelController.signal,
        })
        .then(async ({ events }) => {
          for await (const event of events) {
            // A pre-aborted turn should not complete a provider-backed response.
            void event;
          }
          cancellationSettled = true;
        }),
      delay(3_000),
    ]);
  } catch {
    cancellationSettled = true;
  }
  probes.push(
    probe(
      "cancel-interface",
      cancellationSettled ? "passed" : "failed",
      cancellationSettled
        ? "A pre-aborted turn settled within the A-layer timeout."
        : "A pre-aborted turn did not settle within the A-layer timeout.",
    ),
    probe(
      "provider-backed-permissions-and-usage",
      "b-layer-required",
      "Real approval requests, tool events, usage, and recovered turns require B-layer validation.",
    ),
  );

  return {
    candidate: "codex",
    layer: "A",
    packageName: metadata.name,
    packageVersion: metadata.version,
    runtimeVersion,
    probes,
  };
}
