import { realpathSync } from "node:fs";
import { access, chmod, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

export async function assertLoopbackSandboxAvailable(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("B_LAYER_NETWORK_SANDBOX_UNSUPPORTED");
  }
  await access("/usr/bin/sandbox-exec");
}

export function buildLoopbackSandboxProfile(
  writableRoots: string | string[],
  deniedReadRoots: string[] = [],
): string {
  const roots = (Array.isArray(writableRoots) ? writableRoots : [writableRoots]).map(
    canonicalSandboxPath,
  );
  const deniedRoots = deniedReadRoots.map(canonicalSandboxPath);
  return [
    "(version 1)",
    "(allow default)",
    '(deny network-inbound (require-not (local ip "localhost:*")))',
    '(deny network-outbound (require-not (remote ip "localhost:*")))',
    `(deny file-write* (require-not (regex #"^(${[...roots, "/dev/null"]
      .map(escapeRegex)
      .join("|")})(/|$)")))`,
    ...deniedRoots.map((root) => `(deny file-read* (subpath "${escapeSandboxString(root)}"))`),
    ...roots.map((root) => `; isolated-root ${escapeSandboxString(root)}`),
  ].join("\n");
}

export function sensitiveAgentConfigurationPaths(
  environment: Record<string, string | undefined>,
): string[] {
  const home = environment.HOME;
  const paths = [
    environment.CODEX_HOME,
    environment.CLAUDE_CONFIG_DIR,
    environment.OPENCODE_CONFIG,
    environment.OPENCODE_CONFIG_DIR,
    home === undefined ? undefined : join(home, ".codex"),
    home === undefined ? undefined : join(home, ".claude"),
    home === undefined ? undefined : join(home, ".config", "opencode"),
    home === undefined ? undefined : join(home, ".local", "share", "opencode"),
    environment.XDG_CONFIG_HOME === undefined
      ? undefined
      : join(environment.XDG_CONFIG_HOME, "opencode"),
    environment.XDG_DATA_HOME === undefined
      ? undefined
      : join(environment.XDG_DATA_HOME, "opencode"),
  ];
  return [...new Set(paths.filter((path): path is string => path !== undefined && path !== ""))];
}

export async function installOpenCodeSandboxWrapper(input: {
  binDirectory: string;
  realExecutable: string;
  profilePath: string;
  originalPath: string;
}): Promise<string> {
  const wrapper = join(input.binDirectory, "opencode");
  const script = [
    "#!/bin/sh",
    `exec /usr/bin/sandbox-exec -f ${shellQuote(input.profilePath)} ${shellQuote(input.realExecutable)} "$@"`,
    "",
  ].join("\n");
  await writeFile(wrapper, script, { encoding: "utf8", mode: 0o700 });
  await chmod(wrapper, 0o700);
  return `${input.binDirectory}${delimiter}${input.originalPath}`;
}

export async function installClaudeSandboxWrapper(input: {
  binDirectory: string;
  realExecutable: string;
  profilePath: string;
}): Promise<string> {
  const wrapper = join(input.binDirectory, "claude-sandboxed");
  const script = [
    "#!/bin/sh",
    `exec /usr/bin/sandbox-exec -f ${shellQuote(input.profilePath)} ${shellQuote(input.realExecutable)} "$@"`,
    "",
  ].join("\n");
  await writeFile(wrapper, script, { encoding: "utf8", mode: 0o700 });
  await chmod(wrapper, 0o700);
  return wrapper;
}

function escapeSandboxString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeRegex(value: string): string {
  return escapeSandboxString(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

function canonicalSandboxPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
