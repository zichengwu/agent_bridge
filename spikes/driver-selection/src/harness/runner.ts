import type { CandidateId, CandidateProbeReport, CandidateReport } from "../contract.js";
import { createIsolationEnvironment, replaceProcessEnvironment } from "./environment.js";
import { DescendantProcessTracker } from "./process-tracker.js";
import { finalizeReport, probe } from "./result.js";
import { redactText, safeError } from "./redaction.js";

export async function runCandidate(candidate: CandidateId): Promise<CandidateReport> {
  const originalWorkingDirectory = process.cwd();
  const originalEnvironment = { ...process.env } as Record<string, string>;
  const isolation = await createIsolationEnvironment(candidate);
  replaceProcessEnvironment(isolation.environment);
  process.chdir(isolation.workDirectory);

  const tracker = new DescendantProcessTracker();
  await tracker.start();
  let candidateReport: CandidateProbeReport;

  try {
    candidateReport = await loadAndRunCandidate(candidate, isolation);
  } catch (error) {
    candidateReport = {
      candidate,
      layer: "A",
      packageName: packageNameFor(candidate),
      packageVersion: "unknown",
      probes: [probe("candidate-runtime", "failed", safeError(error, isolation.privatePaths))],
    };
  } finally {
    process.chdir(originalWorkingDirectory);
  }

  const processResult = await tracker.stopAndCleanup();
  await isolation.cleanup();
  replaceProcessEnvironment(originalEnvironment);
  const probes = [...candidateReport.probes];
  probes.push(
    probe(
      "process-cleanup",
      processResult.residualPids.length === 0 ? "passed" : "failed",
      processResult.residualPids.length === 0
        ? `Observed ${processResult.observedPids.length} descendant processes; none remained.`
        : `Forced cleanup of ${processResult.residualPids.length} residual processes: ${redactText(
            processResult.residualCommands.join(" | "),
            isolation.privatePaths,
          )}`,
    ),
  );

  return finalizeReport({
    ...candidateReport,
    probes,
    residualProcessCount: processResult.residualPids.length,
  });
}

async function loadAndRunCandidate(
  candidate: CandidateId,
  isolation: Awaited<ReturnType<typeof createIsolationEnvironment>>,
): Promise<CandidateProbeReport> {
  switch (candidate) {
    case "opencode": {
      const { probeOpenCode } = await import("../candidates/opencode.js");
      return probeOpenCode(isolation);
    }
    case "claude-agent": {
      const { probeClaudeAgent } = await import("../candidates/claude-agent.js");
      return probeClaudeAgent(isolation);
    }
    case "codex": {
      const { probeCodex } = await import("../candidates/codex.js");
      return probeCodex(isolation);
    }
  }
}

function packageNameFor(candidate: CandidateId): string {
  switch (candidate) {
    case "opencode":
      return "@opencode-ai/sdk";
    case "claude-agent":
      return "@anthropic-ai/claude-agent-sdk";
    case "codex":
      return "@openai/codex-sdk";
  }
}
