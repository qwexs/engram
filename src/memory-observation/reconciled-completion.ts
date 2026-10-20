import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,linkSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {sha256} from './ledger.ts';
import type {BatchLiveJobV1} from './batch-live-worker.ts';
import {validateCompiledBatchBundle} from './batch-shadow-runner.ts';
import {buildContextualObservation} from './contextual-observation.ts';
import {contextualBatchObservations} from './contextual-batch-observation.ts';
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const same=(a:any,b:any)=>sha256(a)===sha256(b);
function requireProof(ok:any):asserts ok{if(!ok)throw Error('RECONCILED_COMPLETION_UNVERIFIED');}
function flush(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function atomic(path:string,value:any,immutable=false){
 mkdirSync(dirname(path),{recursive:true,mode:0o700});const tmp=path+'.tmp-'+randomUUID(),fd=openSync(tmp,'wx',0o600);
 try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 if(immutable){try{linkSync(tmp,path);}catch(e:any){if(e.code!=='EEXIST'||!same(read(path),value))throw e;}finally{unlinkSync(tmp);}}
 else renameSync(tmp,path);flush(dirname(path));
}

/** Called only after the evaluator has persisted/validated the result and
 * completed exact source claims under its evaluator lease. A completed explicit
 * recovery can re-use an identical one-source job ID: retain the old exhaustion
 * done marker in that recovery journal before publishing the proven terminal. */
export function publishReconciledCompletion(options:{workspace:string,batchRoot:string,job:BatchLiveJobV1,terminal:any,faultAt?:'after_archive'|'after_publish'}):boolean{
 const {workspace,batchRoot,job,terminal}=options,key=job.jobId.slice(7),donePath=join(batchRoot,'done',key+'.json');
 if(!existsSync(donePath)||same(read(donePath),terminal))return false;
 const old=read(donePath);
 if(old.schema!=='engram.memory-batch-live-reconciliation.v1')return false;
 requireProof(batchRoot===join(workspace,'memory-state/memory-observation/batch-live-store/memory-batch-live/v1'));
 const {reconciliationId,...recBody}=old;
 requireProof(reconciliationId===sha256(recBody)&&old.jobId===job.jobId&&old.bundleId===job.bundle.bundleId&&old.evaluationPolicyDigest===job.evaluationPolicyDigest
  &&same(old,read(join(batchRoot,'reconciliations',key+'.json')))&&same(old.sources.map((s:any)=>s.traceId),job.bundle.sourceRefs.map(s=>s.traceId)));
 validateCompiledBatchBundle(job.bundle,new Date(job.createdAt));
 requireProof(job.schema==='engram.memory-batch-live-job.v1'&&same(job,read(join(batchRoot,'jobs',key+'.json')))
  &&job.jobId===sha256({schema:job.schema,partition:job.partition,evaluationPolicyDigest:job.evaluationPolicyDigest,bundleId:job.bundle.bundleId}));
 const recoveryRoot=join(batchRoot,'recoveries',key),matches:any[]=[];
 if(existsSync(recoveryRoot))for(const name of readdirSync(recoveryRoot).filter(n=>/^[a-f0-9]{64}$/.test(n))){
  const path=join(recoveryRoot,name);if(!existsSync(join(path,'completed.json'))||!existsSync(join(path,'authorization.json')))continue;
  const completed=read(join(path,'completed.json')),auth=read(join(path,'authorization.json'));
  if(completed.schema!=='engram.memory-reconciled-recovery.v1'||completed.reconciliationId!==reconciliationId)continue;
  const {recoveryId,status,...base}=completed;
  requireProof(status==='requeued'&&recoveryId===sha256(base)&&recoveryId.slice(7)===name&&base.jobId===job.jobId
   &&typeof base.authorizedBy==='string'&&base.authorizedBy.trim()&&typeof base.reason==='string'&&base.reason.trim()
   &&Number.isFinite(Date.parse(base.authorizedAt))&&Date.parse(base.authorizedAt)<=Date.parse(terminal.completedAt)
   &&Array.isArray(auth.queues)&&auth.queues.length>0
   &&same({...base,recoveryId,queues:auth.queues},auth)&&same(base.traceIds,auth.queues.map((q:any)=>q.traceId))
   &&same(base.traceIds,old.sources.filter((s:any)=>s.status==='terminal'&&s.reasonCode==='batch_contextual_evaluation_failed'&&s.attempt>=s.maxAttempts).map((s:any)=>s.traceId)));
  for(const q of auth.queues){const s=old.sources.find((s:any)=>s.traceId===q.traceId);
   requireProof(s&&s.status==='terminal'&&s.reasonCode==='batch_contextual_evaluation_failed'&&s.attempt>=s.maxAttempts
    &&q.originalDigest===s.queueDigest&&q.originalDigest===sha256(q.original)&&q.requeuedDigest===sha256(q.requeued)
    &&same(q.requeued,{...q.original,status:'queued',attempt:0,nextAttemptAt:base.authorizedAt,updatedAt:base.authorizedAt,claimedAt:null,claimToken:null,terminalAt:null,reasonCode:'operator_recovery_requeued'}));}
  matches.push({path,recoveryId});
 }
 requireProof(matches.length===1);
 const saved=read(join(batchRoot,'contextual-results',key+'.json')),{digest,...savedBody}=saved;
 requireProof(saved.schema==='engram.memory-contextual-result.v2'&&saved.jobId===job.jobId&&saved.policyDigest===job.evaluationPolicyDigest&&digest===sha256(savedBody));
 const observed=saved.evaluated.observation,output={schema:'engram.memory-contextual-output.v2' as const,assertions:observed.assertions,dispositions:observed.dispositions};
 requireProof(same(buildContextualObservation(output,job.bundle,observed.evaluationPolicyDigest,new Date(observed.recordedAt)),observed));
 const observations=contextualBatchObservations(output,job.bundle,job.evaluationPolicyDigest,new Date(observed.recordedAt));
 const byAssertion=new Map(observations.map(o=>[o.groupId,o.observationId]));
 const dispositions=observed.dispositions.map((d:any)=>({traceId:d.traceId,decision:d.assertionIds.length?'write':'skip',reasonCode:'semantic_contextual_'+d.kind,observationRefs:d.assertionIds.map((id:string)=>byAssertion.get(id))}));
 const terminalBase={schema:'engram.memory-batch-live-terminal.v2',jobId:job.jobId,bundleId:job.bundle.bundleId,resultKey:sha256({schema:'engram.memory-contextual-result-key.v2',requestDigest:saved.evaluated.requestDigest}),resultDigest:sha256(saved.evaluated),dispositions,sourceDispositions:observed.dispositions,completedAt:observed.recordedAt};
 requireProof(same(terminal,{...terminalBase,terminalId:sha256(terminalBase)})&&same(terminal,read(join(batchRoot,'terminals',key+'.json'))));
 for(const d of dispositions){const q=read(join(workspace,'memory-state/memory-observation/v1/queues/evaluator',d.traceId.slice(7)+'.json'));
  requireProof(q.status==='terminal'&&q.reasonCode===d.reasonCode&&q.claimToken===null);}
 for(const o of observations)requireProof(same(o,read(join(workspace,'memory-state/memory-observation/v1/observations/batch',o.observationId.slice(7)+'.json'))));
 const archive=join(matches[0].path,'superseded-done.json');atomic(archive,old,true);
 if(options.faultAt==='after_archive')throw Error('FAULT_INJECTED');
 requireProof(same(read(donePath),old));atomic(donePath,terminal);
 if(options.faultAt==='after_publish')throw Error('FAULT_INJECTED');
 return true;
}
