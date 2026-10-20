import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  BATCH_LIVE_FAILURE_SCHEMA,
  BATCH_LIVE_JOB_SCHEMA,
  type BatchLiveFailureV1,
  type BatchLiveJobV1,
} from "./batch-live-worker.ts";
import { deriveTraceId, sha256, type Digest, type JsonValue, type LedgerQueueRecordV1 } from "./ledger.ts";
import { AdmissionStore, deriveAdmissionGapReceiptId } from "./admission-store.ts";
import { isAdmissionGapRecovered } from "./admission-gap-recovery.ts";
import { RUNTIME_AUTHORITY } from "./runtime-authority.ts";
import { compileBatchFrame } from "./batch-compiler.ts";
import { memoryObservationBinding, memoryObservationCaptureOwner, resolveMemoryObservationProjection } from "./projection.ts";

export const BATCH_TERMINAL_RECOVERY_SCHEMA = "engram.memory-batch-terminal-recovery.v1" as const;
const BATCH_TERMINAL_RECOVERY_AUTHORIZATION_SCHEMA = "engram.memory-batch-terminal-recovery-authorization.v1" as const;
const ALLOWED_FAILURES = new Set(["batch_provider_failure", "batch_invalid_json", "batch_invalid_assertion"]);
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export type BatchTerminalRecoveryFaultPoint =
  | "after_authorization"
  | "after_failure_archive"
  | "after_done_archive"
  | "after_queue_requeue"
  | "before_completed"
  | "after_completed";

export class BatchTerminalRecoveryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BatchTerminalRecoveryError";
  }
}

export type BatchTerminalRecoveryPlan = {
  schema: typeof BATCH_TERMINAL_RECOVERY_SCHEMA;
  recoveryId: Digest;
  status: "planned" | "requeued" | "already-requeued";
  jobId: Digest;
  bundleId: Digest;
  failureCode: string;
  traceIds: Digest[];
  authorizedBy: string;
  authorizedAt: string;
  reason: string;
  archivedFailureRef: string;
  archivedDoneRef: string;
};

type RecoveryQueueSnapshot = {
  /** New admissions pin the full envelope/job/projection across crash recovery. */
  sourceProofDigest?: Digest;
  traceId: Digest;
  evidenceDigest: Digest;
  evidenceExpiresAt: string;
  originalDigest: Digest;
  original: LedgerQueueRecordV1;
  requeuedDigest: Digest;
  requeued: LedgerQueueRecordV1;
};

type BatchTerminalRecoveryAuthorization = {
  schema: typeof BATCH_TERMINAL_RECOVERY_AUTHORIZATION_SCHEMA;
  recoveryId: Digest;
  jobId: Digest;
  bundleId: Digest;
  failureCode: string;
  traceIds: Digest[];
  authorizedBy: string;
  authorizedAt: string;
  reason: string;
  failureDigest: Digest;
  doneDigest: Digest;
  queues: RecoveryQueueSnapshot[];
};

function fail(code: string, message: string): never {
  throw new BatchTerminalRecoveryError(code, message);
}

function digestKey(value: Digest): string {
  if (!DIGEST_RE.test(value)) fail("INVALID_DIGEST", "digest is invalid");
  return value.slice("sha256:".length);
}

export function readJson<T>(path: string): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { fail("STATE_CORRUPT", `invalid JSON artifact: ${path}`); }
}

export function valueDigest(value: unknown): Digest {
  return sha256(value as JsonValue);
}

function sameValue(left: unknown, right: unknown): boolean {
  return valueDigest(left) === valueDigest(right);
}

function flushDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temp, "wx", 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temp, path);
  flushDirectory(dirname(path));
}

export function writeImmutableExact(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temp, "wx", 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  try { linkSync(temp, path); }
  catch (error: any) {
    rmSync(temp, { force: true });
    if (error?.code !== "EEXIST") throw error;
    if (!sameValue(readJson<unknown>(path), value)) {
      fail("IMMUTABLE_CONFLICT", `immutable artifact conflicts with recovery state: ${path}`);
    }
    return;
  }
  rmSync(temp, { force: true });
  flushDirectory(dirname(path));
}

export function instant(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function injectFault(options: { faultAt?: BatchTerminalRecoveryFaultPoint }, point: BatchTerminalRecoveryFaultPoint): void {
  if (options.faultAt === point) fail("FAULT_INJECTED", `fault injection at ${point}`);
}

export function acquireRecoveryLock(path: string, recoveryId: Digest): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const owner = JSON.stringify({ schema: "engram.memory-batch-terminal-recovery-lock.v1", pid: process.pid, recoveryId, token: randomUUID() });
  while (true) {
    try {
      symlinkSync(owner, path);
      flushDirectory(dirname(path));
      return () => {
        try {
          if (readlinkSync(path) === owner) { unlinkSync(path); flushDirectory(dirname(path)); }
        } catch { /* already removed or replaced */ }
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      let observed: string;
      let lockOwner: { pid?: number };
      try { observed = readlinkSync(path); lockOwner = JSON.parse(observed); }
      catch { fail("WORKER_BUSY", "evaluator worker lock is held by an unreadable or legacy owner"); }
      if (!Number.isInteger(lockOwner.pid) || Number(lockOwner.pid) <= 0) fail("WORKER_BUSY", "evaluator worker lock owner is invalid");
      try { process.kill(Number(lockOwner.pid), 0); fail("WORKER_BUSY", "evaluator worker lock is held"); }
      catch (probe: any) {
        if (probe instanceof BatchTerminalRecoveryError) throw probe;
        if (probe?.code !== "ESRCH") fail("WORKER_BUSY", "evaluator worker lock owner cannot be disproved");
      }
      try {
        if (readlinkSync(path) !== observed) continue;
        unlinkSync(path);
        flushDirectory(dirname(path));
      } catch (reclaim: any) {
        if (reclaim?.code !== "ENOENT") throw reclaim;
      }
    }
  }
}

function recoveredQueue(queue: LedgerQueueRecordV1, authorizedAt: string): LedgerQueueRecordV1 {
  return {
    ...queue,
    status: "queued",
    attempt: 0,
    nextAttemptAt: authorizedAt,
    updatedAt: authorizedAt,
    claimedAt: null,
    claimToken: null,
    terminalAt: null,
    reasonCode: "operator_recovery_requeued",
  };
}

/** Migrate one legacy terminal defer to waiting, without inference or deleting history. */
export function restoreLegacyDefer(options: {
  workspace: string; storeRoot: string; jobId: Digest; traceId: Digest;
  authorizedBy: string; authorizedAt: string; reason: string; apply?: boolean;
  now?: Date; faultAt?: "after_authorization" | "after_queue_requeue";
}) {
  const now = options.now ?? new Date();
  if (!options.authorizedBy.trim() || !options.reason.trim() || !instant(options.authorizedAt)
    || Date.parse(options.authorizedAt) > now.getTime()) fail("INVALID_AUTHORIZATION", "explicit operator authorization is required");
  const workspace = resolve(options.workspace), root = join(workspace, "memory-state/memory-observation/v1");
  if (resolve(options.storeRoot) !== join(workspace, "memory-state/memory-observation/batch-live-store")) fail("SCOPE_MISMATCH", "expected workspace-owned batch store");
  const batchRoot = join(options.storeRoot, "memory-batch-live/v1"), jobKey = digestKey(options.jobId), traceKey = digestKey(options.traceId);
  const job = readJson<BatchLiveJobV1>(join(batchRoot, "jobs", jobKey + ".json"));
  const done: any = readJson(join(batchRoot, "done", jobKey + ".json"));
  const { terminalId, ...terminalBase } = done;
  if (job.schema !== BATCH_LIVE_JOB_SCHEMA || job.jobId !== options.jobId || done.jobId !== options.jobId
    || done.schema !== "engram.memory-batch-live-terminal.v1" || terminalId !== valueDigest(terminalBase)
    || done.bundleId !== job.bundle.bundleId || !job.bundle.sourceRefs.some(s => s.traceId === options.traceId)
    || done.dispositions.filter((d: any) => d.traceId === options.traceId).length !== 1
    || !done.dispositions.some((d: any) => d.traceId === options.traceId && d.decision === "defer"
      && d.reasonCode === "semantic_batch_defer" && d.observationRefs.length === 0)) fail("DEFER_INVALID", "exact completed defer required");
  const workspaceId = readJson<any>(join(workspace, "engram.json")).workspace.id;
  const projection = resolveMemoryObservationProjection({ workspace, workspaceId });
  const binding = memoryObservationBinding(projection, job.partition.runtimeSessionKey);
  if (!projection.enabled || !binding || job.partition.workspaceId !== workspaceId
    || binding.scopeId !== job.partition.scopeId || binding.scopeClass !== job.partition.scopeClass) fail("SCOPE_MISMATCH", "defer scope is not active");
  const recoveryId = valueDigest({ schema: "engram.legacy-defer-recovery.v1", jobId: options.jobId, traceId: options.traceId,
    authorizedBy: options.authorizedBy, authorizedAt: options.authorizedAt, reason: options.reason });
  const path = join(batchRoot, "recoveries", jobKey, digestKey(recoveryId));
  const authorizationPath = join(path, "authorization.json"), completionPath = join(path, "completed.json");
  const plan = { schema: "engram.legacy-defer-recovery.v1", recoveryId, jobId: options.jobId, traceId: options.traceId,
    authorizedBy: options.authorizedBy, authorizedAt: options.authorizedAt, reason: options.reason, status: "waiting_context", inferenceRun: false };
  if (existsSync(completionPath)) {
    if (!sameValue(readJson(completionPath), plan)) fail("COMPLETION_CONFLICT", "defer recovery completion mismatch");
    return plan;
  }
  const release = acquireRecoveryLock(join(root, "locks/evaluator.worker"), recoveryId);
  try {
    const evidence: any = readJson(join(root, "evidence", traceKey + ".json"));
    if (evidence.traceId !== options.traceId || !instant(evidence.expiresAt) || Date.parse(evidence.expiresAt) <= now.getTime()
      || evidence.scope.workspaceId !== workspaceId || evidence.scope.runtimeSessionKey !== job.partition.runtimeSessionKey
      || evidence.scope.scopeId !== binding.scopeId || evidence.scope.scopeClass !== binding.scopeClass
      || !sameValue(job.bundle.inputs.find(i => i.traceId === options.traceId)?.evidence, evidence.payload)) fail("SOURCE_MISSING", "retained exact-scope evidence required");
    const queuePath = join(root, "queues/evaluator", traceKey + ".json");
    const current = readJson<LedgerQueueRecordV1>(queuePath);
    const original = existsSync(authorizationPath) ? readJson<any>(authorizationPath).original : current;
    if (original.traceId !== options.traceId || original.status !== "terminal" || original.reasonCode !== "semantic_batch_defer"
      || original.claimToken !== null || original.terminalAt === null) fail("QUEUE_INELIGIBLE", "only legacy terminal defer is eligible");
    const waiting = { ...recoveredQueue(original, options.authorizedAt), reasonCode: "semantic_batch_defer" };
    const authorization = { ...plan, original, waiting, evidenceDigest: valueDigest(evidence), doneDigest: valueDigest(done) };
    if (existsSync(authorizationPath) && !sameValue(readJson(authorizationPath), authorization)) fail("AUTHORIZATION_CONFLICT", "defer recovery authorization changed");
    if (!sameValue(current, original) && !sameValue(current, waiting)) fail("QUEUE_STATE_DIVERGED", "defer queue changed");
    if (!options.apply) return { ...plan, status: "planned" };
    if (!sameValue(resolveMemoryObservationProjection({ workspace, workspaceId }), projection)) fail("SCOPE_MISMATCH", "projection changed");
    writeImmutableExact(authorizationPath, authorization);
    injectFault(options, "after_authorization");
    if (sameValue(current, original)) writeAtomic(queuePath, waiting);
    injectFault(options, "after_queue_requeue");
    writeImmutableExact(completionPath, plan);
    return plan;
  } finally { release(); }
}

function validateFailure(job: BatchLiveJobV1, failure: BatchLiveFailureV1, done: BatchLiveFailureV1): void {
  const { failureId: _failureId, ...failureBase } = failure;
  if (failure.schema !== BATCH_LIVE_FAILURE_SCHEMA
    || failure.jobId !== job.jobId
    || failure.bundleId !== job.bundle.bundleId
    || failure.failureId !== sha256(failureBase as unknown as JsonValue)
    || !sameValue(done, failure)
    || !ALLOWED_FAILURES.has(failure.errorCode)
    || failure.traceIds.length === 0
    || new Set(failure.traceIds).size !== failure.traceIds.length) {
    fail("FAILURE_INVALID", "terminal failure is not eligible for bounded recovery");
  }
}

function readArtifactCandidate<T>(source: string, archive: string, label: string): T {
  const sourceExists = existsSync(source);
  const archiveExists = existsSync(archive);
  if (!sourceExists && !archiveExists) fail("FAILURE_MISSING", `${label} artifact is unavailable`);
  const sourceValue = sourceExists ? readJson<T>(source) : undefined;
  const archiveValue = archiveExists ? readJson<T>(archive) : undefined;
  if (sourceValue !== undefined && archiveValue !== undefined && !sameValue(sourceValue, archiveValue)) {
    fail("ARTIFACT_DIVERGED", `${label} source and archive conflict`);
  }
  return (archiveValue ?? sourceValue)!;
}

function archiveArtifact(source: string, archive: string, expectedDigest: Digest, label: string): void {
  const sourceExists = existsSync(source);
  const archiveExists = existsSync(archive);
  if (sourceExists && valueDigest(readJson<unknown>(source)) !== expectedDigest) fail("ARTIFACT_DIVERGED", `${label} source content changed after authorization`);
  if (archiveExists && valueDigest(readJson<unknown>(archive)) !== expectedDigest) fail("ARTIFACT_DIVERGED", `${label} archive content changed after authorization`);
  if (sourceExists && archiveExists) fail("ARTIFACT_DIVERGED", `${label} exists in both source and archive`);
  if (!sourceExists && !archiveExists) fail("FAILURE_MISSING", `${label} artifact is unavailable`);
  if (sourceExists) {
    mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
    renameSync(source, archive);
    flushDirectory(dirname(source));
    if (dirname(source) !== dirname(archive)) flushDirectory(dirname(archive));
  }
}

function validateAuthorization(authorization: BatchTerminalRecoveryAuthorization, expected: Omit<BatchTerminalRecoveryAuthorization, "queues">): void {
  const { queues, ...base } = authorization;
  if (!sameValue(base, expected) || queues.length !== expected.traceIds.length
    || new Set(queues.map((entry) => entry.traceId)).size !== queues.length) {
    fail("AUTHORIZATION_CONFLICT", "persisted recovery authorization does not match the requested recovery");
  }
  for (const traceId of expected.traceIds) {
    const entry = queues.find((candidate) => candidate.traceId === traceId);
    if (!entry || (entry.sourceProofDigest !== undefined && !DIGEST_RE.test(entry.sourceProofDigest))
      || !DIGEST_RE.test(entry.evidenceDigest) || !instant(entry.evidenceExpiresAt)
      || Date.parse(entry.evidenceExpiresAt) <= Date.parse(expected.authorizedAt)
      || entry.originalDigest !== valueDigest(entry.original) || entry.requeuedDigest !== valueDigest(entry.requeued)
      || entry.original.traceId !== traceId || entry.original.status !== "terminal"
      || entry.original.reasonCode !== expected.failureCode || entry.original.claimToken !== null || entry.original.terminalAt === null
      || !sameValue(entry.requeued, recoveredQueue(entry.original, expected.authorizedAt))) {
      fail("AUTHORIZATION_CONFLICT", "persisted queue snapshot is invalid");
    }
  }
}

export function recoverTerminalBatch(options: {
  workspace: string;
  storeRoot: string;
  jobId: Digest;
  authorizedBy: string;
  authorizedAt: string;
  reason: string;
  apply?: boolean;
  now?: Date;
  /** Synthetic race hook; invoked before the locked second preflight. */
  beforeLock?: () => void;
  faultAt?: BatchTerminalRecoveryFaultPoint;
}): BatchTerminalRecoveryPlan {
  const workspace = realpathSync(resolve(options.workspace));
  const storeRoot = resolve(options.storeRoot);
  const now = () => options.now ?? new Date();
  const checkStore = () => {
    const expected = join(workspace, "memory-state/memory-observation/batch-live-store");
    if (storeRoot !== expected || !existsSync(expected) || realpathSync(expected) !== expected) {
      fail("SCOPE_MISMATCH", "expected canonical workspace-owned batch store");
    }
  };
  checkStore();
  if (!options.authorizedBy.trim() || !options.reason.trim() || !instant(options.authorizedAt)
    || !Number.isFinite(now().getTime()) || Date.parse(options.authorizedAt) > now().getTime()) {
    fail("INVALID_AUTHORIZATION", "authorizedBy, canonical authorizedAt, and reason are required");
  }
  const key = digestKey(options.jobId);
  const batchRoot = join(storeRoot, "memory-batch-live", "v1");
  const jobPath = join(batchRoot, "jobs", `${key}.json`);
  const failurePath = join(batchRoot, "failures", `${key}.json`);
  const donePath = join(batchRoot, "done", `${key}.json`);
  if (!existsSync(jobPath)) fail("JOB_MISSING", "batch job is unavailable");
  const job = readJson<BatchLiveJobV1>(jobPath);
  if (job.schema !== BATCH_LIVE_JOB_SCHEMA || job.jobId !== options.jobId) fail("JOB_INVALID", "batch job identity is invalid");

  const recoveryId = sha256({
    schema: BATCH_TERMINAL_RECOVERY_SCHEMA,
    jobId: options.jobId,
    authorizedBy: options.authorizedBy,
    authorizedAt: options.authorizedAt,
    reason: options.reason,
  } as unknown as JsonValue);
  const recoveryRoot = join(batchRoot, "recoveries", key, digestKey(recoveryId));
  const archivedFailureRef = join(recoveryRoot, "failure.json");
  const archivedDoneRef = join(recoveryRoot, "done.json");
  const authorizationPath = join(recoveryRoot, "authorization.json");
  const completedPath = join(recoveryRoot, "completed.json");
  const failure = readArtifactCandidate<BatchLiveFailureV1>(failurePath, archivedFailureRef, "terminal failure");
  const done = readArtifactCandidate<BatchLiveFailureV1>(donePath, archivedDoneRef, "done marker");
  validateFailure(job, failure, done);
  const failureDigest = valueDigest(failure);
  const doneDigest = valueDigest(done);

  const queueRoot = join(workspace, "memory-state", "memory-observation", "v1", "queues", "evaluator");
  const evidenceRoot = join(workspace, "memory-state", "memory-observation", "v1", "evidence");
  const plan: BatchTerminalRecoveryPlan = {
    schema: BATCH_TERMINAL_RECOVERY_SCHEMA,
    recoveryId,
    status: options.apply ? "requeued" : "planned",
    jobId: job.jobId,
    bundleId: job.bundle.bundleId,
    failureCode: failure.errorCode,
    traceIds: failure.traceIds,
    authorizedBy: options.authorizedBy,
    authorizedAt: options.authorizedAt,
    reason: options.reason,
    archivedFailureRef,
    archivedDoneRef,
  };
  const authorizationBase: Omit<BatchTerminalRecoveryAuthorization, "queues"> = {
    schema: BATCH_TERMINAL_RECOVERY_AUTHORIZATION_SCHEMA,
    recoveryId,
    jobId: job.jobId,
    bundleId: job.bundle.bundleId,
    failureCode: failure.errorCode,
    traceIds: failure.traceIds,
    authorizedBy: options.authorizedBy,
    authorizedAt: options.authorizedAt,
    reason: options.reason,
    failureDigest,
    doneDigest,
  };
  // A completed operation is an immutable requeue receipt, not a new admission.
  // Downstream queues/evidence may already have advanced or expired.
  if (existsSync(completedPath)) {
    if (!existsSync(authorizationPath)) fail("AUTHORIZATION_CONFLICT", "completed recovery has no authorization");
    validateAuthorization(readJson(authorizationPath), authorizationBase);
    const completed = readJson<BatchTerminalRecoveryPlan>(completedPath);
    if (!sameValue(completed, { ...plan, status: "requeued" })) fail("COMPLETION_CONFLICT", "completed recovery artifact does not match the authorized recovery");
    return completed;
  }
  const stateRoot = join(workspace, "memory-state/memory-observation/v1");
  const workspaceId = readJson<any>(join(workspace, "engram.json")).workspace?.id;
  const projection = resolveMemoryObservationProjection({ workspace, workspaceId });
  const projectionDigest = valueDigest(projection);
  const sourcePaths = failure.traceIds.map(traceId => ({
    envelope: join(stateRoot, "envelopes", `${digestKey(traceId)}.json`),
    evidence: join(evidenceRoot, `${digestKey(traceId)}.json`),
  }));
  const sourceDigests = sourcePaths.map(paths => valueDigest(readJson(paths.envelope)));
  const touchesSource = (value: unknown): boolean => {
    if (typeof value === "string") return value === job.bundle.bundleId || value === job.jobId || failure.traceIds.includes(value as Digest)
      || job.bundle.sourceRefs.some(source => source.sourceTurnId === value);
    if (Array.isArray(value)) return value.some(touchesSource);
    return Boolean(value && typeof value === "object" && Object.values(value).some(touchesSource));
  };
  // A verified admission-recovery receipt proves provenance, not a downstream
  // evaluation effect. Only the exact authenticated candidate directory is
  // exempt; arbitrary receipts (including other recovery candidates) still block.
  const verifiedAdmissionRecoveryPaths = new Set<string>();
  const rejectMatchingArtifact = (directory: string, traces = false) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("STATE_CORRUPT", "effect directories must not contain symlinks");
      if (verifiedAdmissionRecoveryPaths.has(path)) continue;
      if (entry.isDirectory()) {
        rejectMatchingArtifact(path, traces);
      }
      else if (entry.name.endsWith(".json")) {
        const record = readJson<any>(path);
        if ((!traces || record.stage !== "source_completed") && touchesSource(record)) {
          fail("EFFECTS_EXIST", "source already has persisted results, observations or effects");
        }
      }
    }
  };
  const checkSourcesAndScope = () => {
    checkStore();
    const currentProjection = resolveMemoryObservationProjection({ workspace, workspaceId });
    const binding = memoryObservationBinding(currentProjection, job.partition.runtimeSessionKey);
    if (readJson<any>(join(workspace, "engram.json")).workspace?.id !== workspaceId
      || valueDigest(currentProjection) !== projectionDigest || job.partition.workspaceId !== workspaceId
      || !binding || binding.scopeId !== job.partition.scopeId || binding.scopeClass !== job.partition.scopeClass
      || memoryObservationCaptureOwner(currentProjection, job.partition.runtimeSessionKey, now()) !== "observer"
      || currentProjection.evaluation?.mode !== "batch-cron"
      || currentProjection.evaluation.batch?.sourcePolicyDigest !== job.partition.policyDigest
      || currentProjection.evaluation.policyDigest !== job.evaluationPolicyDigest) {
      fail("SCOPE_MISMATCH", "current observer binding or source/evaluation policy does not match the failed job");
    }
    const bindingFingerprint = valueDigest({ workspaceId, scopeClass: binding.scopeClass, scopeId: binding.scopeId,
      requireOwner: binding.requireOwner, ...(binding.topicDomain ? { topicDomain: binding.topicDomain } : {}),
      ...(binding.groupDomain ? { groupDomain: binding.groupDomain } : {}), allowedChannels: [...binding.allowedChannels].sort() });
    const checkpoints = new AdmissionStore(workspace, RUNTIME_AUTHORITY).scanCheckpoints();
    if (checkpoints.corrupt.length) fail("STATE_CORRUPT", "retained source admission checkpoint is corrupt");
    verifiedAdmissionRecoveryPaths.clear();
    for (const source of job.bundle.sourceRefs) {
      const matches = checkpoints.records.filter(checkpoint => checkpoint.sourceTurnId === source.sourceTurnId);
      const checkpoint = matches.length === 1 ? matches[0]! : null;
      const recovered = checkpoint?.stage === "terminal_gap" && isAdmissionGapRecovered(workspace, checkpoint);
      if (!checkpoint || (checkpoint.stage !== "ledger_admitted" && !recovered)
        || matches[0]!.bindingFingerprint !== bindingFingerprint
        || matches[0]!.scope.workspaceId !== workspaceId
        || matches[0]!.scope.runtimeSessionKey !== job.partition.runtimeSessionKey
        || matches[0]!.scope.scopeClass !== binding.scopeClass || matches[0]!.scope.scopeId !== binding.scopeId
        || !binding.allowedChannels.includes(matches[0]!.channel)) {
        fail("SCOPE_MISMATCH", "source admission checkpoint does not match the current exact binding fingerprint");
      }
      if (recovered) {
        verifiedAdmissionRecoveryPaths.add(join(stateRoot, "receipts/admission-recovery", checkpoint.candidateId.slice(7)));
        verifiedAdmissionRecoveryPaths.add(join(stateRoot, "receipts/admission-gap", deriveAdmissionGapReceiptId(checkpoint.candidateId).slice(7) + ".json"));
      }
    }
    if (!sameValue(readJson(jobPath), job)
      || valueDigest(readArtifactCandidate(failurePath, archivedFailureRef, "terminal failure")) !== failureDigest
      || valueDigest(readArtifactCandidate(donePath, archivedDoneRef, "done marker")) !== doneDigest) {
      fail("ARTIFACT_DIVERGED", "job or terminal artifacts changed since preflight");
    }
    if (!sameValue(failure.traceIds, job.bundle.sourceRefs.map(source => source.traceId))) {
      fail("SOURCE_MISMATCH", "failure must cover the exact sealed source set");
    }
    const sources = sourcePaths.map((paths, index) => {
      const envelope = readJson<any>(paths.envelope), evidence = readJson<any>(paths.evidence);
      if (valueDigest(envelope) !== sourceDigests[index]
        || envelope.traceId !== deriveTraceId(workspaceId, job.partition.runtimeSessionKey, envelope.sourceTurnId)) {
        fail("SOURCE_MISMATCH", "source envelope changed or trace identity is invalid");
      }
      if (!instant(evidence.expiresAt) || Date.parse(evidence.expiresAt) <= Math.max(Date.parse(options.authorizedAt), now().getTime())) {
        fail("EVIDENCE_EXPIRED", "terminal source evidence is unavailable or expired");
      }
      return { envelope, evidence };
    });
    // Reuse the strict compiler to verify every envelope/evidence field and digest,
    // then compare the complete reconstructed immutable bundle, not only its ID.
    const compiled = compileBatchFrame({ schema: "engram.memory-batch-source-frame.v1", partition: job.partition,
      sealedAt: job.createdAt, sources }, { schema: "engram.memory-batch-compiler-config.v1",
      inactivityGapMs: Number.MAX_SAFE_INTEGER, maxTurns: 100_000,
      maxEvidenceBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER });
    if (compiled.bundles.length !== 1 || compiled.exclusions.length || !sameValue(compiled.bundles[0], job.bundle)
      || job.jobId !== valueDigest({ schema: BATCH_LIVE_JOB_SCHEMA, partition: job.partition,
        evaluationPolicyDigest: job.evaluationPolicyDigest, bundleId: job.bundle.bundleId })) {
      fail("SOURCE_MISMATCH", "sealed bundle or job digest does not match retained sources");
    }
    for (const kind of ["contextual-results", "terminals", "reconciliations"]) {
      if (existsSync(join(batchRoot, kind, `${key}.json`))) fail("EFFECTS_EXIST", "persisted result requires effect reconciliation");
    }
    rejectMatchingArtifact(join(storeRoot, "memory-batch-shadow/v1/results"));
    rejectMatchingArtifact(join(stateRoot, "observations"));
    rejectMatchingArtifact(join(stateRoot, "receipts"));
    rejectMatchingArtifact(join(stateRoot, "traces"), true);
    rejectMatchingArtifact(join(workspace, "memory-state/domain-effects/v1"));
  };
  let authorization: BatchTerminalRecoveryAuthorization;
  if (existsSync(authorizationPath)) {
    authorization = readJson<BatchTerminalRecoveryAuthorization>(authorizationPath);
    validateAuthorization(authorization, authorizationBase);
  } else {
    const queues = failure.traceIds.map((traceId): RecoveryQueueSnapshot => {
      const traceKey = digestKey(traceId);
      const queuePath = join(queueRoot, `${traceKey}.json`);
      const evidencePath = join(evidenceRoot, `${traceKey}.json`);
      if (!existsSync(queuePath) || !existsSync(evidencePath)) fail("SOURCE_MISSING", "terminal queue or evidence is unavailable");
      const queue = readJson<LedgerQueueRecordV1>(queuePath);
      const evidence = readJson<{ traceId: Digest; expiresAt: string }>(evidencePath);
      if (queue.traceId !== traceId || queue.status !== "terminal" || queue.reasonCode !== failure.errorCode
        || queue.claimToken !== null || queue.terminalAt === null) fail("QUEUE_INELIGIBLE", "terminal queue is not in the recorded failure state");
      if (evidence.traceId !== traceId || !instant(evidence.expiresAt)
        || Date.parse(evidence.expiresAt) <= Math.max(Date.parse(options.authorizedAt), now().getTime())) fail("EVIDENCE_EXPIRED", "terminal source evidence is unavailable or expired");
      const requeued = recoveredQueue(queue, options.authorizedAt);
      return {
        traceId,
        sourceProofDigest: valueDigest({ envelope: readJson(join(stateRoot, "envelopes", `${traceKey}.json`)), job, projection }),
        evidenceDigest: valueDigest(evidence),
        evidenceExpiresAt: evidence.expiresAt,
        originalDigest: valueDigest(queue),
        original: queue,
        requeuedDigest: valueDigest(requeued),
        requeued,
      };
    });
    authorization = { ...authorizationBase, queues };
  }
  const check = () => {
    checkSourcesAndScope();
    if (existsSync(authorizationPath) && !sameValue(readJson(authorizationPath), authorization)) fail("AUTHORIZATION_CONFLICT", "recovery authorization changed");
    for (const queueSnapshot of authorization.queues) {
      const envelope = readJson(join(stateRoot, "envelopes", `${digestKey(queueSnapshot.traceId)}.json`));
      if (queueSnapshot.sourceProofDigest !== valueDigest({ envelope, job, projection })) {
        fail("SOURCE_MISMATCH", "source envelope, job or projection changed since recovery authorization");
      }
      const queuePath = join(queueRoot, `${digestKey(queueSnapshot.traceId)}.json`);
      const evidencePath = join(evidenceRoot, `${digestKey(queueSnapshot.traceId)}.json`);
      if (!existsSync(queuePath)) fail("SOURCE_MISSING", "terminal queue is unavailable");
      if (!existsSync(evidencePath)) fail("SOURCE_MISSING", "terminal evidence is unavailable");
      const currentDigest = valueDigest(readJson<LedgerQueueRecordV1>(queuePath));
      const evidence = readJson<{ traceId: Digest; expiresAt: string }>(evidencePath);
      if (evidence.traceId !== queueSnapshot.traceId || evidence.expiresAt !== queueSnapshot.evidenceExpiresAt
        || valueDigest(evidence) !== queueSnapshot.evidenceDigest || Date.parse(evidence.expiresAt) <= Math.max(Date.parse(options.authorizedAt), now().getTime())) {
        fail("EVIDENCE_DIVERGED", `evidence changed or expired after recovery authorization: ${queueSnapshot.traceId}`);
      }
      if (currentDigest !== queueSnapshot.originalDigest && currentDigest !== queueSnapshot.requeuedDigest) {
        fail("QUEUE_STATE_DIVERGED", `queue state changed after recovery authorization: ${queueSnapshot.traceId}`);
      }
    }
  };
  check();
  if (!options.apply) return plan;
  options.beforeLock?.();

  const lockPath = join(workspace, "memory-state", "memory-observation", "v1", "locks", "evaluator.worker");
  const releaseLock = acquireRecoveryLock(lockPath, recoveryId);
  try {
    check();
    writeImmutableExact(authorizationPath, authorization);
    injectFault(options, "after_authorization");
    archiveArtifact(failurePath, archivedFailureRef, authorization.failureDigest, "terminal failure");
    injectFault(options, "after_failure_archive");
    archiveArtifact(donePath, archivedDoneRef, authorization.doneDigest, "done marker");
    injectFault(options, "after_done_archive");
    for (const queueSnapshot of authorization.queues) {
      const queuePath = join(queueRoot, `${digestKey(queueSnapshot.traceId)}.json`);
      if (!existsSync(queuePath)) fail("SOURCE_MISSING", "terminal queue is unavailable");
      const current = readJson<LedgerQueueRecordV1>(queuePath);
      const currentDigest = valueDigest(current);
      if (currentDigest === queueSnapshot.originalDigest) writeAtomic(queuePath, queueSnapshot.requeued);
      else if (currentDigest !== queueSnapshot.requeuedDigest) fail("QUEUE_STATE_DIVERGED", `queue state changed after recovery authorization: ${queueSnapshot.traceId}`);
      injectFault(options, "after_queue_requeue");
    }
    injectFault(options, "before_completed");
    const completed = { ...plan, status: "requeued" as const };
    writeImmutableExact(completedPath, completed);
    injectFault(options, "after_completed");
    return completed;
  } finally {
    releaseLock();
  }
}

/** Explicit bounded recovery of exhausted contextual sources. The immutable
 * reconciled job stays done: recovered rows form a new bundle under the current
 * producer. Old errors and receipts remain visible; no result is injected. */
export function recoverReconciledBatch(options: {
  workspace: string; storeRoot: string; jobId: Digest;
  authorizedBy: string; authorizedAt: string; reason: string; apply?: boolean;
  now?: Date; faultAt?: BatchTerminalRecoveryFaultPoint;
}) {
  if (!options.authorizedBy.trim() || !options.reason.trim() || !instant(options.authorizedAt)) fail('INVALID_AUTHORIZATION','explicit recovery authorization required');
  const state = join(resolve(options.workspace),'memory-state/memory-observation/v1');
  const root = join(resolve(options.storeRoot),'memory-batch-live/v1');
  const key = digestKey(options.jobId);
  const job = readJson<BatchLiveJobV1>(join(root,'jobs',key+'.json'));
  const reconciliation = readJson<any>(join(root,'reconciliations',key+'.json'));
  const done = readJson<any>(join(root,'done',key+'.json'));
  const {reconciliationId,...reconciliationBody} = reconciliation;
  if (job.schema !== BATCH_LIVE_JOB_SCHEMA || job.jobId !== options.jobId
    || reconciliation.schema !== 'engram.memory-batch-live-reconciliation.v1'
    || reconciliation.jobId !== job.jobId || reconciliation.bundleId !== job.bundle.bundleId
    || reconciliation.evaluationPolicyDigest !== job.evaluationPolicyDigest
    || reconciliationId !== valueDigest(reconciliationBody) || !sameValue(done,reconciliation)
    || !sameValue(reconciliation.sources.map((s:any)=>s.traceId),job.bundle.sourceRefs.map(s=>s.traceId))) fail('RECONCILIATION_INVALID','reconciled batch identity changed');
  if (existsSync(join(root,'contextual-results',key+'.json')) || existsSync(join(root,'terminals',key+'.json')))
    fail('EFFECTS_EXIST','a persisted result requires effect reconciliation, not source requeue');
  const observationRoot=join(state,'observations/batch');
  if (existsSync(observationRoot) && readdirSync(observationRoot).filter(n=>n.endsWith('.json')).some(n=>readJson<any>(join(observationRoot,n)).bundleId===job.bundle.bundleId))
    fail('EFFECTS_EXIST','observations already exist for this batch');
  const eligible=reconciliation.sources.filter((s:any)=>s.status==='terminal' && s.reasonCode==='batch_contextual_evaluation_failed' && s.attempt>=s.maxAttempts);
  if (!eligible.length || new Set(eligible.map((s:any)=>s.traceId)).size!==eligible.length) fail('QUEUE_INELIGIBLE','no unique exhausted contextual sources');
  const base={schema:'engram.memory-reconciled-recovery.v1',jobId:job.jobId,reconciliationId,
    authorizedBy:options.authorizedBy,authorizedAt:options.authorizedAt,reason:options.reason,traceIds:eligible.map((s:any)=>s.traceId)};
  const recoveryId=valueDigest(base),path=join(root,'recoveries',key,digestKey(recoveryId));
  const authPath=join(path,'authorization.json'),completePath=join(path,'completed.json');
  const plan={...base,recoveryId,status:'requeued'};
  if (existsSync(completePath)) {
    if (!sameValue(readJson(completePath),plan)) fail('COMPLETION_CONFLICT','recovery receipt changed');
    return plan;
  }
  const readQueue=(trace:Digest)=>readJson<LedgerQueueRecordV1>(join(state,'queues/evaluator',digestKey(trace)+'.json'));
  const snapshots: RecoveryQueueSnapshot[] = existsSync(authPath) ? readJson<any>(authPath).queues : eligible.map((source:any)=>{
    const original=readQueue(source.traceId),evidence=readJson<any>(join(state,'evidence',digestKey(source.traceId)+'.json'));
    if (valueDigest(original)!==source.queueDigest || original.status!=='terminal' || original.reasonCode!==source.reasonCode
      || original.claimToken!==null || original.traceId!==source.traceId) fail('QUEUE_STATE_DIVERGED','queue no longer matches exhaustion receipt');
    const requeued=recoveredQueue(original,options.authorizedAt);
    return {traceId:source.traceId,original,originalDigest:valueDigest(original),requeued,requeuedDigest:valueDigest(requeued),evidenceDigest:valueDigest(evidence),evidenceExpiresAt:evidence.expiresAt};
  });
  const authorization={...base,recoveryId,queues:snapshots};
  if (existsSync(authPath) && !sameValue(readJson(authPath),authorization)) fail('AUTHORIZATION_CONFLICT','authorization identity changed');
  const check=()=>{
    if (snapshots.length!==eligible.length || new Set(snapshots.map(s=>s.traceId)).size!==snapshots.length) fail('AUTHORIZATION_CONFLICT','queue coverage changed');
    for(const s of snapshots) {
      const source=eligible.find((x:any)=>x.traceId===s.traceId),evidence=readJson<any>(join(state,'evidence',digestKey(s.traceId)+'.json'));
      if (!source || s.originalDigest!==source.queueDigest || s.originalDigest!==valueDigest(s.original)
        || s.requeuedDigest!==valueDigest(s.requeued) || !sameValue(s.requeued,recoveredQueue(s.original,options.authorizedAt))) fail('AUTHORIZATION_CONFLICT','queue snapshot changed');
      if (evidence.traceId!==s.traceId || !instant(evidence.expiresAt) || valueDigest(evidence)!==s.evidenceDigest
        || Date.parse(evidence.expiresAt)<=Math.max(Date.parse(options.authorizedAt),(options.now??new Date()).getTime())) fail('EVIDENCE_EXPIRED','evidence changed or expired');
      if (![s.originalDigest,s.requeuedDigest].includes(valueDigest(readQueue(s.traceId)))) fail('QUEUE_STATE_DIVERGED','queue changed since authorization');
    }
  };
  check();
  if (!options.apply) return {...plan,status:'planned'};
  const release=acquireRecoveryLock(join(state,'locks/evaluator.worker'),recoveryId);
  try {
    check();writeImmutableExact(authPath,authorization);injectFault(options,'after_authorization');
    for(const s of snapshots) {
      const current=valueDigest(readQueue(s.traceId));
      if(current===s.originalDigest) writeAtomic(join(state,'queues/evaluator',digestKey(s.traceId)+'.json'),s.requeued);
      else if(current!==s.requeuedDigest) fail('QUEUE_STATE_DIVERGED','queue changed during recovery');
      injectFault(options,'after_queue_requeue');
    }
    injectFault(options,'before_completed');writeImmutableExact(completePath,plan);injectFault(options,'after_completed');return plan;
  } finally {release();}
}

/** Operator-reviewed false skip. Unlike a retry of a failed batch, the old
 * successful terminal/result and other sources' effects remain untouched. */
export function recoverReviewedSkip(options: {
  workspace: string; storeRoot: string; jobId: Digest; traceId: Digest;
  authorizedBy: string; authorizedAt: string; reason: string; apply?: boolean;
  now?: Date; faultAt?: BatchTerminalRecoveryFaultPoint;
}) {
  if(!options.authorizedBy.trim()||!options.reason.trim()||!instant(options.authorizedAt)) fail('INVALID_AUTHORIZATION','explicit skip review required');
  const root=join(resolve(options.storeRoot),'memory-batch-live/v1'),state=join(resolve(options.workspace),'memory-state/memory-observation/v1');
  const key=digestKey(options.jobId),traceKey=digestKey(options.traceId);
  const job=readJson<BatchLiveJobV1>(join(root,'jobs',key+'.json')),terminal=readJson<any>(join(root,'terminals',key+'.json'));
  const {terminalId,...terminalBody}=terminal;
  if(job.schema!==BATCH_LIVE_JOB_SCHEMA||job.jobId!==options.jobId||!job.bundle.sourceRefs.some(s=>s.traceId===options.traceId)
    ||terminal.schema!=='engram.memory-batch-live-terminal.v2'||terminal.jobId!==job.jobId||terminal.bundleId!==job.bundle.bundleId
    ||terminalId!==valueDigest(terminalBody)||!sameValue(terminal,readJson(join(root,'done',key+'.json')))
    ||!terminal.dispositions.some((d:any)=>d.traceId===options.traceId&&d.decision==='skip'&&d.reasonCode==='semantic_contextual_skip'&&d.observationRefs.length===0))
    fail('SKIP_REVIEW_INVALID','target is not an exact completed contextual skip');
  const base={schema:'engram.memory-reviewed-skip-recovery.v1',jobId:job.jobId,traceId:options.traceId,terminalId,
    authorizedBy:options.authorizedBy,authorizedAt:options.authorizedAt,reason:options.reason};
  const recoveryId=valueDigest(base),path=join(root,'recoveries',key,digestKey(recoveryId));
  const plan={...base,recoveryId,status:'requeued'},authPath=join(path,'authorization.json'),completePath=join(path,'completed.json');
  if(existsSync(completePath)){if(!sameValue(readJson(completePath),plan))fail('COMPLETION_CONFLICT','review receipt changed');return plan;}
  const queuePath=join(state,'queues/evaluator',traceKey+'.json'),evidencePath=join(state,'evidence',traceKey+'.json');
  const original=existsSync(authPath)?readJson<any>(authPath).original:readJson<LedgerQueueRecordV1>(queuePath);
  if(original.traceId!==options.traceId||original.status!=='terminal'||original.reasonCode!=='semantic_contextual_skip'||original.claimToken!==null) fail('QUEUE_INELIGIBLE','only reviewed skips may be retried');
  const requeued=recoveredQueue(original,options.authorizedAt),evidence=readJson<any>(evidencePath);
  const auth={...base,recoveryId,original,requeued,evidenceDigest:valueDigest(evidence)};
  if(existsSync(authPath)&&!sameValue(readJson(authPath),auth))fail('AUTHORIZATION_CONFLICT','review authorization changed');
  const check=()=>{
    if(evidence.traceId!==options.traceId||!instant(evidence.expiresAt)||valueDigest(readJson(evidencePath))!==auth.evidenceDigest
      ||Date.parse(evidence.expiresAt)<=Math.max(Date.parse(options.authorizedAt),(options.now??new Date()).getTime()))fail('EVIDENCE_EXPIRED','reviewed source changed or expired');
    if(![valueDigest(original),valueDigest(requeued)].includes(valueDigest(readJson(queuePath))))fail('QUEUE_STATE_DIVERGED','reviewed queue changed');
    const observations=join(state,'observations/batch');
    if(existsSync(observations)&&readdirSync(observations).filter(n=>n.endsWith('.json')).some(n=>readJson<any>(join(observations,n)).sourceRefs?.some((s:any)=>s.traceId===options.traceId)))
      fail('EFFECTS_EXIST','source already has observations; do not duplicate them');
  };
  check();if(!options.apply)return {...plan,status:'planned'};
  const release=acquireRecoveryLock(join(state,'locks/evaluator.worker'),recoveryId);
  try{check();writeImmutableExact(authPath,auth);injectFault(options,'after_authorization');writeAtomic(queuePath,requeued);injectFault(options,'after_queue_requeue');writeImmutableExact(completePath,plan);injectFault(options,'after_completed');return plan;}finally{release();}
}
