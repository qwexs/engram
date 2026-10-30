/** Receipt-specific historical consumer context, not a live producer allowlist.
 * Operator-reviewed immutable metadata only; never loaded by inference/apply. */
import {existsSync,lstatSync,readFileSync,realpathSync,mkdirSync,openSync,writeFileSync,closeSync,fsyncSync,linkSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256,type Digest,type ObservationScope} from './ledger.ts';
import {memoryObservationBinding,resolveMemoryObservationProjection,type MemoryObservationProjectionV1} from './projection.ts';
import {validateModelTransition,type ModelTransition} from './model-transition.ts';
import {qualityScopeEnabled,readableContextualDigests,rebindQualityRollout,type QualityRollout} from './quality-rollout.ts';
type Row=Record<string,any>;
const hash=(x:any)=>sha256(x),HASH=/^sha256:[a-f0-9]{64}$/;
export type HistoricalConsumerProof={schema:'engram.historical-consumer-proof.v1';workspaceId:string;receiptId:Digest;receiptDigest:Digest;
 projection:MemoryObservationProjectionV1;quality:(QualityRollout&{digest:Digest})|null;transition:ModelTransition|null;
 archiveRef:string;archiveDigest:Digest;authorizedBy:string;authorizedAt:string;authorizationSource:string;certificateId:Digest};
export const historicalConsumerProofPath=(w:string,id:Digest)=>join(w,'memory-state/memory-observation/historical-consumer-proofs/v1',id.slice(7)+'.json');
function invalid():never{throw Error('historical_consumer_proof_invalid');}
export function validateHistoricalConsumerProof(c:HistoricalConsumerProof,r:Row,live:MemoryObservationProjectionV1,scope:ObservationScope,now:Date){
 const{certificateId,...body}=c;
 if(Object.keys(c).sort().join()!=='archiveDigest,archiveRef,authorizationSource,authorizedAt,authorizedBy,certificateId,projection,quality,receiptDigest,receiptId,schema,transition,workspaceId'
  ||c.schema!=='engram.historical-consumer-proof.v1'||certificateId!==hash(body)||c.workspaceId!==scope.workspaceId||c.receiptId!==r.receiptId||c.receiptDigest!==hash(r)
  ||!HASH.test(c.archiveDigest)||!c.archiveRef||!c.authorizedBy||!c.authorizationSource||!Number.isFinite(Date.parse(c.authorizedAt))||Date.parse(c.authorizedAt)>now.getTime())invalid();
 const p=c.projection,d=p?.consumers?.dailyNote,active=memoryObservationBinding(live,scope.runtimeSessionKey),old=memoryObservationBinding(p,scope.runtimeSessionKey);
 if(p.workspaceId!==scope.workspaceId||!p.enabled||p.mode!=='canary'||!d||!old||!active
  ||old.scopeClass!==scope.scopeClass||old.scopeId!==scope.scopeId||active.scopeClass!==scope.scopeClass||active.scopeId!==scope.scopeId
  ||p.evaluation?.batch?.sourcePolicyDigest!==live.evaluation?.batch?.sourcePolicyDigest||!HASH.test(p.evaluation?.policyDigest??'')
  ||Date.parse(r.completedAt)<Date.parse(d.applyAfter)||!d.allowedObservationClasses.includes(r.sourceProvenance.observationClass))invalid();
 if(c.transition)validateModelTransition(c.transition,p);
 if(c.quality){const identity={workspaceId:p.workspaceId,pluginDigest:p.pluginDigest,baseEvaluationPolicyDigest:p.evaluation!.policyDigest,sourcePolicyDigest:p.evaluation!.batch!.sourcePolicyDigest,applyAfter:d.applyAfter};
  rebindQualityRollout(c.quality,identity,identity,c.quality.inventoryDigest,c.quality.preparedAt);}
 const policies=(projection:MemoryObservationProjectionV1,q:QualityRollout|null)=>[projection.evaluation!.policyDigest,...qualityScopeEnabled(q,scope)?readableContextualDigests(projection.evaluation!.policyDigest):[]];
 const readable=[...new Set([...policies(p,c.quality),...(c.transition?policies(c.transition.previousProjection,c.transition.previousQuality):[])])];
 if(!readable.includes(r.sourceProvenance.batchEvaluationPolicyDigest))invalid();
 return {projection:p,quality:c.quality,transition:c.transition,readable,certificateId};
}
export function readHistoricalConsumerProof(w:string,r:Row,live:MemoryObservationProjectionV1,scope:ObservationScope,now:Date,override?:HistoricalConsumerProof[]){
 const p=historicalConsumerProofPath(w,r.receiptId);
 const selected=override?.filter(x=>x.receiptId===r.receiptId);
 if(selected&&selected.length>1)invalid();
 let c=selected?.[0];
 if(!c&&existsSync(p)){if(realpathSync(p)!==resolve(p)||!lstatSync(p).isFile())invalid();c=JSON.parse(readFileSync(p,'utf8'));}
 return c?validateHistoricalConsumerProof(c,r,live,scope,now):null;
}
export function publishHistoricalConsumerProof(w:string,c:HistoricalConsumerProof,r:Row,now=new Date()){
 if(!w.startsWith('/')||realpathSync(w)!==w||!HASH.test(r.operationId??''))invalid();
 const receiptPath=join(w,'memory-state/memory-observation/v1/receipts/by-operation',r.operationId.slice(7)+'.json');
 if(realpathSync(receiptPath)!==resolve(receiptPath)||hash(JSON.parse(readFileSync(receiptPath,'utf8')))!==hash(r))invalid();
 const live=resolveMemoryObservationProjection({workspace:w,workspaceId:c.workspaceId});validateHistoricalConsumerProof(c,r,live,r.scope,now);
 const p=historicalConsumerProofPath(w,c.receiptId);if(existsSync(p)){if(realpathSync(p)!==resolve(p)||hash(JSON.parse(readFileSync(p,'utf8')))!==hash(c))invalid();return p;}
 const ensure=(dir:string)=>{if(existsSync(dir)){if(realpathSync(dir)!==resolve(dir)||!lstatSync(dir).isDirectory())invalid();return;}ensure(dirname(dir));mkdirSync(dir,{mode:0o700});};ensure(dirname(p));
 const tmp=p+'.tmp-'+randomUUID(),fd=openSync(tmp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(c)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 try{linkSync(tmp,p);const d=openSync(dirname(p),'r');try{fsyncSync(d);}finally{closeSync(d);}}finally{rmSync(tmp,{force:true});}
 return p;
}
