/** Administrative code-only release. No inference, source/queue mutation or
 * lineage retirement. Call only inside the existing fleet maintenance barrier. */
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,fsyncSync,linkSync,unlinkSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {sha256,type Digest,type JsonValue} from './ledger.ts';
import {acquireProcessLease} from './process-lease.ts';
import {resolveMemoryObservationProjection,type MemoryObservationProjectionV1} from './projection.ts';
import {readModelTransition} from './model-transition.ts';
import {readQualityRollout,rebindQualityRollout} from './quality-rollout.ts';

const SCHEMA='engram.code-only-plugin-rebind.v1' as const;
const RELEASE_SCHEMA='engram.code-only-plugin-release-attestation.v1' as const;
const HASH=/^sha256:[a-f0-9]{64}$/;
const hash=(v:unknown)=>sha256(v as JsonValue);
const fileDigest=(path:string):Digest=>`sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const read=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
const serialize=(v:unknown)=>JSON.stringify(v,null,2)+'\n';
function failure(code:string):never{throw new Error(code);}
const eq=(a:unknown,b:unknown)=>hash(a)===hash(b);
const identity=(p:MemoryObservationProjectionV1)=>({workspaceId:p.workspaceId,pluginDigest:p.pluginDigest,
 baseEvaluationPolicyDigest:p.evaluation!.policyDigest,sourcePolicyDigest:p.evaluation!.batch!.sourcePolicyDigest,
 applyAfter:p.consumers!.dailyNote.applyAfter});

export type CodeOnlyReleaseAttestation={
 schema:typeof RELEASE_SCHEMA;
 fromPluginDigest:Digest;toPluginDigest:Digest;
 approvedBy:string;approvedAt:string;reason:string;
 allowedChangedSurfaces:['runtime-adapter','ledger-purge-guard'];
 unchanged:{evaluator:true;model:true;sourcePolicy:true;authority:true;consumerSemantics:true};
 exactWorkspaceIds:string[];
 /** Only the already-invalid named marker may stay invalid. Never re-authorize it. */
 preserveInvalidTransition?:{workspaceId:string;originalFileDigest:Digest;failureCode:'MODEL_TRANSITION_IDENTITY_CHANGED'};
};
type WorkspaceRef={workspaceId:string;workspace:string};
type Artifact={workspaceId:string;kind:'projection'|'quality'|'transition';path:string;before:string|null;after:string|null;beforeDigest:Digest|null;afterDigest:Digest|null};
type WorkspaceProof=WorkspaceRef&{projectionBeforeDigest:Digest;projectionAfterDigest:Digest;
 transitionStatus:'absent'|'valid-retargeted'|'invalid-preserved';transitionFailureCode:string|null};
export type CodeOnlyRebindPlan={schema:typeof SCHEMA;planId:Digest;attestation:CodeOnlyReleaseAttestation;
 sourcePluginDigest:Digest;installedPluginPath:string;workspaces:WorkspaceProof[];artifacts:Artifact[]};
const rawDigest=(raw:string|null):Digest|null=>raw===null?null:sha256(raw);
const instant=(s:string)=>Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
function validateAttestation(a:CodeOnlyReleaseAttestation,now:Date){
 if(!a||a.schema!==RELEASE_SCHEMA||!HASH.test(a.fromPluginDigest)||!HASH.test(a.toPluginDigest)||a.fromPluginDigest===a.toPluginDigest
  ||!Number.isFinite(now.getTime())||!a.approvedBy?.trim()||!a.reason?.trim()||!instant(a.approvedAt)||Date.parse(a.approvedAt)>now.getTime()
  ||!eq(a.allowedChangedSurfaces,['runtime-adapter','ledger-purge-guard'])
  ||!eq(a.unchanged,{evaluator:true,model:true,sourcePolicy:true,authority:true,consumerSemantics:true})
  ||!Array.isArray(a.exactWorkspaceIds)||!a.exactWorkspaceIds.length||a.exactWorkspaceIds.some(w=>!/^[-a-z0-9]+$/.test(w))
  ||new Set(a.exactWorkspaceIds).size!==a.exactWorkspaceIds.length)failure('CODE_REBIND_ATTESTATION_INVALID');
 if(a.preserveInvalidTransition&&(typeof a.preserveInvalidTransition.workspaceId!=='string'||!a.exactWorkspaceIds.includes(a.preserveInvalidTransition.workspaceId)
  ||a.preserveInvalidTransition.failureCode!=='MODEL_TRANSITION_IDENTITY_CHANGED'||!HASH.test(a.preserveInvalidTransition.originalFileDigest)))failure('CODE_REBIND_EXCEPTION_INVALID');
}
function artifact(workspaceId:string,kind:Artifact['kind'],path:string,after:string|null):Artifact{
 if(existsSync(path)&&realpathSync(path)!==path)failure('CODE_REBIND_WORKSPACE_MISMATCH');
 const before=existsSync(path)?readFileSync(path,'utf8'):null;
 return {workspaceId,kind,path,before,after,beforeDigest:rawDigest(before),afterDigest:rawDigest(after)};
}
function checkInstalledAndSource(plan:Pick<CodeOnlyRebindPlan,'attestation'|'installedPluginPath'>,sourcePluginDigest:Digest,requireInstalledTarget:boolean){
 if(sourcePluginDigest!==plan.attestation.toPluginDigest)failure('CODE_REBIND_SOURCE_DIGEST_CHANGED');
 const installed=fileDigest(plan.installedPluginPath);
 if(requireInstalledTarget?installed!==plan.attestation.toPluginDigest:![plan.attestation.fromPluginDigest,plan.attestation.toPluginDigest].includes(installed))failure('CODE_REBIND_INSTALLED_DIGEST_CHANGED');
 return installed;
}

/** Source digest MUST come from the canonical in-memory Bun build. The named CLI
 * computes it; it is never a user-supplied --source-digest assertion. */
export function planCodeOnlyPluginRebind(options:{attestation:CodeOnlyReleaseAttestation;workspaces:WorkspaceRef[];
 configuredWorkspaces:WorkspaceRef[];installedPluginPath:string;sourcePluginDigest:Digest;now?:Date}):CodeOnlyRebindPlan{
 const a=options.attestation;validateAttestation(a,options.now??new Date());
 const ids=options.workspaces.map(w=>w.workspaceId).sort();
 if(!eq(ids,[...a.exactWorkspaceIds].sort())||new Set(ids).size!==ids.length
  ||!eq(options.configuredWorkspaces.map(w=>w.workspaceId).sort(),ids))failure('CODE_REBIND_FLEET_MISMATCH');
 const artifacts:Artifact[]=[],workspaces:WorkspaceProof[]=[];
 for(const w of [...options.workspaces].sort((x,y)=>x.workspaceId.localeCompare(y.workspaceId))){
  if(!isAbsolute(w.workspace)||resolve(w.workspace)!==realpathSync(w.workspace)
   ||options.configuredWorkspaces.find(c=>c.workspaceId===w.workspaceId)?.workspace!==w.workspace)failure('CODE_REBIND_WORKSPACE_MISMATCH');
  const state=join(w.workspace,'memory-state/memory-observation'),projectionPath=join(state,'projection.json');
  if(realpathSync(state)!==state)failure('CODE_REBIND_WORKSPACE_MISMATCH');
  const before=resolveMemoryObservationProjection({workspace:w.workspace,workspaceId:w.workspaceId,expectedPluginDigest:a.fromPluginDigest});
  if(before.mode!=='canary'||before.evaluation?.mode!=='batch-cron'||before.captureOwnership?.owner!=='observer')failure('CODE_REBIND_WORKSPACE_NOT_ACTIVE');
  const after={...before,pluginDigest:a.toPluginDigest};
  artifacts.push(artifact(w.workspaceId,'projection',projectionPath,serialize(after)));
  const qualityPath=join(state,'quality-rollout.json');
  if(existsSync(qualityPath)){
   readQualityRollout(w.workspace,identity(before));
   const saved=read(qualityPath);
   const rebound=rebindQualityRollout(saved,identity(before),identity(after),saved.inventoryDigest,saved.preparedAt);
   artifacts.push(artifact(w.workspaceId,'quality',qualityPath,serialize(rebound)));
  }else artifacts.push(artifact(w.workspaceId,'quality',qualityPath,null));
  const transitionPath=join(state,'model-transition.json');
  let transitionStatus:WorkspaceProof['transitionStatus']='absent',transitionFailureCode:string|null=null;
  if(existsSync(transitionPath)){
   let transition:ReturnType<typeof readModelTransition>=null;
   try{transition=readModelTransition(w.workspace,before);}
   catch(error){
    const code=error instanceof Error?error.message:'';const allowed=a.preserveInvalidTransition;
    if(!allowed||allowed.workspaceId!==w.workspaceId||allowed.failureCode!==code||fileDigest(transitionPath)!==allowed.originalFileDigest)failure('CODE_REBIND_INVALID_TRANSITION_NOT_ALLOWLISTED');
    transitionStatus='invalid-preserved';transitionFailureCode=code;
   }
   if(transition){
    const {digest,...body}=transition;const nextBody={...body,targetProjectionDigest:hash(after)};
    const next={...nextBody,digest:hash(nextBody)};
    // The ancestor, approved model lineage, quality scopes and authority extension
    // are deliberately preserved. A code rebind is not model/policy migration.
    if(JSON.stringify(next.previousProjection)!==JSON.stringify(transition.previousProjection)
     ||JSON.stringify(next.previousQuality)!==JSON.stringify(transition.previousQuality)
     ||JSON.stringify(next.authorityExtension)!==JSON.stringify(transition.authorityExtension))failure('CODE_REBIND_LINEAGE_CHANGED');
    artifacts.push(artifact(w.workspaceId,'transition',transitionPath,serialize(next)));transitionStatus='valid-retargeted';
   }else artifacts.push(artifact(w.workspaceId,'transition',transitionPath,readFileSync(transitionPath,'utf8')));
  }else artifacts.push(artifact(w.workspaceId,'transition',transitionPath,null));
  workspaces.push({...w,projectionBeforeDigest:hash(before),projectionAfterDigest:hash(after),transitionStatus,transitionFailureCode});
 }
 const base={schema:SCHEMA,attestation:a,sourcePluginDigest:options.sourcePluginDigest,installedPluginPath:resolve(options.installedPluginPath),workspaces,artifacts};
 checkInstalledAndSource(base,options.sourcePluginDigest,false);
 return {...base,planId:hash(base)};
}

function validatePlan(plan:CodeOnlyRebindPlan,now:Date){
 const {planId,...body}=plan;validateAttestation(plan.attestation,now);
 if(plan.schema!==SCHEMA||plan.sourcePluginDigest!==plan.attestation.toPluginDigest||planId!==hash(body)||!isAbsolute(plan.installedPluginPath)||!eq(plan.workspaces.map(w=>w.workspaceId).sort(),[...plan.attestation.exactWorkspaceIds].sort())
  ||new Set(plan.workspaces.map(w=>w.workspaceId)).size!==plan.workspaces.length||plan.artifacts.length!==plan.workspaces.length*3)failure('CODE_REBIND_PLAN_INVALID');
 const keys=new Set<string>();
 for(const w of plan.workspaces){
  if(!isAbsolute(w.workspace)||realpathSync(w.workspace)!==w.workspace)failure('CODE_REBIND_WORKSPACE_MISMATCH');
  const records=plan.artifacts.filter(a=>a.workspaceId===w.workspaceId);
  if(records.length!==3||new Set(records.map(a=>a.kind)).size!==3)failure('CODE_REBIND_PLAN_INVALID');
  const p=records.find(a=>a.kind==='projection')!,before=JSON.parse(p.before!),after=JSON.parse(p.after!);
  if(hash(before)!==w.projectionBeforeDigest||hash(after)!==w.projectionAfterDigest||before.workspaceId!==w.workspaceId
   ||before.pluginDigest!==plan.attestation.fromPluginDigest||after.pluginDigest!==plan.attestation.toPluginDigest
   ||!eq(after,{...before,pluginDigest:plan.attestation.toPluginDigest}))failure('CODE_REBIND_PROJECTION_FIELDS_CHANGED');
  const q=records.find(a=>a.kind==='quality')!;
  if((q.before===null)!==(q.after===null))failure('CODE_REBIND_QUALITY_CHANGED');
  if(q.before!==null){const old=JSON.parse(q.before),next=JSON.parse(q.after!);const expected=rebindQualityRollout(old,identity(before),identity(after),old.inventoryDigest,old.preparedAt);
   if(!eq(next,expected))failure('CODE_REBIND_QUALITY_CHANGED');}
  const t=records.find(a=>a.kind==='transition')!;
  if(w.transitionStatus==='absent'){if(t.before!==null||t.after!==null)failure('CODE_REBIND_LINEAGE_CHANGED');}
  else if(w.transitionStatus==='invalid-preserved'){
   const allowed=plan.attestation.preserveInvalidTransition;
   if(!allowed||allowed.workspaceId!==w.workspaceId||t.before!==t.after||t.beforeDigest!==allowed.originalFileDigest||w.transitionFailureCode!==allowed.failureCode)failure('CODE_REBIND_LINEAGE_CHANGED');
  }else if(w.transitionStatus==='valid-retargeted'){
   const old=JSON.parse(t.before!),next=JSON.parse(t.after!);const {digest,...oldBody}=old;
   const expected={...oldBody,targetProjectionDigest:hash(after)};
   if(digest!==hash(oldBody)||old.targetProjectionDigest!==hash(before)||!eq(next,{...expected,digest:hash(expected)}))failure('CODE_REBIND_LINEAGE_CHANGED');
  }else failure('CODE_REBIND_LINEAGE_CHANGED');
 }
 for(const a of plan.artifacts){
  const w=plan.workspaces.find(w=>w.workspaceId===a.workspaceId);const filename=a.kind==='projection'?'projection.json':a.kind==='quality'?'quality-rollout.json':'model-transition.json';
  if(!w||!['projection','quality','transition'].includes(a.kind)||a.path!==join(w.workspace,'memory-state/memory-observation',filename)||keys.has(a.path)||a.beforeDigest!==rawDigest(a.before)||a.afterDigest!==rawDigest(a.after))failure('CODE_REBIND_PLAN_INVALID');
  if(existsSync(a.path)&&realpathSync(a.path)!==a.path)failure('CODE_REBIND_WORKSPACE_MISMATCH');
  keys.add(a.path);
 }
}
function flush(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function atomic(path:string,raw:string){mkdirSync(dirname(path),{recursive:true,mode:0o700});const temp=path+'.tmp-'+randomUUID();const fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,raw);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);flush(dirname(path));}
function immutable(path:string,value:unknown){const raw=serialize(value);mkdirSync(dirname(path),{recursive:true,mode:0o700});const temp=path+'.tmp-'+randomUUID();const fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,raw);fsyncSync(fd);}finally{closeSync(fd);}try{linkSync(temp,path);}catch(error:any){if(error.code!=='EEXIST'||readFileSync(path,'utf8')!==raw)failure('CODE_REBIND_JOURNAL_CONFLICT');}finally{unlinkSync(temp);}flush(dirname(path));}
function currentDigest(a:Artifact){return existsSync(a.path)?fileDigest(a.path):null;}
function verifyFinal(plan:CodeOnlyRebindPlan){
 for(const w of plan.workspaces){
  const p=resolveMemoryObservationProjection({workspace:w.workspace,workspaceId:w.workspaceId,expectedPluginDigest:plan.attestation.toPluginDigest});
  if(hash(p)!==w.projectionAfterDigest)failure('CODE_REBIND_READBACK_FAILED');
  if(plan.artifacts.find(a=>a.workspaceId===w.workspaceId&&a.kind==='quality')!.after!==null)readQualityRollout(w.workspace,identity(p));
  if(w.transitionStatus==='valid-retargeted')readModelTransition(w.workspace,p);
  if(w.transitionStatus==='invalid-preserved'){
   let code='';try{readModelTransition(w.workspace,p);}catch(e){code=e instanceof Error?e.message:'';}
   if(code!==w.transitionFailureCode)failure('CODE_REBIND_INVALID_TRANSITION_HEALTH_CHANGED');
  }
 }
}
export type CodeOnlyRebindFault={point:'after_journal'|'after_artifact'|'before_completed'|'after_completed';artifactIndex?:number};
/** Parents own the real worker/capture maintenance barrier, install and restart.
 * Journal snapshots contain administrative policy metadata only, never sources. */
export function applyCodeOnlyPluginRebind(options:{plan:CodeOnlyRebindPlan;journalRoot:string;sourcePluginDigest:Digest;
 workersPaused:true;maintenanceBarrierId:string;now?:Date;fault?:CodeOnlyRebindFault}){
 const {plan}=options;validatePlan(plan,options.now??new Date());
 if(options.workersPaused!==true||!options.maintenanceBarrierId?.trim()||!isAbsolute(options.journalRoot))failure('CODE_REBIND_MAINTENANCE_BARRIER_REQUIRED');
 checkInstalledAndSource(plan,options.sourcePluginDigest,true);
 const journal=join(resolve(options.journalRoot),plan.planId.slice(7)),planPath=join(journal,'plan.json'),progressPath=join(journal,'progress.json'),completedPath=join(journal,'completed.json');
 const assertStates=(done:Set<string>)=>{for(const a of plan.artifacts){const current=currentDigest(a);
   if(done.has(a.path)?current!==a.afterDigest:current!==a.beforeDigest&&current!==a.afterDigest)failure('CODE_REBIND_ARTIFACT_DIVERGED');}};
 // This preflight prevents a changed workspace from causing any partial publication.
 const initialProgress=existsSync(progressPath)?read(progressPath):null;
 if(initialProgress&&(initialProgress.schema!=='engram.code-only-plugin-rebind-progress.v1'||initialProgress.planId!==plan.planId||initialProgress.maintenanceBarrierId!==options.maintenanceBarrierId||!Array.isArray(initialProgress.appliedPaths)))failure('CODE_REBIND_JOURNAL_CONFLICT');
 assertStates(new Set(existsSync(completedPath)?plan.artifacts.map(a=>a.path):(initialProgress?.appliedPaths??[])));
 const release=acquireProcessLease(join(resolve(options.journalRoot),'code-only-plugin-rebind.lock'));
 if(!release)failure('CODE_REBIND_BUSY');
 try{
  checkInstalledAndSource(plan,options.sourcePluginDigest,true);
  immutable(planPath,plan);
  const progress=existsSync(progressPath)?read(progressPath):{schema:'engram.code-only-plugin-rebind-progress.v1',planId:plan.planId,maintenanceBarrierId:options.maintenanceBarrierId,appliedPaths:[]};
  if(progress.schema!=='engram.code-only-plugin-rebind-progress.v1'||progress.planId!==plan.planId||progress.maintenanceBarrierId!==options.maintenanceBarrierId||!Array.isArray(progress.appliedPaths)||progress.appliedPaths.some((p:string)=>!plan.artifacts.some(a=>a.path===p)))failure('CODE_REBIND_JOURNAL_CONFLICT');
  const done=new Set<string>(progress.appliedPaths);assertStates(done);
  if(!existsSync(progressPath))atomic(progressPath,serialize(progress));
  if(options.fault?.point==='after_journal')failure('CODE_REBIND_FAULT_INJECTED');
  for(const [index,a] of plan.artifacts.entries()){
   assertStates(done);checkInstalledAndSource(plan,options.sourcePluginDigest,true);
   if(currentDigest(a)!==a.afterDigest){if(a.after===null)failure('CODE_REBIND_UNEXPECTED_DELETE');atomic(a.path,a.after);}
   if(options.fault?.point==='after_artifact'&&(options.fault.artifactIndex??0)===index)failure('CODE_REBIND_FAULT_INJECTED');
   done.add(a.path);atomic(progressPath,serialize({...progress,appliedPaths:[...done]}));
  }
  assertStates(done);verifyFinal(plan);
  if(options.fault?.point==='before_completed')failure('CODE_REBIND_FAULT_INJECTED');
  const result={schema:'engram.code-only-plugin-rebind-completed.v1',planId:plan.planId,fromPluginDigest:plan.attestation.fromPluginDigest,toPluginDigest:plan.attestation.toPluginDigest,
   maintenanceBarrierId:options.maintenanceBarrierId,reboundWorkspaceCount:plan.workspaces.length,
   preservedBlockedWorkspaces:plan.workspaces.filter(w=>w.transitionStatus==='invalid-preserved').map(w=>({workspaceId:w.workspaceId,reason:w.transitionFailureCode})),
   evaluationPoliciesChanged:false,sourcePoliciesChanged:false,modelsChanged:false,activationTimesChanged:false,queuesChanged:false,
   loadedRuntimeVerified:false};
  immutable(completedPath,result);if(options.fault?.point==='after_completed')failure('CODE_REBIND_FAULT_INJECTED');return result;
 }finally{release();}
}
