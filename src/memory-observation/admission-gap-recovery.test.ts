import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {AdmissionStore} from './admission-store.ts';
import {sha256} from './ledger.ts';
import {RUNTIME_AUTHORITY,RUNTIME_POLICY} from './runtime-authority.ts';
import {recoverAdmissionGap,isAdmissionGapRecovered,type GapRecoveryOptions} from './admission-gap-recovery.ts';
import {memoryWorkerHealth} from './worker-health.ts';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const write=(path:string,v:any)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(v));};
const snapshot=(path:string):any=>Object.fromEntries(readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).map(d=>[d.name,d.isDirectory()?snapshot(join(path,d.name)):readFileSync(join(path,d.name),'utf8')]));
function fixture(){
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
 const checkpoint=store.recordCheckpoint({scope,bindingFingerprint:sha256({workspaceId:'main',...fp}),channel:'telegram',inboundMessageId:'42',actorId:'100000001',replyToId:'40',sourceTurnId:null,runId:null,sessionId:null,sourceText:null,stage:'received',now:new Date('2026-09-07T11:00:00.000Z')}).checkpoint;
 store.publishGapReceipt({checkpoint,failureStage:'received',reasonCode:'identity_ambiguous',terminalAt:new Date('2026-09-07T11:01:00.000Z')});
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
