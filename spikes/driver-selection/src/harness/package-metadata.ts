import { dirname, join, parse } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface PackageMetadata {
  name: string;
  version: string;
  [key: string]: unknown;
}

export async function readPackageMetadata(packageName: string): Promise<PackageMetadata> {
  let directory = dirname(fileURLToPath(import.meta.resolve(packageName)));
  const root = parse(directory).root;

  while (directory !== root) {
    const candidate = join(directory, "package.json");
    const metadata = await readMetadata(candidate);
    if (metadata?.name === packageName && typeof metadata.version === "string") {
      return metadata as PackageMetadata;
    }
    directory = dirname(directory);
  }

  throw new Error(`Unable to locate package metadata for ${packageName}`);
}

async function readMetadata(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
