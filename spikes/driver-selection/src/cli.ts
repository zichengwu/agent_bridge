import type { CandidateId, CandidateReport, RepeatabilityReport, SpikeReport } from "./contract.js";
import { normalizeReport } from "./harness/result.js";
import { runCandidate } from "./harness/runner.js";
import {
  B_LAYER_REPORT_PATH,
  readBLayerReport,
  runBLayerCheck,
  runBLayerPreflight,
} from "./harness/b-layer-runner.js";
import {
  clearAuthorization,
  requestRealProviderAuthorization,
  type RealBLayerCommand,
} from "./harness/authorization.js";
import { cleanupBLayerArtifacts } from "./harness/cleanup.js";
import { DescendantProcessTracker } from "./harness/process-tracker.js";
import { VERIFIED_PRICE_SNAPSHOT } from "./harness/provider-policy.js";
import { readRealBLayerReport, runRealBLayer } from "./harness/real-b-layer-runner.js";

const ALL_CANDIDATES: CandidateId[] = ["opencode", "claude-agent", "codex"];

async function main(): Promise<void> {
  const command = process.argv[2] ?? "check";

  switch (command) {
    case "opencode":
      printCandidate(await runCandidate("opencode"));
      return;
    case "claude":
      printCandidate(await runCandidate("claude-agent"));
      return;
    case "codex":
      printCandidate(await runCandidate("codex"));
      return;
    case "repeat":
      await runRepeatability();
      return;
    case "check":
    case "report":
      await runAll();
      return;
    case "b:preflight":
      process.stdout.write(`${JSON.stringify(await runBLayerPreflight(), null, 2)}\n`);
      return;
    case "b:check": {
      const report = await runBLayerCheck();
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.passed) process.exitCode = 1;
      return;
    }
    case "b:report": {
      const report = await readRealBLayerReport().catch(() => readBLayerReport());
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.passed) process.exitCode = 1;
      return;
    }
    case "b:cleanup": {
      const tracker = new DescendantProcessTracker();
      await tracker.start();
      const cleanup = await cleanupBLayerArtifacts(B_LAYER_REPORT_PATH);
      const processes = await tracker.stopAndCleanup();
      const result = { ...cleanup, finalResidualProcessCount: processes.residualPids.length };
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (processes.residualPids.length !== 0) process.exitCode = 1;
      return;
    }
    case "opencode:b":
    case "claude:b":
    case "b:collaboration":
      await runRealProviderCommand(command);
      return;
    default:
      throw new Error(`Unknown driver-selection command: ${command}`);
  }
}

async function runRealProviderCommand(command: RealBLayerCommand): Promise<void> {
  const authorization = await requestRealProviderAuthorization(command, VERIFIED_PRICE_SNAPSHOT);
  try {
    const report = await runRealBLayer(command, authorization);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
  } finally {
    clearAuthorization(authorization);
  }
}

async function runAll(): Promise<void> {
  const candidates: CandidateReport[] = [];
  for (const candidate of ALL_CANDIDATES) {
    candidates.push(await runCandidate(candidate));
  }

  const report: SpikeReport = {
    layer: "A",
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    candidates,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (candidates.some((candidate) => !candidate.passed)) {
    process.exitCode = 1;
  }
}

async function runRepeatability(): Promise<void> {
  const reports: RepeatabilityReport[] = [];
  let candidatesPassed = true;
  for (const candidate of ALL_CANDIDATES) {
    const first = await runCandidate(candidate);
    const second = await runCandidate(candidate);
    const firstNormalized = normalizeReport(first);
    const secondNormalized = normalizeReport(second);
    reports.push({
      candidate,
      stable: firstNormalized === secondNormalized,
      first: firstNormalized,
      second: secondNormalized,
    });
    candidatesPassed &&= first.passed && second.passed;
  }

  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  if (!candidatesPassed || reports.some((report) => !report.stable)) {
    process.exitCode = 1;
  }
}

function printCandidate(report: CandidateReport): void {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) {
    process.exitCode = 1;
  }
}

await main();
