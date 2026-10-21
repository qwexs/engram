import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveTraceId, sha256 } from './ledger.ts';
import { sourceDebtId, sourceDebtSnapshot as rawSnapshot } from './source-debt-capture.ts';
import { sourceDebtSnapshot } from './source-debt.ts';
import { writeOffSourceDebt } from './source-debt-writeoff.ts';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const w = mkdtempSync(join(tmpdir(), 'writeoff-')); roots.push(w);
  const put = (p: string, value: any) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(value)); };
  put(join(w, 'engram.json'), { workspace: { id: 'alpha' } });
  const now = new Date('2026-01-03T00:00:00Z'), at = '2026-01-01T00:00:00Z';
  const scope = { workspaceId: 'alpha', runtimeSessionKey: 'agent:alpha:main', scopeClass: 'self' as const, scopeId: 'self:alpha' };
  const sourceTurnId = 'channel-user:v1:' + 'a'.repeat(64), identity = { kind: 'source' as const, id: sourceTurnId };
  const traceId = deriveTraceId('alpha', scope.runtimeSessionKey, sourceTurnId), debtId = sourceDebtId(scope, identity);
  const body = { schema: 'engram.memory-source-debt.v1', debtId, scope, identity, classification: 'confirmed_completed_source', traceId, candidateId: null,
    sourceTurnId, stage: 'evaluation', reasonCode: 'batch_invalid_json', failedAt: at, proofDigest: sha256('failure'), sourceProof: null, batchParents: [] };
  const r = { ...body, recordId: sha256(body) }, base = join(w, 'memory-state/memory-observation');
  const failures = join(base, 'source-debt/v1/failures'); put(join(failures, r.recordId.slice(7) + '.json'), r);
  const q = join(base, 'v1/queues/evaluator', traceId.slice(7) + '.json');
  const request = { workspaceId: 'alpha', debtId, recordIds: [r.recordId], reasonCode: 'recovery_attempts_exhausted' as const,
    evidenceDigest: sha256('exact-reviewed-failure'), authorizedBy: 'operator:synthetic/message:1', authorizedAt: now.toISOString(), historicalCutoff: at };
  return { w, base, failures, q, r, request, now, put };
}
test('plan changes no state; apply is idempotent accounting, not raw closure or queue mutation', () => {
  const f = fixture(), before = readFileSync(join(f.failures, readdirSync(f.failures)[0]!), 'utf8');
  expect(writeOffSourceDebt(f.w, f.request, { now: f.now }).status).toBe('planned');
  expect(sourceDebtSnapshot(f.w, f.now).openIds).toEqual([f.r.debtId]);
  for (let i = 0; i < 2; i++) expect(writeOffSourceDebt(f.w, f.request, { apply: true, now: f.now }).status).toBe('operator_written_off');
  expect(sourceDebtSnapshot(f.w, f.now)).toMatchObject({ openIds: [], closedIds: [], writtenOffIds: [f.r.debtId], corrupt: false });
  expect(rawSnapshot(f.w, f.now).openIds).toEqual([f.r.debtId]);
  expect(readFileSync(join(f.failures, readdirSync(f.failures)[0]!), 'utf8')).toBe(before);
});
test('queued, claimed, unresolved, deferred and pending job sources cannot be written off', () => {
  for (const [status, reasonCode] of [['queued', 'retry'], ['claimed', 'retry'], ['terminal', 'semantic_contextual_unresolved'], ['terminal', 'semantic_batch_defer']]) {
    const f = fixture(); f.put(f.q, { traceId: f.r.traceId, status, reasonCode });
    expect(() => writeOffSourceDebt(f.w, f.request, { apply: true, now: f.now })).toThrow('STATE_CHANGED_OR_ACTIVE');
  }
  const f = fixture(); f.put(join(f.base, 'batch-live-store/memory-batch-live/v1/jobs', 'b'.repeat(64) + '.json'), { jobId: sha256('pending'), bundle: { sourceRefs: [{ traceId: f.r.traceId }] } });
  expect(() => writeOffSourceDebt(f.w, f.request, { apply: true, now: f.now })).toThrow('STATE_CHANGED_OR_ACTIVE');
});
test('reactivation and a new exact failure reopen written off source, never silence new errors', () => {
  const f = fixture(); writeOffSourceDebt(f.w, f.request, { apply: true, now: f.now });
  f.put(f.q, { traceId: f.r.traceId, status: 'queued', reasonCode: 'retry' });
  expect(sourceDebtSnapshot(f.w, f.now)).toMatchObject({ writtenOffIds: [], openIds: [f.r.debtId], corrupt: false });
  rmSync(f.q); const { recordId: _, ...base } = f.r, body = { ...base, proofDigest: sha256('new-error') };
  const r = { ...body, recordId: sha256(body) }; f.put(join(f.failures, r.recordId.slice(7) + '.json'), r);
  expect(sourceDebtSnapshot(f.w, f.now).openIds).toEqual([f.r.debtId]);
});
test('wrong scope, wrong record set, recent failures, unknown reasons and future authorization fail closed', () => {
  for (const change of [{ workspaceId: 'beta' }, { recordIds: [sha256('other')] }, { historicalCutoff: '2025-12-31T00:00:00Z' }, { reasonCode: 'anything' }, { authorizedAt: '2027-01-01T00:00:00Z' }]) {
    const f = fixture(); expect(() => writeOffSourceDebt(f.w, { ...f.request, ...change } as any, { apply: true, now: f.now })).toThrow();
    expect(sourceDebtSnapshot(f.w, f.now).openIds).toEqual([f.r.debtId]);
  }
});
test('successful evaluator and pending daily effects cannot be hidden by an old failure waiver', () => {
  const f = fixture();
  f.put(f.q, { traceId: f.r.traceId, status: 'terminal', reasonCode: 'semantic_contextual_asserted' });
  expect(() => writeOffSourceDebt(f.w, f.request, { apply: true, now: f.now })).toThrow('STATE_CHANGED_OR_ACTIVE');
  rmSync(f.q);
  const observationId = sha256('pending-daily');
  f.put(join(f.base, 'v1/consumers/daily-note/queue', observationId.slice(7) + '.json'), { observationId, status: 'qmd_pending' });
  f.put(join(f.base, 'v1/observations/batch', observationId.slice(7) + '.json'), { sourceRefs: [{ traceId: f.r.traceId }] });
  expect(() => writeOffSourceDebt(f.w, f.request, { apply: true, now: f.now })).toThrow('STATE_CHANGED_OR_ACTIVE');
});
test('corrupt or foreign receipt is explicit error and preserves open debt; symlinks rejected', () => {
  const f = fixture(), result = writeOffSourceDebt(f.w, f.request, { apply: true, now: f.now });
  const path = join(f.base, 'source-debt-writeoffs/v1', result.receipt.receiptId.slice(7) + '.json');
  f.put(path, { ...result.receipt, reasonCode: 'tampered' });
  expect(sourceDebtSnapshot(f.w, f.now)).toMatchObject({ corrupt: true, openIds: [f.r.debtId], writtenOffIds: [] });
  const g = fixture(); symlinkSync(f.base, join(g.base, 'source-debt-writeoffs'));
  expect(() => writeOffSourceDebt(g.w, g.request, { apply: true, now: g.now })).toThrow('UNSAFE_PATH');
});
