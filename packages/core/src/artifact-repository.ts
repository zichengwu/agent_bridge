import type { DomainMetadata } from "@agent-bridge/schemas";

export const ARTIFACT_RETENTION_CLASSES = ["temporary", "standard", "audit", "pinned"] as const;

export type ArtifactRetentionClass = (typeof ARTIFACT_RETENTION_CLASSES)[number];

export type ArtifactContent = Uint8Array | AsyncIterable<Uint8Array>;

export interface ArtifactWriteRequest {
  readonly artifact_id: string;
  readonly kind: string;
  readonly content: ArtifactContent;
  readonly media_type?: string;
  readonly retention_class?: ArtifactRetentionClass;
  readonly created_at?: string;
  readonly metadata?: DomainMetadata;
}

export interface ArtifactMetadata {
  readonly artifact_id: string;
  readonly kind: string;
  readonly content_hash: string;
  readonly size_bytes: number;
  readonly media_type?: string;
  readonly retention_class: ArtifactRetentionClass;
  readonly created_at: string;
  readonly metadata?: DomainMetadata;
}

export interface ArtifactWriteResult {
  readonly outcome: "STORED" | "REPLAYED";
  readonly artifact: ArtifactMetadata;
}

export interface ArtifactMetadataQuery {
  readonly retention_class?: ArtifactRetentionClass;
  readonly created_before?: string;
  readonly limit?: number;
}

export interface ArtifactRepository {
  put(request: ArtifactWriteRequest): Promise<ArtifactWriteResult>;
  getMetadata(artifactId: string): Promise<ArtifactMetadata | undefined>;
  read(artifactId: string): Promise<AsyncIterable<Uint8Array>>;
  listMetadata(query?: ArtifactMetadataQuery): Promise<readonly ArtifactMetadata[]>;
}

export const ARTIFACT_REFERENCE_SOURCE_KINDS = [
  "agent_run",
  "task_result",
  "handoff_package",
  "continuation_snapshot",
] as const;

export type ArtifactReferenceSourceKind = (typeof ARTIFACT_REFERENCE_SOURCE_KINDS)[number];

export interface ArtifactDomainReference {
  readonly artifact_id: string;
  readonly source_kind: ArtifactReferenceSourceKind;
  readonly source_id: string;
  readonly source_revision: number;
  readonly field_path: string;
  readonly content_hash?: string;
  readonly created_at: string;
}

export interface ArtifactReferenceQuery {
  readonly artifact_id?: string;
  readonly source_kind?: ArtifactReferenceSourceKind;
  readonly limit?: number;
}

export interface ArtifactReferenceRepository {
  listArtifactReferences(
    query?: ArtifactReferenceQuery,
  ): Promise<readonly ArtifactDomainReference[]>;
}
