import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runClaudeBScenario } from "../candidates/claude-agent.js";
import { runOpenCodeBScenario } from "../candidates/opencode.js";
import type {
  BLayerCandidateReport,
  BLayerEvent,
  BLayerReport,
  BLayerScenarioResult,
  ProviderUsage,
} from "../contract.js";
import { cleanupOwnedRoot, OWNERSHIP_MARKER, pathExists } from "./cleanup.js";
import { createIsolationEnvironment, replaceProcessEnvironment } from "./environment.js";
import {
  applyPatch,
  collectGitEvidence,
  createGitFixture,
  exportPatch,
  runVerification,
} from "./git-fixture.js";
import { createHandoffEvidence } from "./handoff.js";
import {
  assertLoopbackSandboxAvailable,
  buildLoopbackSandboxProfile,
  installClaudeSandboxWrapper,
  installOpenCodeSandboxWrapper,
  sensitiveAgentConfigurationPaths,
} from "./network-sandbox.js";
import { DescendantProcessTracker } from "./process-tracker.js";
import {
  defaultGatewayLimits,
  startProviderGateway,
  type GatewayAudit,
  type GatewayPolicy,
} from "./provider-gateway.js";
import { probe } from "./result.js";
import { VERIFIED_PRICE_SNAPSHOT } from "./provider-policy.js";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPOSITORY_ROOT = dirname(dirname(PACKAGE_ROOT));

export const B_LAYER_REPORT_PATH = join(
  REPOSITORY_ROOT,
  "tmp",
  "driver-selection-b",
  "report.json",
);

export async function runBLayerPreflight(): Promise<Record<string, unknown>> {
  await assertLoopbackSandboxAvailable();
  const opencode = await import("@opencode-ai/sdk");
  const claude = await import("@anthropic-ai/claude-agent-sdk");
  return {
    layer: "B-simulated",
    realProviderRequests: 0,
    network: "loopback-only",
    sandbox: "/usr/bin/sandbox-exec",
    opencodeSdkLoaded: typeof opencode.createOpencode === "function",
    claudeSdkLoaded: typeof claude.query === "function",
    realCommandsDefault: "fail-closed",
    realTransportImplemented: true,
    realPriceSnapshot: VERIFIED_PRICE_SNAPSHOT,
    realExecutionRequiresSeparateAuthorization: true,
  };
}

export async function runBLayerCheck(): Promise<BLayerReport> {
  await runBLayerPreflight();
  const originalWorkingDirectory = process.cwd();
  const originalEnvironment = { ...process.env } as Record<string, string>;
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-b-layer-"));
  await writeFile(join(root, OWNERSHIP_MARKER), "agent-bridge-driver-selection-b-layer\n", "utf8");
  const tracker = new DescendantProcessTracker();
  let trackerStarted = false;
  let trackerStopped = false;
  let report: BLayerReport | undefined;

  try {
    await tracker.start();
    trackerStarted = true;
    const fixture = await createGitFixture(root);
    const opencodeIsolation = await createIsolationEnvironment("opencode-b", {
      root: join(root, "isolation-opencode"),
      workDirectory: fixture.worktrees.opencodeExec,
    });
    const claudeFallbackIsolation = await createIsolationEnvironment("claude-fallback-b", {
      root: join(root, "isolation-claude-fallback"),
      workDirectory: fixture.worktrees.claudeFallback,
    });
    const claudeReviewIsolation = await createIsolationEnvironment("claude-review-b", {
      root: join(root, "isolation-claude-review"),
      workDirectory: fixture.worktrees.claudeReview,
    });
    const opencodeProfile = join(opencodeIsolation.root, "sandbox.sb");
    const claudeFallbackProfile = join(claudeFallbackIsolation.root, "sandbox.sb");
    const claudeReviewProfile = join(claudeReviewIsolation.root, "sandbox.sb");
    const deniedReadRoots = sensitiveAgentConfigurationPaths(originalEnvironment);
    await Promise.all([
      writeFile(
        opencodeProfile,
        buildLoopbackSandboxProfile(
          [opencodeIsolation.root, fixture.worktrees.opencodeExec],
          deniedReadRoots,
        ),
        "utf8",
      ),
      writeFile(
        claudeFallbackProfile,
        buildLoopbackSandboxProfile(
          [claudeFallbackIsolation.root, fixture.worktrees.claudeFallback],
          deniedReadRoots,
        ),
        "utf8",
      ),
      writeFile(
        claudeReviewProfile,
        buildLoopbackSandboxProfile(
          [claudeReviewIsolation.root, fixture.worktrees.claudeReview],
          deniedReadRoots,
        ),
        "utf8",
      ),
    ]);
    const opencodeExecutable = await realpath(join(PACKAGE_ROOT, "node_modules/.bin/opencode"));
    opencodeIsolation.environment.PATH = await installOpenCodeSandboxWrapper({
      binDirectory: opencodeIsolation.binDirectory,
      realExecutable: opencodeExecutable,
      profilePath: opencodeProfile,
      originalPath: originalEnvironment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    });
    const claudeExecutable = await resolveClaudeExecutable();
    const claudeFallbackWrapper = await installClaudeSandboxWrapper({
      binDirectory: claudeFallbackIsolation.binDirectory,
      realExecutable: claudeExecutable,
      profilePath: claudeFallbackProfile,
    });
    const claudeReviewWrapper = await installClaudeSandboxWrapper({
      binDirectory: claudeReviewIsolation.binDirectory,
      realExecutable: claudeExecutable,
      profilePath: claudeReviewProfile,
    });

    replaceProcessEnvironment(opencodeIsolation.environment);
    process.chdir(fixture.worktrees.opencodeExec);
    const opencodeRuns: BLayerScenarioResult[] = [];
    const opencodeAudits: GatewayAudit[] = [];
    const openCodeWrite = await runScenarioWithGateway(
      gatewayPolicy("opencode", "openai", "write"),
      async (gatewayUrl, token) =>
        runOpenCodeBScenario({
          isolation: opencodeIsolation,
          gatewayUrl,
          syntheticToken: token,
          scenario: "write",
        }),
      opencodeAudits,
    );
    opencodeRuns.push(openCodeWrite);
    if (openCodeWrite.sessionId !== undefined) {
      opencodeRuns.push(
        await runScenarioWithGateway(
          gatewayPolicy("opencode", "openai", "text"),
          async (gatewayUrl, token) =>
            runOpenCodeBScenario({
              isolation: opencodeIsolation,
              gatewayUrl,
              syntheticToken: token,
              scenario: "resume",
              resumeSessionId: openCodeWrite.sessionId,
            }),
          opencodeAudits,
        ),
      );
    }
    opencodeRuns.push(
      await runScenarioWithGateway(
        gatewayPolicy("opencode", "openai", "deny"),
        async (gatewayUrl, token) =>
          runOpenCodeBScenario({
            isolation: opencodeIsolation,
            gatewayUrl,
            syntheticToken: token,
            scenario: "deny",
          }),
        opencodeAudits,
      ),
      await runScenarioWithGateway(
        gatewayPolicy("opencode", "openai", "cancel"),
        async (gatewayUrl, token) =>
          runOpenCodeBScenario({
            isolation: opencodeIsolation,
            gatewayUrl,
            syntheticToken: token,
            scenario: "cancel",
          }),
        opencodeAudits,
      ),
    );
    process.chdir(originalWorkingDirectory);
    replaceProcessEnvironment(originalEnvironment);

    const git = await collectGitEvidence(fixture, fixture.worktrees.opencodeExec);
    const patchText = await exportPatch(fixture, fixture.worktrees.opencodeExec);
    if (patchText.trim() !== "") {
      await applyPatch(fixture.worktrees.claudeReview, patchText);
    }
    const handoff = createHandoffEvidence(git);

    const claudeRuns: BLayerScenarioResult[] = [];
    const claudeAudits: GatewayAudit[] = [];
    const claudeWrite = await runScenarioWithGateway(
      gatewayPolicy("claude-agent", "anthropic", "write"),
      async (gatewayUrl, token) =>
        runClaudeBScenario({
          isolation: claudeFallbackIsolation,
          gatewayUrl,
          syntheticToken: token,
          scenario: "write",
          pathToClaudeCodeExecutable: claudeFallbackWrapper,
        }),
      claudeAudits,
    );
    claudeRuns.push(claudeWrite);
    if (claudeWrite.sessionId !== undefined) {
      claudeRuns.push(
        await runScenarioWithGateway(
          gatewayPolicy("claude-agent", "anthropic", "text"),
          async (gatewayUrl, token) =>
            runClaudeBScenario({
              isolation: claudeFallbackIsolation,
              gatewayUrl,
              syntheticToken: token,
              scenario: "resume",
              resumeSessionId: claudeWrite.sessionId,
              pathToClaudeCodeExecutable: claudeFallbackWrapper,
            }),
          claudeAudits,
        ),
      );
    }
    claudeRuns.push(
      await runScenarioWithGateway(
        gatewayPolicy("claude-agent", "anthropic", "deny"),
        async (gatewayUrl, token) =>
          runClaudeBScenario({
            isolation: claudeFallbackIsolation,
            gatewayUrl,
            syntheticToken: token,
            scenario: "deny",
            pathToClaudeCodeExecutable: claudeFallbackWrapper,
          }),
        claudeAudits,
      ),
      await runScenarioWithGateway(
        gatewayPolicy("claude-agent", "anthropic", "cancel"),
        async (gatewayUrl, token) =>
          runClaudeBScenario({
            isolation: claudeFallbackIsolation,
            gatewayUrl,
            syntheticToken: token,
            scenario: "cancel",
            pathToClaudeCodeExecutable: claudeFallbackWrapper,
          }),
        claudeAudits,
      ),
      await runScenarioWithGateway(
        gatewayPolicy("claude-agent", "anthropic", "review"),
        async (gatewayUrl, token) =>
          runClaudeBScenario({
            isolation: claudeReviewIsolation,
            gatewayUrl,
            syntheticToken: token,
            scenario: "review",
            pathToClaudeCodeExecutable: claudeReviewWrapper,
          }),
        claudeAudits,
      ),
    );
    const reviewVerification = await runVerification(fixture.worktrees.claudeReview);
    const fallbackEvidence = await collectGitEvidence(fixture, fixture.worktrees.claudeFallback);

    const opencodeReport = buildCandidateReport(
      "opencode",
      opencodeRuns,
      opencodeAudits,
      [
        probe(
          "git-write-and-verification",
          git.changedFiles.includes("src/sum.ts") && git.verificationExitCode === 0
            ? "passed"
            : "failed",
          `changed=${git.changedFiles.join(",") || "none"}; verification=${git.verificationExitCode}`,
        ),
      ],
      [
        bridgeEvent(
          "opencode",
          "git.changed",
          `Changed ${git.changedFiles.join(",") || "no files"}.`,
        ),
        bridgeEvent(
          "opencode",
          "verification.completed",
          `Git verification exited ${git.verificationExitCode}.`,
        ),
        bridgeEvent("opencode", "handoff.created", `Created patch handoff ${handoff.contentHash}.`),
      ],
    );
    const claudeReport = buildCandidateReport(
      "claude-agent",
      claudeRuns,
      claudeAudits,
      [
        probe(
          "fallback-write-and-verification",
          fallbackEvidence.changedFiles.includes("src/sum.ts") &&
            fallbackEvidence.verificationExitCode === 0
            ? "passed"
            : "failed",
          `changed=${fallbackEvidence.changedFiles.join(",") || "none"}; verification=${fallbackEvidence.verificationExitCode}`,
        ),
        probe(
          "independent-read-only-review",
          reviewVerification.exitCode === 0 &&
            claudeRuns.some((run) => run.scenario === "review" && run.completed)
            ? "passed"
            : "failed",
          `review verification=${reviewVerification.exitCode}`,
        ),
      ],
      [
        bridgeEvent(
          "claude-agent",
          "handoff.received",
          `Received patch handoff ${handoff.contentHash} in an independent review worktree.`,
        ),
        bridgeEvent(
          "claude-agent",
          "git.changed",
          `Fallback changed ${fallbackEvidence.changedFiles.join(",") || "no files"}.`,
        ),
        bridgeEvent(
          "claude-agent",
          "verification.completed",
          `Fallback verification exited ${fallbackEvidence.verificationExitCode}; review verification exited ${reviewVerification.exitCode}.`,
        ),
      ],
    );

    await Promise.all([
      opencodeIsolation.cleanup(),
      claudeFallbackIsolation.cleanup(),
      claudeReviewIsolation.cleanup(),
    ]);
    process.chdir(originalWorkingDirectory);
    replaceProcessEnvironment(originalEnvironment);
    const processResult = await tracker.stopAndCleanup();
    trackerStopped = true;
    const candidates = [opencodeReport, claudeReport];
    for (const candidate of candidates) {
      candidate.residualProcessCount = processResult.residualPids.length;
      candidate.events = resequence([
        ...candidate.events,
        bridgeEvent(
          candidate.candidate,
          "driver.exited",
          `Candidate process tree exited with ${processResult.residualPids.length} residual processes.`,
        ),
      ]);
    }
    report = {
      layer: "B-simulated",
      realProviderRequests: 0,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      candidates,
      git,
      handoff,
      temporaryRootRemoved: false,
      finalResidualProcessCount: processResult.residualPids.length,
      passed:
        candidates.every((candidate) => candidate.passed) &&
        processResult.residualPids.length === 0,
    };
  } finally {
    process.chdir(originalWorkingDirectory);
    replaceProcessEnvironment(originalEnvironment);
    if (trackerStarted && !trackerStopped) await tracker.stopAndCleanup().catch(() => undefined);
    await cleanupOwnedRoot(root);
    if (report !== undefined) {
      report.temporaryRootRemoved = !(await pathExists(root));
      report.passed &&= report.temporaryRootRemoved;
      await mkdir(dirname(B_LAYER_REPORT_PATH), { recursive: true });
      await writeFile(
        join(dirname(B_LAYER_REPORT_PATH), OWNERSHIP_MARKER),
        "agent-bridge-driver-selection-b-layer\n",
        "utf8",
      );
      await writeFile(B_LAYER_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
  }
  if (report === undefined) throw new Error("B_LAYER_REPORT_NOT_CREATED");
  return report;
}

export async function readBLayerReport(): Promise<BLayerReport> {
  return JSON.parse(await readFile(B_LAYER_REPORT_PATH, "utf8")) as BLayerReport;
}

function gatewayPolicy(
  candidate: "opencode" | "claude-agent",
  protocol: "openai" | "anthropic",
  scenario: GatewayPolicy["scenario"],
): GatewayPolicy {
  return {
    candidate,
    protocol,
    scenario,
    syntheticToken: `synthetic-${randomBytes(24).toString("hex")}`,
    allowedPaths: protocol === "openai" ? ["/v1/chat/completions"] : ["/anthropic/v1/messages"],
    allowedModel: "deepseek-v4-pro",
    logicalUpstreamOrigin: "https://api.deepseek.com",
    limits: defaultGatewayLimits(),
  };
}

async function runScenarioWithGateway(
  policy: GatewayPolicy,
  run: (gatewayUrl: string, token: string) => Promise<BLayerScenarioResult>,
  audits: GatewayAudit[],
): Promise<BLayerScenarioResult> {
  const gateway = await startProviderGateway(policy);
  try {
    return await run(gateway.url, policy.syntheticToken);
  } finally {
    audits.push(gateway.audit());
    await gateway.close();
  }
}

function buildCandidateReport(
  candidate: "opencode" | "claude-agent",
  runs: BLayerScenarioResult[],
  audits: GatewayAudit[],
  extraProbes: ReturnType<typeof probe>[],
  extraEvents: BLayerEvent[] = [],
): BLayerCandidateReport {
  const gatewayEvents = [
    bridgeEvent(
      candidate,
      "provider.request",
      `Observed ${audits.reduce((sum, audit) => sum + audit.requests, 0)} local mock Provider requests.`,
    ),
    bridgeEvent(
      candidate,
      "provider.usage",
      `Recorded simulated token and cost counters; real Provider requests remained zero.`,
    ),
  ];
  const events = resequence([
    ...runs.flatMap((run) => run.events),
    ...gatewayEvents,
    ...extraEvents,
  ]);
  const scenarios = new Map(runs.map((run) => [run.scenario, run]));
  const scenarioProbes = [
    probe(
      "session-and-structured-events",
      runs.some((run) => run.sessionId !== undefined) && events.length > 0 ? "passed" : "failed",
      `sessions=${runs.filter((run) => run.sessionId !== undefined).length}; events=${events.length}`,
    ),
    probe(
      "permission-allow-deny-wait",
      hasEvents(events, ["permission.waiting", "permission.allowed", "permission.denied"])
        ? "passed"
        : "failed",
      "Required waiting, allow, and deny events must all be present.",
    ),
    probe(
      "execution-cancel",
      scenarios.get("cancel")?.cancelled === true ? "passed" : "failed",
      `cancelled=${String(scenarios.get("cancel")?.cancelled === true)}`,
    ),
    probe(
      "process-exit-session-recovery",
      scenarios.get("resume")?.completed === true ? "passed" : "failed",
      `resumed=${String(scenarios.get("resume")?.completed === true)}`,
    ),
    probe(
      "provider-policy-and-usage",
      audits.every(
        (audit) =>
          audit.realProviderRequests === 0 &&
          audit.rejectedRequests === 0 &&
          audit.models.every((model) => model === "deepseek-v4-pro"),
      )
        ? "passed"
        : "failed",
      `configured=${candidate === "claude-agent" ? "deepseek-v4-pro[1m]" : "deepseek-v4-pro"}; wire=deepseek-v4-pro; mock requests=${audits.reduce((sum, audit) => sum + audit.requests, 0)}; control probes=${audits.reduce((sum, audit) => sum + audit.controlRequests, 0)}; rejected=${audits.reduce((sum, audit) => sum + audit.rejectedRequests, 0)}; rejectedModels=${audits.flatMap((audit) => audit.rejectedModels).join(",") || "none"}; rejectedPaths=${audits.flatMap((audit) => audit.rejectedPaths).join(",") || "none"}; rejectedMethods=${audits.flatMap((audit) => audit.rejectedMethods).join(",") || "none"}; reasons=${audits.flatMap((audit) => audit.rejectionReasons).join(",") || "none"}; real requests=0`,
    ),
  ];
  const probes = [...scenarioProbes, ...extraProbes];
  return {
    candidate,
    layer: "B-simulated",
    packageVersion: runs[0]?.packageVersion ?? "unknown",
    runtimeVersion: runs[0]?.runtimeVersion,
    sessionIds: [
      ...new Set(runs.flatMap((run) => (run.sessionId === undefined ? [] : [run.sessionId]))),
    ],
    events,
    provider: mergeUsage(audits),
    probes,
    residualProcessCount: 0,
    passed:
      probes.every((item) => item.status !== "failed") &&
      runs.every((run) => run.error === undefined),
  };
}

function mergeUsage(audits: GatewayAudit[]): ProviderUsage {
  return audits.reduce<ProviderUsage>(
    (usage, audit) => ({
      requests: usage.requests + audit.requests,
      inputTokens: usage.inputTokens + audit.inputTokens,
      outputTokens: usage.outputTokens + audit.outputTokens,
      simulatedCostMicros: usage.simulatedCostMicros + audit.simulatedCostMicros,
      circuitOpen: usage.circuitOpen || audit.circuitOpen,
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, simulatedCostMicros: 0, circuitOpen: false },
  );
}

function resequence(events: BLayerEvent[]): BLayerEvent[] {
  return events.map((event, index) => ({ ...event, sequence: index + 1 }));
}

function hasEvents(events: BLayerEvent[], required: BLayerEvent["type"][]): boolean {
  const types = new Set(events.map((event) => event.type));
  return required.every((type) => types.has(type));
}

function bridgeEvent(
  candidate: BLayerEvent["candidate"],
  type: BLayerEvent["type"],
  detail: string,
): BLayerEvent {
  return { sequence: 0, candidate, type, detail };
}

async function resolveClaudeExecutable(): Promise<string> {
  const sdkEntry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const scopeDirectory = dirname(dirname(sdkEntry));
  const platform = process.platform;
  const architecture = process.arch;
  return realpath(join(scopeDirectory, `claude-agent-sdk-${platform}-${architecture}`, "claude"));
}
