import type { Config } from "@opencode-ai/sdk";
import type { JsonObject } from "@agent-bridge/driver-protocol";

export interface OpenCodeProviderConfiguration {
  readonly enabledProviders?: readonly string[];
  readonly model?: string;
  readonly smallModel?: string;
  readonly providers?: JsonObject;
  readonly permissions?: {
    readonly edit?: "ask" | "allow" | "deny";
    readonly bash?: "ask" | "allow" | "deny" | Readonly<Record<string, "ask" | "allow" | "deny">>;
    readonly webfetch?: "ask" | "allow" | "deny";
    readonly doomLoop?: "ask" | "allow" | "deny";
    readonly externalDirectory?: "ask" | "allow" | "deny";
  };
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
      edit: provider.permissions?.edit ?? "deny",
      bash: provider.permissions?.bash ?? "deny",
      webfetch: provider.permissions?.webfetch ?? "deny",
      doom_loop: provider.permissions?.doomLoop ?? "deny",
      external_directory: provider.permissions?.externalDirectory ?? "deny",
    },
  };
}
