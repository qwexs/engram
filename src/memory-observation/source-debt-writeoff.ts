/** Operator-only cessation of recovery. Never semantic closure, queue deletion,
 * or a claim of complete memory. Host admission/purge accounting is unchanged. */
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, type Digest } from './ledger.ts';
import { sourceDebtSnapshot as rawSnapshot, type SourceDebtRecord, type SourceDebtSnapshot as RawSnapshot } from './source-debt-capture.ts';
import { acquireProcessLease } from './process-lease.ts';

const HASH = /^sha256:[a-f0-9]{64}$/;
export const WRITE_OFF_REASONS = ['native_completion_unavailable', 'native_source_unavailable', 'failed_original_turn', 'textless_source', 'recovery_attempts_exhausted'] as const;
type Reason = typeof WRITE_OFF_REASONS[number];
export type WriteOffRequest = {
  workspaceId: string; debtId: Digest; recordIds: Digest[]; reasonCode: Reason;
  evidenceDigest: Digest; authorizedBy: string; authorizedAt: string; historicalCutoff: string;
};
type Receipt = WriteOffRequest & { schema: 'engram.memory-source-debt-writeoff.v1'; disposition: 'operator_written_off'; receiptId: Digest };
export type SourceDebtSnapshot = RawSnapshot & { writtenOffIds?: Digest[] };
const root = (w: string) => join(w, 'memory-state/memory-observation');
const directory = (w: string) => join(root(w), 'source-debt-writeoffs/v1');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
function rows(path: string, receiptNames = false): any[] {
  if (!existsSync(path)) return [];
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw Error('WRITE_OFF_UNSAFE_PATH');
  const names = readdirSync(path).sort();
  if (names.length > 10_000) throw Error('WRITE_OFF_CAPACITY_EXCEEDED');
  return names.map(name => {
    const p = join(path, name), info = lstatSync(p);
    if (!/^[a-f0-9]{64}\.json$/.test(name) || !info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw Error('WRITE_OFF_INVALID_METADATA');
    const value = read(p);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('WRITE_OFF_INVALID_METADATA');
    if (receiptNames && name !== value.receiptId?.slice(7) + '.json') throw Error('WRITE_OFF_FILENAME_INVALID');
    return value;
  });
}
function records(w: string, debtId: Digest): SourceDebtRecord[] {
  return rows(join(root(w), 'source-debt/v1/failures')).filter(r => r.debtId === debtId);
}
function validReceipt(r: Receipt, now: Date) {
  const { receiptId, ...body } = r;
  if (r.schema !== 'engram.memory-source-debt-writeoff.v1' || r.disposition !== 'operator_written_off' || receiptId !== sha256(body)
    || Object.keys(r).sort().join() !== 'authorizedAt,authorizedBy,debtId,disposition,evidenceDigest,historicalCutoff,reasonCode,receiptId,recordIds,schema,workspaceId'
    || !/^[A-Za-z0-9_-]+$/.test(r.workspaceId) || !HASH.test(r.debtId) || !HASH.test(r.evidenceDigest)
    || !Array.isArray(r.recordIds) || !r.recordIds.length || r.recordIds.some(id => !HASH.test(id))
    || sha256([...new Set(r.recordIds)].sort()) !== sha256(r.recordIds)
    || !WRITE_OFF_REASONS.includes(r.reasonCode) || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,299}$/.test(r.authorizedBy)
    || !Number.isFinite(Date.parse(r.historicalCutoff)) || !Number.isFinite(Date.parse(r.authorizedAt))
    || Date.parse(r.historicalCutoff) > Date.parse(r.authorizedAt) || Date.parse(r.authorizedAt) > now.getTime()) throw Error('WRITE_OFF_RECEIPT_INVALID');
}
/** Reject anything which could still be processed, or needs real context.
 * This implementation intentionally writes off inactive history only. */
function activity(w: string) {
  const op = join(root(w), 'v1'), batch = join(root(w), 'batch-live-store/memory-batch-live/v1');
  const dailyTraces = new Set<Digest>();
  for (const q of rows(join(op, 'consumers/daily-note/queue'))) if (q.status !== 'terminal') {
    if (q.traceId) dailyTraces.add(q.traceId);
    if (HASH.test(q.observationId ?? '')) for (const kind of ['batch', 'typed']) {
      const file = join(op, 'observations', kind, q.observationId.slice(7) + '.json');
      if (!existsSync(file)) continue;
      const obs = read(file);
      for (const ref of obs.sourceRefs ?? []) dailyTraces.add(ref.traceId);
      if (obs.traceId) dailyTraces.add(obs.traceId);
    }
  }
  return { op, batch, dailyTraces, queues: rows(join(op, 'queues/evaluator')), jobs: rows(join(batch, 'jobs')) };
}
function inactive(w: string, rs: SourceDebtRecord[], state = activity(w)) {
  if (rs.some(r => r.stage === 'daily' || ['semantic_batch_defer', 'semantic_contextual_unresolved'].includes(r.reasonCode))) return false;
  const { op, batch } = state, traces = new Set(rs.flatMap(r => r.traceId ? [r.traceId] : []));
  for (const r of rs) if (r.candidateId) {
    const cp = join(op, 'pre-admission/checkpoints', r.candidateId.slice(7) + '.json');
    if (existsSync(cp)) {
      const c = read(cp);
      if (!['terminal_gap', 'ledger_admitted'].includes(c.stage)) return false;
      if (c.traceId) traces.add(c.traceId);
      // A recovered admission needs a source-effect proof, not a gap write-off.
      if (c.stage === 'ledger_admitted') return false;
    }
  }
  if ([...traces].some(t => state.dailyTraces.has(t))) return false;
  for (const q of state.queues) if (traces.has(q.traceId)
    && (q.status !== 'terminal' || !/^batch_/.test(q.reasonCode ?? ''))) return false;
  for (const job of state.jobs) if (job.bundle?.sourceRefs?.some((s: any) => traces.has(s.traceId))
    && !existsSync(join(batch, 'done', job.jobId.slice(7) + '.json'))) return false;
  return true;
}
function matches(w: string, r: Receipt, rs = records(w, r.debtId), state?: ReturnType<typeof activity>) {
  return rs.length > 0 && rs.every(x => x.scope.workspaceId === r.workspaceId && Date.parse(x.failedAt) <= Date.parse(r.historicalCutoff))
    && sha256(rs.map(x => x.recordId).sort()) === sha256(r.recordIds) && inactive(w, rs, state);
}
/** Read-only overlay. Additional failures or reactivation reopen the identity;
 * an old decision never suppresses new errors, even on the same source. */
export function applySourceDebtWriteOffs(w: string, s: RawSnapshot, now = new Date()): SourceDebtSnapshot {
  const writtenOffIds: Digest[] = [];
  try {
    const receipts = rows(directory(w), true);
    if (receipts.length > 10_000) throw Error('WRITE_OFF_CAPACITY_EXCEEDED');
    const allRecords: SourceDebtRecord[] = receipts.length ? rows(join(root(w), 'source-debt/v1/failures')) : [];
    const state = receipts.length ? activity(w) : undefined;
    for (const r of receipts as Receipt[]) {
      validReceipt(r, now);
      if (r.workspaceId !== s.workspaceId || !s.debtIds.includes(r.debtId)
        || !existsSync(join(directory(w), r.receiptId.slice(7) + '.json'))) throw Error('WRITE_OFF_OWNER_OR_IDENTITY_INVALID');
      if (!s.corrupt && s.openIds.includes(r.debtId) && matches(w, r, allRecords.filter(x => x.debtId === r.debtId), state)) writtenOffIds.push(r.debtId);
    }
    const { snapshotDigest: _old, ...base } = s;
    const unique = [...new Set(writtenOffIds)].sort();
    const result = { ...base, openIds: s.openIds.filter(id => !unique.includes(id)), writtenOffIds: unique };
    return { ...result, snapshotDigest: sha256(result) };
  } catch {
    const { snapshotDigest: _old, ...base } = s;
    const result = { ...base, corrupt: true, errors: [...s.errors, 'WRITE_OFF_STATE_INVALID'], writtenOffIds: [] };
    return { ...result, snapshotDigest: sha256(result) };
  }
}
/** Exact request + immutable receipt, serialized with the existing debt writer.
 * Plan by default. No inference, host changes, KG writes, or canonical writes. */
export function writeOffSourceDebt(w: string, request: WriteOffRequest, options: { apply?: boolean; now?: Date } = {}) {
  const now = options.now ?? new Date();
  if (resolve(w) !== w || realpathSync(w) !== w) throw Error('WRITE_OFF_WORKSPACE_INVALID');
  const body = { ...request, schema: 'engram.memory-source-debt-writeoff.v1' as const, disposition: 'operator_written_off' as const };
  const receipt: Receipt = { ...body, receiptId: sha256(body) };
  validReceipt(receipt, now);
  const release = acquireProcessLease(join(root(w), 'source-debt/v1/writer.lock'));
  if (!release) throw Error('WRITE_OFF_WRITER_BUSY');
  try {
    const s = rawSnapshot(w, now);
    if (s.corrupt || s.workspaceId !== request.workspaceId || !s.openIds.includes(request.debtId) || !matches(w, receipt)) throw Error('WRITE_OFF_STATE_CHANGED_OR_ACTIVE');
    if (!options.apply) return { status: 'planned', receipt, canonicalWrites: 0 };
    const dir = directory(w);
    // A symlink at any path component is not a valid administrative destination.
    for (const p of [join(root(w), 'source-debt-writeoffs'), dir]) {
      if (existsSync(p) && (lstatSync(p).isSymbolicLink() || !lstatSync(p).isDirectory())) throw Error('WRITE_OFF_UNSAFE_PATH');
      if (!existsSync(p)) mkdirSync(p, { mode: 0o700 });
    }
    const file = join(dir, receipt.receiptId.slice(7) + '.json');
    if (existsSync(file)) { if (sha256(read(file)) !== sha256(receipt)) throw Error('WRITE_OFF_CONFLICT'); }
    else {
      const temp = join(dirname(dir), '.writeoff-' + randomUUID()), fd = openSync(temp, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(receipt) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      try { linkSync(temp, file); } finally { rmSync(temp, { force: true }); }
      for (const p of [dir, dirname(dir), root(w)]) { const d = openSync(p, 'r'); try { fsyncSync(d); } finally { closeSync(d); } }
    }
    const after = applySourceDebtWriteOffs(w, rawSnapshot(w, now), now);
    if (after.corrupt || !after.writtenOffIds?.includes(request.debtId)) throw Error('WRITE_OFF_READBACK_FAILED');
    return { status: 'operator_written_off', receipt, canonicalWrites: 0 };
  } finally { release(); }
}
