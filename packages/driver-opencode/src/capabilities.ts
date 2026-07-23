import {
  DRIVER_PROTOCOL_VERSION,
  assertAgentCapabilities,
  type AgentCapabilities,
} from "@agent-bridge/driver-protocol";

export const OPENCODE_DRIVER_ID = "opencode";
export const OPENCODE_DRIVER_VERSION = "1.18.3";

const capabilities: AgentCapabilities = {
  protocolVersion: DRIVER_PROTOCOL_VERSION,
  driver: {
    id: OPENCODE_DRIVER_ID,
    displayName: "OpenCode",
    driverVersion: OPENCODE_DRIVER_VERSION,
  },
  sessions: {
    persistentIds: true,
    resume: true,
    successorSessions: true,
  },
  events: {
    streaming: true,
    strictOrdering: true,
  },
  permissions: {
    mode: "interactive",
    decisions: ["allow", "deny"],
  },
  cancellation: {
    supported: true,
    terminalEvent: true,
  },
  contextUsage: {
    mode: "exact",
  },
};

assertAgentCapabilities(capabilities);

export function openCodeCapabilities(): AgentCapabilities {
  return structuredClone(capabilities);
}
