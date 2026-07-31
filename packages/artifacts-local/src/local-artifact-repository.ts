import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  ARTIFACT_RETENTION_CLASSES,
  canonicalizeDomainJson,
  isDomainJsonValue,
  type ArtifactMetadata,
  type ArtifactMetadataQuery,
  type ArtifactReferenceRepository,
  type ArtifactRepository,
  type ArtifactRetentionClass,
  type ArtifactWriteRequest,
  type ArtifactWriteResult,
} from "@agent-bridge/core";

import { LocalArtifactError } from "./errors.js";

export interface LocalArtifactRepositoryOptions {
  readonly root_path: string;
  readonly temporary_file_max_age_ms?: number;
  readonly now?: () => Date;
}

export interface TemporaryArtifactCleanupResult {
  readonly removed_count: number;
}

export interface ArtifactCleanupPreviewOptions {
  readonly now?: string;
  readonly orphan_grace_ms?: number;
  readonly limit?: number;
}

export interface ArtifactCleanupCandidate {
  readonly artifact: ArtifactMetadata;
  readonly reason: "UNREFERENCED";
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DEFAULT_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_LIMIT = 1_000;

export class LocalArtifactRepository implements ArtifactRepository {
  private constructor(
    private readonly rootPath: string,
    private readonly objectsPath: string,
    private readonly manifestsPath: string,
    private readonly temporaryPath: string,
    private readonly temporaryFileMaxAgeMs: number,
    private readonly now: () => Date,
  ) {}

  static async open(options: LocalArtifactRepositoryOptions): Promise<LocalArtifactRepository> {
    const parsed = readOptions(options);
    const rootPath = resolve(parsed.root_path);
    await ensureDirectory(rootPath);
    const canonicalRoot = await canonicalDirectory(rootPath, rootPath);
    const objectsPath = join(canonicalRoot, "objects", "sha256");
    const manifestsPath = join(canonicalRoot, "manifests");
    const temporaryPath = join(canonicalRoot, "tmp");
    await ensureSafeDirectory(objectsPath, canonicalRoot);
    await ensureSafeDirectory(manifestsPath, canonicalRoot);
    await ensureSafeDirectory(temporaryPath, canonicalRoot);

    const repository = new LocalArtifactRepository(
      canonicalRoot,
      objectsPath,
      manifestsPath,
      temporaryPath,
      parsed.temporary_file_max_age_ms,
      parsed.now,
    );
    await repository.cleanupTemporaryFiles();
    return repository;
  }

  async put(value: ArtifactWriteRequest): Promise<ArtifactWriteResult> {
    const request = readWriteRequest(value);
    const temporaryContentPath = join(this.temporaryPath, `${randomUUID()}.content.tmp`);
    let temporaryExists = false;
    try {
      temporaryExists = true;
      const content = await writeTemporaryContent(
        temporaryContentPath,
        request.content,
        this.temporaryPath,
      );
      const existing = await this.getMetadata(request.artifact_id);
      const createdAt = request.created_at ?? existing?.created_at ?? this.now().toISOString();
      const candidate = freezeMetadata({
        artifact_id: request.artifact_id,
        kind: request.kind,
        content_hash: content.content_hash,
        size_bytes: content.size_bytes,
        ...(request.media_type === undefined ? {} : { media_type: request.media_type }),
        retention_class: request.retention_class ?? "standard",
        created_at: createdAt,
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      });

      if (existing !== undefined) {
        await safeUnlink(temporaryContentPath);
        temporaryExists = false;
        if (!sameMetadata(existing, candidate)) {
          throw new LocalArtifactError("ARTIFACT_CONFLICT", {
            artifact_id: request.artifact_id,
          });
        }
        await this.assertBlobIntegrity(existing);
        return Object.freeze({ outcome: "REPLAYED", artifact: existing });
      }

      const blobPath = await this.blobPath(content.content_hash, true);
      await installNoClobber(temporaryContentPath, blobPath);
      temporaryExists = false;
      await this.assertBlobIntegrity(candidate);
      await this.installManifest(candidate);
      return Object.freeze({ outcome: "STORED", artifact: candidate });
    } catch (error) {
      if (temporaryExists) {
        await safeUnlink(temporaryContentPath);
      }
      if (error instanceof LocalArtifactError) {
        throw error;
      }
      throw new LocalArtifactError("ARTIFACT_IO_ERROR");
    }
  }

  async getMetadata(artifactId: string): Promise<ArtifactMetadata | undefined> {
    const id = readIdentifier(artifactId);
    const path = join(this.manifestsPath, `${id}.json`);
    const state = await safeFileState(path, this.manifestsPath);
    if (state === "missing") {
      return undefined;
    }
    try {
      return readMetadata(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (error instanceof LocalArtifactError) {
        throw error;
      }
      throw new LocalArtifactError("ARTIFACT_INTEGRITY_ERROR", { artifact_id: id });
    }
  }

  async read(artifactId: string): Promise<AsyncIterable<Uint8Array>> {
    const metadata = await this.getMetadata(artifactId);
    if (metadata === undefined) {
      throw new LocalArtifactError("ARTIFACT_NOT_FOUND", { artifact_id: artifactId });
    }
    const blobPath = await this.blobPath(metadata.content_hash, false);
    if ((await safeFileState(blobPath, this.objectsPath)) === "missing") {
      throw new LocalArtifactError("ARTIFACT_INTEGRITY_ERROR", {
        artifact_id: metadata.artifact_id,
      });
    }
    return verifiedStream(blobPath, metadata);
  }

  async listMetadata(value: ArtifactMetadataQuery = {}): Promise<readonly ArtifactMetadata[]> {
    const query = readMetadataQuery(value);
    const entries = await readdir(this.manifestsPath, { withFileTypes: true });
    const result: ArtifactMetadata[] = [];
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        if (entry.isSymbolicLink()) {
          throw new LocalArtifactError("ARTIFACT_PATH_UNSAFE");
        }
        continue;
      }
      const id = entry.name.slice(0, -".json".length);
      if (!IDENTIFIER_PATTERN.test(id)) {
        throw new LocalArtifactError("ARTIFACT_INTEGRITY_ERROR");
      }
      const metadata = await this.getMetadata(id);
      if (
        metadata !== undefined &&
        (query.retention_class === undefined ||
          metadata.retention_class === query.retention_class) &&
        (query.created_before === undefined ||
          Date.parse(metadata.created_at) < Date.parse(query.created_before))
      ) {
        result.push(metadata);
        if (result.length === query.limit) {
          break;
        }
      }
    }
    return Object.freeze(result);
  }

  async cleanupTemporaryFiles(): Promise<TemporaryArtifactCleanupResult> {
    const threshold = this.now().getTime() - this.temporaryFileMaxAgeMs;
    const entries = await readdir(this.temporaryPath, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new LocalArtifactError("ARTIFACT_PATH_UNSAFE");
      }
      if (!entry.isFile() || !entry.name.endsWith(".tmp")) {
        continue;
      }
      const path = join(this.temporaryPath, entry.name);
      const state = await lstat(path);
      if (state.mtimeMs <= threshold) {
        await unlink(path);
        removed += 1;
      }
    }
    return Object.freeze({ removed_count: removed });
  }

  private async installManifest(metadata: ArtifactMetadata): Promise<void> {
    const temporaryPath = join(this.temporaryPath, `${randomUUID()}.manifest.tmp`);
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const destination = join(this.manifestsPath, `${metadata.artifact_id}.json`);
    try {
      const installed = await installNoClobber(temporaryPath, destination);
      if (installed) {
        return;
      }
      const existing = await this.getMetadata(metadata.artifact_id);
      if (existing !== undefined && sameMetadata(existing, metadata)) {
        return;
      }
      throw new LocalArtifactError("ARTIFACT_CONFLICT", {
        artifact_id: metadata.artifact_id,
      });
    } catch (error) {
      await safeUnlink(temporaryPath);
      if (error instanceof LocalArtifactError) {
        throw error;
      }
      throw new LocalArtifactError("ARTIFACT_IO_ERROR");
    }
  }

  private async blobPath(contentHash: string, createShard: boolean): Promise<string> {
    if (!HASH_PATTERN.test(contentHash)) {
      throw new LocalArtifactError("ARTIFACT_INTEGRITY_ERROR");
    }
    const digest = contentHash.slice("sha256:".length);
    const shard = join(this.objectsPath, digest.slice(0, 2));
    if (createShard) {
      await ensureSafeDirectory(shard, this.rootPath);
    } else {
      await canonicalDirectory(shard, this.rootPath);
    }
    return join(shard, digest);
  }

  private async assertBlobIntegrity(metadata: ArtifactMetadata): Promise<void> {
    const path = await this.blobPath(metadata.content_hash, false);
    const state = await safeFileState(path, this.objectsPath);
    if (state === "missing") {
      throw new LocalArtifactError("ARTIFACT_INTEGRITY_ERROR", {
        artifact_id: metadata.artifact_id,
      });
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
      hash.update(chunk);
      size += chunk.length;
    }
    if (`sha256:${hash.digest("hex")}` !== metadata.content_hash || size !== metadata.size_bytes) {
      throw new LocalArtifactError("ARTIFACT_INTEGRITY_ERROR", {
        artifact_id: metadata.artifact_id,
      });
    }
  }
}

export async function previewArtifactCleanup(
  artifacts: ArtifactRepository,
  references: ArtifactReferenceRepository,
  value: ArtifactCleanupPreviewOptions = {},
): Promise<readonly ArtifactCleanupCandidate[]> {
  const options = readCleanupOptions(value);
  const metadata = await artifacts.listMetadata({
    created_before: options.now,
    limit: DEFAULT_LIMIT,
  });
  const candidates: ArtifactCleanupCandidate[] = [];
  for (const artifact of metadata) {
    if (
      artifact.retention_class === "pinned" ||
      Date.parse(artifact.created_at) + options.orphan_grace_ms > Date.parse(options.now)
    ) {
      continue;
    }
    const links = await references.listArtifactReferences({
      artifact_id: artifact.artifact_id,
      limit: 1,
    });
    if (links.length === 0) {
      candidates.push(Object.freeze({ artifact, reason: "UNREFERENCED" }));
      if (candidates.length === options.limit) {
        break;
      }
    }
  }
  return Object.freeze(candidates);
}

async function writeTemporaryContent(
  path: string,
  content: ArtifactWriteRequest["content"],
  root: string,
): Promise<{ readonly content_hash: string; readonly size_bytes: number }> {
  assertContained(path, root);
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of chunks(content)) {
      if (!(chunk instanceof Uint8Array)) {
        throw new LocalArtifactError("ARTIFACT_REQUEST_INVALID");
      }
      await handle.write(chunk);
      hash.update(chunk);
      size += chunk.byteLength;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return Object.freeze({
    content_hash: `sha256:${hash.digest("hex")}`,
    size_bytes: size,
  });
}

async function* chunks(content: ArtifactWriteRequest["content"]): AsyncIterable<Uint8Array> {
  if (content instanceof Uint8Array) {
    yield content;
    return;
  }
  for await (const chunk of content) {
    yield chunk;
  }
}

async function installNoClobber(source: string, destination: string): Promise<boolean> {
  try {
    await link(source, destination);
    await unlink(source);
    return true;
  } catch (error) {
    if (isFileExistsError(error)) {
      await unlink(source);
      return false;
    }
    throw error;
  }
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch {
    throw new LocalArtifactError("ARTIFACT_CONFIGURATION_INVALID");
  }
}

async function ensureSafeDirectory(path: string, root: string): Promise<void> {
  assertContained(path, root);
  const segments = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  await canonicalDirectory(current, root);
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw new LocalArtifactError("ARTIFACT_IO_ERROR");
      }
    }
    await canonicalDirectory(current, root);
  }
}

async function canonicalDirectory(path: string, root: string): Promise<string> {
  assertContained(path, root);
  let state;
  try {
    state = await lstat(path);
  } catch {
    throw new LocalArtifactError("ARTIFACT_PATH_UNSAFE");
  }
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new LocalArtifactError("ARTIFACT_PATH_UNSAFE");
  }
  const canonical = await realpath(path);
  if (resolve(path) !== resolve(root)) {
    assertContained(canonical, root);
  }
  return canonical;
}

async function safeFileState(path: string, root: string): Promise<"file" | "missing"> {
  assertContained(path, root);
  try {
    const state = await lstat(path);
    if (!state.isFile() || state.isSymbolicLink()) {
      throw new LocalArtifactError("ARTIFACT_PATH_UNSAFE");
    }
    const canonical = await realpath(path);
    assertContained(canonical, root);
    return "file";
  } catch (error) {
    if (isMissingError(error)) {
      return "missing";
    }
    if (error instanceof LocalArtifactError) {
      throw error;
    }
    throw new LocalArtifactError("ARTIFACT_IO_ERROR");
  }
}

function verifiedStream(path: string, metadata: ArtifactMetadata): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
        hash.update(chunk);
        size += chunk.length;
        yield chunk;
      }
      if (
        `sha256:${hash.digest("hex")}` !== metadata.content_hash ||
        size !== metadata.size_bytes
      ) {
        throw new LocalArtifactError("ARTIFACT_INTEGRITY_ERROR", {
          artifact_id: metadata.artifact_id,
        });
      }
    },
  };
}

function readOptions(
  value: unknown,
): Required<Pick<LocalArtifactRepositoryOptions, "temporary_file_max_age_ms" | "now">> &
  Pick<LocalArtifactRepositoryOptions, "root_path"> {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["root_path", "temporary_file_max_age_ms", "now"]) ||
    typeof value.root_path !== "string" ||
    value.root_path.length === 0 ||
    !isAbsolute(value.root_path) ||
    (value.temporary_file_max_age_ms !== undefined &&
      !isPositiveInteger(value.temporary_file_max_age_ms)) ||
    (value.now !== undefined && typeof value.now !== "function")
  ) {
    throw new LocalArtifactError("ARTIFACT_CONFIGURATION_INVALID");
  }
  return {
    root_path: value.root_path,
    temporary_file_max_age_ms: value.temporary_file_max_age_ms ?? DEFAULT_TEMP_MAX_AGE_MS,
    now: value.now === undefined ? () => new Date() : (value.now as () => Date),
  };
}

function readWriteRequest(value: unknown): ArtifactWriteRequest {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, [
      "artifact_id",
      "kind",
      "content",
      "media_type",
      "retention_class",
      "created_at",
      "metadata",
    ]) ||
    !IDENTIFIER_PATTERN.test(String(value.artifact_id)) ||
    !KIND_PATTERN.test(String(value.kind)) ||
    !isArtifactContent(value.content) ||
    (value.media_type !== undefined &&
      (typeof value.media_type !== "string" || !MEDIA_TYPE_PATTERN.test(value.media_type))) ||
    (value.retention_class !== undefined &&
      !ARTIFACT_RETENTION_CLASSES.includes(value.retention_class as ArtifactRetentionClass)) ||
    (value.created_at !== undefined && !isTimestamp(value.created_at)) ||
    (value.metadata !== undefined &&
      (!isPlainRecord(value.metadata) || !isDomainJsonValue(value.metadata)))
  ) {
    throw new LocalArtifactError("ARTIFACT_REQUEST_INVALID");
  }
  return Object.freeze(value as unknown as ArtifactWriteRequest);
}

function readMetadata(value: unknown): ArtifactMetadata {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, [
      "artifact_id",
      "kind",
      "content_hash",
      "size_bytes",
      "media_type",
      "retention_class",
      "created_at",
      "metadata",
    ]) ||
    !IDENTIFIER_PATTERN.test(String(value.artifact_id)) ||
    !KIND_PATTERN.test(String(value.kind)) ||
    !HASH_PATTERN.test(String(value.content_hash)) ||
    typeof value.size_bytes !== "number" ||
    !Number.isSafeInteger(value.size_bytes) ||
    value.size_bytes < 0 ||
    (value.media_type !== undefined &&
      (typeof value.media_type !== "string" || !MEDIA_TYPE_PATTERN.test(value.media_type))) ||
    !ARTIFACT_RETENTION_CLASSES.includes(value.retention_class as ArtifactRetentionClass) ||
    !isTimestamp(value.created_at) ||
    (value.metadata !== undefined &&
      (!isPlainRecord(value.metadata) || !isDomainJsonValue(value.metadata)))
  ) {
    throw new LocalArtifactError("ARTIFACT_INTEGRITY_ERROR");
  }
  return freezeMetadata(value as unknown as ArtifactMetadata);
}

function readMetadataQuery(
  value: unknown,
): Required<Pick<ArtifactMetadataQuery, "limit">> & Omit<ArtifactMetadataQuery, "limit"> {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["retention_class", "created_before", "limit"]) ||
    (value.retention_class !== undefined &&
      !ARTIFACT_RETENTION_CLASSES.includes(value.retention_class as ArtifactRetentionClass)) ||
    (value.created_before !== undefined && !isTimestamp(value.created_before)) ||
    (value.limit !== undefined && (!isPositiveInteger(value.limit) || value.limit > DEFAULT_LIMIT))
  ) {
    throw new LocalArtifactError("ARTIFACT_REQUEST_INVALID");
  }
  return Object.freeze({
    ...(value.retention_class === undefined
      ? {}
      : { retention_class: value.retention_class as ArtifactRetentionClass }),
    ...(value.created_before === undefined ? {} : { created_before: value.created_before }),
    limit: value.limit ?? DEFAULT_LIMIT,
  });
}

function readCleanupOptions(value: unknown): Required<ArtifactCleanupPreviewOptions> {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["now", "orphan_grace_ms", "limit"]) ||
    (value.now !== undefined && !isTimestamp(value.now)) ||
    (value.orphan_grace_ms !== undefined &&
      (!isPositiveInteger(value.orphan_grace_ms) ||
        value.orphan_grace_ms > 365 * 24 * 60 * 60 * 1_000)) ||
    (value.limit !== undefined && (!isPositiveInteger(value.limit) || value.limit > DEFAULT_LIMIT))
  ) {
    throw new LocalArtifactError("ARTIFACT_CLEANUP_QUERY_INVALID");
  }
  return Object.freeze({
    now: value.now ?? new Date().toISOString(),
    orphan_grace_ms: value.orphan_grace_ms ?? DEFAULT_ORPHAN_GRACE_MS,
    limit: value.limit ?? DEFAULT_LIMIT,
  });
}

function freezeMetadata(value: ArtifactMetadata): ArtifactMetadata {
  return Object.freeze({
    ...value,
    ...(value.metadata === undefined ? {} : { metadata: Object.freeze({ ...value.metadata }) }),
  });
}

function sameMetadata(left: ArtifactMetadata, right: ArtifactMetadata): boolean {
  return (
    left.artifact_id === right.artifact_id &&
    left.kind === right.kind &&
    left.content_hash === right.content_hash &&
    left.size_bytes === right.size_bytes &&
    left.media_type === right.media_type &&
    left.retention_class === right.retention_class &&
    left.created_at === right.created_at &&
    (left.metadata === undefined
      ? right.metadata === undefined
      : right.metadata !== undefined &&
        canonicalizeDomainJson(left.metadata) === canonicalizeDomainJson(right.metadata))
  );
}

function readIdentifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new LocalArtifactError("ARTIFACT_REQUEST_INVALID");
  }
  return value;
}

function assertContained(path: string, root: string): void {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  const child = relative(normalizedRoot, normalizedPath);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new LocalArtifactError("ARTIFACT_PATH_UNSAFE");
  }
}

function isArtifactContent(value: unknown): value is ArtifactWriteRequest["content"] {
  return (
    value instanceof Uint8Array ||
    (typeof value === "object" &&
      value !== null &&
      Symbol.asyncIterator in value &&
      typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function")
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingError(error)) {
      throw error;
    }
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
