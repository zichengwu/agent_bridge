export type CandidateId = "opencode" | "claude-agent" | "codex";

export type ProbeStatus = "passed" | "failed" | "b-layer-required";

export interface ProbeResult {
  id: string;
  status: ProbeStatus;
  evidence: string;
}

export interface CandidateReport {
  candidate: CandidateId;
  layer: "A";
  packageName: string;
  packageVersion: string;
  runtimeVersion?: string;
  probes: ProbeResult[];
  residualProcessCount: number;
  passed: boolean;
}

export type CandidateProbeReport = Omit<CandidateReport, "passed" | "residualProcessCount">;

export interface RepeatabilityReport {
  candidate: CandidateId;
  stable: boolean;
  first: string;
  second: string;
}

export interface SpikeReport {
  layer: "A";
  nodeVersion: string;
  platform: string;
  architecture: string;
  candidates: CandidateReport[];
}

export type BLayerCandidateId = Exclude<CandidateId, "codex">;

export type BLayerEventType =
  | "session.created"
  | "session.resumed"
  | "run.started"
  | "assistant.output"
  | "tool.requested"
  | "tool.result"
  | "permission.waiting"
  | "permission.allowed"
  | "permission.denied"
  | "cancel.requested"
  | "run.cancelled"
  | "run.completed"
  | "run.failed"
  | "driver.exited"
  | "git.changed"
  | "verification.completed"
  | "handoff.created"
  | "handoff.received"
  | "provider.request"
  | "provider.usage"
  | "provider.circuit-open";

export interface BLayerEvent {
  sequence: number;
  type: BLayerEventType;
  candidate: BLayerCandidateId;
  sessionId?: string;
  toolCallId?: string;
  detail: string;
}

export interface ProviderUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  simulatedCostMicros: number;
  circuitOpen: boolean;
}

export interface GitEvidence {
  baselineCommit: string;
  baselineSha256: string;
  changedFiles: string[];
  patchSha256: string;
  verificationExitCode: number;
}

export interface HandoffEvidence {
  sourceCandidate: BLayerCandidateId;
  targetCandidate: BLayerCandidateId;
  patchSha256: string;
  changedFiles: string[];
  verificationExitCode: number;
  contentHash: string;
}

export interface BLayerCandidateReport {
  candidate: BLayerCandidateId;
  layer: "B-simulated";
  packageVersion: string;
  runtimeVersion?: string;
  sessionIds: string[];
  events: BLayerEvent[];
  provider: ProviderUsage;
  probes: ProbeResult[];
  residualProcessCount: number;
  passed: boolean;
}

export interface BLayerScenarioResult {
  candidate: BLayerCandidateId;
  scenario: "write" | "review" | "deny" | "cancel" | "resume";
  packageVersion: string;
  runtimeVersion?: string;
  sessionId?: string;
  events: BLayerEvent[];
  completed: boolean;
  cancelled: boolean;
  error?: string;
}

export interface BLayerReport {
  layer: "B-simulated";
  realProviderRequests: 0;
  nodeVersion: string;
  platform: string;
  architecture: string;
  candidates: BLayerCandidateReport[];
  git: GitEvidence;
  handoff: HandoffEvidence;
  temporaryRootRemoved: boolean;
  finalResidualProcessCount: number;
  passed: boolean;
}

export interface RealProviderUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicrosUsd: number;
  rejectedRequests: number;
  realProviderRequests: number;
  circuitOpen: boolean;
  models: string[];
  paths: string[];
  statusCodes: number[];
  requestIds: string[];
  terminalReasons: string[];
  errorClasses: string[];
}

export interface RealBLayerCandidateReport extends Omit<
  BLayerCandidateReport,
  "layer" | "provider"
> {
  layer: "B-real";
  provider: RealProviderUsage;
}

export interface RealBLayerReport {
  layer: "B-real";
  command: "opencode:b" | "claude:b" | "b:collaboration";
  realProviderRequests: number;
  priceSnapshot: {
    source: string;
    checkedAt: string;
    currency: "USD";
    cacheHitInputUsdPerMillion: number;
    cacheMissInputUsdPerMillion: number;
    outputUsdPerMillion: number;
  };
  candidates: RealBLayerCandidateReport[];
  git?: GitEvidence;
  handoff?: HandoffEvidence;
  temporaryRootRemoved: boolean;
  finalResidualProcessCount: number;
  passed: boolean;
}
