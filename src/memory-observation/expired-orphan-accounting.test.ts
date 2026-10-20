import {test,expect,afterEach} from 'bun:test';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {sha256,deriveTraceId,deriveSourceDigest} from './ledger.ts';import {reconcileExpiredOrphan} from './expired-orphan-accounting.ts';import {sourceDebtSnapshot} from './source-debt-capture.ts';import {memoryWorkerHealth} from './worker-health.ts';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
function fixture(){const workspace=mkdtempSync(join(tmpdir(),'orphan-accounting-'));roots.push(workspace);writeFileSync(join(workspace,'engram.json'),JSON.stringify({workspace:{id:'test'}}));
 const scope={workspaceId:'test',runtimeSessionKey:'agent:test:telegram:group:-123:topic:1',scopeClass:'project' as const,scopeId:'domain:test:one'},partition={...scope,producerEpoch:'v1',policyDigest:sha256('policy')},sourceTurnId='channel-user:v1:'+'1'.repeat(64),traceId=deriveTraceId('test',scope.runtimeSessionKey,sourceTurnId),at='2026-09-01T00:00:00.000Z',payload={text:'source'};
 const ref={traceId,sourceTurnId,sourceDigest:deriveSourceDigest(sourceTurnId,scope,at),evidenceDigest:sha256({schema:'engram.memory-evidence-envelope.v1',traceId,scope,payload}),sourceCompletedAt:at};
 const base={schema:'engram.memory-batch-bundle.v1',partition,policyDigest:partition.policyDigest,sourceRefs:[ref]},bundle={...base,bundleId:sha256(base),inputs:[{traceId,evidenceRefs:[{kind:'source-turn',ref:sourceTurnId,digest:sha256('ref')}],evidence:payload,expiresAt:'2026-09-04T00:00:00.000Z'}],evidenceBytes:Buffer.byteLength(JSON.stringify(payload))};
 const jb={schema:'engram.memory-batch-live-job.v1',partition,evaluationPolicyDigest:sha256('legacy'),bundleId:bundle.bundleId},job={schema:jb.schema,jobId:sha256(jb),partition,evaluationPolicyDigest:jb.evaluationPolicyDigest,bundle,createdAt:at},root=join(workspace,'memory-state/memory-observation/batch-live-store/memory-batch-live/v1');mkdirSync(join(root,'jobs'),{recursive:true});writeFileSync(join(root,'jobs',job.jobId.slice(7)+'.json'),JSON.stringify(job));
 return{workspace,job,root,options:{workspace,jobId:job.jobId,expectedJobDigest:sha256(job),authorizedBy:'operator',authorizedAt:'2026-10-01T00:00:00.000Z',now:new Date('2026-10-02T00:00:00.000Z')}};}
test('accounting releases stale scheduling barrier, never closes missing source debt',()=>{const x=fixture();expect(reconcileExpiredOrphan(x.options).status).toBe('planned');expect(sourceDebtSnapshot(x.workspace).observed).toBe(false);expect(reconcileExpiredOrphan({...x.options,apply:true}).status).toBe('accounted');const d=sourceDebtSnapshot(x.workspace);expect(d.openIds).toHaveLength(1);expect(d.closedIds).toHaveLength(0);expect(memoryWorkerHealth(x.workspace).batchPending).toBe(0);expect(reconcileExpiredOrphan({...x.options,apply:true}).status).toBe('accounted');});
test('unexpired or present source and existing output cannot be sealed',()=>{for(const kind of ['fresh','present','output']){const x=fixture();if(kind==='fresh'){x.options.now=new Date('2026-09-02T00:00:00Z');x.options.authorizedAt='2026-09-01T00:00:00.000Z';}if(kind==='present'){const p=join(x.workspace,'memory-state/memory-observation/v1/envelopes');mkdirSync(p,{recursive:true});writeFileSync(join(p,x.job.bundle.sourceRefs[0]!.traceId.slice(7)+'.json'),'{}');}if(kind==='output'){mkdirSync(join(x.root,'contextual-results'),{recursive:true});writeFileSync(join(x.root,'contextual-results',x.job.jobId.slice(7)+'.json'),'{}');}expect(()=>reconcileExpiredOrphan({...x.options,apply:true})).toThrow();expect(existsSync(join(x.root,'done'))).toBe(false);}});

for(const point of ['after_debt','after_receipt','after_done'] as const)test('resumes quarantine without source closure after '+point,()=>{
 const x=fixture();expect(()=>reconcileExpiredOrphan({...x.options,apply:true,fault:p=>{if(p===point)throw Error('CRASH');}})).toThrow('CRASH');
 expect(sourceDebtSnapshot(x.workspace).openIds).toHaveLength(1);
 const done=join(x.root,'done',x.job.jobId.slice(7)+'.json');
 expect(existsSync(done)).toBe(point==='after_done');
 expect(reconcileExpiredOrphan({...x.options,apply:true}).status).toBe('accounted');
 expect(sourceDebtSnapshot(x.workspace).closedIds).toHaveLength(0);
 expect(memoryWorkerHealth(x.workspace).batchPending).toBe(0);
});
test('dry-run rejects foreign workspace owner and symlinked state without creating debt',()=>{
 const x=fixture();writeFileSync(join(x.workspace,'engram.json'),JSON.stringify({workspace:{id:'foreign'}}));
 expect(()=>reconcileExpiredOrphan(x.options)).toThrow('ORPHAN_WORKSPACE_INVALID');expect(sourceDebtSnapshot(x.workspace).observed).toBe(false);
 const y=fixture(),jobs=join(y.root,'jobs'),target=join(y.workspace,'external-jobs');
 mkdirSync(target);const path=y.job.jobId.slice(7)+'.json';writeFileSync(join(target,path),readFileSync(join(jobs,path)));rmSync(jobs,{recursive:true});symlinkSync(target,jobs);
 expect(()=>reconcileExpiredOrphan(y.options)).toThrow('ORPHAN_UNSAFE_PATH');expect(sourceDebtSnapshot(y.workspace).observed).toBe(false);
});
test('race after debt capture cannot seal a changed job or newly present source',()=>{
 const x=fixture(),path=join(x.root,'jobs',x.job.jobId.slice(7)+'.json');
 expect(()=>reconcileExpiredOrphan({...x.options,apply:true,fault:p=>{if(p==='after_debt')writeFileSync(path,JSON.stringify({...x.job,createdAt:'2026-09-01T00:01:00.000Z'}));}})).toThrow('ORPHAN_JOB_CHANGED');
 expect(existsSync(join(x.root,'done'))).toBe(false);expect(sourceDebtSnapshot(x.workspace).openIds).toHaveLength(1);
});
test('a forged done marker without matching protected debt and journal cannot be replayed',()=>{
 const x=fixture();reconcileExpiredOrphan({...x.options,apply:true});rmSync(join(x.root,'orphan-accounting'),{recursive:true});
 expect(()=>reconcileExpiredOrphan({...x.options,apply:true})).toThrow('ORPHAN_RECEIPT_CONFLICT');
});
