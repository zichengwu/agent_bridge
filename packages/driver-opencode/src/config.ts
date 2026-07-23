import type { Config } from "@opencode-ai/sdk";
import type { JsonObject } from "@agent-bridge/driver-protocol";

export interface OpenCodeProviderConfiguration {
  readonly enabledProviders?: readonly string[];
  readonly model?: string;
  readonly smallModel?: string;
  readonly providers?: JsonObject;
}

export function buildOpenCodeConfig(provider: OpenCodeProviderConfiguration = {}): Config {
  return {
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    plugin: [],
    mcp: {},
    formatter: false,
    lsp: false,
    enabled_providers: [...(provider.enabledProviders ?? [])],
    model: provider.model,
    small_model: provider.smallModel,
    provider: provider.providers as Config["provider"],
    permission: {
      edit: "deny",
      bash: "deny",
      webfetch: "deny",
      doom_loop: "deny",
      external_directory: "deny",
    },
  };
}
