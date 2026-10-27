import {afterEach,expect,test} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {deriveTraceId,sha256} from './ledger.ts';
import {sourceDebtId} from './source-debt-capture.ts';
import {sourceDebtSnapshot} from './source-debt.ts';
import {stopExpiredSourceDebt} from './source-debt-writeoff.ts';
import {memoryWorkerHealth} from './worker-health.ts';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(w=>rmSync(w,{recursive:true,force:true})));
function fixture(){
 const w=mkdtempSync(join(tmpdir(),'debt-expiry-'));roots.push(w);
 const root=join(w,'memory-state/memory-observation'),op=join(root,'v1');
 const put=(p:string,v:any)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,JSON.stringify(v));};
 const at='2026-01-01T00:00:00.000Z',now=new Date('2026-01-05T00:00:00.000Z');
 const scope={workspaceId:'alpha',runtimeSessionKey:'agent:alpha:telegram:direct:100000001',scopeClass:'self' as const,scopeId:'telegram:100000001'};
 const config={workspace:{id:'alpha'},memoryObservation:{autoStopExpiredRecovery:true}};
 put(join(w,'engram.json'),config);
 const projection={schema:'engram.memory-observation-rollout.v1',workspaceId:'alpha',enabled:true,mode:'canary',
  bindings:[{runtimeSessionKey:scope.runtimeSessionKey,scopeClass:scope.scopeClass,scopeId:scope.scopeId,requireOwner:true,allowedChannels:['telegram']}],
  pluginDigest:sha256('plugin'),inference:{provider:'openai',model:'openai/synthetic',evaluateAfter:at},
  limits:{evidenceTtlHours:72,maxJobs:1000,maxBytes:67108864,maxQueueAgeHours:168,maxAttempts:2,claimTtlSeconds:300,maxInferenceCalls:0},
  approvedBy:'synthetic',approvedAt:at,consumers:{dailyNote:{mode:'canary',applyAfter:at,timezone:'UTC',allowedObservationClasses:['episodic.event','episodic.decision'],maxAppliesPerWake:1,qmdBinding:{collection:'alpha-memory'}}},
  captureOwnership:{owner:'observer',effectiveAfter:at,foregroundDailyNoteCapture:'disabled'}};
 put(join(root,'projection.json'),projection);
 function debt(key='a',reasonCode='batch_invalid_json',extra:any={}){
  const sourceTurnId='channel-user:v1:'+key.repeat(64),identity={kind:'source' as const,id:sourceTurnId};
  const traceId=deriveTraceId('alpha',scope.runtimeSessionKey,sourceTurnId),debtId=sourceDebtId(scope,identity);
  const body={schema:'engram.memory-source-debt.v1',debtId,scope,identity,classification:'confirmed_completed_source',traceId,candidateId:null,
   sourceTurnId,stage:'evaluation',reasonCode,failedAt:at,proofDigest:sha256('failure'),sourceProof:null,batchParents:[],...extra};
  const r={...body,recordId:sha256(body)};
  put(join(root,'source-debt/v1/failures',r.recordId.slice(7)+'.json'),r);return r;
 }
 const r=debt();
 const queueFile=join(op,'queues/evaluator',r.traceId.slice(7)+'.json');
 const queue={schema:'engram.memory-observation-ledger-queue.v1',traceId:r.traceId,status:'terminal',reasonCode:r.reasonCode,createdAt:at,updatedAt:at,terminalAt:at,claimToken:null,claimedAt:null};
 put(queueFile,queue);
 const receiptDir=join(root,'source-debt-writeoffs/v1');
 return {w,root,op,put,at,now,scope,config,projection,debt,r,queue,queueFile,receiptDir};
}
test('opt-in and plan default; automatic stop is not a closure or queue mutation; repeat is a no-op',()=>{
 const f=fixture(),original=readFileSync(f.queueFile,'utf8');
 f.put(join(f.w,'engram.json'),{...f.config,memoryObservation:{}});
 expect(stopExpiredSourceDebt(f.w,f.now,{apply:true}).status).toBe('disabled');expect(existsSync(f.receiptDir)).toBe(false);
 f.put(join(f.w,'engram.json'),f.config);
 expect(stopExpiredSourceDebt(f.w,f.now).receipts).toHaveLength(1);expect(existsSync(f.receiptDir)).toBe(false);
 expect(stopExpiredSourceDebt(f.w,f.now,{apply:true}).receipts).toHaveLength(1);
 expect(sourceDebtSnapshot(f.w,f.now)).toMatchObject({openIds:[],closedIds:[],writtenOffIds:[f.r.debtId],automaticallyStoppedIds:[f.r.debtId],corrupt:false});
 expect(stopExpiredSourceDebt(f.w,new Date('2026-01-06T00:00:00Z'),{apply:true}).receipts).toHaveLength(0);
 expect(readdirSync(f.receiptDir)).toHaveLength(1);expect(readFileSync(f.queueFile,'utf8')).toBe(original);
 expect(memoryWorkerHealth(f.w,f.now)).toMatchObject({status:'accounted_incomplete',terminalFailures:0,historicalTerminalFailures:1,sourceDebtAutomaticallyStopped:1});
});
test('recent errors, fresh evidence, claims, results and pending downstream work are protected',()=>{
 for(const kind of ['recent','evidence','claim','daily','observation','successful_result','pending_job']){
  const f=fixture();
  if(kind==='recent')f.now=new Date('2026-01-02T00:00:00Z');
  if(kind==='evidence')f.put(join(f.op,'evidence',f.r.traceId.slice(7)+'.json'),{schema:'engram.memory-evidence-envelope.v1',traceId:f.r.traceId,scope:f.scope,expiresAt:'2026-01-06T00:00:00Z'});
  if(kind==='claim')f.put(f.queueFile,{...f.queue,status:'claimed',claimedAt:f.now.toISOString(),claimToken:'owner'});
  if(kind==='daily')f.put(join(f.op,'consumers/daily-note/queue',sha256('observation').slice(7)+'.json'),{schema:'engram.memory-observation-consumer-queue.v1',traceId:f.r.traceId,status:'qmd_pending'});
  if(kind==='observation')f.put(join(f.op,'observations/batch',sha256('observation').slice(7)+'.json'),{sourceRefs:[{traceId:f.r.traceId}]});
  if(kind==='successful_result')f.put(f.queueFile,{...f.queue,reasonCode:'semantic_contextual_asserted'});
  if(kind==='pending_job')f.put(join(f.root,'batch-live-store/memory-batch-live/v1/jobs',sha256('job').slice(7)+'.json'),{jobId:sha256('job'),bundle:{sourceRefs:[{traceId:f.r.traceId}]}});
  expect(stopExpiredSourceDebt(f.w,f.now,{apply:true}).receipts,kind).toHaveLength(0);
  expect(sourceDebtSnapshot(f.w,f.now).openIds).toEqual([f.r.debtId]);
 }
});
test('expired unresolved terminates only recovery; a new failure or reactivation reopens it',()=>{
 const f=fixture();rmSync(join(f.root,'source-debt/v1/failures'),{recursive:true});
 const r=f.debt('a','semantic_contextual_unresolved');f.put(f.queueFile,{...f.queue,reasonCode:r.reasonCode});
 const result=stopExpiredSourceDebt(f.w,f.now,{apply:true});expect(result.receipts[0]?.reasonCode).toBe('unresolved_window_ended');
 expect(sourceDebtSnapshot(f.w,f.now).closedIds).toEqual([]);
 f.put(f.queueFile,{...f.queue,status:'queued'});expect(sourceDebtSnapshot(f.w,f.now).openIds).toEqual([r.debtId]);
 f.put(f.queueFile,{...f.queue,reasonCode:r.reasonCode});
 expect(sourceDebtSnapshot(f.w,f.now).openIds).toEqual([]);
 f.debt('a','semantic_contextual_unresolved',{failedAt:f.now.toISOString(),proofDigest:sha256('new failure')});
 expect(sourceDebtSnapshot(f.w,f.now).openIds).toEqual([r.debtId]);
 expect(stopExpiredSourceDebt(f.w,f.now,{apply:true}).receipts).toHaveLength(0);
});
test('retained checkpoints and revoked scope cannot be disposed by an old TTL',()=>{
 for(const kind of ['pending','deadline','revoked']){
  const f=fixture();
  if(kind==='revoked')f.put(join(f.root,'projection.json'),{...f.projection,bindings:[{...f.projection.bindings[0],scopeId:'other'}]});
  else{
   rmSync(join(f.root,'source-debt/v1/failures'),{recursive:true});const candidateId=sha256('candidate');
   const identity={kind:'candidate',id:candidateId};f.debt('a','run_failed',{identity,debtId:sourceDebtId(f.scope,identity as any),candidateId});
   const cp={schema:'engram.memory-admission-checkpoint.v1',candidateId,scope:f.scope,stage:kind==='pending'?'received':'terminal_gap',expiresAt:'2026-01-07T00:00:00Z'};
   f.put(join(f.op,'pre-admission/checkpoints',candidateId.slice(7)+'.json'),{...cp,checkpointDigest:sha256(cp)});
  }
  expect(stopExpiredSourceDebt(f.w,f.now,{apply:true}).receipts,kind).toHaveLength(0);
 }
});
test('batch limit bounds initial fsync work; a second pass drains remaining identities',()=>{
 const f=fixture();for(const key of 'bcdef0123456789')f.debt(key);
 // Add a second exact source per key without using a non-hex identifier.
 for(let i=0;i<10;i++){
  const sourceTurnId='channel-user:v1:'+sha256('extra'+i).slice(7),identity={kind:'source',id:sourceTurnId};
  f.debt('a','batch_invalid_json',{sourceTurnId,identity,debtId:sourceDebtId(f.scope,identity as any),traceId:deriveTraceId('alpha',f.scope.runtimeSessionKey,sourceTurnId)});
 }
 expect(stopExpiredSourceDebt(f.w,f.now,{apply:true}).receipts).toHaveLength(20);
 expect(stopExpiredSourceDebt(f.w,f.now,{apply:true}).receipts).toHaveLength(6);
 expect(sourceDebtSnapshot(f.w,f.now).openIds).toEqual([]);
});
test('revalidation catches fresh arrival before publication; corrupt state never creates a waiver',()=>{
 const f=fixture();
 const result=stopExpiredSourceDebt(f.w,f.now,{apply:true,beforePublish:()=>f.put(f.queueFile,{...f.queue,status:'queued'})});
 expect(result.receipts).toHaveLength(0);expect(existsSync(f.receiptDir)).toBe(false);
 f.put(join(f.op,'evidence',f.r.traceId.slice(7)+'.json'),{schema:'engram.memory-evidence-envelope.v1',traceId:f.r.traceId,expiresAt:'bad'});
 expect(()=>stopExpiredSourceDebt(f.w,f.now,{apply:true})).toThrow();expect(existsSync(f.receiptDir)).toBe(false);
});
test('automatic receipts are content-free, scope-bound and checksum verified',()=>{
 const f=fixture();stopExpiredSourceDebt(f.w,f.now,{apply:true});
 const path=join(f.receiptDir,readdirSync(f.receiptDir)[0]!);const receipt=JSON.parse(readFileSync(path,'utf8'));
 expect(receipt.disposition).toBe('policy_recovery_stopped');expect(receipt).not.toHaveProperty('authorizedBy');
 const {receiptId,...body}=receipt;body.workspaceId='foreign';const forged={...body,receiptId:sha256(body)};
 rmSync(path);f.put(join(f.receiptDir,forged.receiptId.slice(7)+'.json'),forged);
 expect(sourceDebtSnapshot(f.w,f.now)).toMatchObject({corrupt:true,openIds:[f.r.debtId]});
});
test('symlink state and invalid policy flags fail closed',()=>{
 const f=fixture();f.put(join(f.w,'engram.json'),{...f.config,memoryObservation:{autoStopExpiredRecovery:'true'}});
 expect(()=>stopExpiredSourceDebt(f.w,f.now,{apply:true})).toThrow('POLICY_INVALID');
 f.put(join(f.w,'engram.json'),f.config);
 const target=mkdtempSync(join(tmpdir(),'debt-expiry-target-'));roots.push(target);
 symlinkSync(target,join(f.root,'source-debt-writeoffs'));
 expect(()=>stopExpiredSourceDebt(f.w,f.now,{apply:true})).toThrow();expect(readdirSync(target)).toEqual([]);
});
test('crash after durable publication resumes without another stop or invented recovery',()=>{
 const f=fixture();expect(()=>stopExpiredSourceDebt(f.w,f.now,{apply:true,afterReceipt:()=>{throw Error('synthetic crash');}})).toThrow('synthetic crash');
 expect(readdirSync(f.receiptDir)).toHaveLength(1);
 expect(stopExpiredSourceDebt(f.w,f.now,{apply:true}).receipts).toHaveLength(0);
 expect(sourceDebtSnapshot(f.w,f.now)).toMatchObject({openIds:[],closedIds:[],automaticallyStoppedIds:[f.r.debtId]});
});
test('purging expired operational evidence does not reopen an already accounted source',()=>{
 const f=fixture(),path=join(f.op,'evidence',f.r.traceId.slice(7)+'.json');
 f.put(path,{schema:'engram.memory-evidence-envelope.v1',traceId:f.r.traceId,scope:f.scope,expiresAt:'2026-01-05T00:00:00.000Z'});
 const now=new Date('2026-01-06T00:00:00Z');
 expect(stopExpiredSourceDebt(f.w,now,{apply:true}).receipts).toHaveLength(1);rmSync(path);
 expect(sourceDebtSnapshot(f.w,now).openIds).toEqual([]);
 expect(stopExpiredSourceDebt(f.w,now,{apply:true}).receipts).toHaveLength(0);
});
test('a standing policy revoked before publication cannot authorize a new receipt',()=>{
 const f=fixture();const result=stopExpiredSourceDebt(f.w,f.now,{apply:true,beforePublish:()=>f.put(join(f.w,'engram.json'),{...f.config,memoryObservation:{autoStopExpiredRecovery:false}})});
 expect(result.status).toBe('disabled');expect(existsSync(f.receiptDir)).toBe(false);
});
test('a missing or changed immutable batch parent remains a repair blocker',()=>{
 const f=fixture();rmSync(join(f.root,'source-debt/v1/failures'),{recursive:true});
 f.debt('a','batch_invalid_json',{batchParents:[{jobId:sha256('job'),jobDigest:sha256('original'),bundleId:sha256('bundle'),failureDigest:null}]});
 expect(stopExpiredSourceDebt(f.w,f.now,{apply:true}).receipts).toHaveLength(0);
 f.put(join(f.root,'batch-live-store/memory-batch-live/v1/jobs',sha256('job').slice(7)+'.json'),{jobId:sha256('job'),changed:true});
 expect(stopExpiredSourceDebt(f.w,f.now,{apply:true}).receipts).toHaveLength(0);
});
