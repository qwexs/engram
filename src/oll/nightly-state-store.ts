import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteJson } from "./legacy-migration";

export interface NightlyLeaseV1 {
  schema: "oll.nightly-lease.v1";
  ownerToken: string;
  fencingGeneration: number;
  acquiredAt: string;
  expiresAt: string;
}

export interface NightlyBatchStateV1 {
  schemaVersion: 1;
  revision: number;
  batchId: string;
  mode: "daily" | "weekly";
  status: string;
  registryDigest: string;
  configDigest: string;
  lease: Omit<NightlyLeaseV1, "schema">;
  workspaceQueue: string[];
  activeWorkspace: string | null;
  activeSnapshotAt?: string | null;
  activeRunId: string | null;
  activeEvaluationId: string | null;
  activeAttempt: number | null;
  activeContextDigest: string | null;
  activeHandoffPath: string | null;
  completed: string[];
  failed: string[];
  startedAt: string;
  updatedAt: string;
}

export interface NightlyBatchEventV1 {
  schema: "oll.nightly-batch-event.v1";
  eventId: string;
  sequence: number;
  batchId: string;
  workspaceId: string | null;
  runId: string | null;
  transition: string;
  errorClass: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export class NightlyStateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NightlyStateError";
  }
}

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function readObject<T>(path: string): T {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must contain an object`);
  return value as T;
}

function sleepSync(ms: number): void {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, ms);
}

function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temp, path);
  // Directory fsync makes a rename durable on POSIX. Windows rejects it with
  // EPERM, while flushing the file descriptor above is the supported step.
  if (process.platform !== "win32") {
    const dirFd = openSync(dirname(path), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  }
}

function withLock<T>(root: string, fn: () => T): T {
  mkdirSync(root, { recursive: true });
  const lock = join(root, ".state.lock");
  const started = Date.now();
  while (true) {
    try { mkdirSync(lock); break; }
    catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try { stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { stale = false; }
      if (stale) { rmSync(lock, { recursive: true, force: true }); continue; }
      if (Date.now() - started >= LOCK_WAIT_MS) throw new NightlyStateError("lock_timeout", "nightly state lock timeout");
      sleepSync(20);
    }
  }
  try { return fn(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

function iso(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new NightlyStateError("invalid_timestamp", "invalid timestamp");
  return new Date(timestamp).toISOString();
}

/** Stable filesystem representation; canonical batch IDs remain in JSON. */
export function nightlyBatchStorageKey(batchId: string): string {
  return `b-${Buffer.from(batchId, "utf8").toString("base64url")}`;
}

/** Prefer the portable layout, but keep existing POSIX installations readable. */
export function nightlyBatchDirectory(root: string, batchId: string): string {
  const portable = join(root, "batches", nightlyBatchStorageKey(batchId));
  const legacy = join(root, "batches", batchId);
  return existsSync(portable) || !existsSync(legacy) ? portable : legacy;
}

export class NightlyStateStore {
  readonly root: string;
  readonly leasePath: string;
  readonly generationPath: string;
  readonly currentBatchPath: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.leasePath = join(this.root, "lease.json");
    this.generationPath = join(this.root, "generation.txt");
    this.currentBatchPath = join(this.root, "current-batch.json");
  }

  private readLeaseOrNull(): NightlyLeaseV1 | null {
    return existsSync(this.leasePath) ? readObject<NightlyLeaseV1>(this.leasePath) : null;
  }

  private assertHolder(expected: Pick<NightlyLeaseV1, "ownerToken" | "fencingGeneration">, now?: string): NightlyLeaseV1 {
    const current = this.readLeaseOrNull();
    if (!current || current.ownerToken !== expected.ownerToken || current.fencingGeneration !== expected.fencingGeneration) {
      throw new NightlyStateError("fenced", "lease holder was fenced by another generation");
    }
    if (now && Date.parse(current.expiresAt) <= Date.parse(now)) throw new NightlyStateError("lease_expired", "lease has expired");
    return current;
  }

  acquireLease(options: { ownerToken?: string; now: string; ttlSeconds: number }): NightlyLeaseV1 {
    const now = iso(options.now);
    if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds < 1) throw new NightlyStateError("invalid_lease", "lease TTL must be positive");
    return withLock(this.root, () => {
      const current = this.readLeaseOrNull();
      const ownerToken = options.ownerToken || randomUUID();
      if (current && Date.parse(current.expiresAt) > Date.parse(now) && current.ownerToken !== ownerToken) {
        throw new NightlyStateError("lease_held", "nightly lease is held by another owner");
      }
      if (current && current.ownerToken === ownerToken && Date.parse(current.expiresAt) > Date.parse(now)) {
        return this.renewLeaseUnlocked(current, now, options.ttlSeconds);
      }
      const storedGeneration = existsSync(this.generationPath) ? Number(readFileSync(this.generationPath, "utf8").trim()) || 0 : 0;
      const fencingGeneration = Math.max(storedGeneration, current?.fencingGeneration || 0) + 1;
      atomicWriteText(this.generationPath, `${fencingGeneration}\n`);
      const lease: NightlyLeaseV1 = {
        schema: "oll.nightly-lease.v1",
        ownerToken,
        fencingGeneration,
        acquiredAt: now,
        expiresAt: new Date(Date.parse(now) + options.ttlSeconds * 1000).toISOString(),
      };
      atomicWriteJson(this.leasePath, lease);
      return lease;
    });
  }

  private renewLeaseUnlocked(current: NightlyLeaseV1, now: string, ttlSeconds: number): NightlyLeaseV1 {
    const next = { ...current, expiresAt: new Date(Date.parse(now) + ttlSeconds * 1000).toISOString() };
    atomicWriteJson(this.leasePath, next);
    return next;
  }

  renewLease(expected: Pick<NightlyLeaseV1, "ownerToken" | "fencingGeneration">, now: string, ttlSeconds: number): NightlyLeaseV1 {
    return withLock(this.root, () => this.renewLeaseUnlocked(this.assertHolder(expected, now), iso(now), ttlSeconds));
  }

  releaseLease(expected: Pick<NightlyLeaseV1, "ownerToken" | "fencingGeneration">): void {
    withLock(this.root, () => {
      this.assertHolder(expected);
      if (existsSync(this.leasePath)) unlinkSync(this.leasePath);
    });
  }

  batchPath(batchId: string): string {
    return join(nightlyBatchDirectory(this.root, batchId), "batch.json");
  }

  readBatch(batchId: string): NightlyBatchStateV1 {
    return readObject<NightlyBatchStateV1>(this.batchPath(batchId));
  }

  readCurrentBatchId(): string | null {
    if (!existsSync(this.currentBatchPath)) return null;
    const pointer = readObject<{ schema: string; batchId: string }>(this.currentBatchPath);
    return pointer.schema === "oll.current-batch.v1" ? pointer.batchId : null;
  }

  createBatch(batch: Omit<NightlyBatchStateV1, "revision">, lease: Pick<NightlyLeaseV1, "ownerToken" | "fencingGeneration">): NightlyBatchStateV1 {
    return withLock(this.root, () => {
      this.assertHolder(lease, batch.updatedAt);
      const path = this.batchPath(batch.batchId);
      if (existsSync(path)) throw new NightlyStateError("batch_exists", "batch already exists");
      const created = { ...batch, revision: 1 };
      atomicWriteJson(path, created);
      atomicWriteJson(this.currentBatchPath, { schema: "oll.current-batch.v1", batchId: batch.batchId, updatedAt: batch.updatedAt });
      return created;
    });
  }

  writeBatch(next: NightlyBatchStateV1, expectedRevision: number, lease: Pick<NightlyLeaseV1, "ownerToken" | "fencingGeneration">): NightlyBatchStateV1 {
    return withLock(this.root, () => {
      const currentLease = this.assertHolder(lease, next.updatedAt);
      const path = this.batchPath(next.batchId);
      if (!existsSync(path)) throw new NightlyStateError("batch_missing", "batch does not exist");
      const current = readObject<NightlyBatchStateV1>(path);
      if (current.revision !== expectedRevision) throw new NightlyStateError("revision_conflict", "batch revision mismatch");
      if (next.lease.ownerToken !== currentLease.ownerToken || next.lease.fencingGeneration !== currentLease.fencingGeneration) {
        throw new NightlyStateError("fenced", "batch lease projection does not match current holder");
      }
      const written = { ...next, revision: expectedRevision + 1 };
      atomicWriteJson(path, written);
      atomicWriteJson(this.currentBatchPath, { schema: "oll.current-batch.v1", batchId: next.batchId, updatedAt: next.updatedAt });
      return written;
    });
  }

  appendEvent(batchId: string, input: Omit<NightlyBatchEventV1, "schema" | "eventId" | "sequence" | "batchId">): NightlyBatchEventV1 {
    return withLock(this.root, () => {
      const eventsDir = join(nightlyBatchDirectory(this.root, batchId), "events");
      mkdirSync(eventsDir, { recursive: true });
      const events = readdirSync(eventsDir).filter((name) => /^\d{8}-/.test(name)).sort();
      const sequence = events.reduce((max, name) => Math.max(max, Number(name.slice(0, 8)) || 0), 0) + 1;
      const event: NightlyBatchEventV1 = {
        schema: "oll.nightly-batch-event.v1",
        eventId: randomUUID(),
        sequence,
        batchId,
        ...input,
      };
      const path = join(eventsDir, `${String(sequence).padStart(8, "0")}-${event.eventId}.json`);
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(event, null, 2)}\n`, "utf8");
        fsyncSync(fd);
      } finally { closeSync(fd); }
      return event;
    });
  }
}
