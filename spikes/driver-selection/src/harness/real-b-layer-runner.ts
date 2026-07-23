import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runClaudeBScenario } from "../candidates/claude-agent.js";
import { runOpenCodeBScenario } from "../candidates/opencode.js";
import type {
  BLayerEvent,
  BLayerScenarioResult,
  GitEvidence,
  HandoffEvidence,
  RealBLayerCandidateReport,
  RealBLayerReport,
  RealProviderUsage,
} from "../contract.js";
import type { RealBLayerCommand, RealProviderAuthorization } from "./authorization.js";
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
  buildLoopbackSandboxProfile,
  installClaudeSandboxWrapper,
  installOpenCodeSandboxWrapper,
  sensitiveAgentConfigurationPaths,
} from "./network-sandbox.js";
import { DescendantProcessTracker } from "./process-tracker.js";
import { realGatewayPolicy, VERIFIED_PRICE_SNAPSHOT } from "./provider-policy.js";
import { startRealProviderGateway } from "./real-provider-gateway.js";
import { probe } from "./result.js";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPOSITORY_ROOT = dirname(dirname(PACKAGE_ROOT));
export const REAL_B_LAYER_REPORT_PATH = join(
  REPOSITORY_ROOT,
  "tmp",
  "driver-selection-b",
  "real-report.json",
);

export async function runRealBLayer(
  command: RealBLayerCommand,
  authorization: RealProviderAuthorization,
): Promise<RealBLayerReport> {
  const expectedCredentials = command === "b:collaboration" ? 2 : 1;
  const expectedBudgetUsd = command === "b:collaboration" ? 0.24 : 0.12;
  if (authorization.credentials.length !== expectedCredentials) {
    throw new Error("B_LAYER_CREDENTIAL_COUNT_INVALID");
  }
  if (authorization.totalBudgetUsd !== expectedBudgetUsd) {
    throw new Error("B_LAYER_TOTAL_BUDGET_INVALID");
  }
  const originalCwd = process.cwd();
  const originalEnvironment = { ...process.env } as Record<string, string>;
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-b-layer-"));
  await writeFile(join(root, OWNERSHIP_MARKER), "agent-bridge-driver-selection-b-layer\n");
  const tracker = new DescendantProcessTracker();
  let trackerStarted = false;
  let trackerStopped = false;
  let report: RealBLayerReport | undefined;

  try {
    await tracker.start();
    trackerStarted = true;
    const fixture = await createGitFixture(root);
    const opencodeIsolation = await createIsolationEnvironment("opencode-real", {
      root: join(root, "isolation-opencode"),
      workDirectory: fixture.worktrees.opencodeExec,
    });
    const claudeFallbackIsolation = await createIsolationEnvironment("claude-real", {
      root: join(root, "isolation-claude-fallback"),
      workDirectory: fixture.worktrees.claudeFallback,
    });
    const claudeReviewIsolation = await createIsolationEnvironment("claude-review-real", {
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
      ),
      writeFile(
        claudeFallbackProfile,
        buildLoopbackSandboxProfile(
          [claudeFallbackIsolation.root, fixture.worktrees.claudeFallback],
          deniedReadRoots,
        ),
      ),
      writeFile(
        claudeReviewProfile,
        buildLoopbackSandboxProfile(
          [claudeReviewIsolation.root, fixture.worktrees.claudeReview],
          deniedReadRoots,
        ),
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

    const candidates: RealBLayerCandidateReport[] = [];
    let git: GitEvidence | undefined;
    let handoff: HandoffEvidence | undefined;
    const runOpenCode = command !== "claude:b";
    const runClaude = command !== "opencode:b";
    if (runOpenCode) {
      replaceProcessEnvironment(opencodeIsolation.environment);
      process.chdir(fixture.worktrees.opencodeExec);
      const result = await runOpenCodeReal(opencodeIsolation, authorization.credentials[0]!);
      git = await collectGitEvidence(fixture, fixture.worktrees.opencodeExec);
      candidates.push(buildRealCandidate("opencode", result.runs, result.audit, git));
      process.chdir(originalCwd);
      replaceProcessEnvironment(originalEnvironment);
    }

    if (command === "b:collaboration" && git !== undefined) {
      const patch = await exportPatch(fixture, fixture.worktrees.opencodeExec);
      if (patch.trim() !== "") await applyPatch(fixture.worktrees.claudeReview, patch);
      handoff = createHandoffEvidence(git);
    }

    if (runClaude) {
      const credential = authorization.credentials[command === "b:collaboration" ? 1 : 0]!;
      const result = await runClaudeReal({
        fallbackIsolation: claudeFallbackIsolation,
        reviewIsolation: claudeReviewIsolation,
        fallbackWrapper: claudeFallbackWrapper,
        reviewWrapper: claudeReviewWrapper,
        credential,
        includeReview: command === "b:collaboration",
      });
      const fallbackGit = await collectGitEvidence(fixture, fixture.worktrees.claudeFallback);
      const review = await runVerification(fixture.worktrees.claudeReview);
      candidates.push(
        buildRealCandidate(
          "claude-agent",
          result.runs,
          result.audit,
          fallbackGit,
          command === "b:collaboration" ? review.exitCode : undefined,
        ),
      );
      git ??= fallbackGit;
      process.chdir(originalCwd);
      replaceProcessEnvironment(originalEnvironment);
    }

    await Promise.all([
      opencodeIsolation.cleanup(),
      claudeFallbackIsolation.cleanup(),
      claudeReviewIsolation.cleanup(),
    ]);
    const processes = await tracker.stopAndCleanup();
    trackerStopped = true;
    for (const candidate of candidates)
      candidate.residualProcessCount = processes.residualPids.length;
    const totalCostMicros = candidates.reduce(
      (sum, candidate) => sum + candidate.provider.costMicrosUsd,
      0,
    );
    report = {
      layer: "B-real",
      command,
      realProviderRequests: candidates.reduce(
        (sum, candidate) => sum + candidate.provider.realProviderRequests,
        0,
      ),
      priceSnapshot: VERIFIED_PRICE_SNAPSHOT,
      candidates,
      git,
      handoff,
      temporaryRootRemoved: false,
      finalResidualProcessCount: processes.residualPids.length,
      passed:
        candidates.length > 0 &&
        candidates.every((candidate) => candidate.passed) &&
        totalCostMicros <= Math.round(authorization.totalBudgetUsd * 1_000_000) &&
        processes.residualPids.length === 0,
    };
  } finally {
    process.chdir(originalCwd);
    replaceProcessEnvironment(originalEnvironment);
    if (trackerStarted && !trackerStopped) await tracker.stopAndCleanup().catch(() => undefined);
    await cleanupOwnedRoot(root);
    if (report !== undefined) {
      report.temporaryRootRemoved = !(await pathExists(root));
      report.passed &&= report.temporaryRootRemoved;
      await mkdir(dirname(REAL_B_LAYER_REPORT_PATH), { recursive: true });
      await writeFile(
        join(dirname(REAL_B_LAYER_REPORT_PATH), OWNERSHIP_MARKER),
        "agent-bridge-driver-selection-b-layer\n",
      );
      await writeFile(REAL_B_LAYER_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    }
  }
  if (report === undefined) throw new Error("B_LAYER_REAL_REPORT_NOT_CREATED");
  return report;
}

export async function readRealBLayerReport(): Promise<RealBLayerReport> {
  return JSON.parse(await readFile(REAL_B_LAYER_REPORT_PATH, "utf8")) as RealBLayerReport;
}

async function runOpenCodeReal(
  isolation: Awaited<ReturnType<typeof createIsolationEnvironment>>,
  credential: Buffer,
): Promise<{ runs: BLayerScenarioResult[]; audit: RealProviderUsage }> {
  const policy = realGatewayPolicy("opencode", syntheticToken());
  const gateway = await startRealProviderGateway({ policy, credential });
  credential.fill(0);
  const base = {
    isolation,
    gatewayUrl: gateway.url,
    syntheticToken: policy.syntheticToken,
    executionMode: "real" as const,
    scenarioTimeoutMs: 180_000,
  };
  const runs: BLayerScenarioResult[] = [];
  let finalAudit: RealProviderUsage | undefined;
  try {
    const write = await runOpenCodeBScenario({ ...base, scenario: "write" });
    runs.push(write);
    if (write.sessionId !== undefined)
      runs.push(
        await runOpenCodeBScenario({
          ...base,
          scenario: "resume",
          resumeSessionId: write.sessionId,
        }),
      );
    runs.push(await runOpenCodeBScenario({ ...base, scenario: "deny" }));
    runs.push(await runOpenCodeBScenario({ ...base, scenario: "cancel" }));
  } finally {
    finalAudit = await gateway.close();
  }
  if (finalAudit === undefined) throw new Error("B_LAYER_FINAL_PROVIDER_AUDIT_MISSING");
  return { runs, audit: finalAudit };
}

async function runClaudeReal(input: {
  fallbackIsolation: Awaited<ReturnType<typeof createIsolationEnvironment>>;
  reviewIsolation: Awaited<ReturnType<typeof createIsolationEnvironment>>;
  fallbackWrapper: string;
  reviewWrapper: string;
  credential: Buffer;
  includeReview: boolean;
}): Promise<{ runs: BLayerScenarioResult[]; audit: RealProviderUsage }> {
  const policy = realGatewayPolicy("claude-agent", syntheticToken());
  const gateway = await startRealProviderGateway({ policy, credential: input.credential });
  input.credential.fill(0);
  const common = {
    gatewayUrl: gateway.url,
    syntheticToken: policy.syntheticToken,
    executionMode: "real" as const,
    scenarioTimeoutMs: 180_000,
  };
  const runs: BLayerScenarioResult[] = [];
  let finalAudit: RealProviderUsage | undefined;
  try {
    replaceProcessEnvironment(input.fallbackIsolation.environment);
    process.chdir(input.fallbackIsolation.workDirectory);
    const write = await runClaudeBScenario({
      ...common,
      isolation: input.fallbackIsolation,
      pathToClaudeCodeExecutable: input.fallbackWrapper,
      scenario: "write",
    });
    runs.push(write);
    if (write.sessionId !== undefined)
      runs.push(
        await runClaudeBScenario({
          ...common,
          isolation: input.fallbackIsolation,
          pathToClaudeCodeExecutable: input.fallbackWrapper,
          scenario: "resume",
          resumeSessionId: write.sessionId,
        }),
      );
    runs.push(
      await runClaudeBScenario({
        ...common,
        isolation: input.fallbackIsolation,
        pathToClaudeCodeExecutable: input.fallbackWrapper,
        scenario: "deny",
      }),
    );
    if (input.includeReview) {
      replaceProcessEnvironment(input.reviewIsolation.environment);
      process.chdir(input.reviewIsolation.workDirectory);
      runs.push(
        await runClaudeBScenario({
          ...common,
          isolation: input.reviewIsolation,
          pathToClaudeCodeExecutable: input.reviewWrapper,
          scenario: "review",
        }),
      );
    }
    replaceProcessEnvironment(input.fallbackIsolation.environment);
    process.chdir(input.fallbackIsolation.workDirectory);
    runs.push(
      await runClaudeBScenario({
        ...common,
        isolation: input.fallbackIsolation,
        pathToClaudeCodeExecutable: input.fallbackWrapper,
        scenario: "cancel",
      }),
    );
  } finally {
    finalAudit = await gateway.close();
  }
  if (finalAudit === undefined) throw new Error("B_LAYER_FINAL_PROVIDER_AUDIT_MISSING");
  return { runs, audit: finalAudit };
}

function buildRealCandidate(
  candidate: "opencode" | "claude-agent",
  runs: BLayerScenarioResult[],
  provider: RealProviderUsage,
  git: GitEvidence,
  reviewExitCode?: number,
): RealBLayerCandidateReport {
  const events = resequence(runs.flatMap((run) => run.events));
  const eventTypes = new Set(events.map((event) => event.type));
  const scenarios = new Map(runs.map((run) => [run.scenario, run]));
  const probes = [
    probe(
      "session-and-structured-events",
      runs.some((run) => run.sessionId !== undefined) && events.length > 0 ? "passed" : "failed",
      `sessions=${runs.filter((run) => run.sessionId !== undefined).length}; events=${events.length}`,
    ),
    probe(
      "permission-allow-deny-wait",
      ["permission.waiting", "permission.allowed", "permission.denied"].every((type) =>
        eventTypes.has(type as BLayerEvent["type"]),
      )
        ? "passed"
        : "failed",
      "Required waiting, allow and deny events must all be present.",
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
      "real-provider-model",
      provider.models.length > 0 && provider.models.every((model) => model === "deepseek-v4-pro")
        ? "passed"
        : "failed",
      `models=${provider.models.join(",") || "missing"}`,
    ),
    probe(
      "real-provider-usage",
      provider.realProviderRequests > 0 &&
        provider.requests === provider.realProviderRequests &&
        provider.inputTokens > 0 &&
        provider.outputTokens > 0 &&
        provider.costMicrosUsd <= 120_000 &&
        provider.statusCodes.length === provider.realProviderRequests &&
        provider.statusCodes.every((status) => status >= 200 && status < 300) &&
        provider.rejectedRequests === 0 &&
        provider.errorClasses.length === 0 &&
        !provider.circuitOpen
        ? "passed"
        : "failed",
      `requests=${provider.realProviderRequests}; input=${provider.inputTokens}; output=${provider.outputTokens}; costMicrosUsd=${provider.costMicrosUsd}; rejected=${provider.rejectedRequests}; errors=${provider.errorClasses.join(",") || "none"}; circuitOpen=${String(provider.circuitOpen)}`,
    ),
    probe(
      "git-write-and-verification",
      git.changedFiles.includes("src/sum.ts") && git.verificationExitCode === 0
        ? "passed"
        : "failed",
      `changed=${git.changedFiles.join(",")}; verification=${git.verificationExitCode}`,
    ),
  ];
  if (reviewExitCode !== undefined)
    probes.push(
      probe(
        "independent-review",
        reviewExitCode === 0 ? "passed" : "failed",
        `verification=${reviewExitCode}`,
      ),
    );
  return {
    candidate,
    layer: "B-real",
    packageVersion: runs[0]?.packageVersion ?? "unknown",
    runtimeVersion: runs[0]?.runtimeVersion,
    sessionIds: [...new Set(runs.flatMap((run) => (run.sessionId ? [run.sessionId] : [])))],
    events,
    provider,
    probes,
    residualProcessCount: 0,
    passed:
      probes.every((item) => item.status === "passed") &&
      runs.every((run) => run.error === undefined),
  };
}

function resequence(events: BLayerEvent[]): BLayerEvent[] {
  return events.map((event, index) => ({ ...event, sequence: index + 1 }));
}

function syntheticToken(): string {
  return `synthetic-${randomBytes(24).toString("hex")}`;
}

async function resolveClaudeExecutable(): Promise<string> {
  const sdkEntry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  return realpath(
    join(
      dirname(dirname(sdkEntry)),
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      "claude",
    ),
  );
}
