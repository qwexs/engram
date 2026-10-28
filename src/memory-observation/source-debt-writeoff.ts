/** Cessation of recovery. Never semantic closure, queue deletion,
 * or a claim of complete memory. Host admission/purge accounting is unchanged. */
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, type Digest } from './ledger.ts';
import { sourceDebtSnapshot as rawSnapshot, type SourceDebtRecord, type SourceDebtSnapshot as RawSnapshot } from './source-debt-capture.ts';
import { acquireProcessLease } from './process-lease.ts';
import { memoryObservationBinding, memoryObservationCaptureOwner, resolveMemoryObservationProjection } from './projection.ts';

const HASH = /^sha256:[a-f0-9]{64}$/;
export const WRITE_OFF_REASONS = ['native_completion_unavailable', 'native_source_unavailable', 'failed_original_turn', 'textless_source', 'recovery_attempts_exhausted'] as const;
type Reason = typeof WRITE_OFF_REASONS[number];
export type WriteOffRequest = {
  workspaceId: string; debtId: Digest; recordIds: Digest[]; reasonCode: Reason;
  evidenceDigest: Digest; authorizedBy: string; authorizedAt: string; historicalCutoff: string;
};
type Receipt = WriteOffRequest & { schema: 'engram.memory-source-debt-writeoff.v1'; disposition: 'operator_written_off'; receiptId: Digest };
type RecoveryPolicy = { schema: 'engram.memory-recovery-policy.v1'; workspaceId: string; evidenceTtlHours: number };
type AutomaticReceipt = {
  schema: 'engram.memory-source-debt-writeoff.v2'; disposition: 'policy_recovery_stopped';
  workspaceId: string; debtId: Digest; recordIds: Digest[]; policy: RecoveryPolicy; policyDigest: Digest;
  reasonCode: 'recovery_window_ended' | 'unresolved_window_ended'; stoppedAt: string; recoveryDeadline: string;
  evidenceDigest: Digest; receiptId: Digest;
};
export type SourceDebtClasses = { confirmedCompleted:number; failedRuns:number; completionUnverified:number; identityUnverified:number; unclassified:number };
export type SourceDebtSnapshot = RawSnapshot & { writtenOffIds?: Digest[]; automaticallyStoppedIds?: Digest[]; openClassifications?:SourceDebtClasses };
const root = (w: string) => join(w, 'memory-state/memory-observation');
const directory = (w: string) => join(root(w), 'source-debt-writeoffs/v1');
const read = (p: string): any => {
  if (realpathSync(p) !== resolve(p) || !lstatSync(p).isFile()) throw Error('WRITE_OFF_UNSAFE_PATH');
  return JSON.parse(readFileSync(p, 'utf8'));
};
function rows(path: string, receiptNames: boolean | 'completion' = false): any[] {
  if (!existsSync(path)) return [];
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== resolve(path)) throw Error('WRITE_OFF_UNSAFE_PATH');
  const names = readdirSync(path).sort();
  if (names.length > 10_000) throw Error('WRITE_OFF_CAPACITY_EXCEEDED');
  return names.map(name => {
    const p = join(path, name), info = lstatSync(p);
    const validName = receiptNames === 'completion' ? /^(?:unresolved-)?[a-f0-9]{64}\.json$/.test(name) : /^[a-f0-9]{64}\.json$/.test(name);
    if (!validName || !info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw Error('WRITE_OFF_INVALID_METADATA');
    const value = read(p);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('WRITE_OFF_INVALID_METADATA');
    if (receiptNames === true && name !== value.receiptId?.slice(7) + '.json') throw Error('WRITE_OFF_FILENAME_INVALID');
    if (receiptNames === 'completion') {
      const expected = value.schema === 'engram.completion-unresolved.v1' ? 'unresolved-' + sha256(value.request).slice(7)
        : value.schema === 'engram.completion-mirror-feed.v1' ? sha256(value.target).slice(7) : null;
      if (!expected || name !== expected + '.json') throw Error('WRITE_OFF_INVALID_COMPLETION');
    }
    return value;
  });
}
function records(w: string, debtId: Digest): SourceDebtRecord[] {
  return rows(join(root(w), 'source-debt/v1/failures')).filter(r => r.debtId === debtId);
}
function validReceipt(r: Receipt | AutomaticReceipt, now: Date) {
  const { receiptId, ...body } = r;
  if (r.schema === 'engram.memory-source-debt-writeoff.v2') {
    if (r.disposition !== 'policy_recovery_stopped' || receiptId !== sha256(body)
      || Object.keys(r).sort().join() !== 'debtId,disposition,evidenceDigest,policy,policyDigest,reasonCode,receiptId,recordIds,recoveryDeadline,schema,stoppedAt,workspaceId'
      || !/^[A-Za-z0-9_-]+$/.test(r.workspaceId) || !HASH.test(r.debtId) || !HASH.test(r.evidenceDigest)
      || !Array.isArray(r.recordIds) || !r.recordIds.length || r.recordIds.some(id => !HASH.test(id))
      || sha256([...new Set(r.recordIds)].sort()) !== sha256(r.recordIds)
      || !r.policy || Object.keys(r.policy).sort().join() !== 'evidenceTtlHours,schema,workspaceId'
      || r.policy.schema !== 'engram.memory-recovery-policy.v1' || r.policy.workspaceId !== r.workspaceId
      || !Number.isFinite(r.policy.evidenceTtlHours) || r.policy.evidenceTtlHours < 1 || r.policy.evidenceTtlHours > 168
      || r.policyDigest !== sha256(r.policy) || !['recovery_window_ended', 'unresolved_window_ended'].includes(r.reasonCode)
      || r.evidenceDigest !== sha256({ recordIds: r.recordIds, recoveryDeadline: r.recoveryDeadline, reasonCode: r.reasonCode })
      || !Number.isFinite(Date.parse(r.stoppedAt)) || Date.parse(r.stoppedAt) > now.getTime()
      || !Number.isFinite(Date.parse(r.recoveryDeadline)) || Date.parse(r.recoveryDeadline) > Date.parse(r.stoppedAt)) throw Error('WRITE_OFF_RECEIPT_INVALID');
    return;
  }
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

/** Loaded once per batch, never once per debt. Payload text is neither copied
 * into receipts nor interpreted here. Any persisted effect protects its source. */
function automaticActivity(w: string) {
  if (realpathSync(root(w)) !== root(w)) throw Error('WRITE_OFF_UNSAFE_PATH');
  const op = join(root(w), 'v1'), batch = join(root(w), 'batch-live-store/memory-batch-live/v1');
  const config = read(join(w, 'engram.json'));
  const projection = resolveMemoryObservationProjection({ workspace: w, workspaceId: config.workspace?.id });
  const checkpoints = new Map(rows(join(op, 'pre-admission/checkpoints')).map(c => [c.candidateId, c]));
  const links = new Map(rows(join(root(w), 'source-debt/v1/links')).map(l => [l.debtId, l]));
  const envelopes = rows(join(op, 'envelopes'));
  const evidence = new Map(rows(join(op, 'evidence')).map(e => {
    if (e.schema !== 'engram.memory-evidence-envelope.v1' || !HASH.test(e.traceId ?? '')
      || !Number.isFinite(Date.parse(e.expiresAt))) throw Error('WRITE_OFF_INVALID_EVIDENCE');
    return [e.traceId, e];
  }));
  const blocked = new Set<string>(), pendingCandidates = new Set<string>();
  for (const dir of ['observations/batch', 'observations/typed', 'receipts/by-operation']) for (const value of rows(join(op, dir))) {
    if (value.traceId) blocked.add(value.traceId);
    for (const ref of value.sourceRefs ?? []) { if (ref.traceId) blocked.add(ref.traceId); if (ref.sourceTurnId) blocked.add(ref.sourceTurnId); }
  }
  for (const value of rows(join(w, 'memory-state/domain-effects/v1/receipts'))) if (value.traceId) blocked.add(value.traceId);
  for (const feed of rows(join(op, 'completion-mirrors'), 'completion')) {
    if (feed.schema === 'engram.completion-unresolved.v1') {
      if (!feed.request || !HASH.test(feed.request.candidateId ?? '')
        || !/^channel-user:v1:[a-f0-9]{64}$/.test(feed.request.sourceTurnId ?? '')
        || !Number.isFinite(Date.parse(feed.closedAt))) throw Error('WRITE_OFF_INVALID_COMPLETION');
      continue;
    }
    const { digest, ...body } = feed;
    if (digest !== sha256(body) || !Array.isArray(feed.pending) || !feed.target) throw Error('WRITE_OFF_INVALID_COMPLETION');
    for (const pending of feed.pending) {
      const request = pending?.request;
      if (!request || !HASH.test(request.candidateId ?? '')
        || !/^channel-user:v1:[a-f0-9]{64}$/.test(request.sourceTurnId ?? '')
        || !request.runId || !Number.isFinite(Date.parse(pending.registeredAt))
        || sha256({agentId:request.agentId,sessionKey:request.sessionKey,sessionId:request.sessionId}) !== sha256(feed.target)) throw Error('WRITE_OFF_INVALID_COMPLETION');
      pendingCandidates.add(request.candidateId);
      blocked.add(request.sourceTurnId);
    }
  }
  const queues = rows(join(op, 'queues/evaluator'));
  for (const q of queues) if (q.schema !== 'engram.memory-observation-ledger-queue.v1'
    || !['queued', 'claimed', 'terminal'].includes(q.status) || !HASH.test(q.traceId ?? '')) throw Error('WRITE_OFF_INVALID_QUEUE');
  for (const q of rows(join(op, 'consumers/daily-note/queue'))) {
    if (q.schema !== 'engram.memory-observation-consumer-queue.v1' || !['queued', 'claimed', 'qmd_pending', 'terminal'].includes(q.status)) throw Error('WRITE_OFF_INVALID_QUEUE');
    if (q.traceId) blocked.add(q.traceId);
  }
  const jobs = rows(join(batch, 'jobs'));
  const done = new Map(rows(join(batch, 'done')).map(d => [d.jobId, d]));
  const jobsById = new Map(jobs.map(j => [j.jobId, j]));
  return { projection, checkpoints, links, envelopes, evidence, blocked, pendingCandidates, queues, jobs, jobsById, done };
}

function automaticEligibility(rs: SourceDebtRecord[], policy: RecoveryPolicy, state: ReturnType<typeof automaticActivity>, now: Date) {
  if (!rs.length || rs.some(r => r.scope.workspaceId !== policy.workspaceId || r.stage === 'daily')) return null;
  const scope = rs[0]!.scope;
  if (rs.some(r => sha256(r.scope) !== sha256(scope))) return null;
  const binding = memoryObservationBinding(state.projection, scope.runtimeSessionKey);
  if (!binding || binding.scopeClass !== scope.scopeClass || binding.scopeId !== scope.scopeId
    || memoryObservationCaptureOwner(state.projection, scope.runtimeSessionKey, now) !== 'observer') return null;
  let deadline = Math.max(...rs.map(r => Date.parse(r.failedAt))) + policy.evidenceTtlHours * 3600_000;
  const traces = new Set(rs.flatMap(r => r.traceId ? [r.traceId] : []));
  const sources = new Set(rs.flatMap(r => r.sourceTurnId ? [r.sourceTurnId] : []));
  for (const r of rs) {
    for (const parent of r.batchParents ?? []) {
      const job = state.jobsById.get(parent.jobId);
      if (!job || sha256(job) !== parent.jobDigest) return null;
    }
    const link = state.links.get(r.debtId); if (link?.traceId) traces.add(link.traceId);
    const cp = r.candidateId ? state.checkpoints.get(r.candidateId) : null;
    if (r.candidateId && state.pendingCandidates.has(r.candidateId)) return null;
    if (cp) {
      const { checkpointDigest, ...body } = cp;
      if (cp.schema !== 'engram.memory-admission-checkpoint.v1' || checkpointDigest !== sha256(body)
        || sha256(cp.scope) !== sha256(scope) || !Number.isFinite(Date.parse(cp.expiresAt))) throw Error('WRITE_OFF_INVALID_CHECKPOINT');
      if (!['terminal_gap', 'ledger_admitted'].includes(cp.stage)) return null;
      deadline = Math.max(deadline, Date.parse(cp.expiresAt));
      if (cp.sourceTurnId) sources.add(cp.sourceTurnId);
    }
  }
  for (const e of state.envelopes) if (sources.has(e.sourceTurnId) || traces.has(e.traceId)) {
    if (sha256(e.scope) !== sha256(scope)) return null;
    traces.add(e.traceId); sources.add(e.sourceTurnId);
  }
  if ([...traces, ...sources].some(t => state.blocked.has(t))) return null;
  for (const trace of traces) {
    const e = state.evidence.get(trace);
    if (e) { if (sha256(e.scope) !== sha256(scope)) return null; deadline = Math.max(deadline, Date.parse(e.expiresAt)); }
  }
  for (const q of state.queues) if (traces.has(q.traceId)
    && (q.status !== 'terminal' || !(/^batch_/.test(q.reasonCode ?? '') || ['semantic_contextual_unresolved', 'semantic_batch_defer'].includes(q.reasonCode)))) return null;
  for (const job of state.jobs) if (job.bundle?.sourceRefs?.some((ref: any) => traces.has(ref.traceId) || sources.has(ref.sourceTurnId))) {
    const d = state.done.get(job.jobId);
    if (!d || !HASH.test(job.jobId ?? '') || d.bundleId !== job.bundle.bundleId) return null;
    if (job.jobId !== sha256({ schema: job.schema, partition: job.partition, evaluationPolicyDigest: job.evaluationPolicyDigest, bundleId: job.bundle.bundleId })
      || sha256({ workspaceId: job.partition?.workspaceId, runtimeSessionKey: job.partition?.runtimeSessionKey,
        scopeClass: job.partition?.scopeClass, scopeId: job.partition?.scopeId }) !== sha256(scope)) throw Error('WRITE_OFF_INVALID_JOB');
    const idField = d.schema === 'engram.memory-batch-live-failure.v1' ? 'failureId'
      : ['engram.memory-batch-live-terminal.v1', 'engram.memory-batch-live-terminal.v2'].includes(d.schema) ? 'terminalId'
      : ['engram.memory-batch-live-reconciliation.v1', 'engram.memory-batch-accounting-reconciliation.v1'].includes(d.schema) ? 'reconciliationId' : null;
    if (!idField) return null;
    const { [idField]: id, ...body } = d;
    if (id !== sha256(body)) throw Error('WRITE_OFF_INVALID_DONE');
    for (const input of job.bundle.inputs ?? []) if (traces.has(input.traceId)) {
      if (!Number.isFinite(Date.parse(input.expiresAt))) throw Error('WRITE_OFF_INVALID_EVIDENCE');
      deadline = Math.max(deadline, Date.parse(input.expiresAt));
    }
    for (const disposition of d.dispositions ?? []) if (traces.has(disposition.traceId)) {
      if (disposition.decision === 'write' || disposition.observationRefs?.length
        || !['semantic_contextual_unresolved', 'semantic_batch_defer'].includes(disposition.reasonCode)) return null;
    }
  }
  if (!Number.isFinite(deadline) || deadline > now.getTime()) return null;
  return { recoveryDeadline: new Date(deadline).toISOString(),
    reasonCode: rs.some(r => ['semantic_contextual_unresolved', 'semantic_batch_defer'].includes(r.reasonCode))
      ? 'unresolved_window_ended' as const : 'recovery_window_ended' as const };
}

function publishReceipt(w: string, receipt: Receipt | AutomaticReceipt) {
  const dir = directory(w);
  for (const p of [join(root(w), 'source-debt-writeoffs'), dir]) {
    if (existsSync(p) && (lstatSync(p).isSymbolicLink() || !lstatSync(p).isDirectory())) throw Error('WRITE_OFF_UNSAFE_PATH');
    if (!existsSync(p)) mkdirSync(p, { mode: 0o700 });
  }
  const file = join(dir, receipt.receiptId.slice(7) + '.json');
  if (existsSync(file)) { if (sha256(read(file)) !== sha256(receipt)) throw Error('WRITE_OFF_CONFLICT'); return; }
  const temp = join(dirname(dir), '.writeoff-' + randomUUID()), fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(receipt) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temp, file); } finally { rmSync(temp, { force: true }); }
  for (const p of [dir, dirname(dir), root(w)]) { const d = openSync(p, 'r'); try { fsyncSync(d); } finally { closeSync(d); } }
}

/** Worker-only, opt-in accounting, with the existing TTL and one existing debt
 * lease. It never resets retries, invokes a model, or changes source queues. */
export function stopExpiredSourceDebt(w: string, now = new Date(), options: { apply?: boolean; beforePublish?: () => void; afterReceipt?: () => void } = {}) {
  if (resolve(w) !== w || realpathSync(w) !== w) throw Error('WRITE_OFF_WORKSPACE_INVALID');
  const config = read(join(w, 'engram.json'));
  const flag = config.memoryObservation?.autoStopExpiredRecovery;
  if (flag !== undefined && typeof flag !== 'boolean') throw Error('WRITE_OFF_POLICY_INVALID');
  if (flag !== true) return { status: 'disabled' as const, receipts: [] as AutomaticReceipt[], canonicalWrites: 0 };
  const release = acquireProcessLease(join(root(w), 'source-debt/v1/writer.lock'));
  if (!release) throw Error('WRITE_OFF_WRITER_BUSY');
  try {
    const snapshot = applySourceDebtWriteOffs(w, rawSnapshot(w, now), now);
    if (snapshot.corrupt) throw Error('WRITE_OFF_STATE_INVALID');
    let state = automaticActivity(w);
    const policy: RecoveryPolicy = { schema: 'engram.memory-recovery-policy.v1', workspaceId: config.workspace.id,
      evidenceTtlHours: state.projection.limits.evidenceTtlHours };
    const all = rows(join(root(w), 'source-debt/v1/failures')) as SourceDebtRecord[];
    const groups = new Map<Digest, SourceDebtRecord[]>();
    for (const r of all) { const group = groups.get(r.debtId) ?? []; group.push(r); groups.set(r.debtId, group); }
    const eligible = snapshot.openIds.filter(id => automaticEligibility(groups.get(id) ?? [], policy, state, now)).slice(0, 20);
    if (options.apply && eligible.length && rows(directory(w), true).length + eligible.length > 10_000) throw Error('WRITE_OFF_CAPACITY_EXCEEDED');
    options.beforePublish?.();
    if (options.beforePublish) state = automaticActivity(w);
    if (read(join(w, 'engram.json')).memoryObservation?.autoStopExpiredRecovery !== true)
      return { status: 'disabled' as const, receipts: [] as AutomaticReceipt[], canonicalWrites: 0 };
    const receipts: AutomaticReceipt[] = [];
    for (const debtId of eligible) {
      const rs = groups.get(debtId)!;
      const decision = automaticEligibility(rs, policy, state, now); if (!decision) continue;
      const body = { schema: 'engram.memory-source-debt-writeoff.v2' as const, disposition: 'policy_recovery_stopped' as const,
        workspaceId: policy.workspaceId, debtId, recordIds: rs.map(r => r.recordId).sort(), policy, policyDigest: sha256(policy),
        ...decision, stoppedAt: now.toISOString(), evidenceDigest: sha256({ recordIds: rs.map(r => r.recordId).sort(), ...decision }) };
      const receipt = { ...body, receiptId: sha256(body) }; validReceipt(receipt, now);
      if (options.apply) { publishReceipt(w, receipt); options.afterReceipt?.(); }
      receipts.push(receipt);
    }
    if (options.apply && receipts.length) {
      const after = applySourceDebtWriteOffs(w, rawSnapshot(w, now), now);
      if (after.corrupt) throw Error('WRITE_OFF_READBACK_FAILED');
      // A concurrent real arrival may reopen a receipt; it is never a recovered source.
    }
    return { status: options.apply ? 'completed' as const : 'planned' as const, receipts, canonicalWrites: 0 };
  } finally { release(); }
}
/** Read-only overlay. Additional failures or reactivation reopen the identity;
 * an old decision never suppresses new errors, even on the same source. */
export function applySourceDebtWriteOffs(w: string, s: RawSnapshot, now = new Date()): SourceDebtSnapshot {
  const writtenOffIds: Digest[] = [];
  const automaticallyStoppedIds: Digest[] = [];
  try {
    const receipts = rows(directory(w), true);
    if (receipts.length > 10_000) throw Error('WRITE_OFF_CAPACITY_EXCEEDED');
    const allRecords: SourceDebtRecord[] = receipts.length ? rows(join(root(w), 'source-debt/v1/failures')) : [];
    const state = receipts.length ? activity(w) : undefined;
    let automaticState: ReturnType<typeof automaticActivity> | undefined;
    for (const r of receipts as Array<Receipt | AutomaticReceipt>) {
      validReceipt(r, now);
      if (r.workspaceId !== s.workspaceId || !s.debtIds.includes(r.debtId)
        || !existsSync(join(directory(w), r.receiptId.slice(7) + '.json'))) throw Error('WRITE_OFF_OWNER_OR_IDENTITY_INVALID');
      if (s.corrupt || !s.openIds.includes(r.debtId)) continue;
      const rs = allRecords.filter(x => x.debtId === r.debtId);
      if (r.schema === 'engram.memory-source-debt-writeoff.v2') {
        automaticState ??= automaticActivity(w);
        const eligible = automaticEligibility(rs, r.policy, automaticState, now);
        if (rs.length && sha256(rs.map(x => x.recordId).sort()) === sha256(r.recordIds)
          && eligible && Date.parse(eligible.recoveryDeadline) <= Date.parse(r.recoveryDeadline) && eligible.reasonCode === r.reasonCode) {
          writtenOffIds.push(r.debtId); automaticallyStoppedIds.push(r.debtId);
        }
      } else if (matches(w, r, rs, state)) writtenOffIds.push(r.debtId);
    }
    const { snapshotDigest: _old, ...base } = s;
    const unique = [...new Set(writtenOffIds)].sort();
    const result = { ...base, openIds: s.openIds.filter(id => !unique.includes(id)), writtenOffIds: unique,
      ...(receipts.some(r => r.schema === 'engram.memory-source-debt-writeoff.v2') ? { automaticallyStoppedIds: [...new Set(automaticallyStoppedIds)].sort() } : {}) };
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
    publishReceipt(w, receipt);
    const after = applySourceDebtWriteOffs(w, rawSnapshot(w, now), now);
    if (after.corrupt || !after.writtenOffIds?.includes(request.debtId)) throw Error('WRITE_OFF_READBACK_FAILED');
    return { status: 'operator_written_off', receipt, canonicalWrites: 0 };
  } finally { release(); }
}
