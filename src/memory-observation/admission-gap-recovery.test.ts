import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {AdmissionStore} from './admission-store.ts';
import {sha256} from './ledger.ts';
import {compileBatchFrame} from './batch-compiler.ts';
import {recoverTerminalBatch} from './batch-terminal-recovery.ts';
import {RUNTIME_AUTHORITY,RUNTIME_POLICY} from './runtime-authority.ts';
import {recoverAdmissionGap,isAdmissionGapRecovered,type GapRecoveryOptions} from './admission-gap-recovery.ts';
import {memoryWorkerHealth} from './worker-health.ts';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const write=(path:string,v:any)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(v));};
const snapshot=(path:string):any=>Object.fromEntries(readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).map(d=>[d.name,d.isDirectory()?snapshot(join(path,d.name)):readFileSync(join(path,d.name),'utf8')]));
function fixture(knownSource = false, gapReason: 'identity_ambiguous' | 'evidence_invalid' | 'scope_revoked' = 'identity_ambiguous'){
 const workspace=mkdtempSync(join(tmpdir(),'engram-gap-recovery-'));roots.push(workspace);
 const sessionKey='agent:main:telegram:direct:100000001';
 const binding={runtimeSessionKey:sessionKey,scopeClass:'self' as const,scopeId:'telegram:100000001',requireOwner:true,allowedChannels:['telegram']};
 const scope={workspaceId:'main',runtimeSessionKey:sessionKey,scopeClass:'self' as const,scopeId:binding.scopeId};
 const start='2026-09-07T10:00:00.000Z';
 const projection={schema:'engram.memory-observation-rollout.v2',workspaceId:'main',enabled:true,mode:'canary',bindings:[binding],
  pluginDigest:sha256('plugin'),inference:{provider:'openai',model:'openai/model',evaluateAfter:start},
  limits:{evidenceTtlHours:72,maxJobs:100,maxBytes:10000000,maxQueueAgeHours:168,maxAttempts:2,claimTtlSeconds:30,maxInferenceCalls:1},
  evaluation:{mode:'batch-cron',policyDigest:sha256('evaluation'),batch:{sourcePolicyDigest:sha256(RUNTIME_POLICY),inactivityGapSeconds:60,maxTurns:12,maxEvidenceBytes:32000,maxAgeSeconds:600,maxInferenceCallsPerRun:1,schedulerId:'fixture'}},
  consumers:{dailyNote:{mode:'canary',applyAfter:start,timezone:'UTC',allowedObservationClasses:['episodic.event','episodic.decision'],maxAppliesPerWake:1,qmdBinding:{collection:'main-memory'}}},
  captureOwnership:{owner:'observer',effectiveAfter:start,foregroundDailyNoteCapture:'disabled'},approvedBy:'operator',approvedAt:start};
 write(join(workspace,'engram.json'),{workspace:{id:'main'}});
 const projectionPath=join(workspace,'memory-state/memory-observation/projection.json');write(projectionPath,projection);
 const store=new AdmissionStore(workspace,RUNTIME_AUTHORITY);
 const {runtimeSessionKey,...fp}=binding;
 const checkpoint=store.recordCheckpoint({scope,bindingFingerprint:sha256({workspaceId:'main',...fp}),channel:'telegram',inboundMessageId:'42',actorId:'100000001',replyToId:'40',sourceTurnId:knownSource?'channel-user:v1:'+'a'.repeat(64):null,runId:knownSource?'run-a':null,sessionId:knownSource?'session-a':null,sourceText:null,stage:'received',now:new Date('2026-09-07T11:00:00.000Z')}).checkpoint;
 store.publishGapReceipt({checkpoint,failureStage:gapReason==='evidence_invalid'?'completion_observed':'received',reasonCode:gapReason,terminalAt:new Date('2026-09-07T11:01:00.000Z')});
 const sourceId='channel-user:v1:'+'a'.repeat(64);
 const source={role:'user',content:'Во втором абзаце убери последнее предложение',timestamp:Date.parse('2026-09-07T11:00:00.000Z'),idempotencyKey:sourceId,__openclaw:{idempotencyKey:sourceId,senderId:'100000001',senderIsOwner:true,runId:'run-a',mirrorOrigin:'codex-app-server',mirrorIdentity:'turn-a:prompt',transcriptPosition:{source:'transcript-a',rawSeq:10},transport:{channel:'telegram',messageId:'42',replyToId:'40'}}};
 const final={role:'assistant',content:'Готово',stopReason:'stop',timestamp:Date.parse('2026-09-07T11:00:30.000Z'),__openclaw:{runId:'run-a',mirrorOrigin:'codex-app-server',mirrorIdentity:'turn-a:assistant',runTerminal:true,transcriptPosition:{source:'transcript-a',rawSeq:14}}};
 const inventory:GapRecoveryOptions['inventory']={schema:'iss19.gap-source-review.v1',source:'OpenClaw sessions_history (sanitized)',sessionKey,sessionId:'session-a',canonicalWrites:0,records:[{messageId:'42',source,finalCandidates:[final]}]};
 const input:GapRecoveryOptions={workspace,inventory,inventoryDigest:sha256(inventory as any),messageId:'42',authorizedBy:'operator:message:99',authorizedAt:'2026-09-07T20:00:00.000Z',reason:'recover exact source',now:new Date('2026-09-07T21:00:00.000Z')};
 return {input,store,projection,projectionPath,checkpoint:store.readCheckpoint(checkpoint.candidateId)!,final,source};
}
test('read-only plan; apply preserves original gap and source, queues once, health distinguishes historical gaps',()=>{
 const f=fixture(),before=snapshot(f.input.workspace);const plan=recoverAdmissionGap(f.input);expect(plan.status).toBe('planned');expect(snapshot(f.input.workspace)).toEqual(before);
 const result=recoverAdmissionGap({...f.input,apply:true});expect(result.status).toBe('admitted');
 expect(f.store.readCheckpoint(f.checkpoint.candidateId)).toEqual(f.checkpoint);
 expect(f.store.readGapReceiptForCandidate(f.checkpoint.candidateId)).toBeTruthy();
 expect(recoverAdmissionGap({...f.input,apply:true})).toEqual(result);
 const queues=readdirSync(join(f.store.root,'queues/evaluator'));expect(queues).toHaveLength(1);
 const payload=JSON.parse(readFileSync(join(f.store.root,'evidence',queues[0]!),'utf8')).payload;
 expect(payload.source.text).toBe(f.source.content);expect(payload.source.actorId).toBe('100000001');expect(payload.source.replyToMessageId).toBe('40');
 expect(payload.outcome.status).toBe('reported_not_verified');expect(payload.replyContext.pairs).toEqual([]);
 expect(memoryWorkerHealth(f.input.workspace)).toMatchObject({admissionGaps:0,recoveredAdmissionGaps:1,historicalAdmissionGaps:1,pending:1});
});
for(const faultAt of ['after_authorization','after_evidence','after_envelope','after_queue','after_source_trace','after_admission'] as const){
 test('resumes without duplicates after '+faultAt,()=>{const f=fixture();expect(()=>recoverAdmissionGap({...f.input,apply:true,faultAt})).toThrow();
 expect(memoryWorkerHealth(f.input.workspace).admissionGaps).toBe(1);
 expect(recoverAdmissionGap({...f.input,apply:true}).status).toBe('admitted');expect(recoverAdmissionGap({...f.input,apply:true}).status).toBe('admitted');
 expect(readdirSync(join(f.store.root,'queues/evaluator'))).toHaveLength(1);expect(f.store.readCheckpoint(f.checkpoint.candidateId)).toEqual(f.checkpoint);});
}
for(const [label,mutate] of [
 ['actor',(f:any)=>f.source.__openclaw.senderId='999'],['topic',(f:any)=>f.source.__openclaw.transport.threadId='14'],
 ['source ID',(f:any)=>f.source.__openclaw.idempotencyKey='channel-user:v1:'+'b'.repeat(64)],
 ['run',(f:any)=>f.final.__openclaw.runId='other'],['mirror',(f:any)=>f.final.__openclaw.mirrorIdentity='other:assistant'],
 ['transcript',(f:any)=>f.final.__openclaw.transcriptPosition.source='other'],['position',(f:any)=>f.final.__openclaw.transcriptPosition.rawSeq=9],
 ['failed',(f:any)=>f.final.stopReason='error'],['nonterminal',(f:any)=>f.final.__openclaw.runTerminal=false],
 ['duplicate final',(f:any)=>f.input.inventory.records[0].finalCandidates.push(f.final)],['owner',(f:any)=>f.source.__openclaw.senderIsOwner=false],
 ['reply',(f:any)=>f.source.__openclaw.transport.replyToId='41']
] as const){test('rejects mismatched '+label+' before mutation',()=>{const f=fixture();mutate(f);f.input.inventoryDigest=sha256(f.input.inventory as any);const before=snapshot(f.input.workspace);expect(()=>recoverAdmissionGap({...f.input,apply:true})).toThrow();expect(snapshot(f.input.workspace)).toEqual(before);});}
test('missing completion remains blocked and unchanged even with apply',()=>{const f=fixture();f.input.inventory.records[0]!.finalCandidates=[];f.input.inventoryDigest=sha256(f.input.inventory as any);const before=snapshot(f.input.workspace);expect(recoverAdmissionGap({...f.input,apply:true}).status).toBe('blocked_missing_completion');expect(snapshot(f.input.workspace)).toEqual(before);});
test('modified import cannot use old digest',()=>{const f=fixture();f.source.content='invented';expect(()=>recoverAdmissionGap({...f.input,apply:true})).toThrow('pinned');});
test('a different authorization cannot create another recovery for same source',()=>{const f=fixture();recoverAdmissionGap({...f.input,apply:true});expect(()=>recoverAdmissionGap({...f.input,authorizedBy:'other',apply:true})).toThrow('another authorized recovery');});
test('revocation after partial commit prevents resume',()=>{const f=fixture();expect(()=>recoverAdmissionGap({...f.input,apply:true,faultAt:'after_authorization'})).toThrow();f.projection.enabled=false;write(f.projectionPath,f.projection);expect(()=>recoverAdmissionGap({...f.input,apply:true})).toThrow();});
test('corrupt completion cannot hide gap or pass idempotence',()=>{const f=fixture();recoverAdmissionGap({...f.input,apply:true});const path=join(f.store.root,'receipts/admission-recovery',f.checkpoint.candidateId.slice(7),'completed.json');const c=JSON.parse(readFileSync(path,'utf8'));c.envelopeDigest=sha256('wrong');write(path,c);expect(isAdmissionGapRecovered(f.input.workspace,f.checkpoint)).toBe(false);expect(memoryWorkerHealth(f.input.workspace).admissionGaps).toBe(1);expect(()=>recoverAdmissionGap({...f.input,apply:true})).toThrow();});
test('attachment-only terminal preserves source with unknown outcome',()=>{const f=fixture();f.final.content='';f.input.inventoryDigest=sha256(f.input.inventory as any);const result=recoverAdmissionGap({...f.input,apply:true}) as any;const e=JSON.parse(readFileSync(join(f.store.root,'evidence',result.traceId.slice(7)+'.json'),'utf8'));expect(e.payload.outcome).toMatchObject({status:'unknown',text:''});});
test('expired recovery cannot enqueue expired evidence',()=>{const f=fixture();f.input.now=new Date('2026-09-11T21:00:00.000Z');const before=snapshot(f.input.workspace);expect(()=>recoverAdmissionGap({...f.input,apply:true})).toThrow('window expired');expect(snapshot(f.input.workspace)).toEqual(before);});
test('standard evaluator reads recovered evidence under unchanged source policy',async()=>{
 const f=fixture();const r=recoverAdmissionGap({...f.input,apply:true}) as any;
 const {MemoryObservationLedger}=await import('./ledger.ts');const {RUNTIME_REGISTRY}=await import('./runtime-authority.ts');
 const ledger=new MemoryObservationLedger({workspace:f.input.workspace,workspaceId:'main',exactSessionKeys:[f.input.inventory.sessionKey],producerRegistry:RUNTIME_REGISTRY,authorityPolicy:RUNTIME_POLICY,evaluatorEnabled:true,evaluationStartedAt:f.projection.inference.evaluateAfter,
 limits:{evidenceTtlMs:72*3600000,maxJobs:100,maxBytes:10000000,maxQueueAgeMs:168*3600000,maxAttempts:2,claimTtlMs:30000,maxInferenceCalls:1}});
 const due=ledger.peekDueEvaluationEvidence(f.input.now);expect(due).toHaveLength(1);expect(due[0]!.envelope.traceId).toBe(r.traceId);expect(due[0]!.envelope.policyDigest).toBe(f.projection.evaluation.batch.sourcePolicyDigest);
 expect(due[0]!.evidence.payload.source.text).toBe(f.source.content);
});

test('long source requires explicit bounded projection, pins full identity and marks missing middle',()=>{
 const f=fixture();f.source.content='Head decision '+ 'x'.repeat(52140)+' Tail instruction';f.input.inventoryDigest=sha256(f.input.inventory as any);
 const before=snapshot(f.input.workspace);expect(()=>recoverAdmissionGap({...f.input,apply:true})).toThrow('opt-in');expect(snapshot(f.input.workspace)).toEqual(before);
 const r=recoverAdmissionGap({...f.input,apply:true,allowBoundedSource:true}) as any;
 const payload=JSON.parse(readFileSync(join(f.store.root,'evidence',r.traceId.slice(7)+'.json'),'utf8')).payload;
 expect(payload.source.text.length).toBe(50000);expect(payload.source.text).toContain('MIDDLE OMITTED');expect(payload.source.text.endsWith('Tail instruction')).toBe(true);
 expect(payload.source.projection.fullTextDigest).toBe(sha256(f.source.content));expect(payload.source.projection.fullChars).toBe(f.source.content.length);
 expect(recoverAdmissionGap({...f.input,apply:true,allowBoundedSource:true})).toEqual(r);
});
test('long source over hard import cap is rejected even with projection opt-in',()=>{
 const f=fixture();f.source.content='x'.repeat(200001);f.input.inventoryDigest=sha256(f.input.inventory as any);const before=snapshot(f.input.workspace);
 expect(()=>recoverAdmissionGap({...f.input,apply:true,allowBoundedSource:true})).toThrow('bounded');expect(snapshot(f.input.workspace)).toEqual(before);
});

function failedRecoveredSource(){
 const f=fixture(true),admission=recoverAdmissionGap({...f.input,apply:true}) as any;
 const root=f.store.root,traceId=admission.traceId,key=traceId.slice(7);
 const envelope=JSON.parse(readFileSync(join(root,'envelopes',key+'.json'),'utf8'));
 const evidence=JSON.parse(readFileSync(join(root,'evidence',key+'.json'),'utf8'));
 const partition={...envelope.scope,producerEpoch:'v1' as const,policyDigest:envelope.policyDigest};
 const createdAt=f.input.authorizedAt;
 const compiled=compileBatchFrame({schema:'engram.memory-batch-source-frame.v1',partition,sealedAt:createdAt,sources:[{envelope,evidence}]},
  {schema:'engram.memory-batch-compiler-config.v1',inactivityGapMs:Number.MAX_SAFE_INTEGER,maxTurns:100000,maxEvidenceBytes:Number.MAX_SAFE_INTEGER,maxAgeMs:Number.MAX_SAFE_INTEGER});
 const bundle=compiled.bundles[0]!,evaluationPolicyDigest=f.projection.evaluation.policyDigest;
 const jobId=sha256({schema:'engram.memory-batch-live-job.v1',partition,evaluationPolicyDigest,bundleId:bundle.bundleId});
 const job={schema:'engram.memory-batch-live-job.v1',jobId,partition,evaluationPolicyDigest,bundle,createdAt};
 const failedAt=f.input.now!.toISOString(),failureBody={schema:'engram.memory-batch-live-failure.v1',jobId,bundleId:bundle.bundleId,errorCode:'batch_invalid_json',attempt:2,maxAttempts:2,traceIds:[traceId],failedAt};
 const failure={...failureBody,failureId:sha256(failureBody)},storeRoot=join(f.input.workspace,'memory-state/memory-observation/batch-live-store'),batchRoot=join(storeRoot,'memory-batch-live/v1');
 for(const [folder,value] of [['jobs',job],['failures',failure],['done',failure]] as const)write(join(batchRoot,folder,jobId.slice(7)+'.json'),value);
 const queuePath=join(root,'queues/evaluator',key+'.json'),q=JSON.parse(readFileSync(queuePath,'utf8'));
 write(queuePath,{...q,status:'terminal',attempt:2,terminalAt:failedAt,updatedAt:failedAt,reasonCode:'batch_invalid_json',claimedAt:null,claimToken:null});
 const options={workspace:f.input.workspace,storeRoot,jobId,authorizedBy:'operator:message:100',authorizedAt:failedAt,reason:'bounded retry of authenticated historical recovery',now:f.input.now};
 return {f,options,traceId,queuePath,authRoot:join(root,'receipts/admission-recovery',f.checkpoint.candidateId.slice(7))};
}

test('terminal retry accepts authenticated recovered gap without rewriting its original checkpoint',()=>{
 const {f,options,queuePath}=failedRecoveredSource(),checkpoint=f.store.readCheckpoint(f.checkpoint.candidateId);
 expect(checkpoint!.stage).toBe('terminal_gap');
 const before=snapshot(f.input.workspace);expect(recoverTerminalBatch(options).status).toBe('planned');expect(snapshot(f.input.workspace)).toEqual(before);
 const result=recoverTerminalBatch({...options,apply:true});expect(result.status).toBe('requeued');
 expect(f.store.readCheckpoint(f.checkpoint.candidateId)).toEqual(checkpoint);
 expect(JSON.parse(readFileSync(queuePath,'utf8')).status).toBe('queued');
 expect(recoverTerminalBatch({...options,apply:true})).toEqual(result);
});

for(const corrupt of ['missing_completion','changed_authorization','downstream_receipt'] as const)test('historical terminal retry refuses '+corrupt+' without mutation',()=>{
 const {f,options,authRoot,traceId}=failedRecoveredSource();
 if(corrupt==='missing_completion')rmSync(join(authRoot,'completed.json'));
 else if(corrupt==='changed_authorization'){const a=JSON.parse(readFileSync(join(authRoot,'authorization.json'),'utf8'));a.sourceTurnId='channel-user:v1:'+'b'.repeat(64);write(join(authRoot,'authorization.json'),a);}
 else write(join(f.store.root,'receipts','synthetic-effect.json'),{traceId,kind:'downstream_write'});
 const before=snapshot(f.input.workspace);expect(()=>recoverTerminalBatch({...options,apply:true})).toThrow();expect(snapshot(f.input.workspace)).toEqual(before);
});

test('invalid admission evidence requires explicit native-history review and preserves the original gap',()=>{
 const f=fixture(true,'evidence_invalid'),before=snapshot(f.input.workspace);
 expect(()=>recoverAdmissionGap({...f.input,apply:true})).toThrow('terminal gap');expect(snapshot(f.input.workspace)).toEqual(before);
 const input={...f.input,reviewInvalidEvidence:true};expect(recoverAdmissionGap(input).status).toBe('planned');expect(snapshot(f.input.workspace)).toEqual(before);
 const r=recoverAdmissionGap({...input,apply:true}) as any;
 expect(isAdmissionGapRecovered(f.input.workspace,f.checkpoint)).toBe(true);
 expect(f.store.readCheckpoint(f.checkpoint.candidateId)).toEqual(f.checkpoint);
 expect(f.store.readGapReceiptForCandidate(f.checkpoint.candidateId)!.reasonCode).toBe('evidence_invalid');
 const auth=JSON.parse(readFileSync(join(f.store.root,'receipts/admission-recovery',f.checkpoint.candidateId.slice(7),'authorization.json'),'utf8'));
 expect(auth.reviewedAdmissionFailure).toBe('completion_evidence_invalid_native_history.v1');
 expect(recoverAdmissionGap({...input,apply:true})).toEqual(r);
});

test('pinned native SDK inventory is admitted with the same exact provenance checks',()=>{
 const f=fixture(true);f.input.inventory.source='OpenClaw visible-transcript SDK (sanitized)';f.input.inventoryDigest=sha256(f.input.inventory as any);
 expect(recoverAdmissionGap({...f.input,apply:true}).status).toBe('admitted');expect(isAdmissionGapRecovered(f.input.workspace,f.checkpoint)).toBe(true);
});
test('native SDK inventory cannot bypass terminal completion identity',()=>{
 const f=fixture(true);f.input.inventory.source='OpenClaw visible-transcript SDK (sanitized)';f.final.__openclaw.runId='foreign';f.input.inventoryDigest=sha256(f.input.inventory as any);
 const before=snapshot(f.input.workspace);expect(()=>recoverAdmissionGap({...f.input,apply:true})).toThrow();expect(snapshot(f.input.workspace)).toEqual(before);
});

for(const invalid of ['unknown_identity','revoked_scope','empty_source','foreign_actor','foreign_completion'] as const)test('invalid-evidence review still rejects '+invalid+' before writing',()=>{
 const f=fixture(invalid!=='unknown_identity',invalid==='revoked_scope'?'scope_revoked':'evidence_invalid');
 if(invalid==='empty_source')f.source.content='';
 if(invalid==='foreign_actor')f.source.__openclaw.senderId='999';
 if(invalid==='foreign_completion')f.final.__openclaw.runId='foreign';
 f.input.inventoryDigest=sha256(f.input.inventory as any);const before=snapshot(f.input.workspace);
 expect(()=>recoverAdmissionGap({...f.input,reviewInvalidEvidence:true,apply:true})).toThrow();expect(snapshot(f.input.workspace)).toEqual(before);
});
