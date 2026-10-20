import {afterEach,expect,test} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {captureSourceDebt,captureLegacyRecoveryOrigins,sourceDebtSnapshot} from './source-debt-capture.ts';
import {deriveTraceId,deriveSourceDigest,sha256} from './ledger.ts';
import {RUNTIME_POLICY,RUNTIME_REGISTRY,RUNTIME_AUTHORITY} from './runtime-authority.ts';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
const repo=join(import.meta.dir,'../..');
function put(p:string,v:any){mkdirSync(dirname(p),{recursive:true});writeFileSync(p,JSON.stringify(v));}
function fixture(config=true){const workspace=mkdtempSync(join(tmpdir(),'node-debt-capture-'));roots.push(workspace);
 const op=join(workspace,'memory-state/memory-observation/v1'),scope={workspaceId:'fixture-main',runtimeSessionKey:'agent:fixture-main:telegram:direct:100000001',scopeClass:'self' as const,scopeId:'telegram:100000001'};
 const at='2026-10-01T00:00:00.000Z',sourceTurnId='channel-user:v1:'+'1'.repeat(64),traceId=deriveTraceId(scope.workspaceId,scope.runtimeSessionKey,sourceTurnId);
 const envelope={schema:'engram.memory-observation-job.v1',traceId,sourceTurnId,scope,sourceCompletedAt:at,sourceDigest:deriveSourceDigest(sourceTurnId,scope,at),evidenceDigest:sha256('evidence'),policyVersion:'v1',policyDigest:sha256('policy'),evidenceRefs:[],authority:RUNTIME_AUTHORITY,admittedAt:at};
 const queue={schema:'engram.memory-observation-ledger-queue.v1',traceId,queueClass:'evaluator',status:'queued',attempt:0,maxAttempts:2,nextAttemptAt:at,createdAt:at,updatedAt:at,claimedAt:null,claimToken:null,terminalAt:null,reasonCode:null};
 const evidence={schema:'engram.memory-evidence-envelope.v1',traceId,scope,payload:{source:{role:'user',text:'not copied'}},createdAt:at,expiresAt:'2026-10-01T01:00:00.000Z'};
 if(config)put(join(workspace,'engram.json'),{workspace:{id:scope.workspaceId}});
 const queuePath=join(op,'queues/evaluator',traceId.slice(7)+'.json'),evidencePath=join(op,'evidence',traceId.slice(7)+'.json');
 put(join(op,'envelopes',traceId.slice(7)+'.json'),envelope);put(queuePath,queue);put(evidencePath,evidence);
 return {workspace,op,scope,envelope,queue,queuePath,evidencePath,now:new Date('2026-10-01T01:00:01.000Z')};}
let ledgerModule:Promise<any>|undefined;
async function nodeSafeLedger(){return ledgerModule??=(async()=>{const directory=mkdtempSync(join(tmpdir(),'node-debt-canonical-'));roots.push(directory);
 const ledger=join(repo,'src/memory-observation/ledger.ts');const build=await Bun.build({entrypoints:[ledger],target:'node',format:'esm',write:false});
 expect(build.success).toBe(true);const code=await build.outputs[0]!.text();expect(code.includes('bun:sqlite')).toBe(false);const out=join(directory,'ledger.mjs');writeFileSync(out,code);return import(out);})();}
function ledgerOptions(f:ReturnType<typeof fixture>){return{workspace:f.workspace,workspaceId:f.scope.workspaceId,exactSessionKeys:[f.scope.runtimeSessionKey],producerRegistry:RUNTIME_REGISTRY,authorityPolicy:RUNTIME_POLICY,limits:{evidenceTtlMs:3600000,maxJobs:100,maxBytes:10000000,maxQueueAgeMs:86400000,maxAttempts:2,claimTtlMs:300000,maxInferenceCalls:0}};}
test('capture honors actual one-hour evidence expiry and never performs business closure',()=>{const f=fixture();const snapshot=captureSourceDebt(f.workspace,f.now);expect(snapshot.openIds).toHaveLength(1);expect(snapshot.closedIds).toHaveLength(0);const rows=readdirSync(join(f.workspace,'memory-state/memory-observation/source-debt/v1/failures')).map(n=>readFileSync(join(f.workspace,'memory-state/memory-observation/source-debt/v1/failures',n),'utf8')).join('');expect(rows).not.toContain('not copied');expect(rows).toContain('source_evidence_expired');});
test('standalone purge durably captures exact pending source before one-hour raw deletion',async()=>{const f=fixture(),{MemoryObservationLedger}=await nodeSafeLedger();const ledger=new MemoryObservationLedger(ledgerOptions(f));expect(ledger.purgeExpiredEvidence(f.now)).toBe(1);expect(existsSync(f.evidencePath)).toBe(false);expect(sourceDebtSnapshot(f.workspace,f.now).openIds).toHaveLength(1);});
test('standalone purge fails closed on corrupt debt and leaves raw evidence untouched',async()=>{const f=fixture(),{MemoryObservationLedger}=await nodeSafeLedger();put(join(f.workspace,'memory-state/memory-observation/source-debt/v1/failures/bad.json'),{bad:true});const ledger=new MemoryObservationLedger(ledgerOptions(f));expect(()=>ledger.purgeExpiredEvidence(f.now)).toThrow();expect(existsSync(f.evidencePath)).toBe(true);});
test('lifecycle purge guards before any deletion, and missing owner config is not silently ignored',async()=>{const f=fixture(false),{purgeMemoryObservationLifecycle}=await nodeSafeLedger();expect(()=>purgeMemoryObservationLifecycle(f.workspace,f.now)).toThrow();expect(existsSync(f.evidencePath)).toBe(true);put(join(f.workspace,'engram.json'),{workspace:{id:'foreign'}});expect(()=>purgeMemoryObservationLifecycle(f.workspace,f.now)).toThrow();expect(existsSync(f.evidencePath)).toBe(true);});
test('standalone ledger owner supports legacy fixture but cannot override conflicting configured owner',async()=>{const f=fixture(false),{MemoryObservationLedger}=await nodeSafeLedger();const ledger=new MemoryObservationLedger(ledgerOptions(f));expect(ledger.purgeExpiredEvidence(f.now)).toBe(1);const other=fixture();put(join(other.workspace,'engram.json'),{workspace:{id:'foreign'}});expect(()=>new MemoryObservationLedger(ledgerOptions(other)).purgeExpiredEvidence(other.now)).toThrow();expect(existsSync(other.evidencePath)).toBe(true);});
test('fresh per-admission purge does not scan or create debt when no raw deletion is due',async()=>{const f=fixture(),{MemoryObservationLedger}=await nodeSafeLedger();const ledger=new MemoryObservationLedger(ledgerOptions(f));expect(ledger.purgeExpiredEvidence(new Date('2026-10-01T00:30:00.000Z'))).toBe(0);expect(existsSync(join(f.workspace,'memory-state/memory-observation/source-debt'))).toBe(false);});
test('canonical shared plugin and both purge guards import under Node without Bun sqlite',async()=>{const directory=mkdtempSync(join(tmpdir(),'node-safe-plugin-'));roots.push(directory);
 const result=await Bun.build({entrypoints:[join(repo,'integrations/openclaw-memory-observation/index.ts')],target:'node',format:'esm',write:false,plugins:[{name:'sdk-fixture',setup(b){
  b.onResolve({filter:/^openclaw\/plugin-sdk\//},a=>({path:a.path,namespace:'sdk-fixture'}));b.onLoad({filter:/.*/,namespace:'sdk-fixture'},()=>({loader:'js',contents:'export const definePluginEntry=x=>x;export const readSessionTranscriptVisibleMessageDelta=async()=>({kind:"unavailable"});'}));
 }}]});expect(result.success).toBe(true);const code=await result.outputs[0]!.text();expect(code.includes('bun:sqlite')).toBe(false);expect(code.includes('// src/memory-observation/source-effect-proof.ts')).toBe(false);expect(code.includes('function verifySourceEffectClosure')).toBe(false);
 const entry=join(directory,'index.mjs');writeFileSync(entry,code);const run=spawnSync('node',['--input-type=module','-e','await import('+JSON.stringify(entry)+'); process.stdout.write("NODE_SAFE\\n");'],{encoding:'utf8'});expect({status:run.status,error:run.stderr}).toEqual({status:0,error:''});expect(run.stdout).toBe('NODE_SAFE\n');
});

test('verified legacy recovery without envelope retains open trace debt, never fabricated source closure',()=>{
 const f=fixture(),batch=join(f.workspace,'memory-state/memory-observation/batch-live-store/memory-batch-live/v1');
 const partition={...f.scope,producerEpoch:'v1',policyDigest:f.envelope.policyDigest};
 const ref={traceId:f.envelope.traceId,sourceTurnId:f.envelope.sourceTurnId,sourceDigest:f.envelope.sourceDigest,evidenceDigest:f.envelope.evidenceDigest,sourceCompletedAt:f.envelope.sourceCompletedAt};
 const bb={schema:'engram.memory-batch-bundle.v1',partition,policyDigest:partition.policyDigest,sourceRefs:[ref]};
 const bundle={...bb,bundleId:sha256(bb),inputs:[],evidenceBytes:0};
 const jb={schema:'engram.memory-batch-live-job.v1',partition,evaluationPolicyDigest:sha256('evaluation'),bundleId:bundle.bundleId};
 const job={schema:jb.schema,jobId:sha256(jb),partition,evaluationPolicyDigest:jb.evaluationPolicyDigest,bundle,createdAt:f.envelope.admittedAt};
 const fb={schema:'engram.memory-batch-live-failure.v1',jobId:job.jobId,bundleId:bundle.bundleId,errorCode:'batch_invalid_json'};
 const failure={...fb,failureId:sha256(fb)};
 const original={...f.queue,status:'terminal',reasonCode:fb.errorCode,terminalAt:f.envelope.admittedAt},requeued={...f.queue};
 const base={schema:'engram.memory-batch-terminal-recovery.v1',jobId:job.jobId,authorizedBy:'operator',authorizedAt:f.envelope.admittedAt,reason:'recover'};
 const auth={...base,schema:'engram.memory-batch-terminal-recovery-authorization.v1',recoveryId:sha256(base),bundleId:bundle.bundleId,failureCode:fb.errorCode,traceIds:[ref.traceId],failureDigest:sha256(failure),doneDigest:sha256(failure),queues:[{traceId:ref.traceId,original,originalDigest:sha256(original),requeued,requeuedDigest:sha256(requeued)}]};
 const archive=join(batch,'recoveries',job.jobId.slice(7),auth.recoveryId.slice(7));
 put(join(batch,'jobs',job.jobId.slice(7)+'.json'),job);put(join(archive,'authorization.json'),auth);put(join(archive,'failure.json'),failure);put(join(archive,'done.json'),failure);
 rmSync(join(f.op,'envelopes',ref.traceId.slice(7)+'.json'));rmSync(f.queuePath);rmSync(f.evidencePath);
 captureLegacyRecoveryOrigins(f.workspace);const s=captureSourceDebt(f.workspace,f.now);expect(s.openIds).toHaveLength(1);expect(s.closedIds).toHaveLength(0);
 const dir=join(f.workspace,'memory-state/memory-observation/source-debt/v1/failures'),record=JSON.parse(readFileSync(join(dir,readdirSync(dir)[0]!), 'utf8'));
 expect(record.identity.kind).toBe('trace');expect(record.classification).toBe('identity_unverified');expect(record.sourceProof).toBeNull();
 expect(captureSourceDebt(f.workspace,f.now).openIds).toEqual(s.openIds);
 // Valid initial-version records have no batchParents; upgrade by appending a
 // new origin without rewriting or discarding the immutable legacy record.
 const {recordId,...legacyBody}=record;delete legacyBody.batchParents;
 const legacy={...legacyBody,recordId:sha256(legacyBody)};
 rmSync(join(dir,recordId.slice(7)+'.json'));put(join(dir,legacy.recordId.slice(7)+'.json'),legacy);
 expect(captureLegacyRecoveryOrigins(f.workspace)).toBe(1);
 expect(sourceDebtSnapshot(f.workspace,f.now).openIds).toHaveLength(1);
 expect(JSON.parse(readFileSync(join(dir,legacy.recordId.slice(7)+'.json'),'utf8'))).toEqual(legacy);

 // A checksum-consistent but mis-scoped ref must not become admissible metadata.
 rmSync(join(f.workspace,'memory-state/memory-observation/source-debt'),{recursive:true});job.bundle.sourceRefs[0]!.sourceDigest=sha256('forged');put(join(batch,'jobs',job.jobId.slice(7)+'.json'),job);
 expect(()=>captureLegacyRecoveryOrigins(f.workspace)).toThrow();
});
