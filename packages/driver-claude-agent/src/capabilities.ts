import {
  DRIVER_PROTOCOL_VERSION,
  assertAgentCapabilities,
  type AgentCapabilities,
} from "@agent-bridge/driver-protocol";

export const CLAUDE_AGENT_DRIVER_ID = "claude-agent";
export const CLAUDE_AGENT_SDK_VERSION = "0.3.215";
export const CLAUDE_CODE_VERSION = "2.1.215";

const capabilities: AgentCapabilities = {
  protocolVersion: DRIVER_PROTOCOL_VERSION,
  driver: {
    id: CLAUDE_AGENT_DRIVER_ID,
    displayName: "Claude Agent SDK",
    driverVersion: CLAUDE_AGENT_SDK_VERSION,
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
    mode: "estimated",
  },
};

assertAgentCapabilities(capabilities);

export function claudeAgentCapabilities(): AgentCapabilities {
  return structuredClone(capabilities);
}
