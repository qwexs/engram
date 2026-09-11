import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, type Digest, type JsonValue, type ObservationScope } from './ledger.ts';
import { CONTEXTUAL_PROMPT_VERSION } from './contextual-observation.ts';
export type QualityRollout = {
    schema: 'engram.memory-quality-rollout.v1';
    mode: 'active' | 'drain';
    workspaceId: string;
    pluginDigest: Digest;
    baseEvaluationPolicyDigest: Digest;
    sourcePolicyDigest: Digest;
    applyAfter: string;
    exactScopes: ObservationScope[];
    preparedAt: string;
    inventoryDigest: Digest;
};
const hash = (v: unknown) => sha256(v as JsonValue);
export function contextualEvaluationDigest(base: Digest): Digest {
    return hash({ schema: 'engram.memory-contextual-policy.v2', baseEvaluationPolicyDigest: base, promptVersion: CONTEXTUAL_PROMPT_VERSION });
}
/** An opt-in sidecar does not rewrite source admission, the v1 projection,
 * activation time or old receipts. Both consumer policy digests remain admitted
 * during a producer-only rollback (drain). Removing the sidecar is NOT rollback. */
export function readQualityRollout(workspace: string, expected: Pick<QualityRollout, 'workspaceId' | 'pluginDigest' | 'baseEvaluationPolicyDigest' | 'sourcePolicyDigest' | 'applyAfter'>): QualityRollout | null {
    const path = join(workspace, 'memory-state/memory-observation/quality-rollout.json');
    if (!existsSync(path))
        return null;
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    const { digest, ...value } = saved;
    if (value.schema !== 'engram.memory-quality-rollout.v1' || !['active', 'drain'].includes(value.mode)
        || Object.keys(value).sort().join(',') !== 'applyAfter,baseEvaluationPolicyDigest,exactScopes,inventoryDigest,mode,pluginDigest,preparedAt,schema,sourcePolicyDigest,workspaceId'
        || digest !== hash(value) || !/^sha256:[a-f0-9]{64}$/.test(value.inventoryDigest)
        || !Number.isFinite(Date.parse(value.preparedAt)) || !Array.isArray(value.exactScopes) || !value.exactScopes.length
        || (['workspaceId', 'pluginDigest', 'baseEvaluationPolicyDigest', 'sourcePolicyDigest', 'applyAfter'] as const).some(k => value[k] !== expected[k])
        || value.exactScopes.some((s: any) => !s || Object.keys(s).sort().join(',') !== 'runtimeSessionKey,scopeClass,scopeId,workspaceId'
            || s.workspaceId !== expected.workspaceId || typeof s.runtimeSessionKey !== 'string' || !s.runtimeSessionKey.startsWith(`agent:${expected.workspaceId}:`)
            || !['self', 'managers', 'company', 'project'].includes(s.scopeClass) || typeof s.scopeId !== 'string' || !s.scopeId)
        || new Set(value.exactScopes.map(hash)).size !== value.exactScopes.length)
        throw Error('QUALITY_ROLLOUT_IDENTITY_CHANGED');
    return value;
}
export function qualityScopeEnabled(rollout: QualityRollout | null, scope: ObservationScope): boolean {
    return !!rollout?.exactScopes.some(s => hash(s) === hash(scope));
}
function records(path: string): any[] {
    if (!existsSync(path))
        return [];
    return readdirSync(path).filter(n => n.endsWith('.json')).sort().map(n => JSON.parse(readFileSync(join(path, n), 'utf8')));
}
/** Read-only accounting: every unfinished artifact is listed; nothing gets
 * terminalized as a side effect of a policy-version change. */
export function qualityTransitionInventory(workspace: string) {
    const root = join(workspace, 'memory-state/memory-observation');
    const jobs = records(join(root, 'batch-live-store/memory-batch-live/v1/jobs'));
    const done = new Set(records(join(root, 'batch-live-store/memory-batch-live/v1/done')).map(v => v.jobId));
    const evaluator = records(join(root, 'v1/queues/evaluator'));
    const daily = records(join(root, 'v1/consumers/daily-note/queue'));
    const observations = records(join(root, 'v1/observations/batch'));
    const base = { schema: 'engram.memory-quality-transition-inventory.v1',
        evaluator: evaluator.filter(q => q.status !== 'terminal').map(q => ({ traceId: q.traceId, status: q.status, digest: hash(q) })),
        batches: jobs.filter(j => !done.has(j.jobId)).map(j => ({ jobId: j.jobId, policyDigest: j.evaluationPolicyDigest, partition: j.partition, sourceRefs: j.bundle.sourceRefs, digest: hash(j) })),
        consumer: daily.filter(q => q.status !== 'terminal').map(q => ({ observationId: q.observationId, status: q.status, digest: hash(q) })),
        unconsumed: observations.filter(o => !daily.some(q => q.observationId === o.observationId && q.status === 'terminal')).map(o => ({ observationId: o.observationId, scope: o.scope, policyDigest: o.evaluationPolicyDigest, digest: hash(o) })) };
    return { ...base, inventoryDigest: hash(base) };
}
/** Resume an immutable bundle under the producer that created it. Never let
 * a newer producer claim those same sources while its old job is outstanding. */
export function qualityProducerForScope(workspace: string, scope: ObservationScope, rollout: QualityRollout | null): 'v1' | 'v2' | 'blocked' {
    if (!qualityScopeEnabled(rollout, scope))
        return 'v1';
    const r = rollout!;
    const root = join(workspace, 'memory-state/memory-observation');
    const queues = new Map(records(join(root, 'v1/queues/evaluator')).map(q => [q.traceId, q]));
    const inventory = qualityTransitionInventory(workspace);
    const scopeHash = hash(scope);
    const jobs = inventory.batches.filter(j => hash({ workspaceId: j.partition.workspaceId, runtimeSessionKey: j.partition.runtimeSessionKey, scopeClass: j.partition.scopeClass, scopeId: j.partition.scopeId }) === scopeHash);
    const liveJobs = jobs.filter(j => [r.baseEvaluationPolicyDigest, contextualEvaluationDigest(r.baseEvaluationPolicyDigest)].includes(j.policyDigest) || j.sourceRefs.some((s: any) => queues.get(s.traceId)?.status !== 'terminal'));
    if (liveJobs.some(j => ![r.baseEvaluationPolicyDigest, contextualEvaluationDigest(r.baseEvaluationPolicyDigest)].includes(j.policyDigest)))
        return 'blocked';
    const pending = liveJobs[0];
    if (pending) {
        if (pending.policyDigest === r.baseEvaluationPolicyDigest)
            return 'v1';
        // Producer rollback may complete a persisted v2 result, but cannot make a
        // new v2 model call. Its sources stay queued and visible for explicit resume.
        if (r.mode === 'drain' && !existsSync(join(root, 'batch-live-store/memory-batch-live/v1/contextual-results', pending.jobId.slice(7) + '.json')))
            return 'blocked';
        return 'v2';
    }
    return r.mode === 'active' ? 'v2' : 'v1';
}
