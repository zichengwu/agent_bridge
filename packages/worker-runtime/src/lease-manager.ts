import { WorkerRuntimeError } from "./errors.js";

export interface LeaseAcquireRequest {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly resources: readonly string[];
  readonly ttlMs: number;
}

export interface LeaseRecord {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly resources: readonly string[];
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface LeaseManager {
  acquire(request: LeaseAcquireRequest): LeaseRecord;
  renew(leaseId: string, ownerId: string, ttlMs: number): LeaseRecord;
  release(leaseId: string, ownerId: string): void;
  getByResource(resource: string): LeaseRecord | undefined;
  snapshot(): readonly LeaseRecord[];
}

export interface InMemoryLeaseManagerOptions {
  readonly now?: () => Date;
  readonly restore?: readonly LeaseRecord[];
}

export class InMemoryLeaseManager implements LeaseManager {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly resourceOwners = new Map<string, string>();
  private readonly now: () => Date;

  constructor(options: InMemoryLeaseManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    for (const record of options.restore ?? []) {
      this.restore(record);
    }
  }

  acquire(request: LeaseAcquireRequest): LeaseRecord {
    const normalized = readAcquireRequest(request);
    this.pruneExpired();
    const existing = this.leases.get(normalized.leaseId);
    if (existing !== undefined) {
      if (
        existing.ownerId === normalized.ownerId &&
        sameResources(existing.resources, normalized.resources)
      ) {
        return existing;
      }
      throw conflict("LEASE_ID_CONFLICT");
    }
    for (const resource of normalized.resources) {
      const leaseId = this.resourceOwners.get(resource);
      if (leaseId !== undefined) {
        throw conflict("RESOURCE_ALREADY_LEASED", resource);
      }
    }
    const acquired = this.now();
    const record = freezeLease({
      leaseId: normalized.leaseId,
      ownerId: normalized.ownerId,
      resources: normalized.resources,
      acquiredAt: acquired.toISOString(),
      expiresAt: new Date(acquired.getTime() + normalized.ttlMs).toISOString(),
    });
    this.leases.set(record.leaseId, record);
    for (const resource of record.resources) {
      this.resourceOwners.set(resource, record.leaseId);
    }
    return record;
  }

  renew(leaseId: string, ownerId: string, ttlMs: number): LeaseRecord {
    assertIdentifier(leaseId);
    assertIdentifier(ownerId);
    assertTtl(ttlMs);
    this.pruneExpired();
    const current = this.leases.get(leaseId);
    if (current === undefined || current.ownerId !== ownerId) {
      throw ownershipMismatch();
    }
    const renewed = freezeLease({
      ...current,
      expiresAt: new Date(this.now().getTime() + ttlMs).toISOString(),
    });
    this.leases.set(leaseId, renewed);
    return renewed;
  }

  release(leaseId: string, ownerId: string): void {
    assertIdentifier(leaseId);
    assertIdentifier(ownerId);
    this.pruneExpired();
    const current = this.leases.get(leaseId);
    if (current === undefined) {
      return;
    }
    if (current.ownerId !== ownerId) {
      throw ownershipMismatch();
    }
    this.delete(current);
  }

  getByResource(resource: string): LeaseRecord | undefined {
    assertResource(resource);
    this.pruneExpired();
    const leaseId = this.resourceOwners.get(resource);
    return leaseId === undefined ? undefined : this.leases.get(leaseId);
  }

  snapshot(): readonly LeaseRecord[] {
    this.pruneExpired();
    return Object.freeze(
      [...this.leases.values()]
        .sort((left, right) => left.leaseId.localeCompare(right.leaseId))
        .map((record) => freezeLease(record)),
    );
  }

  private restore(value: LeaseRecord): void {
    const acquiredAt = Date.parse(value.acquiredAt);
    const expiresAt = Date.parse(value.expiresAt);
    if (!Number.isFinite(acquiredAt) || !Number.isFinite(expiresAt) || expiresAt <= acquiredAt) {
      throw new WorkerRuntimeError("RECOVERY_STATE_INVALID", "Lease recovery state is invalid");
    }
    const normalized = readAcquireRequest({
      leaseId: value.leaseId,
      ownerId: value.ownerId,
      resources: value.resources,
      ttlMs: expiresAt - acquiredAt,
    });
    if (this.leases.has(normalized.leaseId)) {
      throw new WorkerRuntimeError("RECOVERY_STATE_INVALID", "Lease recovery state is duplicated");
    }
    for (const resource of normalized.resources) {
      if (this.resourceOwners.has(resource)) {
        throw new WorkerRuntimeError("RECOVERY_STATE_INVALID", "Lease recovery resources conflict");
      }
    }
    const record = freezeLease(value);
    this.leases.set(record.leaseId, record);
    for (const resource of record.resources) {
      this.resourceOwners.set(resource, record.leaseId);
    }
    this.pruneExpired();
  }

  private pruneExpired(): void {
    const now = this.now().getTime();
    for (const record of this.leases.values()) {
      if (Date.parse(record.expiresAt) <= now) {
        this.delete(record);
      }
    }
  }

  private delete(record: LeaseRecord): void {
    this.leases.delete(record.leaseId);
    for (const resource of record.resources) {
      if (this.resourceOwners.get(resource) === record.leaseId) {
        this.resourceOwners.delete(resource);
      }
    }
  }
}

function readAcquireRequest(request: LeaseAcquireRequest): LeaseAcquireRequest {
  assertIdentifier(request.leaseId);
  assertIdentifier(request.ownerId);
  assertTtl(request.ttlMs);
  if (
    !Array.isArray(request.resources) ||
    request.resources.length === 0 ||
    !request.resources.every(isResource) ||
    new Set(request.resources).size !== request.resources.length
  ) {
    throw new WorkerRuntimeError("WORKER_CONFIGURATION_INVALID", "Lease resources are invalid");
  }
  return Object.freeze({
    leaseId: request.leaseId,
    ownerId: request.ownerId,
    resources: Object.freeze([...request.resources].sort()),
    ttlMs: request.ttlMs,
  });
}

function freezeLease(record: LeaseRecord): LeaseRecord {
  return Object.freeze({ ...record, resources: Object.freeze([...record.resources]) });
}

function sameResources(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((resource, index) => resource === right[index]);
}

function assertIdentifier(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new WorkerRuntimeError("WORKER_CONFIGURATION_INVALID", "Lease identifier is invalid");
  }
}

function assertResource(value: string): void {
  if (!isResource(value)) {
    throw new WorkerRuntimeError("WORKER_CONFIGURATION_INVALID", "Lease resource is invalid");
  }
}

function isResource(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0")
  );
}

function assertTtl(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkerRuntimeError("WORKER_CONFIGURATION_INVALID", "Lease TTL is invalid");
  }
}

function conflict(reason: string, resource?: string): WorkerRuntimeError {
  return new WorkerRuntimeError("LEASE_CONFLICT", "Write lease conflicts with an active owner", {
    reason,
    ...(resource === undefined ? {} : { resource }),
  });
}

function ownershipMismatch(): WorkerRuntimeError {
  return new WorkerRuntimeError(
    "LEASE_OWNERSHIP_MISMATCH",
    "Write lease is not owned by the requested owner",
  );
}
