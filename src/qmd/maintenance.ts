import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { contextError } from "../cli/errors.ts";
import { buildQmdInvocation } from "./invocation.ts";
import { authorizeQmdInvocation } from "./policy.ts";
import { runQmdInvocation, type QmdRunnerOptions } from "./runner.ts";
import type {
  QmdCallerContext,
  QmdContext,
  QmdInvocation,
  QmdRunResult,
} from "./types.ts";

const MAX_REASONS = 32;
const STATE_MUTEX_STALE_MS = 30_000;
const STATE_MUTEX_WAIT_MS = 10_000;

export type QmdDirtyReason = {
  generation: number;
  reason: string;
  markedAt: string;
};

export type QmdMaintenanceState = {
  schema: "engram.qmd.maintenance-state.v1";
  indexKey: string;
  generation: number;
  updateCompletedGeneration: number;
  embedCompletedGeneration: number;
  dirty: {
    bm25: boolean;
    vectors: boolean;
    collections: string[];
    reasons: QmdDirtyReason[];
  };
  lastUpdateAt: string | null;
  lastEmbedAt: string | null;
  lastError: {
    phase: "update" | "embed" | "coordinator";
    message: string;
    at: string;
  } | null;
};

export type MarkQmdDirtyInput = {
  indexKey: string;
  collections?: string[];
  reason: string;
  bm25?: boolean;
  vectors?: boolean;
};

export type QmdMaintenanceRunStatus = "clean" | "ok" | "partial" | "deferred" | "error";

export type QmdMaintenanceRunResult = {
  schema: "engram.qmd.maintenance-run.v1";
  status: QmdMaintenanceRunStatus;
  indexKey: string;
  observedGeneration: number;
  currentGeneration: number;
  recoveredStaleLease: boolean;
  update?: QmdRunResult;
  embed?: QmdRunResult;
  error?: { phase: "update" | "embed" | "coordinator"; message: string };
};

export type QmdMaintenanceExecutor = (
  context: QmdContext,
  invocation: QmdInvocation,
  options: QmdRunnerOptions,
) => Promise<QmdRunResult>;

export type RunQmdMaintenanceOptions = {
  context: QmdContext;
  caller: QmdCallerContext;
  collections: string[];
  stateRoot: string;
  timeoutMs?: number;
  leaseTtlMs?: number;
  env?: Record<string, string | undefined>;
  execute?: QmdMaintenanceExecutor;
};

type MaintenancePaths = {
  directory: string;
  state: string;
  stateMutex: string;
  lease: string;
  leaseMetadata: string;
  leaseRecovery: string;
};

type LeaseMetadata = {
  schema: "engram.qmd.maintenance-lease.v1";
  token: string;
  indexKey: string;
  pid: number;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
};

type AcquiredLease = {
  metadata: LeaseMetadata;
  recoveredStale: boolean;
};

function isoNow(): string {
  return new Date().toISOString();
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function validateIndexKey(indexKey: string): void {
  if (typeof indexKey !== "string" || indexKey.trim() === "") {
    throw contextError("QMD maintenance indexKey must be a non-empty string.");
  }
}

function validateCollections(collections: string[]): string[] {
  if (!Array.isArray(collections)) {
    throw contextError("QMD maintenance collections must be an array.");
  }
  const normalized = uniqueSorted(collections);
  if (normalized.length === 0) {
    throw contextError("QMD maintenance requires at least one explicit collection.");
  }
  return normalized;
}

export function qmdMaintenancePaths(stateRoot: string, indexKey: string): MaintenancePaths {
  validateIndexKey(indexKey);
  if (typeof stateRoot !== "string" || !isAbsolute(stateRoot)) {
    throw contextError("QMD maintenance stateRoot must be an absolute path.", { stateRoot });
  }
  const id = createHash("sha256").update(indexKey).digest("hex");
  const directory = join(stateRoot, id);
  return {
    directory,
    state: join(directory, "state.json"),
    stateMutex: join(directory, ".state-lock"),
    lease: join(directory, ".maintenance-lease"),
    leaseMetadata: join(directory, ".maintenance-lease", "lease.json"),
    leaseRecovery: join(directory, ".maintenance-lease-recovery"),
  };
}

function defaultState(indexKey: string): QmdMaintenanceState {
  return {
    schema: "engram.qmd.maintenance-state.v1",
    indexKey,
    generation: 0,
    updateCompletedGeneration: 0,
    embedCompletedGeneration: 0,
    dirty: { bm25: false, vectors: false, collections: [], reasons: [] },
    lastUpdateAt: null,
    lastEmbedAt: null,
    lastError: null,
  };
}

function parseState(raw: string, indexKey: string): QmdMaintenanceState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw contextError("QMD maintenance state is not valid JSON.", {
      indexKey,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const state = parsed as Partial<QmdMaintenanceState>;
  if (state.schema !== "engram.qmd.maintenance-state.v1" || state.indexKey !== indexKey
    || !Number.isSafeInteger(state.generation) || (state.generation ?? -1) < 0
    || !state.dirty || !Array.isArray(state.dirty.collections) || !Array.isArray(state.dirty.reasons)) {
    throw contextError("QMD maintenance state has an invalid schema or index identity.", { indexKey });
  }
  return state as QmdMaintenanceState;
}

export function readQmdMaintenanceState(stateRoot: string, indexKey: string): QmdMaintenanceState {
  const paths = qmdMaintenancePaths(stateRoot, indexKey);
  if (!existsSync(paths.state)) return defaultState(indexKey);
  return parseState(readFileSync(paths.state, "utf8"), indexKey);
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function lockIsStale(path: string, staleMs: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

async function withStateMutex<T>(paths: MaintenancePaths, action: () => T | Promise<T>): Promise<T> {
  mkdirSync(paths.directory, { recursive: true });
  const deadline = Date.now() + STATE_MUTEX_WAIT_MS;
  while (true) {
    try {
      mkdirSync(paths.stateMutex);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (lockIsStale(paths.stateMutex, STATE_MUTEX_STALE_MS)) {
        rmSync(paths.stateMutex, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw contextError("Timed out waiting for the QMD maintenance state mutex.", {
          path: paths.stateMutex,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  try {
    return await action();
  } finally {
    rmSync(paths.stateMutex, { recursive: true, force: true });
  }
}

export async function markQmdDirty(stateRoot: string, input: MarkQmdDirtyInput): Promise<QmdMaintenanceState> {
  validateIndexKey(input.indexKey);
  if (typeof input.reason !== "string" || input.reason.trim() === "") {
    throw contextError("QMD dirty reason must be a non-empty string.");
  }
  const bm25 = input.bm25 ?? true;
  const vectors = input.vectors ?? true;
  if (!bm25 && !vectors) {
    throw contextError("QMD dirty mark must request BM25, vectors, or both.");
  }
  const collections = uniqueSorted(input.collections ?? []);
  if (vectors && collections.length === 0) {
    throw contextError("Vector dirty marks require at least one explicit collection.");
  }
  const paths = qmdMaintenancePaths(stateRoot, input.indexKey);
  return withStateMutex(paths, () => {
    const state = readQmdMaintenanceState(stateRoot, input.indexKey);
    const generation = state.generation + 1;
    const reason: QmdDirtyReason = {
      generation,
      reason: input.reason.trim().slice(0, 240),
      markedAt: isoNow(),
    };
    const next: QmdMaintenanceState = {
      ...state,
      generation,
      dirty: {
        bm25: state.dirty.bm25 || bm25,
        vectors: state.dirty.vectors || vectors,
        collections: uniqueSorted([...state.dirty.collections, ...collections]),
        reasons: [...state.dirty.reasons, reason].slice(-MAX_REASONS),
      },
    };
    writeJsonAtomic(paths.state, next);
    return next;
  });
}

function readLeaseMetadata(paths: MaintenancePaths): LeaseMetadata | null {
  return readLeaseMetadataAt(paths.leaseMetadata);
}

function readLeaseMetadataAt(path: string): LeaseMetadata | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LeaseMetadata;
    return parsed.schema === "engram.qmd.maintenance-lease.v1" ? parsed : null;
  } catch {
    return null;
  }
}

function staleLeaseToken(paths: MaintenancePaths): string | null | undefined {
  const metadata = readLeaseMetadata(paths);
  if (metadata) {
    const expiresAt = Date.parse(metadata.expiresAt);
    if (Number.isFinite(expiresAt)) return expiresAt <= Date.now() ? metadata.token : null;
  }
  return lockIsStale(paths.lease, STATE_MUTEX_STALE_MS) ? undefined : null;
}

function recoverAndAcquireStaleLease(
  paths: MaintenancePaths,
  indexKey: string,
  ttlMs: number,
  observedToken: string | undefined,
): AcquiredLease | null {
  try {
    mkdirSync(paths.leaseRecovery);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  const quarantine = `${paths.lease}.stale-${process.pid}-${randomUUID()}`;
  try {
    try {
      const currentToken = staleLeaseToken(paths);
      if (currentToken === null || currentToken !== observedToken) return null;
      renameSync(paths.lease, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    const capturedMetadata = readLeaseMetadataAt(join(quarantine, "lease.json"));
    if (observedToken !== undefined && capturedMetadata?.token !== observedToken) {
      if (!existsSync(paths.lease)) renameSync(quarantine, paths.lease);
      return null;
    }
    if (observedToken === undefined && capturedMetadata) {
      const capturedExpiry = Date.parse(capturedMetadata.expiresAt);
      if (Number.isFinite(capturedExpiry) && capturedExpiry > Date.now()) {
        if (!existsSync(paths.lease)) renameSync(quarantine, paths.lease);
        return null;
      }
    }
    rmSync(quarantine, { recursive: true, force: true });
    mkdirSync(paths.lease);
    const metadata = makeLease(indexKey, ttlMs);
    writeJsonAtomic(paths.leaseMetadata, metadata);
    return { metadata, recoveredStale: true };
  } finally {
    if (existsSync(quarantine)) rmSync(quarantine, { recursive: true, force: true });
    rmSync(paths.leaseRecovery, { recursive: true, force: true });
  }
}

function makeLease(indexKey: string, ttlMs: number): LeaseMetadata {
  const now = Date.now();
  return {
    schema: "engram.qmd.maintenance-lease.v1",
    token: randomUUID(),
    indexKey,
    pid: process.pid,
    acquiredAt: new Date(now).toISOString(),
    renewedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
}

function acquireMaintenanceLease(paths: MaintenancePaths, indexKey: string, ttlMs: number): AcquiredLease | null {
  mkdirSync(paths.directory, { recursive: true });
  if (existsSync(paths.leaseRecovery)) return null;
  try {
    mkdirSync(paths.lease);
    const metadata = makeLease(indexKey, ttlMs);
    writeJsonAtomic(paths.leaseMetadata, metadata);
    return { metadata, recoveredStale: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    const observedToken = staleLeaseToken(paths);
    if (observedToken === null) return null;
    return recoverAndAcquireStaleLease(paths, indexKey, ttlMs, observedToken);
  }
}

function renewMaintenanceLease(paths: MaintenancePaths, lease: AcquiredLease, ttlMs: number): void {
  try {
    const current = readLeaseMetadata(paths);
    if (!current || current.token !== lease.metadata.token) return;
    const now = Date.now();
    lease.metadata = {
      ...current,
      renewedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    writeJsonAtomic(paths.leaseMetadata, lease.metadata);
  } catch {
    // The main run remains authoritative. A failed renewal will eventually
    // make the lease recoverable instead of crashing the coordinator process.
  }
}

function releaseMaintenanceLease(paths: MaintenancePaths, lease: AcquiredLease): void {
  const current = readLeaseMetadata(paths);
  if (current?.token === lease.metadata.token) {
    rmSync(paths.lease, { recursive: true, force: true });
  }
}

function runFailureMessage(result: QmdRunResult): string {
  if (result.timedOut) return "QMD operation timed out";
  if (result.spawnError) return result.spawnError.message;
  return result.stderr.trim() || `QMD exited with code ${String(result.exitCode)}`;
}

function embedFinished(result: QmdRunResult): boolean {
  if (!result.ok || result.parseError) return false;
  const data = result.structuredData as Record<string, unknown> | undefined;
  if (!data || data.schema !== "qmd.embed.v1") return false;
  if (data.status !== "ok") return false;
  if (data.skippedReason && data.skippedReason !== "no-pending-documents") return false;
  return typeof data.pendingAfter !== "number" || data.pendingAfter === 0;
}

async function recordFailure(
  stateRoot: string,
  indexKey: string,
  phase: "update" | "embed" | "coordinator",
  message: string,
  observedGeneration: number,
  updateSucceeded: boolean,
): Promise<QmdMaintenanceState> {
  const paths = qmdMaintenancePaths(stateRoot, indexKey);
  return withStateMutex(paths, () => {
    const current = readQmdMaintenanceState(stateRoot, indexKey);
    const sameGeneration = current.generation === observedGeneration;
    const next: QmdMaintenanceState = {
      ...current,
      updateCompletedGeneration: updateSucceeded
        ? Math.max(current.updateCompletedGeneration, observedGeneration)
        : current.updateCompletedGeneration,
      dirty: {
        ...current.dirty,
        bm25: updateSucceeded && sameGeneration ? false : current.dirty.bm25,
        vectors: phase === "update" ? current.dirty.vectors : true,
      },
      lastUpdateAt: updateSucceeded ? isoNow() : current.lastUpdateAt,
      lastError: { phase, message: message.slice(0, 500), at: isoNow() },
    };
    writeJsonAtomic(paths.state, next);
    return next;
  });
}

async function recordSuccess(
  stateRoot: string,
  indexKey: string,
  observedGeneration: number,
  updated: boolean,
  embedded: boolean,
): Promise<QmdMaintenanceState> {
  const paths = qmdMaintenancePaths(stateRoot, indexKey);
  return withStateMutex(paths, () => {
    const current = readQmdMaintenanceState(stateRoot, indexKey);
    const sameGeneration = current.generation === observedGeneration;
    const next: QmdMaintenanceState = {
      ...current,
      updateCompletedGeneration: updated
        ? Math.max(current.updateCompletedGeneration, observedGeneration)
        : current.updateCompletedGeneration,
      embedCompletedGeneration: embedded
        ? Math.max(current.embedCompletedGeneration, observedGeneration)
        : current.embedCompletedGeneration,
      dirty: sameGeneration
        ? {
            bm25: updated ? false : current.dirty.bm25,
            vectors: embedded ? false : current.dirty.vectors,
            collections: embedded ? [] : current.dirty.collections,
            reasons: (updated || !current.dirty.bm25) && (embedded || !current.dirty.vectors)
              ? []
              : current.dirty.reasons,
          }
        : current.dirty,
      lastUpdateAt: updated ? isoNow() : current.lastUpdateAt,
      lastEmbedAt: embedded ? isoNow() : current.lastEmbedAt,
      lastError: null,
    };
    writeJsonAtomic(paths.state, next);
    return next;
  });
}

function makeResult(
  status: QmdMaintenanceRunStatus,
  indexKey: string,
  observedGeneration: number,
  currentGeneration: number,
  recoveredStaleLease: boolean,
  extra: Pick<QmdMaintenanceRunResult, "update" | "embed" | "error"> = {},
): QmdMaintenanceRunResult {
  return {
    schema: "engram.qmd.maintenance-run.v1",
    status,
    indexKey,
    observedGeneration,
    currentGeneration,
    recoveredStaleLease,
    ...extra,
  };
}

export async function runQmdMaintenance(options: RunQmdMaintenanceOptions): Promise<QmdMaintenanceRunResult> {
  const { context, caller, stateRoot } = options;
  const indexKey = context.physicalIndex.key;
  const collections = validateCollections(options.collections);
  const timeoutMs = options.timeoutMs ?? 600_000;
  const leaseTtlMs = options.leaseTtlMs ?? Math.max(timeoutMs * 2, 60_000);
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) {
    throw contextError("QMD maintenance lease TTL must be a positive safe integer.");
  }
  if (caller.kind !== "coordinator") {
    throw contextError("runQmdMaintenance requires a trusted coordinator caller.");
  }

  const updateInvocation = buildQmdInvocation(context, { operation: "update", timeoutMs });
  const updateDecision = authorizeQmdInvocation(context, updateInvocation, caller);
  const embedInvocation = buildQmdInvocation(context, { operation: "embed", collections, timeoutMs });
  const embedDecision = authorizeQmdInvocation(context, embedInvocation, caller);
  const execute = options.execute ?? runQmdInvocation;
  const paths = qmdMaintenancePaths(stateRoot, indexKey);
  const lease = acquireMaintenanceLease(paths, indexKey, leaseTtlMs);
  if (!lease) {
    const current = readQmdMaintenanceState(stateRoot, indexKey);
    return makeResult("deferred", indexKey, current.generation, current.generation, false);
  }

  const renewEveryMs = Math.max(50, Math.floor(leaseTtlMs / 3));
  const renewal = setInterval(() => renewMaintenanceLease(paths, lease, leaseTtlMs), renewEveryMs);
  try {
    const snapshot = readQmdMaintenanceState(stateRoot, indexKey);
    const observedGeneration = snapshot.generation;
    if (!snapshot.dirty.bm25 && !snapshot.dirty.vectors) {
      return makeResult("clean", indexKey, observedGeneration, observedGeneration, lease.recoveredStale);
    }
    const maintenanceScope = new Set(collections);
    const unownedDirtyCollections = snapshot.dirty.collections.filter((collection) => !maintenanceScope.has(collection));
    if (unownedDirtyCollections.length > 0) {
      const message = `Dirty collections are outside the coordinator maintenance scope: ${unownedDirtyCollections.join(", ")}`;
      const current = await recordFailure(
        stateRoot,
        indexKey,
        "coordinator",
        message,
        observedGeneration,
        false,
      );
      return makeResult("error", indexKey, observedGeneration, current.generation, lease.recoveredStale, {
        error: { phase: "coordinator", message },
      });
    }

    let update: QmdRunResult | undefined;
    let embed: QmdRunResult | undefined;
    if (snapshot.dirty.bm25) {
      update = await execute(context, updateInvocation, { caller, decision: updateDecision, env: options.env });
      if (!update.ok) {
        const message = runFailureMessage(update);
        const current = await recordFailure(stateRoot, indexKey, "update", message, observedGeneration, false);
        return makeResult("partial", indexKey, observedGeneration, current.generation, lease.recoveredStale, {
          update,
          error: { phase: "update", message },
        });
      }
    }

    if (snapshot.dirty.vectors) {
      embed = await execute(context, embedInvocation, { caller, decision: embedDecision, env: options.env });
      if (!embedFinished(embed)) {
        const message = embed.ok
          ? "QMD embed did not complete all pending vectors"
          : runFailureMessage(embed);
        const current = await recordFailure(
          stateRoot,
          indexKey,
          "embed",
          message,
          observedGeneration,
          snapshot.dirty.bm25,
        );
        return makeResult("partial", indexKey, observedGeneration, current.generation, lease.recoveredStale, {
          ...(update ? { update } : {}),
          embed,
          error: { phase: "embed", message },
        });
      }
    }

    const current = await recordSuccess(
      stateRoot,
      indexKey,
      observedGeneration,
      snapshot.dirty.bm25,
      snapshot.dirty.vectors,
    );
    return makeResult("ok", indexKey, observedGeneration, current.generation, lease.recoveredStale, {
      ...(update ? { update } : {}),
      ...(embed ? { embed } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = await recordFailure(
      stateRoot,
      indexKey,
      "coordinator",
      message,
      readQmdMaintenanceState(stateRoot, indexKey).generation,
      false,
    );
    return makeResult("error", indexKey, current.generation, current.generation, lease.recoveredStale, {
      error: { phase: "coordinator", message },
    });
  } finally {
    clearInterval(renewal);
    releaseMaintenanceLease(paths, lease);
  }
}
