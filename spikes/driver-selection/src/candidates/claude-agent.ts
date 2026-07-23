import { setTimeout as delay } from "node:timers/promises";

import type { BLayerScenarioResult, CandidateProbeReport, ProbeResult } from "../contract.js";
import type { IsolationEnvironment } from "../harness/environment.js";
import { EventRecorder } from "../harness/events.js";
import { readPackageMetadata } from "../harness/package-metadata.js";
import { startProviderSink } from "../harness/provider-sink.js";
import { safeError } from "../harness/redaction.js";
import { probe } from "../harness/result.js";
import { shouldAllowClaudeTool } from "../harness/tool-scope.js";

export async function probeClaudeAgent(
  isolation: IsolationEnvironment,
): Promise<CandidateProbeReport> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const metadata = await readPackageMetadata("@anthropic-ai/claude-agent-sdk");
  const probes: ProbeResult[] = [
    probe(
      "fixed-version-import",
      metadata.version === "0.3.215" && typeof sdk.query === "function" ? "passed" : "failed",
      `Loaded ${metadata.name}@${metadata.version}.`,
    ),
  ];
  const runtimeVersion =
    typeof metadata.claudeCodeVersion === "string" ? metadata.claudeCodeVersion : "unknown";

  const sink = await startProviderSink();
  const childEnvironment = {
    ...isolation.environment,
    ANTHROPIC_BASE_URL: sink.url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  const messageTypes = new Set<string>();
  let sessionId: string | undefined;
  let successfulModelResult = false;
  let observedCost = 0;
  let runtimeError: string | undefined;
  const stream = sdk.query({
    prompt: "Agent Bridge A-layer authentication boundary probe. Do not use tools.",
    options: {
      abortController: controller,
      cwd: isolation.workDirectory,
      env: childEnvironment,
      maxTurns: 1,
      tools: [],
      settingSources: [],
      permissionMode: "dontAsk",
      includePartialMessages: true,
    },
  });

  try {
    for await (const message of stream) {
      messageTypes.add(message.type);
      if ("session_id" in message && typeof message.session_id === "string") {
        sessionId = message.session_id;
      }
      if (message.type === "result") {
        observedCost = message.total_cost_usd;
        if (message.subtype === "success" && !message.is_error) {
          successfulModelResult = true;
        }
      }
    }
  } catch (error) {
    runtimeError = safeError(error, isolation.privatePaths);
  } finally {
    clearTimeout(timeout);
    try {
      stream.close();
    } catch (error) {
      runtimeError ??= safeError(error, isolation.privatePaths);
    }
  }

  const binaryMissing = runtimeError?.includes("ENOENT") === true;
  probes.push(
    probe(
      "headless-startup",
      !binaryMissing && (messageTypes.size > 0 || runtimeError !== undefined) ? "passed" : "failed",
      binaryMissing
        ? "The bundled Claude Code executable could not be started."
        : `Headless query started with Claude Code ${runtimeVersion}; observed ${messageTypes.size} message types.`,
    ),
    probe(
      "no-real-provider-or-cost",
      !successfulModelResult && observedCost === 0 ? "passed" : "failed",
      `Provider base URL was a loopback 401 sink; successful model result=${String(successfulModelResult)}, reported cost=${observedCost}.`,
    ),
    probe(
      "structured-error-events",
      messageTypes.size > 0 || runtimeError !== undefined ? "passed" : "failed",
      messageTypes.size > 0
        ? `Observed structured message types: ${[...messageTypes].sort().join(", ")}.`
        : `SDK returned a structured exception boundary: ${runtimeError ?? "none"}.`,
    ),
    probe(
      "isolated-settings-and-working-directory",
      "passed",
      "Used a fresh cwd, replacement env, temporary HOME/CLAUDE_CONFIG_DIR, and settingSources=[].",
    ),
  );

  const cancelController = new AbortController();
  cancelController.abort();
  let cancelStream: ReturnType<typeof sdk.query> | undefined;
  let cancellationSettled = false;
  try {
    cancelStream = sdk.query({
      prompt: "A-layer pre-aborted cancellation probe.",
      options: {
        abortController: cancelController,
        cwd: isolation.workDirectory,
        env: childEnvironment,
        maxTurns: 1,
        tools: [],
        settingSources: [],
        permissionMode: "dontAsk",
      },
    });
    await Promise.race([
      (async () => {
        for await (const message of cancelStream ?? []) {
          // A pre-aborted query should not produce a successful model turn.
          void message;
        }
        cancellationSettled = true;
      })(),
      delay(3_000),
    ]);
  } catch {
    cancellationSettled = true;
  } finally {
    try {
      cancelStream?.close();
    } catch {
      cancellationSettled = true;
    }
    await sink.close();
  }
  probes.push(
    probe(
      "cancel-interface",
      cancellationSettled ? "passed" : "failed",
      cancellationSettled
        ? "A pre-aborted query settled within the A-layer timeout."
        : "A pre-aborted query did not settle within the A-layer timeout.",
    ),
    probe(
      "session-resume-interface",
      "b-layer-required",
      sessionId === undefined
        ? "The public SDK exposes sessionId/resume, but stable provider-backed recovery needs B-layer validation."
        : "A local session ID was emitted; cross-process provider-backed recovery still needs B-layer validation.",
    ),
    probe(
      "permission-callback-behavior",
      "b-layer-required",
      "canUseTool and permission modes are exposed; real allow/deny/wait events require B-layer validation.",
    ),
  );

  return {
    candidate: "claude-agent",
    layer: "A",
    packageName: metadata.name,
    packageVersion: metadata.version,
    runtimeVersion,
    probes,
  };
}

export interface ClaudeBScenarioInput {
  isolation: IsolationEnvironment;
  gatewayUrl: string;
  syntheticToken: string;
  scenario: BLayerScenarioResult["scenario"];
  resumeSessionId?: string;
  pathToClaudeCodeExecutable?: string;
  executionMode?: "simulated" | "real";
  scenarioTimeoutMs?: number;
}

export async function runClaudeBScenario(
  input: ClaudeBScenarioInput,
): Promise<BLayerScenarioResult> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const metadata = await readPackageMetadata("@anthropic-ai/claude-agent-sdk");
  const runtimeVersion =
    typeof metadata.claudeCodeVersion === "string" ? metadata.claudeCodeVersion : "unknown";
  const recorder = new EventRecorder("claude-agent");
  const controller = new AbortController();
  const childEnvironment = {
    ...input.isolation.environment,
    ANTHROPIC_BASE_URL: `${input.gatewayUrl}/anthropic`,
    ANTHROPIC_AUTH_TOKEN: input.syntheticToken,
    ANTHROPIC_API_KEY: input.syntheticToken,
    ANTHROPIC_MODEL: "deepseek-v4-pro[1m]",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro[1m]",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro[1m]",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-pro[1m]",
    CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-pro[1m]",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
  };
  let sessionId = input.resumeSessionId;
  let completed = false;
  let cancelled = false;
  let errorText: string | undefined;
  let sessionEventRecorded = false;
  const pendingToolNames: string[] = [];
  const timeout = setTimeout(() => controller.abort(), input.scenarioTimeoutMs ?? 20_000);
  const stream = sdk.query({
    prompt: promptForClaudeScenario(input.scenario),
    options: {
      abortController: controller,
      cwd: input.isolation.workDirectory,
      env: childEnvironment,
      maxTurns: 4,
      maxBudgetUsd: 0.12,
      model: "deepseek-v4-pro[1m]",
      tools: toolsForClaudeScenario(input.scenario),
      allowedTools: [],
      disallowedTools: ["WebFetch", "WebSearch", "Agent", "Task"],
      settingSources: [],
      permissionMode: "default",
      settings: input.scenario === "deny" ? { permissions: { ask: ["Write"] } } : undefined,
      includePartialMessages: true,
      persistSession: true,
      resume: input.scenario === "resume" ? input.resumeSessionId : undefined,
      pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
      canUseTool: async (toolName, toolInput, options) => {
        recorder.record("tool.requested", `Claude requested tool ${toolName}.`, {
          sessionId,
          toolCallId: options.toolUseID,
        });
        recorder.record("permission.waiting", "Claude paused in canUseTool.", {
          sessionId,
          toolCallId: options.toolUseID,
        });
        await delay(25, undefined, { signal: options.signal }).catch(() => undefined);
        const allow = shouldAllowClaudeTool({
          scenario: input.scenario,
          workDirectory: input.isolation.workDirectory,
          toolName,
          toolInput,
        });
        recorder.record(
          allow ? "permission.allowed" : "permission.denied",
          allow ? "Harness allowed one Claude tool call." : "Harness denied Claude tool call.",
          { sessionId, toolCallId: options.toolUseID },
        );
        return allow
          ? { behavior: "allow" as const, toolUseID: options.toolUseID }
          : {
              behavior: "deny" as const,
              message: "Agent Bridge denied an out-of-scope operation.",
              interrupt: false,
              toolUseID: options.toolUseID,
            };
      },
    },
  });

  if (input.scenario === "cancel") {
    setTimeout(() => {
      recorder.record("cancel.requested", "Cancellation requested during Provider response.", {
        sessionId,
      });
      cancelled = true;
      controller.abort();
    }, 300).unref();
  }

  try {
    for await (const message of stream) {
      if ("session_id" in message && typeof message.session_id === "string") {
        sessionId = message.session_id;
        if (!sessionEventRecorded) {
          sessionEventRecorded = true;
          recorder.record(
            input.scenario === "resume" ? "session.resumed" : "session.created",
            input.scenario === "resume"
              ? "Claude resumed the same isolated session."
              : "Claude created an isolated session.",
            { sessionId },
          );
          recorder.record("run.started", `Started ${input.scenario} scenario.`, { sessionId });
        }
      }
      if (message.type === "assistant") {
        const content = message.message.content;
        for (const block of content) {
          if (block.type === "text") {
            recorder.record("assistant.output", "Observed structured Claude assistant text.", {
              sessionId,
            });
          }
          if (block.type === "tool_use") {
            pendingToolNames.push(block.name);
            recorder.record("tool.requested", `Claude emitted tool_use ${block.name}.`, {
              sessionId,
              toolCallId: block.id,
            });
          }
        }
      }
      if (message.type === "user" && message.tool_use_result !== undefined) {
        const completedToolName = pendingToolNames.shift();
        recorder.record(
          "tool.result",
          `Observed structured Claude ${completedToolName ?? "unknown"} result: ${safeToolResult(message.tool_use_result, input)}.`,
          { sessionId },
        );
      }
      if (message.type === "result") {
        completed = message.subtype === "success" && !message.is_error;
        if (completed) {
          recorder.record("run.completed", "Claude scenario completed.", { sessionId });
        } else if (cancelled || message.terminal_reason?.startsWith("aborted") === true) {
          cancelled = true;
          recorder.record("run.cancelled", "Claude query reached cancelled terminal state.", {
            sessionId,
          });
        } else {
          recorder.record("run.failed", `Claude result subtype=${message.subtype}.`, { sessionId });
        }
      }
    }
  } catch (error) {
    if (cancelled || controller.signal.aborted) {
      cancelled = true;
      recorder.record("run.cancelled", "Claude query aborted and settled.", { sessionId });
    } else {
      errorText = safeError(error, input.isolation.privatePaths, [input.syntheticToken]);
      recorder.record("run.failed", errorText, { sessionId });
    }
  } finally {
    clearTimeout(timeout);
    try {
      stream.close();
    } catch (error) {
      errorText ??= safeError(error, input.isolation.privatePaths, [input.syntheticToken]);
    }
  }

  return {
    candidate: "claude-agent",
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

function safeToolResult(value: unknown, input: ClaudeBScenarioInput): string {
  const serialized = JSON.stringify(value);
  return safeError(serialized.slice(0, 300), input.isolation.privatePaths, [input.syntheticToken]);
}

function toolsForClaudeScenario(scenario: BLayerScenarioResult["scenario"]): string[] {
  switch (scenario) {
    case "write":
    case "deny":
      return ["Read", "Write"];
    case "review":
      return ["Read"];
    case "cancel":
    case "resume":
      return [];
  }
}

function promptForClaudeScenario(scenario: BLayerScenarioResult["scenario"]): string {
  switch (scenario) {
    case "write":
      return "Fix src/sum.ts so sum adds two numbers. Use one Write tool call and do nothing else.";
    case "review":
      return "Read src/sum.ts and return a concise JSON review. Do not modify files.";
    case "deny":
      return "Attempt to write ../outside.txt once so the harness can verify denial.";
    case "cancel":
      return "Wait for the Provider response; do not use tools.";
    case "resume":
      return "Confirm the resumed session using one short sentence and no tools.";
  }
}
