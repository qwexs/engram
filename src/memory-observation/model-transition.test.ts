import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {sha256} from './ledger.ts';
import {evaluationProjectionForScope,readModelTransition,readableEvaluationPolicies} from './model-transition.ts';
import {contextualEvaluationDigest,contextualThinkingForScope} from './quality-rollout.ts';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(r=>rmSync(r,{recursive:true,force:true})));
function fixture(){
 const workspace=mkdtempSync(join(tmpdir(),'mw-model-transition-'));roots.push(workspace);
 const scope={workspaceId:'alpha',runtimeSessionKey:'agent:alpha:telegram:direct:123',scopeClass:'self',scopeId:'workspace:alpha'} as const;
 const old:any={workspaceId:'alpha',pluginDigest:sha256('old-plugin'),bindings:[{...scope}],inference:{provider:'openai',model:'openai/gpt-5.6-terra',evaluateAfter:'2026-09-01T00:00:00.000Z'},evaluation:{policyDigest:sha256('old-base'),batch:{sourcePolicyDigest:sha256('source')}},consumers:{dailyNote:{applyAfter:'2026-09-01T00:00:00.000Z'}}};
 const current=structuredClone(old);current.pluginDigest=sha256('new-plugin');current.inference.model='openai/gpt-6-luna';current.evaluation.policyDigest=sha256('new-base');
 const q:any={schema:'engram.memory-quality-rollout.v1',mode:'active',workspaceId:'alpha',pluginDigest:old.pluginDigest,baseEvaluationPolicyDigest:old.evaluation.policyDigest,sourcePolicyDigest:old.evaluation.batch.sourcePolicyDigest,applyAfter:old.consumers.dailyNote.applyAfter,exactScopes:[scope],preparedAt:'2026-09-01T00:00:00.000Z',inventoryDigest:sha256('inventory')};
 const put=(rel:string,value:any)=>{const path=join(workspace,'memory-state/memory-observation',rel);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value));return path;};
 const body={schema:'engram.memory-model-transition.v1',targetProjectionDigest:sha256(current),previousProjection:old,previousQuality:{...q,digest:sha256(q)},approvedBy:'operator',approvedAt:'2026-10-01T18:52:49.000Z'};
 const save=()=>put('model-transition.json',{...body,digest:sha256(body)});save();
 const nq={...q,pluginDigest:current.pluginDigest,baseEvaluationPolicyDigest:current.evaluation.policyDigest};put('quality-rollout.json',{...nq,digest:sha256(nq)});
 mkdirSync(join(workspace,'memory-state/memory-observation/v1/queues/evaluator'),{recursive:true});
 const traceId=sha256('trace'),jobId=sha256('job');
 const job=(policy=contextualEvaluationDigest(old.evaluation.policyDigest,'memory-contextual-shadow-v16','medium'))=>put('batch-live-store/memory-batch-live/v1/jobs/'+jobId.slice(7)+'.json',{jobId,evaluationPolicyDigest:policy,partition:scope,bundle:{sourceRefs:[{traceId}]}});
 return {workspace,scope,old,current,body,save,put,traceId,jobId,job};
}
test('old immutable bundle resumes Terra medium; after done new sources choose Luna high',()=>{
 const f=fixture();const path=f.job();f.put('v1/queues/evaluator/'+f.traceId.slice(7)+'.json',{traceId:f.traceId,status:'queued'});const bytes=readFileSync(path,'utf8');
 expect(evaluationProjectionForScope(f.workspace,f.current,f.scope)).toEqual(f.old);
 expect(contextualThinkingForScope(f.workspace,f.scope,f.old.evaluation.policyDigest)).toBe('medium');
 expect(readableEvaluationPolicies(f.workspace,f.current,f.scope)).toContain(contextualEvaluationDigest(f.old.evaluation.policyDigest,'memory-contextual-shadow-v16','medium'));
 expect(readFileSync(path,'utf8')).toBe(bytes);
 f.put('batch-live-store/memory-batch-live/v1/done/'+f.jobId.slice(7)+'.json',{jobId:f.jobId});
 expect(evaluationProjectionForScope(f.workspace,f.current,f.scope)).toEqual(f.current);
});
test('transition cannot widen source scope, epoch, or target identity even with recomputed checksum',()=>{
 const f=fixture();expect(readModelTransition(f.workspace,f.current)).not.toBeNull();
 f.body.previousProjection.bindings.push({...f.scope,runtimeSessionKey:'agent:alpha:telegram:direct:999'});f.save();
 expect(()=>readModelTransition(f.workspace,f.current)).toThrow('MODEL_TRANSITION_SCOPE_CHANGED');
});
test('unknown live policy blocks duplicate production; historical terminal debt is not deleted',()=>{
 const f=fixture();const path=f.job(sha256('foreign-policy'));f.put('v1/queues/evaluator/'+f.traceId.slice(7)+'.json',{traceId:f.traceId,status:'queued'});
 expect(()=>evaluationProjectionForScope(f.workspace,f.current,f.scope)).toThrow('MODEL_TRANSITION_PENDING_POLICY_DENIED');
 f.put('v1/queues/evaluator/'+f.traceId.slice(7)+'.json',{traceId:f.traceId,status:'terminal'});
 expect(evaluationProjectionForScope(f.workspace,f.current,f.scope)).toEqual(f.current);expect(readFileSync(path,'utf8')).toContain('evaluationPolicyDigest');
});
