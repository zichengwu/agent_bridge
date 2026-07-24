import type { Options } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeAgentIsolationConfiguration {
  readonly homeDirectory: string;
  readonly tempDirectory: string;
  readonly configDirectory: string;
  readonly dataDirectory: string;
  readonly cacheDirectory: string;
  readonly claudeConfigDirectory: string;
  readonly path?: string;
  readonly lang?: string;
}

export interface ClaudeAgentProviderConfiguration {
  readonly baseUrl?: string;
  readonly authToken?: string;
  readonly apiKey?: string;
  readonly model?: string;
}

export interface ClaudeAgentSecurityConfiguration {
  readonly tools?: readonly string[];
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
}

export const CLAUDE_AGENT_DISALLOWED_TOOLS = ["WebFetch", "WebSearch", "Agent", "Task"] as const;

export function buildClaudeAgentEnvironment(input: {
  readonly isolation: ClaudeAgentIsolationConfiguration;
  readonly provider?: ClaudeAgentProviderConfiguration;
}): Record<string, string> {
  const { isolation, provider } = input;
  const environment: Record<string, string> = {
    PATH: isolation.path ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: isolation.homeDirectory,
    TMPDIR: isolation.tempDirectory,
    LANG: isolation.lang ?? "C.UTF-8",
    LC_ALL: isolation.lang ?? "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    XDG_CONFIG_HOME: isolation.configDirectory,
    XDG_DATA_HOME: isolation.dataDirectory,
    XDG_CACHE_HOME: isolation.cacheDirectory,
    CLAUDE_CONFIG_DIR: isolation.claudeConfigDirectory,
    CLAUDE_CODE_TMPDIR: isolation.tempDirectory,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
    DISABLE_TELEMETRY: "1",
  };

  if (provider?.baseUrl !== undefined) {
    environment.ANTHROPIC_BASE_URL = provider.baseUrl;
  }
  if (provider?.authToken !== undefined) {
    environment.ANTHROPIC_AUTH_TOKEN = provider.authToken;
  }
  if (provider?.apiKey !== undefined) {
    environment.ANTHROPIC_API_KEY = provider.apiKey;
  }
  if (provider?.model !== undefined) {
    environment.ANTHROPIC_MODEL = provider.model;
    environment.ANTHROPIC_DEFAULT_OPUS_MODEL = provider.model;
    environment.ANTHROPIC_DEFAULT_SONNET_MODEL = provider.model;
    environment.ANTHROPIC_DEFAULT_HAIKU_MODEL = provider.model;
    environment.CLAUDE_CODE_SUBAGENT_MODEL = provider.model;
  }

  return environment;
}

export function buildClaudeAgentQueryOptions(input: {
  readonly environment: Record<string, string>;
  readonly workDirectory: string;
  readonly security?: ClaudeAgentSecurityConfiguration;
  readonly pathToClaudeCodeExecutable?: string;
  readonly resumeSessionId?: string;
  readonly forkSession?: boolean;
  readonly abortController: AbortController;
  readonly canUseTool: NonNullable<Options["canUseTool"]>;
}): Options {
  return {
    abortController: input.abortController,
    cwd: input.workDirectory,
    env: input.environment,
    maxTurns: input.security?.maxTurns ?? 8,
    maxBudgetUsd: input.security?.maxBudgetUsd,
    model: input.environment.ANTHROPIC_MODEL,
    tools: [...(input.security?.tools ?? [])],
    allowedTools: [],
    disallowedTools: [...CLAUDE_AGENT_DISALLOWED_TOOLS],
    agents: {},
    mcpServers: {},
    plugins: [],
    skills: [],
    settingSources: [],
    permissionMode: "default",
    includePartialMessages: false,
    includeHookEvents: false,
    forwardSubagentText: false,
    promptSuggestions: false,
    agentProgressSummaries: false,
    persistSession: true,
    resume: input.resumeSessionId,
    forkSession: input.forkSession,
    pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
    canUseTool: input.canUseTool,
  };
}
