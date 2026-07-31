import { lstat, mkdtemp, readdir, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ArtifactReferenceRepository } from "@agent-bridge/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  LocalArtifactError,
  LocalArtifactRepository,
  previewArtifactCleanup,
} from "../src/index.js";

const roots: string[] = [];
const createdAt = "2026-07-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local Artifact Repository", () => {
  it("atomically writes, hashes, streams, and describes content without exposing a path", async () => {
    const { repository } = await createRepository();
    const stored = await repository.put({
      artifact_id: "artifact-log-1",
      kind: "test_log",
      content: bytes("hello artifact"),
      media_type: "text/plain",
      retention_class: "audit",
      created_at: createdAt,
    });

    expect(stored).toMatchObject({
      outcome: "STORED",
      artifact: {
        artifact_id: "artifact-log-1",
        kind: "test_log",
        size_bytes: 14,
        retention_class: "audit",
      },
    });
    expect(stored.artifact.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(stored.artifact).not.toHaveProperty("path");
    await expect(text(repository.read("artifact-log-1"))).resolves.toBe("hello artifact");
  });

  it("replays identical writes, rejects identifier conflicts, and deduplicates blobs by hash", async () => {
    const { repository, root } = await createRepository();
    const request = {
      artifact_id: "artifact-a",
      kind: "report",
      content: bytes("same content"),
      created_at: createdAt,
    } as const;
    expect((await repository.put(request)).outcome).toBe("STORED");
    expect((await repository.put(request)).outcome).toBe("REPLAYED");
    await expect(repository.put({ ...request, content: bytes("different") })).rejects.toMatchObject(
      { code: "ARTIFACT_CONFLICT" },
    );
    await repository.put({ ...request, artifact_id: "artifact-b" });

    const shards = await readdir(join(root, "objects", "sha256"));
    const blobs = (
      await Promise.all(shards.map((shard) => readdir(join(root, "objects", "sha256", shard))))
    ).flat();
    expect(blobs).toHaveLength(1);
  });

  it("returns stable missing and validation errors for unsafe identifiers", async () => {
    const { repository } = await createRepository();
    await expect(repository.read("artifact-missing")).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
    await expect(
      repository.put({
        artifact_id: "../escape",
        kind: "log",
        content: bytes("secret"),
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_REQUEST_INVALID" });
  });

  it("rejects a symlink root, manifest escape, and blob escape", async () => {
    const outside = await temporaryRoot("agent-bridge-artifact-outside-");
    const linkedRoot = join(outside, "linked-root");
    const target = await temporaryRoot("agent-bridge-artifact-target-");
    await symlink(target, linkedRoot);
    await expect(LocalArtifactRepository.open({ root_path: linkedRoot })).rejects.toMatchObject({
      code: "ARTIFACT_PATH_UNSAFE",
    });

    const { repository, root } = await createRepository();
    const outsideFile = join(outside, "outside.json");
    await writeFile(outsideFile, "{}");
    await symlink(outsideFile, join(root, "manifests", "artifact-link.json"));
    await expect(repository.getMetadata("artifact-link")).rejects.toMatchObject({
      code: "ARTIFACT_PATH_UNSAFE",
    });

    const stored = await repository.put({
      artifact_id: "artifact-blob-link",
      kind: "log",
      content: bytes("content"),
      created_at: createdAt,
    });
    const digest = stored.artifact.content_hash.slice("sha256:".length);
    const blobPath = join(root, "objects", "sha256", digest.slice(0, 2), digest);
    await unlink(blobPath);
    await symlink(outsideFile, blobPath);
    await expect(repository.read("artifact-blob-link")).rejects.toMatchObject({
      code: "ARTIFACT_PATH_UNSAFE",
    });
  });

  it("cleans only expired recognized temporary files and removes failed-write residue", async () => {
    const now = new Date("2026-07-31T00:00:00.000Z");
    const { repository, root } = await createRepository({
      now: () => now,
      temporary_file_max_age_ms: 1_000,
    });
    const old = join(root, "tmp", "old.content.tmp");
    const unrelated = join(root, "tmp", "keep.txt");
    await writeFile(old, "partial");
    await writeFile(unrelated, "keep");
    await utimes(old, new Date(now.getTime() - 2_000), new Date(now.getTime() - 2_000));

    expect(await repository.cleanupTemporaryFiles()).toEqual({ removed_count: 1 });
    expect(await lstat(unrelated)).toBeDefined();

    async function* failingContent(): AsyncIterable<Uint8Array> {
      await Promise.resolve();
      yield bytes("partial");
      throw new Error("write failed");
    }
    await expect(
      repository.put({
        artifact_id: "artifact-failed",
        kind: "log",
        content: failingContent(),
      }),
    ).rejects.toBeInstanceOf(LocalArtifactError);
    expect((await readdir(join(root, "tmp"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("previews only old unreferenced non-pinned Artifacts without deleting them", async () => {
    const { repository } = await createRepository();
    await repository.put({
      artifact_id: "artifact-orphan",
      kind: "log",
      content: bytes("orphan"),
      retention_class: "temporary",
      created_at: createdAt,
    });
    await repository.put({
      artifact_id: "artifact-referenced",
      kind: "report",
      content: bytes("referenced"),
      created_at: createdAt,
    });
    await repository.put({
      artifact_id: "artifact-pinned",
      kind: "report",
      content: bytes("pinned"),
      retention_class: "pinned",
      created_at: createdAt,
    });
    const references: ArtifactReferenceRepository = {
      listArtifactReferences: (query) =>
        Promise.resolve(
          query?.artifact_id === "artifact-referenced"
            ? [
                {
                  artifact_id: "artifact-referenced",
                  source_kind: "task_result",
                  source_id: "run-1",
                  source_revision: 1,
                  field_path: "/artifacts/0",
                  created_at: createdAt,
                },
              ]
            : [],
        ),
    };

    const preview = await previewArtifactCleanup(repository, references, {
      now: "2026-07-31T00:00:00.000Z",
      orphan_grace_ms: 1_000,
    });
    expect(preview.map((candidate) => candidate.artifact.artifact_id)).toEqual(["artifact-orphan"]);
    expect(await repository.getMetadata("artifact-orphan")).toBeDefined();
  });
});

async function createRepository(
  options: {
    now?: () => Date;
    temporary_file_max_age_ms?: number;
  } = {},
): Promise<{ repository: LocalArtifactRepository; root: string }> {
  const root = await temporaryRoot("agent-bridge-artifact-");
  const repository = await LocalArtifactRepository.open({
    root_path: root,
    ...options,
  });
  return { repository, root };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function text(content: Promise<AsyncIterable<Uint8Array>>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of await content) {
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
