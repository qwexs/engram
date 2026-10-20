import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {sha256,type Digest} from './ledger.ts';
import {readModelTransition,readableEvaluationPolicies} from './model-transition.ts';
import {contextualEvaluationDigest} from './quality-rollout.ts';
import {planCodeOnlyPluginRebind,applyCodeOnlyPluginRebind,type CodeOnlyReleaseAttestation,type CodeOnlyRebindPlan,type CodeOnlyRebindFault} from './code-only-plugin-rebind.ts';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(r=>rmSync(r,{recursive:true,force:true})));
function put(path:string,value:any){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2)+'\n');}
function fixture(options:{invalid?:boolean;noTransition?:boolean;mainAuthorityExtension?:boolean}={}){
 const root=mkdtempSync(join(tmpdir(),'code-only-rebind-'));roots.push(root);
 const oldBytes='// installed old plugin\n',newBytes='// reviewed code-only plugin\n';
 const fromPluginDigest=sha256(oldBytes),toPluginDigest=sha256(newBytes),installedPluginPath=join(root,'state/extensions/engram-memory-observation/index.js');
 mkdirSync(dirname(installedPluginPath),{recursive:true});writeFileSync(installedPluginPath,oldBytes);
 const at='2026-10-20T13:30:55.000Z',now=new Date('2026-10-20T14:00:00.000Z');
 const ids=options.invalid?['alpha','gamma']:options.mainAuthorityExtension?['main','beta']:['alpha','beta'];
 const workspaces=ids.map(workspaceId=>({workspaceId,workspace:join(root,workspaceId)}));
 const original=new Map<string,string>(),snapshots:any[]=[];
 for(const w of workspaces){
  const scope={workspaceId:w.workspaceId,runtimeSessionKey:`agent:${w.workspaceId}:telegram:direct:100`,scopeClass:'self',scopeId:`workspace:${w.workspaceId}`};
  const p:any={schema:'engram.memory-observation-rollout.v2',workspaceId:w.workspaceId,enabled:true,mode:'canary',
   bindings:[{runtimeSessionKey:scope.runtimeSessionKey,scopeClass:scope.scopeClass,scopeId:scope.scopeId,requireOwner:true,allowedChannels:['telegram']}],
   pluginDigest:fromPluginDigest,inference:{provider:'openai',model:'openai/gpt-6-luna',evaluateAfter:at},
   evaluation:{mode:'batch-cron',policyDigest:sha256(w.workspaceId+'-current-evaluation'),batch:{sourcePolicyDigest:sha256('source-policy'),inactivityGapSeconds:300,maxTurns:8,maxEvidenceBytes:262144,maxAgeSeconds:900,maxInferenceCallsPerRun:1,schedulerId:'existing-worker'}},
   limits:{evidenceTtlHours:72,maxJobs:1000,maxBytes:67108864,maxQueueAgeHours:168,maxAttempts:2,claimTtlSeconds:300,maxInferenceCalls:1},
   consumers:{dailyNote:{mode:'canary',applyAfter:at,timezone:'UTC',allowedObservationClasses:['episodic.event','episodic.decision'],maxAppliesPerWake:1,qmdBinding:{collection:'synthetic-memory'}}},
   captureOwnership:{owner:'observer',effectiveAfter:at,foregroundDailyNoteCapture:'disabled'},approvedBy:'operator',approvedAt:at};
  const baseline=structuredClone(p);
  if(options.mainAuthorityExtension&&w.workspaceId==='main'){
   baseline.schema='engram.memory-observation-rollout.v3';baseline.bindings=[{runtimeSessionKey:'agent:main:*',scopeClass:'self',scopeId:'workspace:main',requireOwner:true,allowedChannels:['telegram','openclaw']}];
   baseline.consumers.dailyNote.qmdBinding={resolver:'exact-session-registry',manifestPath:join(w.workspace,'manifest.json'),workspaceRegistryDigest:sha256('registry')};
   Object.assign(p,structuredClone(baseline));p.schema='engram.memory-observation-rollout.v6';
   p.bindings.push({runtimeSessionKey:'agent:main:telegram:group:-123:topic:2',scopeClass:'project',scopeId:'domain:main:example',requireOwner:false,allowedChannels:['telegram'],topicDomain:{domain:'example',chatId:'-123',topicId:'2'}});
   p.consumers.dailyNote.qmdBinding.manifestPath=join(w.workspace,'new-manifest.json');
   mkdirSync(join(w.workspace,'memory/domains/example'),{recursive:true});put(join(w.workspace,'memory/domains/registry.json'),{domains:{example:{type:'topic-thread',topic:{chatId:'-123',topicId:'2'}}}});
  }
  const previous=structuredClone(options.mainAuthorityExtension&&w.workspaceId==='main'?baseline:p);
  previous.pluginDigest=sha256('ancestor-plugin');previous.inference.model='openai/gpt-5.6-terra';previous.evaluation.policyDigest=sha256(w.workspaceId+'-previous-evaluation');
  const q:any={schema:'engram.memory-quality-rollout.v1',mode:'active',workspaceId:w.workspaceId,pluginDigest:fromPluginDigest,baseEvaluationPolicyDigest:p.evaluation.policyDigest,
   sourcePolicyDigest:p.evaluation.batch.sourcePolicyDigest,applyAfter:at,exactScopes:[scope],preparedAt:at,inventoryDigest:sha256('original-inventory')};
  const previousQ={...q,pluginDigest:previous.pluginDigest,baseEvaluationPolicyDigest:previous.evaluation.policyDigest};
  const body:any={schema:'engram.memory-model-transition.v1',targetProjectionDigest:sha256(p),previousProjection:previous,previousQuality:{...previousQ,digest:sha256(previousQ)},approvedBy:'operator',approvedAt:at};
  if(options.mainAuthorityExtension&&w.workspaceId==='main')body.authorityExtension={baselineProjection:baseline};
  if(options.invalid&&w.workspaceId==='gamma')body.targetProjectionDigest=sha256('stale-target');
  const state=join(w.workspace,'memory-state/memory-observation');
  put(join(state,'projection.json'),p);put(join(state,'quality-rollout.json'),{...q,digest:sha256(q)});
  if(!options.noTransition)put(join(state,'model-transition.json'),{...body,digest:sha256(body)});
  put(join(state,'v1/queues/evaluator/source.json'),{traceId:sha256(w.workspaceId+'-trace'),status:'queued'});
  put(join(state,'batch-live-store/memory-batch-live/v1/jobs/source.json'),{jobId:sha256(w.workspaceId+'-job'),evaluationPolicyDigest:previous.evaluation.policyDigest,partition:scope,bundle:{sourceRefs:[{traceId:sha256(w.workspaceId+'-trace')}]}});
  for(const name of ['projection.json','quality-rollout.json','model-transition.json'])if(existsSync(join(state,name)))original.set(join(state,name),readFileSync(join(state,name),'utf8'));
  snapshots.push({w,p,q,previous,body,state,scope});
 }
 const a:CodeOnlyReleaseAttestation={schema:'engram.code-only-plugin-release-attestation.v1',fromPluginDigest,toPluginDigest,approvedBy:'operator',approvedAt:at,reason:'Reviewed capture durability and purge-guard release',
  allowedChangedSurfaces:['runtime-adapter','ledger-purge-guard'],unchanged:{evaluator:true,model:true,sourcePolicy:true,authority:true,consumerSemantics:true},exactWorkspaceIds:ids};
 if(options.invalid){const path=join(workspaces[1]!.workspace,'memory-state/memory-observation/model-transition.json');a.preserveInvalidTransition={workspaceId:'gamma',originalFileDigest:sha256(readFileSync(path,'utf8')),failureCode:'MODEL_TRANSITION_IDENTITY_CHANGED'};}
 const planInput={attestation:a,workspaces,configuredWorkspaces:workspaces,installedPluginPath,sourcePluginDigest:toPluginDigest,now};
 const plan=()=>planCodeOnlyPluginRebind(planInput);
 const apply=(plan:CodeOnlyRebindPlan,fault?:CodeOnlyRebindFault)=>applyCodeOnlyPluginRebind({plan,journalRoot:join(root,'journal'),sourcePluginDigest:toPluginDigest,workersPaused:true,maintenanceBarrierId:'existing-workers-paused',now,fault});
 const install=()=>writeFileSync(installedPluginPath,newBytes);
 return {root,plan,apply,install,planInput,a,snapshots,original,fromPluginDigest,toPluginDigest,installedPluginPath};
}

test('plan is read-only; code rebind preserves both policy families, quality timing/inventory, queues and lineage',()=>{
 const f=fixture(),plan=f.plan();
 for(const [path,before]of f.original)expect(readFileSync(path,'utf8')).toBe(before);
 expect(existsSync(join(f.root,'journal'))).toBe(false);f.install();const result=f.apply(plan);
 expect(result.reboundWorkspaceCount).toBe(2);expect(result.evaluationPoliciesChanged).toBe(false);expect(result.loadedRuntimeVerified).toBe(false);
 for(const s of f.snapshots){
  const p=JSON.parse(readFileSync(join(s.state,'projection.json'),'utf8'));
  expect(p).toEqual({...s.p,pluginDigest:f.toPluginDigest});
  const transition=readModelTransition(s.w.workspace,p)!;expect(transition.previousProjection).toEqual(s.previous);expect(transition.previousQuality).toEqual(s.body.previousQuality);
  const policies=readableEvaluationPolicies(s.w.workspace,p,s.scope);
  expect(policies).toContain(s.p.evaluation.policyDigest);expect(policies).toContain(s.previous.evaluation.policyDigest);
  expect(policies).toContain(contextualEvaluationDigest(s.previous.evaluation.policyDigest));
  const quality=JSON.parse(readFileSync(join(s.state,'quality-rollout.json'),'utf8'));
  expect(quality.preparedAt).toBe(s.q.preparedAt);expect(quality.inventoryDigest).toBe(s.q.inventoryDigest);expect(quality.exactScopes).toEqual(s.q.exactScopes);
  expect(JSON.parse(readFileSync(join(s.state,'v1/queues/evaluator/source.json'),'utf8')).status).toBe('queued');
  expect(JSON.parse(readFileSync(join(s.state,'batch-live-store/memory-batch-live/v1/jobs/source.json'),'utf8')).evaluationPolicyDigest).toBe(s.previous.evaluation.policyDigest);
 }
 expect(f.apply(plan)).toEqual(result);
});

test('preserves main additive authorityExtension exactly during plugin-only rebind',()=>{
 const f=fixture({mainAuthorityExtension:true}),plan=f.plan();f.install();f.apply(plan);
 const s=f.snapshots[0],p=JSON.parse(readFileSync(join(s.state,'projection.json'),'utf8'));
 expect(readModelTransition(s.w.workspace,p)!.authorityExtension).toEqual(s.body.authorityExtension);
});

test('only exact named invalid marker is preserved byte-identically and remains blocked',()=>{
 const f=fixture({invalid:true}),plan=f.plan();const original=f.original.get(join(f.snapshots[1].state,'model-transition.json'));f.install();const result=f.apply(plan);
 expect(result.preservedBlockedWorkspaces).toEqual([{workspaceId:'gamma',reason:'MODEL_TRANSITION_IDENTITY_CHANGED'}]);
 expect(readFileSync(join(f.snapshots[1].state,'model-transition.json'),'utf8')).toBe(original);
 expect(()=>readModelTransition(f.snapshots[1].w.workspace,JSON.parse(readFileSync(join(f.snapshots[1].state,'projection.json'),'utf8')))).toThrow('MODEL_TRANSITION_IDENTITY_CHANGED');
});

test('absence of lineage/quality stays absent; no new authority is created',()=>{
 const f=fixture({noTransition:true});for(const s of f.snapshots)rmSync(join(s.state,'quality-rollout.json'));
 const plan=f.plan();f.install();f.apply(plan);for(const s of f.snapshots){expect(existsSync(join(s.state,'model-transition.json'))).toBe(false);expect(existsSync(join(s.state,'quality-rollout.json'))).toBe(false);}
});

for(const fault of [{point:'after_journal'},{point:'before_completed'},{point:'after_completed'},...Array.from({length:6},(_,artifactIndex)=>({point:'after_artifact',artifactIndex}))] as CodeOnlyRebindFault[]){
 test('resumes exact global publication after '+fault.point+':'+fault.artifactIndex,()=>{
  const f=fixture(),plan=f.plan();f.install();expect(()=>f.apply(plan,fault)).toThrow('CODE_REBIND_FAULT_INJECTED');
  const result=f.apply(plan);expect(result.reboundWorkspaceCount).toBe(2);expect(f.apply(plan)).toEqual(result);
 });
}

for(const changed of ['evaluator','model','sourcePolicy','authority','consumerSemantics'] as const)test('rejects non-code-only semantic attestation: '+changed,()=>{
 const f=fixture();(f.a.unchanged as any)[changed]=false;expect(()=>f.plan()).toThrow('CODE_REBIND_ATTESTATION_INVALID');
});

test('rejects missing/mismatched exact fleet and configured workspace',()=>{
 const f=fixture();expect(()=>planCodeOnlyPluginRebind({...f.planInput,configuredWorkspaces:f.planInput.configuredWorkspaces.slice(1)})).toThrow('CODE_REBIND_FLEET_MISMATCH');
 expect(()=>planCodeOnlyPluginRebind({...f.planInput,configuredWorkspaces:f.planInput.configuredWorkspaces.map(w=>({...w,workspace:f.root}))})).toThrow('CODE_REBIND_WORKSPACE_MISMATCH');
});

test('invalid transition exception cannot bless a changed or different marker',()=>{
 const f=fixture({invalid:true});delete f.a.preserveInvalidTransition;expect(()=>f.plan()).toThrow('CODE_REBIND_INVALID_TRANSITION_NOT_ALLOWLISTED');
 const g=fixture({invalid:true});g.a.preserveInvalidTransition!.originalFileDigest=sha256('different-marker');expect(()=>g.plan()).toThrow('CODE_REBIND_INVALID_TRANSITION_NOT_ALLOWLISTED');
});

test('checks installed and source digest and maintenance barrier before writes',()=>{
 const f=fixture(),plan=f.plan();expect(()=>f.apply(plan)).toThrow('CODE_REBIND_INSTALLED_DIGEST_CHANGED');
 f.install();const options={plan,journalRoot:join(f.root,'journal'),sourcePluginDigest:f.toPluginDigest,workersPaused:true as const,maintenanceBarrierId:'existing-workers-paused',now:f.planInput.now};
 expect(()=>applyCodeOnlyPluginRebind({...options,sourcePluginDigest:sha256('wrong-source')})).toThrow('CODE_REBIND_SOURCE_DIGEST_CHANGED');
 expect(()=>applyCodeOnlyPluginRebind({...options,workersPaused:false as any})).toThrow('CODE_REBIND_MAINTENANCE_BARRIER_REQUIRED');
 for(const [path,before]of f.original)expect(readFileSync(path,'utf8')).toBe(before);
});

test('changed artifact before apply stops entire fleet before first live write',()=>{
 const f=fixture(),plan=f.plan();f.install();const s=f.snapshots[1];put(join(s.state,'projection.json'),{...s.p,approvedBy:'changed-admin'});
 expect(()=>f.apply(plan)).toThrow('CODE_REBIND_ARTIFACT_DIVERGED');
 expect(readFileSync(join(f.snapshots[0].state,'projection.json'),'utf8')).toBe(f.original.get(join(f.snapshots[0].state,'projection.json')));
});

test('changed already-published artifact blocks crash resume instead of overwriting it',()=>{
 const f=fixture(),plan=f.plan();f.install();expect(()=>f.apply(plan,{point:'after_artifact',artifactIndex:1})).toThrow('CODE_REBIND_FAULT_INJECTED');
 const s=f.snapshots[0];put(join(s.state,'projection.json'),{...s.p,pluginDigest:f.toPluginDigest,approvedBy:'changed-admin'});
 expect(()=>f.apply(plan)).toThrow('CODE_REBIND_ARTIFACT_DIVERGED');
});

test('self-consistent forged plan cannot change model, source policy or scopes',()=>{
 for(const key of ['model','source','scope']){
  const f=fixture(),plan=f.plan(),p=plan.artifacts.find(a=>a.kind==='projection')!,changed=JSON.parse(p.after!);
  if(key==='model')changed.inference.model='openai/other';if(key==='source')changed.evaluation.batch.sourcePolicyDigest=sha256('different-policy');if(key==='scope')changed.bindings[0].scopeId='foreign';
  p.after=JSON.stringify(changed,null,2)+'\n';p.afterDigest=sha256(p.after);plan.workspaces[0]!.projectionAfterDigest=sha256(changed);const {planId,...body}=plan;plan.planId=sha256(body as any);
  f.install();expect(()=>f.apply(plan)).toThrow('CODE_REBIND_PROJECTION_FIELDS_CHANGED');
 }
});

test('named CLI pins canonical source bytes from an unrelated caller cwd without changing runtime',()=>{
 const f=fixture(),repository=join(import.meta.dir,'../..');
 const buildCode=`import {createHash} from 'node:crypto';const r=await Bun.build({entrypoints:['./integrations/openclaw-memory-observation/index.ts'],target:'node',format:'esm',external:['openclaw/plugin-sdk/core','openclaw/plugin-sdk/session-transcript-runtime'],minify:false,sourcemap:'none',write:false});if(!r.success||r.outputs.length!==1)throw Error('BUILD_FAILED');process.stdout.write('sha256:'+createHash('sha256').update(Buffer.from(await r.outputs[0].arrayBuffer())).digest('hex'));`;
 const build=Bun.spawnSync([process.execPath,'-e',buildCode],{cwd:repository});expect(build.exitCode).toBe(0);
 const attestation={...f.a,toPluginDigest:build.stdout.toString() as Digest};
 put(join(f.root,'attestation.json'),attestation);put(join(f.root,'manifest.json'),{workspaces:f.planInput.workspaces.map(w=>({id:w.workspaceId,path:w.workspace}))});
 put(join(f.root,'config.json'),{agents:{entries:Object.fromEntries(f.planInput.workspaces.map(w=>[w.workspaceId,{workspace:w.workspace}]))}});
 const planPath=join(f.root,'named-plan.json');
 const run=Bun.spawnSync([process.execPath,join(repository,'scripts/memory-observation-code-only-plugin-rebind.ts'),'plan','--attestation',join(f.root,'attestation.json'),'--workspace-manifest',join(f.root,'manifest.json'),'--config',join(f.root,'config.json'),'--plan-out',planPath],{cwd:f.root,env:{...process.env,OPENCLAW_STATE_DIR:join(f.root,'state')}});
 expect(run.exitCode,run.stderr.toString()).toBe(0);
 expect(JSON.parse(readFileSync(planPath,'utf8')).sourcePluginDigest).toBe(attestation.toPluginDigest);
 for(const [path,before] of f.original)expect(readFileSync(path,'utf8')).toBe(before);
});
