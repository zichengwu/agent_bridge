import { access, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const OWNERSHIP_MARKER = ".agent-bridge-b-layer-owned";

export async function cleanupOwnedRoot(root: string): Promise<void> {
  const marker = join(root, OWNERSHIP_MARKER);
  const contents = await readFile(marker, "utf8").catch(() => "");
  if (contents.trim() !== "agent-bridge-driver-selection-b-layer") {
    throw new Error("B_LAYER_CLEANUP_OWNERSHIP_MISSING");
  }
  await rm(root, { recursive: true, force: true });
}

export async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export async function cleanupBLayerArtifacts(reportPath: string): Promise<{
  removedTemporaryRoots: number;
  reportDirectoryRemoved: boolean;
}> {
  let removedTemporaryRoots = 0;
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("agent-bridge-b-layer-")) continue;
    const root = join(tmpdir(), entry.name);
    try {
      await cleanupOwnedRoot(root);
      removedTemporaryRoots += 1;
    } catch {
      // Never remove a directory without the exact ownership marker.
    }
  }

  const reportDirectory = dirname(reportPath);
  let reportDirectoryRemoved = false;
  if (await pathExists(reportDirectory)) {
    try {
      await cleanupOwnedRoot(reportDirectory);
      reportDirectoryRemoved = true;
    } catch {
      reportDirectoryRemoved = false;
    }
  }
  return { removedTemporaryRoots, reportDirectoryRemoved };
}
