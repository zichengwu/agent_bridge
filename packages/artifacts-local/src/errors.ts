export const LOCAL_ARTIFACT_ERROR_CODES = [
  "ARTIFACT_CONFIGURATION_INVALID",
  "ARTIFACT_REQUEST_INVALID",
  "ARTIFACT_NOT_FOUND",
  "ARTIFACT_CONFLICT",
  "ARTIFACT_INTEGRITY_ERROR",
  "ARTIFACT_PATH_UNSAFE",
  "ARTIFACT_IO_ERROR",
  "ARTIFACT_CLEANUP_QUERY_INVALID",
] as const;

export type LocalArtifactErrorCode = (typeof LOCAL_ARTIFACT_ERROR_CODES)[number];

export class LocalArtifactError extends Error {
  readonly code: LocalArtifactErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: LocalArtifactErrorCode,
    details: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(messageFor(code));
    this.name = "LocalArtifactError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function messageFor(code: LocalArtifactErrorCode): string {
  switch (code) {
    case "ARTIFACT_CONFIGURATION_INVALID":
      return "The local Artifact repository configuration is invalid";
    case "ARTIFACT_REQUEST_INVALID":
      return "The Artifact request is invalid";
    case "ARTIFACT_NOT_FOUND":
      return "The Artifact does not exist";
    case "ARTIFACT_CONFLICT":
      return "The Artifact identifier conflicts with existing content";
    case "ARTIFACT_INTEGRITY_ERROR":
      return "The Artifact content does not match its metadata";
    case "ARTIFACT_PATH_UNSAFE":
      return "The Artifact storage path is unsafe";
    case "ARTIFACT_IO_ERROR":
      return "The Artifact storage operation failed";
    case "ARTIFACT_CLEANUP_QUERY_INVALID":
      return "The Artifact cleanup query is invalid";
  }
}
