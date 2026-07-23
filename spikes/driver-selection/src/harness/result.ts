import type { CandidateReport, ProbeResult } from "../contract.js";

export function probe(id: string, status: ProbeResult["status"], evidence: string): ProbeResult {
  return { id, status, evidence };
}

export function finalizeReport(report: Omit<CandidateReport, "passed">): CandidateReport {
  return {
    ...report,
    passed:
      report.probes.every((item) => item.status !== "failed") && report.residualProcessCount === 0,
  };
}

export function normalizeReport(report: CandidateReport): string {
  return JSON.stringify({
    candidate: report.candidate,
    layer: report.layer,
    packageName: report.packageName,
    packageVersion: report.packageVersion,
    runtimeVersion: report.runtimeVersion,
    probes: report.probes.map(({ id, status }) => ({ id, status })),
    residualProcessCount: report.residualProcessCount,
    passed: report.passed,
  });
}
