import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IsolationEnvironment {
  root: string;
  home: string;
  workDirectory: string;
  configDirectory: string;
  dataDirectory: string;
  cacheDirectory: string;
  codexHome: string;
  claudeConfigDirectory: string;
  tempDirectory: string;
  binDirectory: string;
  environment: Record<string, string>;
  privatePaths: string[];
  cleanup(): Promise<void>;
}

export interface IsolationOptions {
  root?: string;
  workDirectory?: string;
}

const OPENCODE_CONFIG = {
  autoupdate: false,
  share: "disabled",
  snapshot: false,
  plugin: [],
  mcp: {},
  formatter: false,
  lsp: false,
  permission: {
    edit: "deny",
    bash: "deny",
    webfetch: "deny",
    doom_loop: "deny",
    external_directory: "deny",
  },
};

const ISOLATION_TEMP_ROOT = tmpdir();

export async function createIsolationEnvironment(
  label: string,
  options: IsolationOptions = {},
): Promise<IsolationEnvironment> {
  const root = options.root ?? (await mkdtemp(join(ISOLATION_TEMP_ROOT, `agent-bridge-${label}-`)));
  const home = join(root, "home");
  const workDirectory = options.workDirectory ?? join(root, "workspace");
  const configDirectory = join(root, "config");
  const dataDirectory = join(root, "data");
  const cacheDirectory = join(root, "cache");
  const codexHome = join(root, "codex-home");
  const claudeConfigDirectory = join(root, "claude-config");
  const openCodeConfigDirectory = join(configDirectory, "opencode");
  const tempDirectory = join(root, "tmp");
  const binDirectory = join(root, "bin");
  const openCodeConfigPath = join(openCodeConfigDirectory, "opencode.json");

  await Promise.all(
    [
      home,
      workDirectory,
      configDirectory,
      dataDirectory,
      cacheDirectory,
      codexHome,
      claudeConfigDirectory,
      openCodeConfigDirectory,
      tempDirectory,
      binDirectory,
    ].map((directory) => mkdir(directory, { recursive: true })),
  );
  await writeFile(openCodeConfigPath, `${JSON.stringify(OPENCODE_CONFIG, null, 2)}\n`, "utf8");

  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    TMPDIR: tempDirectory,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    XDG_CONFIG_HOME: configDirectory,
    XDG_DATA_HOME: dataDirectory,
    XDG_CACHE_HOME: cacheDirectory,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeConfigDirectory,
    CLAUDE_CODE_TMPDIR: tempDirectory,
    OPENCODE_CONFIG: openCodeConfigPath,
    OPENCODE_CONFIG_DIR: openCodeConfigDirectory,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(OPENCODE_CONFIG),
  };

  return {
    root,
    home,
    workDirectory,
    configDirectory,
    dataDirectory,
    cacheDirectory,
    codexHome,
    claudeConfigDirectory,
    tempDirectory,
    binDirectory,
    environment,
    privatePaths: [root, home, workDirectory, configDirectory, dataDirectory, cacheDirectory],
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function replaceProcessEnvironment(environment: Record<string, string>): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, environment);
}
