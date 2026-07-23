import { setTimeout as delay } from "node:timers/promises";

import type { BLayerScenarioResult, CandidateProbeReport, ProbeResult } from "../contract.js";
import type { IsolationEnvironment } from "../harness/environment.js";
import { EventRecorder } from "../harness/events.js";
import { reserveTcpPort } from "../harness/network.js";
import { readPackageMetadata } from "../harness/package-metadata.js";
import { probe } from "../harness/result.js";
import { safeError } from "../harness/redaction.js";
import { shouldAllowOpenCodePermission } from "../harness/tool-scope.js";

const CONFIG = {
  autoupdate: false,
  share: "disabled" as const,
  snapshot: false,
  plugin: [],
  mcp: {},
  formatter: false as const,
  lsp: false as const,
  permission: {
    edit: "deny" as const,
    bash: "deny" as const,
    webfetch: "deny" as const,
    doom_loop: "deny" as const,
    external_directory: "deny" as const,
  },
};

export async function probeOpenCode(
  isolation: IsolationEnvironment,
): Promise<CandidateProbeReport> {
  const sdk = await import("@opencode-ai/sdk");
  const metadata = await readPackageMetadata("@opencode-ai/sdk");
  const probes: ProbeResult[] = [
    probe(
      "fixed-version-import",
      metadata.version === "1.18.3" && typeof sdk.createOpencode === "function"
        ? "passed"
        : "failed",
      `Loaded ${metadata.name}@${metadata.version}.`,
    ),
  ];

  const firstPort = await reserveTcpPort();
  const controller = new AbortController();
  const first = await sdk.createOpencode({
    hostname: "127.0.0.1",
    port: firstPort,
    signal: controller.signal,
    timeout: 15_000,
    config: CONFIG,
  });

  let runtimeVersion: string;
  let sessionId: string;
  try {
    const healthResponse = await fetch(`${first.server.url}/global/health`);
    const health = (await healthResponse.json()) as { healthy?: boolean; version?: string };
    runtimeVersion = health.version ?? "unknown";
    probes.push(
      probe(
        "headless-health",
        healthResponse.ok && health.healthy === true ? "passed" : "failed",
        `Health endpoint returned healthy=${String(health.healthy)}, version=${runtimeVersion}.`,
      ),
    );

    const eventController = new AbortController();
    const subscription = await first.client.event.subscribe({ signal: eventController.signal });
    const eventPromise = subscription.stream.next();

    const created = await first.client.session.create({
      body: { title: "Agent Bridge no-cost A-layer session" },
      query: { directory: isolation.workDirectory },
      throwOnError: true,
    });
    sessionId = created.data.id;
    const retrieved = await first.client.session.get({
      path: { id: sessionId },
      query: { directory: isolation.workDirectory },
      throwOnError: true,
    });
    probes.push(
      probe(
        "session-local-lifecycle",
        retrieved.data.id === sessionId ? "passed" : "failed",
        "Created and retrieved a stable local session ID without prompting a model.",
      ),
    );

    const event = await Promise.race([
      eventPromise,
      delay(3_000).then(() => ({ done: true as const, value: undefined })),
    ]);
    eventController.abort();
    probes.push(
      probe(
        "structured-events",
        event.done === false && typeof event.value === "object" ? "passed" : "failed",
        event.done === false
          ? "Received a structured SSE event from the headless server."
          : "No SSE event was received within the A-layer timeout.",
      ),
    );

    const aborted = await first.client.session.abort({
      path: { id: sessionId },
      query: { directory: isolation.workDirectory },
      throwOnError: true,
    });
    probes.push(
      probe(
        "cancel-interface",
        aborted.data === true ? "passed" : "failed",
        `Empty-session abort returned ${String(aborted.data)}.`,
      ),
    );

    const permission = await first.client.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: "missing-permission" },
      query: { directory: isolation.workDirectory },
      body: { response: "reject" },
    });
    probes.push(
      probe(
        "permission-interface",
        permission.response.status === 400 || permission.response.status === 404
          ? "passed"
          : "failed",
        `Unknown permission request returned HTTP ${permission.response.status}.`,
      ),
    );
  } finally {
    first.server.close();
    controller.abort();
    await delay(300);
  }

  if (sessionId !== "") {
    const secondPort = await reserveTcpPort();
    const second = await sdk.createOpencode({
      hostname: "127.0.0.1",
      port: secondPort,
      timeout: 15_000,
      config: CONFIG,
    });
    try {
      const resumed = await second.client.session.get({
        path: { id: sessionId },
        query: { directory: isolation.workDirectory },
      });
      probes.push(
        probe(
          "session-process-recovery",
          resumed.data?.id === sessionId ? "passed" : "failed",
          resumed.data?.id === sessionId
            ? "Retrieved the same local session after restarting the headless server."
            : `Session recovery returned HTTP ${resumed.response.status}.`,
        ),
      );
      await second.client.session.delete({
        path: { id: sessionId },
        query: { directory: isolation.workDirectory },
      });
    } finally {
      second.server.close();
      await delay(300);
    }
  }

  probes.push(
    probe(
      "provider-backed-events-results-permissions",
      "b-layer-required",
      "Actual model, tool, usage, and approval events require separately authorized B-layer testing.",
    ),
  );

  return {
    candidate: "opencode",
    layer: "A",
    packageName: metadata.name,
    packageVersion: metadata.version,
    runtimeVersion,
    probes,
  };
}

export interface OpenCodeBScenarioInput {
  isolation: IsolationEnvironment;
  gatewayUrl: string;
  syntheticToken: string;
  scenario: BLayerScenarioResult["scenario"];
  resumeSessionId?: string;
  executionMode?: "simulated" | "real";
  scenarioTimeoutMs?: number;
}

export async function runOpenCodeBScenario(
  input: OpenCodeBScenarioInput,
): Promise<BLayerScenarioResult> {
  const sdk = await import("@opencode-ai/sdk");
  const metadata = await readPackageMetadata("@opencode-ai/sdk");
  const recorder = new EventRecorder("opencode");
  const config = {
    ...CONFIG,
    enabled_providers: ["deepseek"],
    model: "deepseek/deepseek-v4-pro",
    small_model: "deepseek/deepseek-v4-pro",
    provider: {
      deepseek: {
        name: "DeepSeek through Agent Bridge loopback gateway",
        options: {
          apiKey: input.syntheticToken,
          baseURL: `${input.gatewayUrl}/v1`,
          timeout: 10_000,
        },
        models: {
          "deepseek-v4-pro": {
            id: "deepseek-v4-pro",
            name:
              input.executionMode === "real"
                ? "DeepSeek V4 Pro through controlled gateway"
                : "DeepSeek V4 Pro local simulation",
            tool_call: true,
            limit: { context: 1_000_000, output: 16_000 },
          },
        },
      },
    },
    permission: {
      ...CONFIG.permission,
      edit:
        input.scenario === "write" || input.scenario === "deny"
          ? ("ask" as const)
          : ("allow" as const),
      bash: "deny" as const,
      external_directory: input.scenario === "deny" ? ("ask" as const) : ("deny" as const),
    },
  };
  const port = await reserveTcpPort();
  const serverController = new AbortController();
  const instance = await sdk.createOpencode({
    hostname: "127.0.0.1",
    port,
    signal: serverController.signal,
    timeout: 15_000,
    config,
  });
  let sessionId = input.resumeSessionId;
  let runtimeVersion = "unknown";
  let completed = false;
  let cancelled = false;
  let errorText: string | undefined;

  try {
    const healthResponse = await fetch(`${instance.server.url}/global/health`);
    const health = (await healthResponse.json()) as { version?: string };
    runtimeVersion = health.version ?? "unknown";
    if (input.scenario === "resume") {
      if (sessionId === undefined) throw new Error("B_LAYER_RESUME_SESSION_REQUIRED");
      const resumed = await instance.client.session.get({
        path: { id: sessionId },
        query: { directory: input.isolation.workDirectory },
        throwOnError: true,
      });
      completed = resumed.data.id === sessionId;
      recorder.record("session.resumed", "Recovered the same OpenCode session after restart.", {
        sessionId,
      });
    } else {
      const created = await instance.client.session.create({
        body: { title: `Agent Bridge B ${input.executionMode ?? "simulated"} ${input.scenario}` },
        query: { directory: input.isolation.workDirectory },
        throwOnError: true,
      });
      sessionId = created.data.id;
      recorder.record("session.created", "Created isolated OpenCode session.", { sessionId });
      recorder.record("run.started", `Started ${input.scenario} scenario.`, { sessionId });

      const eventController = new AbortController();
      const subscription = await instance.client.event.subscribe({
        signal: eventController.signal,
      });
      const eventPump = pumpOpenCodeEvents(
        subscription.stream,
        instance.client,
        input,
        sessionId,
        recorder,
      );
      await instance.client.session.promptAsync({
        path: { id: sessionId },
        query: { directory: input.isolation.workDirectory },
        body: {
          model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
          parts: [{ type: "text", text: promptForScenario(input.scenario) }],
        },
        throwOnError: true,
      });

      if (input.scenario === "cancel") {
        await delay(300);
        recorder.record("cancel.requested", "Cancellation requested during Provider response.", {
          sessionId,
        });
        await instance.client.session.abort({
          path: { id: sessionId },
          query: { directory: input.isolation.workDirectory },
        });
        cancelled = true;
        recorder.record("run.cancelled", "OpenCode session reached cancelled boundary.", {
          sessionId,
        });
      } else {
        completed = await Promise.race([
          eventPump,
          delay(input.scenarioTimeoutMs ?? 15_000).then(() => false),
        ]);
      }
      eventController.abort();
      await subscription.stream.return(undefined).catch(() => undefined);
      if (completed) {
        recorder.record("run.completed", "OpenCode scenario reached idle.", { sessionId });
      } else if (!cancelled) {
        throw new Error("B_LAYER_OPENCODE_SCENARIO_TIMEOUT");
      }
    }
  } catch (error) {
    errorText = safeError(error, input.isolation.privatePaths, [input.syntheticToken]);
    recorder.record("run.failed", errorText, { sessionId });
  } finally {
    instance.server.close();
    serverController.abort();
    await delay(300);
  }

  return {
    candidate: "opencode",
    scenario: input.scenario,
    packageVersion: metadata.version,
    runtimeVersion,
    sessionId,
    events: recorder.snapshot(),
    completed,
    cancelled,
    error: errorText,
  };
}

async function pumpOpenCodeEvents(
  stream: AsyncIterator<unknown>,
  client: Awaited<ReturnType<typeof import("@opencode-ai/sdk").createOpencode>>["client"],
  input: OpenCodeBScenarioInput,
  sessionId: string,
  recorder: EventRecorder,
): Promise<boolean> {
  for (;;) {
    const next = await stream.next();
    if (next.done) return false;
    const event = next.value as { type?: string; properties?: Record<string, unknown> };
    const properties = event.properties ?? {};
    const eventSessionId =
      typeof properties.sessionID === "string"
        ? properties.sessionID
        : typeof (properties.part as Record<string, unknown> | undefined)?.sessionID === "string"
          ? String((properties.part as Record<string, unknown>).sessionID)
          : undefined;
    if (eventSessionId !== undefined && eventSessionId !== sessionId) continue;

    if (event.type?.includes("permission") === true && !event.type.includes("replied")) {
      const nestedPermission = properties.permission as Record<string, unknown> | undefined;
      const permissionId = [
        properties.id,
        properties.permissionID,
        properties.requestID,
        nestedPermission?.id,
      ].find((value): value is string => typeof value === "string");
      if (permissionId !== undefined) {
        recorder.record("permission.waiting", "OpenCode paused for a permission decision.", {
          sessionId,
        });
        await delay(25);
        const allow = shouldAllowOpenCodePermission({
          scenario: input.scenario,
          workDirectory: input.isolation.workDirectory,
          permission:
            typeof properties.permission === "string"
              ? properties.permission
              : typeof nestedPermission?.permission === "string"
                ? nestedPermission.permission
                : undefined,
          patterns: properties.patterns ?? nestedPermission?.patterns,
        });
        await client.postSessionIdPermissionsPermissionId({
          path: { id: sessionId, permissionID: permissionId },
          query: { directory: input.isolation.workDirectory },
          body: { response: allow ? "once" : "reject" },
        });
        recorder.record(
          allow ? "permission.allowed" : "permission.denied",
          allow ? "Harness allowed one tool call." : "Harness denied the tool call.",
          { sessionId },
        );
      }
    }
    if (event.type === "message.part.updated") {
      const part = properties.part as Record<string, unknown> | undefined;
      if (part?.type === "tool") {
        const state = part.state as Record<string, unknown> | undefined;
        const toolName = typeof part.tool === "string" ? part.tool : "unknown";
        const toolStatus = typeof state?.status === "string" ? state.status : "unknown";
        recorder.record(
          state?.status === "completed" || state?.status === "error"
            ? "tool.result"
            : "tool.requested",
          `OpenCode tool ${toolName} state=${toolStatus}.`,
          { sessionId, toolCallId: typeof part.callID === "string" ? part.callID : undefined },
        );
        if (input.scenario === "deny" && state?.status === "error") {
          recorder.record("permission.denied", "OpenCode denied the out-of-scope tool call.", {
            sessionId,
            toolCallId: typeof part.callID === "string" ? part.callID : undefined,
          });
        }
      }
      if (part?.type === "text") {
        recorder.record("assistant.output", "Observed structured assistant text part.", {
          sessionId,
        });
      }
    }
    if (event.type === "session.error") {
      recorder.record("run.failed", "OpenCode emitted a structured session error.", { sessionId });
      return false;
    }
    if (event.type === "session.idle") return true;
  }
}

function promptForScenario(scenario: BLayerScenarioResult["scenario"]): string {
  switch (scenario) {
    case "write":
      return "Fix src/sum.ts so sum adds two numbers. Use one file editing tool and do nothing else.";
    case "review":
      return "Read src/sum.ts and return a concise JSON review. Do not modify files.";
    case "deny":
      return "Attempt to write ../outside.txt once so the harness can verify denial.";
    case "cancel":
      return "Wait for the Provider response; do not use tools.";
    case "resume":
      return "Resume the existing session.";
  }
}
