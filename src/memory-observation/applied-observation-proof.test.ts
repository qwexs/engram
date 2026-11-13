import {afterEach,expect,test} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {sha256} from './ledger.ts';
import {BATCH_EVALUATOR_AUTHORITY,deriveBatchObservationId} from './batch-observation.ts';
import {DAILY_NOTE_APPLICATOR,renderDailyNoteEntry} from './daily-note-applicator.ts';
import {persistedDailyEffectProof} from './applied-observation-proof.ts';
import {assertModelTransitionRetirable} from './model-transition-retirement.ts';

const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
function fixture(){
 const workspace=mkdtempSync(join(tmpdir(),'engram-applied-proof-'));roots.push(workspace);
 const root=join(workspace,'memory-state/memory-observation');
 const put=(p:string,v:any)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,typeof v==='string'?v:JSON.stringify(v));};
 put(join(workspace,'engram.json'),{workspace:{id:'project'}});
 const scope={workspaceId:'project',runtimeSessionKey:'agent:project:telegram:group:-1001:topic:1',scopeClass:'project',scopeId:'domain:project:general'};
 const source={traceId:sha256('trace'),sourceTurnId:'channel-user:v1:'+'1'.repeat(64),sourceDigest:sha256('source'),evidenceDigest:sha256('evidence'),sourceCompletedAt:'2026-09-01T00:00:00.000Z'};
 const identity={bundleId:sha256('bundle'),groupId:'g1',assertionIndex:0,observationClass:'episodic.event',evaluationPolicyDigest:sha256('historical-policy')};
 const body:any={schema:'engram.memory-batch-observation.v1',observationId:deriveBatchObservationId(identity as any),...identity,scope,
  sourceRefs:[source],producer:BATCH_EVALUATOR_AUTHORITY,targetConsumer:'daily-note',payload:{section:'events',text:'Verified synthetic outcome.',actorRef:'assistant',outcomeStatus:'completed'},
  citations:[{traceId:source.traceId,evidenceRef:{kind:'source-turn',ref:source.sourceTurnId,digest:sha256('citation')}}],sourceCompletedAt:source.sourceCompletedAt,
  confidence:1,reasonCodes:['verified_outcome'],completedAt:'2026-09-01T00:01:00.000Z'};
 const o={...body,observationDigest:sha256(body)};
 const entry=sha256(`engram.daily-note-entry.v1\0${o.observationId}`),operation=sha256(`engram.memory-apply.v1\0daily-note\0${o.observationId}\0${entry}`);
 const note=join(workspace,'memory/agent-project/telegram-group--1001-topic-1/2026-09-01.md'),rendered=renderDailyNoteEntry(o as any,entry);
 const r:any={schema:'engram.memory-apply-receipt.v1',consumer:'daily-note',status:'applied',canonicalMutation:true,producer:DAILY_NOTE_APPLICATOR,
  operationId:operation,destinationEntryId:entry,receiptId:sha256(`engram.memory-apply-receipt.v1\0${operation}`),sourceObservationRef:o.observationId,
  traceId:source.traceId,sourceCompletedAt:o.sourceCompletedAt,scope,sourceProvenance:{observationDigest:o.observationDigest,producer:o.producer,
   sourceTurnId:source.sourceTurnId,batchSourceRefs:o.sourceRefs,batchCitations:o.citations,batchEvaluationPolicyDigest:o.evaluationPolicyDigest,
   observationClass:o.observationClass,evidenceRefs:o.citations.map((c:any)=>c.evidenceRef)},destinationDate:'2026-09-01',
  destinationRef:relative(workspace,note)+`#engram-entry:${entry}`,readBackDigest:sha256(rendered),completedAt:'2026-09-01T00:02:00.000Z',policyDigest:sha256('old-consumer')};
 const obs=join(root,'v1/observations/batch',o.observationId.slice(7)+'.json'),receipt=join(root,'v1/receipts/by-operation',operation.slice(7)+'.json'),alias=join(root,'v1/receipts/by-entry',entry.slice(7)+'.json');
 put(obs,o);put(receipt,r);put(alias,r);put(note,'# Synthetic note\n\n'+rendered+'\n');
 return {workspace,root,put,o,r,note,obs,receipt,alias,operation,rendered};
}

test('immutable aliases and exact note read-back prove consumed effects without reconstructing a queue',()=>{
 const f=fixture(),before=[f.obs,f.receipt,f.alias,f.note].map(p=>readFileSync(p,'utf8'));
 expect(persistedDailyEffectProof(f.workspace,f.o)).toEqual({verified:true,receiptId:f.r.receiptId});
 expect([f.obs,f.receipt,f.alias,f.note].map(p=>readFileSync(p,'utf8'))).toEqual(before);
 expect(existsSync(join(f.root,'v1/consumers/daily-note/queue'))).toBe(false);
});

test('missing/forged aliases, changed sources and duplicate or modified canonical entries fail closed',()=>{
 for(const mutation of ['alias','digest','note','duplicate','source']){
  const f=fixture();
  if(mutation==='alias')rmSync(f.alias);
  if(mutation==='digest'){f.r.readBackDigest=sha256('forged');f.put(f.receipt,f.r);f.put(f.alias,f.r);}
  if(mutation==='note')f.put(f.note,'# No matching entry\n');
  if(mutation==='duplicate')f.put(f.note,f.rendered+'\n'+f.rendered+'\n');
  if(mutation==='source')f.o.sourceRefs[0].sourceTurnId='channel-user:v1:'+'2'.repeat(64);
  expect(persistedDailyEffectProof(f.workspace,f.o).verified).toBe(false);
 }
});

test('symlink destinations and a QMD-bound receipt without index proof cannot complete a drain',()=>{
 const f=fixture(),saved=f.note+'.retained';f.put(saved,readFileSync(f.note,'utf8'));rmSync(f.note);symlinkSync(saved,f.note);
 expect(persistedDailyEffectProof(f.workspace,f.o).verified).toBe(false);
 const g=fixture();g.r.qmdBinding={collection:'synthetic-topic'};g.put(g.receipt,g.r);g.put(g.alias,g.r);
 expect(persistedDailyEffectProof(g.workspace,g.o).verified).toBe(false);
});

test('retirement accepts receipt-backed history but still requires domain completion and drains live queues',()=>{
 const f=fixture(),before:any={schema:'engram.memory-observation-rollout.v4',workspaceId:'project',enabled:true,mode:'canary',pluginDigest:sha256('new-plugin'),
  bindings:[{runtimeSessionKey:f.o.scope.runtimeSessionKey,scopeId:f.o.scope.scopeId,scopeClass:'project',topicDomain:{domain:'general',chatId:'-1001',topicId:'1'}}],
  inference:{model:'openai/gpt-6-luna',provider:'openai'},evaluation:{policyDigest:sha256('new-policy'),batch:{sourcePolicyDigest:sha256('source')}},
  consumers:{dailyNote:{qmdBinding:{manifestPath:'/synthetic.json'}}}};
 const previousProjection=structuredClone(before);previousProjection.inference.model='openai/gpt-5.6-terra';previousProjection.pluginDigest=sha256('old-plugin');previousProjection.evaluation.policyDigest=sha256('old-policy');
 const body={schema:'engram.memory-model-transition.v1',targetProjectionDigest:sha256(before),previousProjection,previousQuality:null,approvedBy:'operator',approvedAt:'2026-10-01T00:00:00.000Z'};
 f.put(join(f.root,'projection.json'),before);f.put(join(f.root,'model-transition.json'),{...body,digest:sha256(body)});
 expect(()=>assertModelTransitionRetirable(f.workspace,before)).toThrow('MODEL_TRANSITION_DOMAIN_DRAIN_REQUIRED');
 const applied={schema:'engram.domain-apply-receipt.v1',operationId:f.operation,sourceReceiptId:f.r.receiptId,canonicalApplied:true};
 f.put(join(f.workspace,'memory-state/domain-effects/v1/receipts',f.operation.slice(7)+'.json'),applied);
 f.put(join(f.workspace,'memory-state/domain-effects/v1/dirty',f.operation.slice(7)+'.json'),{schema:'engram.domain-dirty-receipt.v1',operationId:f.operation,canonicalApplied:true,qmdDirtyMarked:true,domainApplyReceiptDigest:sha256(applied)});
 expect(assertModelTransitionRetirable(f.workspace,before)?.receiptBackedConsumed).toEqual([f.o.observationId]);
 f.put(join(f.root,'v1/consumers/daily-note/queue',f.o.observationId.slice(7)+'.json'),{observationId:f.o.observationId,status:'queued'});
 expect(()=>assertModelTransitionRetirable(f.workspace,before)).toThrow('MODEL_TRANSITION_DRAIN_REQUIRED');
});
