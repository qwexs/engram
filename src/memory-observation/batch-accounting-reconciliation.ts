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
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BATCH_LIVE_JOB_SCHEMA, type BatchLiveJobV1 } from "./batch-live-worker.ts";
import { sha256, type Digest, type JsonValue, type LedgerQueueRecordV1 } from "./ledger.ts";

export const BATCH_ACCOUNTING_RECONCILIATION_SCHEMA = "engram.memory-batch-accounting-reconciliation.v1" as const;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const FAILURE_REASONS = new Set(["batch_provider_failure", "batch_invalid_json", "batch_invalid_assertion", "batch_contextual_evaluation_failed"]);

export class BatchAccountingReconciliationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BatchAccountingReconciliationError";
  }
}

type SourceState = {
  traceId: Digest;
  status: "terminal";
  reasonCode: string;
  attempt: number;
  maxAttempts: number;
  queueDigest: Digest;
};

export type BatchAccountingReconciliation = {
  schema: typeof BATCH_ACCOUNTING_RECONCILIATION_SCHEMA;
  reconciliationId: Digest;
  outcome: "terminal_failure_accounted" | "superseded_by_completed_job";
  jobId: Digest;
  jobDigest: Digest;
  bundleId: Digest;
  evaluationPolicyDigest: Digest;
  sourceStates: SourceState[];
  supersedingJobId: Digest | null;
  supersedingDoneDigest: Digest | null;
  authorizedBy: string;
  authorizedAt: string;
  reason: string;
  reconciledAt: string;
};

function fail(code: string, message: string): never {
  throw new BatchAccountingReconciliationError(code, message);
}

function key(value: Digest): string {
  if (!DIGEST_RE.test(value)) fail("INVALID_DIGEST", "digest is invalid");
  return value.slice(7);
}

function readJson<T>(path: string): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { fail("STATE_CORRUPT", `invalid JSON artifact: ${path}`); }
}

function digest(value: unknown): Digest {
  return sha256(value as JsonValue);
}

function same(left: unknown, right: unknown): boolean {
  return digest(left) === digest(right);
}

function canonicalInstant(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function flushDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeImmutableExact(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  try { linkSync(temporary, path); }
  catch (error: any) {
    rmSync(temporary, { force: true });
    if (error?.code !== "EEXIST") throw error;
    if (!same(readJson(path), value)) fail("IMMUTABLE_CONFLICT", `immutable accounting artifact conflicts: ${path}`);
    return;
  }
  rmSync(temporary, { force: true });
  flushDirectory(dirname(path));
}

function acquireLock(path: string, reconciliationId: Digest): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const owner = JSON.stringify({ schema: "engram.memory-batch-accounting-lock.v1", pid: process.pid, reconciliationId, token: randomUUID() });
  while (true) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try { writeFileSync(descriptor, owner, "utf8"); fsyncSync(descriptor); }
      finally { closeSync(descriptor); }
      flushDirectory(dirname(path));
      return () => {
        try { if (readFileSync(path, "utf8") === owner) { unlinkSync(path); flushDirectory(dirname(path)); } }
        catch { /* lock already removed or replaced */ }
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      let observed: string;
      let lockOwner: { pid?: number };
      try { observed = readFileSync(path, "utf8"); lockOwner = JSON.parse(observed); }
      catch { fail("WORKER_BUSY", "evaluator worker lock has an unreadable owner"); }
      if (!Number.isInteger(lockOwner.pid) || Number(lockOwner.pid) <= 0) fail("WORKER_BUSY", "evaluator worker lock owner is invalid");
      try { process.kill(Number(lockOwner.pid), 0); fail("WORKER_BUSY", "evaluator worker lock is held"); }
      catch (probe: any) {
        if (probe instanceof BatchAccountingReconciliationError) throw probe;
        if (probe?.code !== "ESRCH") fail("WORKER_BUSY", "evaluator worker lock owner cannot be disproved");
      }
      try { if (readFileSync(path, "utf8") === observed) { unlinkSync(path); flushDirectory(dirname(path)); } }
      catch (reclaim: any) { if (reclaim?.code !== "ENOENT") throw reclaim; }
    }
  }
}

function validCompletedTerminal(value: any, job: BatchLiveJobV1): boolean {
  if (!value || !["engram.memory-batch-live-terminal.v1", "engram.memory-batch-live-terminal.v2"].includes(value.schema)
    || value.jobId !== job.jobId || value.bundleId !== job.bundle.bundleId || !Array.isArray(value.dispositions)) return false;
  const { terminalId, ...base } = value;
  return terminalId === digest(base);
}

function sourceStates(workspace: string, job: BatchLiveJobV1): SourceState[] {
  const queueRoot = join(workspace, "memory-state/memory-observation/v1/queues/evaluator");
  return job.bundle.sourceRefs.map(source => {
    const queue = readJson<LedgerQueueRecordV1>(join(queueRoot, `${key(source.traceId)}.json`));
    if (queue.traceId !== source.traceId || queue.status !== "terminal" || typeof queue.reasonCode !== "string"
      || queue.claimToken !== null || queue.terminalAt === null) fail("QUEUE_INELIGIBLE", "all batch sources must be terminal and unclaimed");
    return { traceId: source.traceId, status: "terminal", reasonCode: queue.reasonCode,
      attempt: queue.attempt, maxAttempts: queue.maxAttempts, queueDigest: digest(queue) };
  });
}

function observationsExist(workspace: string, bundleId: Digest): boolean {
  const root = join(workspace, "memory-state/memory-observation/v1/observations/batch");
  if (!existsSync(root)) return false;
  return readdirSync(root).filter(name => name.endsWith(".json"))
    .some(name => readJson<any>(join(root, name)).bundleId === bundleId);
}

/** Close accounting for an old immutable job without replaying its source or
 * altering queue state. A job is eligible only when it is either an exhausted
 * terminal failure with no effects, or the identical bundle was completed by
 * a later digest-bound job. */
export function reconcileBatchAccounting(options: {
  workspace: string;
  storeRoot: string;
  jobId: Digest;
  supersedingJobId?: Digest;
  authorizedBy: string;
  authorizedAt: string;
  reason: string;
  apply?: boolean;
  now?: Date;
}): BatchAccountingReconciliation & { status: "planned" | "accounted" } {
  const workspace = resolve(options.workspace);
  const storeRoot = resolve(options.storeRoot);
  const expectedStore = join(workspace, "memory-state/memory-observation/batch-live-store");
  const now = options.now ?? new Date();
  if (storeRoot !== expectedStore) fail("SCOPE_MISMATCH", "store root must belong to the selected workspace");
  if (!options.authorizedBy.trim() || !options.reason.trim() || !canonicalInstant(options.authorizedAt)
    || Date.parse(options.authorizedAt) > now.getTime()) fail("INVALID_AUTHORIZATION", "explicit, non-future operator authorization is required");

  const root = join(storeRoot, "memory-batch-live/v1");
  const jobPath = join(root, "jobs", `${key(options.jobId)}.json`);
  if (!existsSync(jobPath)) fail("JOB_MISSING", "batch job is unavailable");
  const job = readJson<BatchLiveJobV1>(jobPath);
  if (job.schema !== BATCH_LIVE_JOB_SCHEMA || job.jobId !== options.jobId) fail("JOB_INVALID", "batch job identity is invalid");
  const donePath = join(root, "done", `${key(job.jobId)}.json`);
  const receiptPath = join(root, "accounting-reconciliations", `${key(job.jobId)}.json`);
  const states = sourceStates(workspace, job);

  let outcome: BatchAccountingReconciliation["outcome"];
  let supersedingDoneDigest: Digest | null = null;
  if (options.supersedingJobId) {
    if (options.supersedingJobId === job.jobId) fail("SUPERSESSION_INVALID", "a job cannot supersede itself");
    const supersedingPath = join(root, "jobs", `${key(options.supersedingJobId)}.json`);
    const supersedingDonePath = join(root, "done", `${key(options.supersedingJobId)}.json`);
    const supersedingTerminalPath = join(root, "terminals", `${key(options.supersedingJobId)}.json`);
    if (!existsSync(supersedingPath) || !existsSync(supersedingDonePath) || !existsSync(supersedingTerminalPath))
      fail("SUPERSESSION_INCOMPLETE", "superseding job must have matching terminal and done artifacts");
    const superseding = readJson<BatchLiveJobV1>(supersedingPath);
    const supersedingDone = readJson<any>(supersedingDonePath);
    const supersedingTerminal = readJson<any>(supersedingTerminalPath);
    if (superseding.schema !== BATCH_LIVE_JOB_SCHEMA || superseding.jobId !== options.supersedingJobId
      || !same(superseding.bundle, job.bundle) || !same(superseding.partition, job.partition)
      || Date.parse(superseding.createdAt) < Date.parse(job.createdAt)
      || !same(supersedingDone, supersedingTerminal) || !validCompletedTerminal(supersedingDone, superseding))
      fail("SUPERSESSION_INVALID", "superseding job is not a valid completion of the identical bundle");
    const dispositions = new Map(supersedingDone.dispositions.map((entry: any) => [entry.traceId, entry]));
    if (dispositions.size !== states.length || states.some(state => {
      const disposition: any = dispositions.get(state.traceId);
      return !disposition || disposition.reasonCode !== state.reasonCode || !["write", "skip", "defer"].includes(disposition.decision);
    })) fail("SUPERSESSION_INVALID", "superseding dispositions do not match current terminal source state");
    outcome = "superseded_by_completed_job";
    supersedingDoneDigest = digest(supersedingDone);
  } else {
    if (observationsExist(workspace, job.bundle.bundleId)) fail("EFFECTS_EXIST", "persisted observations require explicit supersession reconciliation");
    if (states.some(state => state.attempt < state.maxAttempts || !FAILURE_REASONS.has(state.reasonCode)))
      fail("FAILURE_INVALID", "only exhausted batch failures without effects may be accounted");
    for (const directory of ["contextual-results", "terminals", "failures", "reconciliations"]) {
      if (existsSync(join(root, directory, `${key(job.jobId)}.json`))) fail("ARTIFACT_EXISTS", "job has an output artifact and cannot be sealed as an orphaned failure");
    }
    outcome = "terminal_failure_accounted";
  }

  const base = {
    schema: BATCH_ACCOUNTING_RECONCILIATION_SCHEMA,
    outcome,
    jobId: job.jobId,
    jobDigest: digest(job),
    bundleId: job.bundle.bundleId,
    evaluationPolicyDigest: job.evaluationPolicyDigest,
    sourceStates: states,
    supersedingJobId: options.supersedingJobId ?? null,
    supersedingDoneDigest,
    authorizedBy: options.authorizedBy,
    authorizedAt: options.authorizedAt,
    reason: options.reason,
    reconciledAt: options.authorizedAt,
  };
  const receipt: BatchAccountingReconciliation = { ...base, reconciliationId: digest(base) };

  if (existsSync(donePath)) {
    if (!existsSync(receiptPath) || !same(readJson(receiptPath), receipt) || !same(readJson(donePath), receipt))
      fail("JOB_ALREADY_DONE", "job already has a different completion artifact");
    return { ...receipt, status: "accounted" };
  }
  if (existsSync(receiptPath) && !same(readJson(receiptPath), receipt)) fail("IMMUTABLE_CONFLICT", "accounting receipt changed");
  if (!options.apply) return { ...receipt, status: "planned" };

  const release = acquireLock(join(workspace, "memory-state/memory-observation/v1/locks/evaluator.worker"), receipt.reconciliationId);
  try {
    for (const state of states) {
      const queue = readJson<LedgerQueueRecordV1>(join(workspace, "memory-state/memory-observation/v1/queues/evaluator", `${key(state.traceId)}.json`));
      if (digest(queue) !== state.queueDigest) fail("QUEUE_STATE_DIVERGED", "source queue changed before accounting publication");
    }
    writeImmutableExact(receiptPath, receipt);
    writeImmutableExact(donePath, receipt);
    return { ...receipt, status: "accounted" };
  } finally { release(); }
}
