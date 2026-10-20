/** Explicit historical quarantine, not a producer migration or business closure.
 * Expired originals and existing archived effects remain unresolved. */
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { sha256, type Digest } from './ledger.ts';
import { validateCompiledBatchBundle } from './batch-shadow-runner.ts';
import { captureExpiredOrphanJob, sourceDebtSnapshot } from './source-debt-capture.ts';
import { acquireProcessLease } from './process-lease.ts';

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const SCHEMA = 'engram.memory-expired-orphan-accounting.v1';
const HASH = /^sha256:[a-f0-9]{64}$/;
function canonicalPath(path: string) {
  if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw Error('ORPHAN_UNSAFE_PATH');
}
function immutable(path: string, value: any) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  canonicalPath(join(path, '..'));
  if (existsSync(path)) { canonicalPath(path); if (sha256(read(path)) !== sha256(value)) throw Error('ORPHAN_RECEIPT_CONFLICT'); return; }
  const temp = path + '.' + randomUUID(), fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    linkSync(temp, path);
    const dir = openSync(join(path, '..'), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { unlinkSync(temp); }
}
export function reconcileExpiredOrphan(options: {
  workspace: string; jobId: Digest; expectedJobDigest: Digest; authorizedBy: string;
  authorizedAt: string; apply?: boolean; now?: Date;
  /** Synthetic crash/race probes; never provided by the normal Worker. */
  fault?: (point: 'after_debt' | 'after_receipt' | 'after_done') => void;
}) {
  if (!isAbsolute(options.workspace)) throw Error('ORPHAN_WORKSPACE_INVALID');
  const workspace = realpathSync(resolve(options.workspace)), jobId = options.jobId, now = options.now ?? new Date();
  const state = join(workspace, 'memory-state/memory-observation'), root = join(state, 'batch-live-store/memory-batch-live/v1');
  for (const path of [state, root, join(root, 'jobs')]) canonicalPath(path);
  if (!HASH.test(jobId) || !HASH.test(options.expectedJobDigest) || !options.authorizedBy.trim()
    || !Number.isFinite(now.getTime()) || !Number.isFinite(Date.parse(options.authorizedAt))
    || Date.parse(options.authorizedAt) > now.getTime()) throw Error('ORPHAN_AUTHORIZATION_INVALID');
  const release = acquireProcessLease(join(tmpdir(), 'engram-memory-batch-inference-' + (process.getuid?.() ?? 'user')));
  if (!release) throw Error('ORPHAN_WORKER_BUSY');
  try {
    const jobPath = join(root, 'jobs', jobId.slice(7) + '.json'); canonicalPath(jobPath);
    const job = read(jobPath), digest = sha256(job), done = join(root, 'done', jobId.slice(7) + '.json');
    const receiptPath = join(root, 'orphan-accounting', jobId.slice(7) + '.json');
    const owner = read(join(workspace, 'engram.json')).workspace?.id;
    if (!owner || job.partition?.workspaceId !== owner || job.jobId !== jobId) throw Error('ORPHAN_WORKSPACE_INVALID');
    if (digest !== options.expectedJobDigest) throw Error('ORPHAN_JOB_CHANGED');
    const ids = new Set<string>(job.bundle.sourceRefs.map((ref: any) => ref.traceId));
    const preflight = () => {
      if (sha256(read(jobPath)) !== digest || read(join(workspace, 'engram.json')).workspace?.id !== owner) throw Error('ORPHAN_JOB_CHANGED');
      const expires = job.bundle.inputs.map((input: any) => Date.parse(input.expiresAt));
      if (!expires.length || expires.some((value: number) => !Number.isFinite(value) || value > now.getTime())) throw Error('ORPHAN_EVIDENCE_NOT_EXPIRED');
      // Authenticate original bytes at their historical valid instant; this
      // never makes expired evidence eligible for current inference.
      validateCompiledBatchBundle(job.bundle, new Date(Math.min(...expires) - 1));
      if (sha256({ schema: job.schema, partition: job.partition, evaluationPolicyDigest: job.evaluationPolicyDigest, bundleId: job.bundle.bundleId }) !== jobId) throw Error('ORPHAN_JOB_INVALID');
      for (const ref of job.bundle.sourceRefs) for (const directory of ['envelopes', 'evidence', 'queues/evaluator']) {
        if (existsSync(join(state, 'v1', directory, ref.traceId.slice(7) + '.json'))) throw Error('ORPHAN_SOURCE_STILL_PRESENT');
      }
      for (const directory of ['contextual-results', 'terminals', 'failures', 'reconciliations']) {
        if (existsSync(join(root, directory, jobId.slice(7) + '.json'))) throw Error('ORPHAN_EFFECTS_EXIST');
      }
      const retained: Array<{ path: string; digest: Digest }> = [];
      for (const dir of [join(state, 'batch-live-store/memory-batch-shadow/v1/results'), ...['observations/batch', 'observations/typed', 'consumers/daily-note/queue', 'receipts/by-operation'].map(d => join(state, 'v1', d))]) {
        if (!existsSync(dir)) continue; canonicalPath(dir);
        for (const name of readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
          const path = join(dir, name); canonicalPath(path); const record = read(path);
          if (record.bundleId === job.bundle.bundleId || ids.has(record.traceId) || record.sourceRefs?.some((ref: any) => ids.has(ref.traceId))) {
            if (dir.endsWith('consumers/daily-note/queue') && record.status !== 'terminal') throw Error('ORPHAN_ACTIVE_EFFECTS_EXIST');
            retained.push({ path: path.slice(state.length + 1), digest: sha256(record) });
          }
        }
      }
      return retained;
    };
    if (existsSync(done) || existsSync(receiptPath)) {
      const selected = existsSync(receiptPath) ? receiptPath : done; canonicalPath(selected);
      const receipt = read(selected), { accountingId, ...body } = receipt;
      if (receipt.schema !== SCHEMA || accountingId !== sha256(body) || receipt.jobDigest !== digest
        || receipt.jobId !== jobId || receipt.bundleId !== job.bundle.bundleId || receipt.evaluationPolicyDigest !== job.evaluationPolicyDigest
        || receipt.outcome !== 'historical_orphan_quarantined' || receipt.closedSources !== 0 || receipt.canonicalWrites !== 0
        || sha256(receipt.traceIds) !== sha256([...ids]) || receipt.authorizedBy !== options.authorizedBy || receipt.authorizedAt !== options.authorizedAt
        || !Array.isArray(receipt.debtIds) || receipt.debtIds.length !== ids.size
        || !Array.isArray(receipt.debtRecordIds) || receipt.debtRecordIds.length !== ids.size) throw Error('ORPHAN_ALREADY_DONE');
      const snapshot = sourceDebtSnapshot(workspace, now);
      if (snapshot.corrupt || receipt.debtIds.some((id: Digest) => !snapshot.debtIds.includes(id))) throw Error('ORPHAN_DEBT_NOT_OPEN');
      for (const [index, id] of receipt.debtRecordIds.entries()) {
        if (!HASH.test(id)) throw Error('ORPHAN_RECEIPT_CONFLICT');
        const record = read(join(state, 'source-debt/v1/failures', id.slice(7) + '.json'));
        if (record.recordId !== id || record.traceId !== receipt.traceIds[index] || record.debtId !== receipt.debtIds[index]
          || !record.batchParents?.some((parent: any) => parent.jobId === jobId && parent.jobDigest === digest)) throw Error('ORPHAN_RECEIPT_CONFLICT');
      }
      if (existsSync(done)) {
        canonicalPath(done);
        if (!existsSync(receiptPath) || sha256(read(done)) !== sha256(receipt)) throw Error('ORPHAN_RECEIPT_CONFLICT');
        return { status: 'accounted', receipt };
      }
      // Resume the persisted receipt, not a newly reconstructed mutable plan.
      if (sha256(preflight()) !== sha256(receipt.retainedArtifacts)) throw Error('ORPHAN_EFFECTS_CHANGED');
      if (options.apply) immutable(done, receipt);
      return { status: options.apply ? 'accounted' : 'planned', receipt };
    }
    const retainedArtifacts = preflight();
    if (!options.apply) return { status: 'planned', jobId, jobDigest: digest, unresolvedSources: ids.size };
    const records = captureExpiredOrphanJob(workspace, jobId, now), snapshot = sourceDebtSnapshot(workspace, now);
    if (snapshot.corrupt || records.some(record => !snapshot.openIds.includes(record.debtId))) throw Error('ORPHAN_DEBT_NOT_OPEN');
    options.fault?.('after_debt');
    if (sha256(preflight()) !== sha256(retainedArtifacts)) throw Error('ORPHAN_EFFECTS_CHANGED');
    const body = { schema: SCHEMA, outcome: 'historical_orphan_quarantined', jobId, jobDigest: digest, bundleId: job.bundle.bundleId, evaluationPolicyDigest: job.evaluationPolicyDigest,
      retainedArtifacts, traceIds: [...ids], debtRecordIds: records.map(record => record.recordId), debtIds: records.map(record => record.debtId),
      authorizedBy: options.authorizedBy, authorizedAt: options.authorizedAt, closedSources: 0, canonicalWrites: 0 };
    const receipt = { ...body, accountingId: sha256(body) };
    immutable(receiptPath, receipt); options.fault?.('after_receipt');
    // Keep both crash points resumable; source debt remains open in every case.
    immutable(done, receipt); options.fault?.('after_done');
    return { status: 'accounted', receipt };
  } finally { release(); }
}
