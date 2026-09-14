import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256, type ObservationScope } from './ledger.ts';
import { contextualEvaluationDigest, qualityProducerForScope, qualityTransitionInventory, readQualityRollout, type QualityRollout } from './quality-rollout.ts';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })));
const scope: ObservationScope = { workspaceId: 'alpha', runtimeSessionKey: 'agent:alpha:telegram:direct:100000001', scopeClass: 'self', scopeId: 'workspace:alpha' };
function setup() {
    const workspace = mkdtempSync(join(tmpdir(), 'quality-transition-'));
    roots.push(workspace);
    const rollout: QualityRollout = { schema: 'engram.memory-quality-rollout.v1', mode: 'active', workspaceId: 'alpha', pluginDigest: sha256('plugin'), baseEvaluationPolicyDigest: sha256('base'), sourcePolicyDigest: sha256('source'), applyAfter: '2026-09-01T12:00:00.000Z', exactScopes: [scope], preparedAt: '2026-09-01T13:00:00.000Z', inventoryDigest: qualityTransitionInventory(workspace).inventoryDigest };
    const put = (path: string, value: any) => { const file = join(workspace, 'memory-state/memory-observation', path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); return file; };
    const traceId = sha256('trace'), jobId = sha256('job');
    const job = (policy = rollout.baseEvaluationPolicyDigest) => put('batch-live-store/memory-batch-live/v1/jobs/' + jobId.slice(7) + '.json', { jobId, evaluationPolicyDigest: policy, partition: scope, bundle: { sourceRefs: [{ traceId }] } });
    return { workspace, rollout, put, job, traceId, jobId };
}
test('absent opt-in keeps v1; scoped active mode has a separate prompt-bound digest', () => {
    const f = setup();
    expect(readQualityRollout(f.workspace, f.rollout)).toBeNull();
    expect(qualityProducerForScope(f.workspace, scope, null)).toBe('v1');
    expect(qualityProducerForScope(f.workspace, scope, f.rollout)).toBe('v2');
    expect(qualityProducerForScope(f.workspace, { ...scope, runtimeSessionKey: scope.runtimeSessionKey + '-other' }, f.rollout)).toBe('v1');
    expect(contextualEvaluationDigest(f.rollout.baseEvaluationPolicyDigest)).not.toBe(f.rollout.baseEvaluationPolicyDigest);
});
test('binding, plugin, source-policy and activation-time drift fail closed', () => {
    const f = setup();
    f.put('quality-rollout.json', { ...f.rollout, digest: sha256(f.rollout) });
    expect(readQualityRollout(f.workspace, f.rollout)).toEqual(f.rollout);
    for (const k of ['pluginDigest', 'baseEvaluationPolicyDigest', 'sourcePolicyDigest', 'applyAfter'] as const)
        expect(() => readQualityRollout(f.workspace, { ...f.rollout, [k]: k === 'applyAfter' ? '2026-09-02T12:00:00.000Z' : sha256('drift') })).toThrow();
});
test('old unfinished bundle drains under original policy; source and job bytes remain unchanged', () => {
    const f = setup();
    const path = f.job();
    const q = f.put('v1/queues/evaluator/' + f.traceId.slice(7) + '.json', { traceId: f.traceId, status: 'queued' });
    const before = [readFileSync(path, 'utf8'), readFileSync(q, 'utf8')];
    expect(qualityProducerForScope(f.workspace, scope, f.rollout)).toBe('v1');
    expect(qualityTransitionInventory(f.workspace).batches).toHaveLength(1);
    expect([readFileSync(path, 'utf8'), readFileSync(q, 'utf8')]).toEqual(before);
});
test('rollback retains v2 sources, permits cached result completion, never silently re-evaluates as v1', () => {
    const f = setup();
    f.job(contextualEvaluationDigest(f.rollout.baseEvaluationPolicyDigest));
    f.put('v1/queues/evaluator/' + f.traceId.slice(7) + '.json', { traceId: f.traceId, status: 'queued' });
    const rollback = { ...f.rollout, mode: 'drain' as const };
    expect(qualityProducerForScope(f.workspace, scope, rollback)).toBe('blocked');
    f.put('batch-live-store/memory-batch-live/v1/contextual-results/' + f.jobId.slice(7) + '.json', {});
    expect(qualityProducerForScope(f.workspace, scope, rollback)).toBe('v2');
    f.put('v1/queues/evaluator/' + f.traceId.slice(7) + '.json', { traceId: f.traceId, status: 'terminal' });
    expect(qualityProducerForScope(f.workspace, scope, rollback)).toBe('v2'); // finish interrupted done receipt
    f.put('batch-live-store/memory-batch-live/v1/done/' + f.jobId.slice(7) + '.json', { jobId: f.jobId });
    expect(qualityProducerForScope(f.workspace, scope, rollback)).toBe('v1');
});
test('unknown pending policy blocks only its scope; historical terminal debt is retained in inventory', () => {
    const f = setup();
    f.job(sha256('unreviewed'));
    expect(qualityProducerForScope(f.workspace, scope, f.rollout)).toBe('blocked');
    f.put('v1/queues/evaluator/' + f.traceId.slice(7) + '.json', { traceId: f.traceId, status: 'terminal' });
    expect(qualityProducerForScope(f.workspace, scope, f.rollout)).toBe('v2');
    expect(qualityTransitionInventory(f.workspace).batches).toHaveLength(1);
});

test('preceding prompt version resumes its own producer and stays readable without broad policy acceptance',async()=>{
 const {readableContextualDigests,contextualPromptForScope}=await import('./quality-rollout.ts');
 const f=setup();const previous=contextualEvaluationDigest(f.rollout.baseEvaluationPolicyDigest,'memory-contextual-shadow-v10');
 expect(readableContextualDigests(f.rollout.baseEvaluationPolicyDigest)).toContain(previous);
 expect(readableContextualDigests(f.rollout.baseEvaluationPolicyDigest)).not.toContain(sha256('unreviewed'));
 f.job(previous);f.put('v1/queues/evaluator/'+f.traceId.slice(7)+'.json',{traceId:f.traceId,status:'queued'});
 expect(qualityProducerForScope(f.workspace,scope,f.rollout)).toBe('v2');
 expect(contextualPromptForScope(f.workspace,scope,f.rollout.baseEvaluationPolicyDigest)).toBe('memory-contextual-shadow-v10');
 expect(qualityProducerForScope(f.workspace,scope,{...f.rollout,mode:'drain'})).toBe('blocked');
 f.put('batch-live-store/memory-batch-live/v1/done/'+f.jobId.slice(7)+'.json',{jobId:f.jobId});
 expect(contextualPromptForScope(f.workspace,scope,f.rollout.baseEvaluationPolicyDigest)).toBe('memory-contextual-shadow-v15');
});

test('unfinished v13 job keeps its legacy parser and policy identity after v15 becomes default',async()=>{
 const {contextualPromptForScope}=await import('./quality-rollout.ts');const f=setup();
 const previous=contextualEvaluationDigest(f.rollout.baseEvaluationPolicyDigest,'memory-contextual-shadow-v13');
 f.job(previous);f.put('v1/queues/evaluator/'+f.traceId.slice(7)+'.json',{traceId:f.traceId,status:'queued'});
 expect(qualityProducerForScope(f.workspace,scope,f.rollout)).toBe('v2');
 expect(contextualPromptForScope(f.workspace,scope,f.rollout.baseEvaluationPolicyDigest)).toBe('memory-contextual-shadow-v13');
});

test('unfinished v14 job keeps its JSONL parser and policy identity after v15 becomes default',async()=>{
 const {contextualPromptForScope}=await import('./quality-rollout.ts');const f=setup();
 const previous=contextualEvaluationDigest(f.rollout.baseEvaluationPolicyDigest,'memory-contextual-shadow-v14');
 f.job(previous);f.put('v1/queues/evaluator/'+f.traceId.slice(7)+'.json',{traceId:f.traceId,status:'queued'});
 expect(qualityProducerForScope(f.workspace,scope,f.rollout)).toBe('v2');
 expect(contextualPromptForScope(f.workspace,scope,f.rollout.baseEvaluationPolicyDigest)).toBe('memory-contextual-shadow-v14');
});
