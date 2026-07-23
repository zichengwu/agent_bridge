import { createHash } from "node:crypto";

import type { GitEvidence, HandoffEvidence } from "../contract.js";

export function createHandoffEvidence(git: GitEvidence): HandoffEvidence {
  const body = {
    sourceCandidate: "opencode" as const,
    targetCandidate: "claude-agent" as const,
    patchSha256: git.patchSha256,
    changedFiles: git.changedFiles,
    verificationExitCode: git.verificationExitCode,
  };
  return {
    ...body,
    contentHash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
}
