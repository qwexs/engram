import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "./ledger.ts";
import { createExecutionProfile, defaultProfilePolicy, jobProfilePolicy, profileStatePath, readExecutionProfiles, authorizeProfileOperation } from "./execution-profiles.ts";
import { planProfileSwitch, applyProfileSwitch, setProfileLifecycle, type ModelQualification } from "./execution-profile-control.ts";
import type { MemoryObservationProjectionV1 } from "./projection.ts";
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
const at="2026-11-03T17:00:00.000Z",scope={workspaceId:"alpha",runtimeSessionKey:"agent:alpha:telegram:direct:123",scopeClass:"self" as const,scopeId:"telegram:123"};
const boundary={provider:"openai",baseUrl:"https://example.invalid/v1",api:"responses",runtime:"host-default"};
function fixture(){
  const workspace=mkdtempSync(join(tmpdir(),"mw-profiles-"));roots.push(workspace);
  const put=(rel:string,v:unknown)=>{const p=join(workspace,rel);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,JSON.stringify(v));};
  const projection:MemoryObservationProjectionV1={schema:"engram.memory-observation-rollout.v2",workspaceId:"alpha",enabled:true,mode:"canary",
    bindings:[{runtimeSessionKey:scope.runtimeSessionKey,scopeClass:scope.scopeClass,scopeId:scope.scopeId,requireOwner:true,allowedChannels:["telegram"]}],pluginDigest:sha256("plugin"),
    inference:{provider:"openai",model:"openai/gpt-6-luna",evaluateAfter:at},evaluation:{mode:"batch-cron",policyDigest:sha256("legacy"),batch:{sourcePolicyDigest:sha256("source"),inactivityGapSeconds:300,maxTurns:8,maxEvidenceBytes:262144,maxAgeSeconds:900,maxInferenceCallsPerRun:1,schedulerId:"existing"}},
    limits:{evidenceTtlHours:72,maxJobs:1000,maxBytes:67108864,maxQueueAgeHours:168,maxAttempts:2,claimTtlSeconds:300,maxInferenceCalls:1},
    consumers:{dailyNote:{mode:"canary",applyAfter:at,timezone:"UTC",allowedObservationClasses:["episodic.event","episodic.decision"],maxAppliesPerWake:1}},
    captureOwnership:{owner:"observer",effectiveAfter:at,foregroundDailyNoteCapture:"disabled"},approvedBy:"operator",approvedAt:at};
  put("engram.json",{workspace:{id:"alpha"}});put("memory-state/memory-observation/projection.json",projection);
  const quality={schema:"engram.memory-quality-rollout.v1",mode:"active",workspaceId:"alpha",pluginDigest:projection.pluginDigest,baseEvaluationPolicyDigest:projection.evaluation!.policyDigest,
    sourcePolicyDigest:projection.evaluation!.batch!.sourcePolicyDigest,applyAfter:at,exactScopes:[scope],preparedAt:at,inventoryDigest:sha256("inventory")};
  put("memory-state/memory-observation/quality-rollout.json",{...quality,digest:sha256(quality)});
  const options=(model="openai/gpt-6.1-terra",thinking:"medium"|"high"="high")=>({workspace,workspaceId:"alpha",model,thinking,boundary,legacyBoundaries:{"openai/gpt-6-luna":boundary},approvedBy:"telegram:123",approvedAt:at,
    qualification:{schema:"engram.memory-model-qualification.v1",model,thinking,boundaryDigest:sha256(boundary),promptVersion:"memory-contextual-shadow-v16",basePromptVersion:"memory-batch-shadow-prompt-v11",checks:["negation","request-not-completion","actor-attribution","failure-not-success","untrusted-injection","base-contract"].map(id=>({id,passed:true})),passed:true,latencyMs:1,requestedTokenBudget:8192,tokenBudgetEnforcement:"unavailable",thinkingReadback:"requested-only",completedAt:at} as ModelQualification});
  return {workspace,put,projection,options};
}
test("model and thinking change only execution identity; effect and contract identities stay stable",()=>{
  const f=fixture(),plan=planProfileSwitch(f.options());
  const first=plan.after.revisions[1]!.profile;
  const next=createExecutionProfile(plan.after.legacy[0]!,boundary,"openai/another-model","medium",true);
  expect(first.authorityDigest).toBe(next.authorityDigest);expect(first.contractDigest).toBe(next.contractDigest);
  expect(first.template.evaluationPolicyDigest).toBe(next.template.evaluationPolicyDigest);
  expect(first.executionDigest).not.toBe(next.executionDigest);expect(first.profileId).not.toBe(next.profileId);
  expect(first.template.contextualThinking).toBe("high");expect(next.template.contextualThinking).toBe("medium");
});
test("plan is read-only, apply has CAS/read-back, idempotence and no source/plugin changes",()=>{
  const f=fixture(),before=readFileSync(join(f.workspace,"memory-state/memory-observation/projection.json"),"utf8"),plan=planProfileSwitch(f.options());
  expect(existsSync(profileStatePath(f.workspace))).toBe(false);
  const receipt=applyProfileSwitch(plan,boundary,join(f.workspace,"ops"));
  expect(receipt).toMatchObject({sourceJobsMigrated:0,sourceProjectionUnchanged:true,pluginRebuilt:false,readBackVerified:true});
  expect(applyProfileSwitch(plan,boundary,join(f.workspace,"ops"))).toEqual(receipt);
  expect(readFileSync(join(f.workspace,"memory-state/memory-observation/projection.json"),"utf8")).toBe(before);
  expect(defaultProfilePolicy(readExecutionProfiles(f.workspace,f.projection)!,f.projection,scope).runner.requestedModel).toBe("openai/gpt-6.1-terra");
});
test("new default never rewrites a pending job's revisions; multiple switches and rollback retain exact profiles",()=>{
  const f=fixture(),one=planProfileSwitch(f.options());applyProfileSwitch(one,boundary,join(f.workspace,"ops"));
  const original=defaultProfilePolicy(one.after,f.projection,scope);
  const job:any={partition:{...scope,producerEpoch:"v1",policyDigest:original.sourcePolicyDigest},profileRefs:original.profileRefs,evaluationPolicyDigest:original.evaluationPolicyDigest};
  const two=planProfileSwitch(f.options("openai/other-model","medium"));applyProfileSwitch(two,boundary,join(f.workspace,"ops"));
  expect(defaultProfilePolicy(two.after,f.projection,scope).runner.requestedModel).toBe("openai/other-model");
  expect(jobProfilePolicy(two.after,f.projection,job)).toEqual(original);
  const back=planProfileSwitch(f.options());applyProfileSwitch(back,boundary,join(f.workspace,"ops"));
  expect(back.after.revisions).toHaveLength(4);expect(back.after.defaults).toEqual(one.after.defaults);
});
test("endpoint, scope, immutable revisions and live anchors cannot silently change",()=>{
  const f=fixture(),plan=planProfileSwitch(f.options());applyProfileSwitch(plan,boundary,join(f.workspace,"ops"));
  const policy=defaultProfilePolicy(plan.after,f.projection,scope);
  expect(()=>authorizeProfileOperation(plan.after,f.projection,policy,"execute",{...boundary,baseUrl:"https://foreign.invalid"})).toThrow("PROFILE_PROVIDER_BOUNDARY_CHANGED");
  expect(()=>defaultProfilePolicy(plan.after,f.projection,{...scope,runtimeSessionKey:"agent:alpha:telegram:direct:999"})).toThrow("PROFILE_SCOPE_REVOKED");
  const changed=structuredClone(f.projection);changed.limits.maxAttempts=3;
  expect(()=>readExecutionProfiles(f.workspace,changed)).toThrow("PROFILE_REGISTRY_IDENTITY_CHANGED");
  const mutated=structuredClone(plan.after);mutated.revisions[0]!.profile.template.runner.requestedModel="openai/injected";
  const {digest,...body}=mutated;f.put("memory-state/memory-observation/execution-profiles.json",{...body,digest:sha256(body)});
  expect(()=>readExecutionProfiles(f.workspace,f.projection)).toThrow("PROFILE_REVISION_CHANGED");
});
test("failed qualification, provider change and stale apply are rejected before mutation",()=>{
  const f=fixture(),bad=f.options();bad.qualification.passed=false;
  expect(()=>planProfileSwitch(bad)).toThrow("PROFILE_QUALIFICATION_REQUIRED");
  expect(()=>planProfileSwitch({...f.options(),model:"foreign/model"})).toThrow();
  const one=planProfileSwitch(f.options()),two=planProfileSwitch(f.options("openai/other"));
  applyProfileSwitch(one,boundary,join(f.workspace,"ops"));
  expect(()=>applyProfileSwitch(two,boundary,join(f.workspace,"ops"))).toThrow("PROFILE_PLAN_CAS_CONFLICT");
});

test("same-provider endpoint/runtime drift and legacy execution are pinned independently of cached consumption",()=>{
  const f=fixture(),one=planProfileSwitch(f.options());applyProfileSwitch(one,boundary,join(f.workspace,"ops"));
  for(const changed of [{...boundary,baseUrl:"https://foreign.invalid"},{...boundary,runtime:"foreign-runtime"}]) {
    const o=f.options();o.boundary=changed;o.qualification.boundaryDigest=sha256(changed);
    expect(()=>planProfileSwitch(o)).toThrow("PROFILE_PROVIDER_CHANGE_REQUIRES_AUTHORITY_ROLLOUT");
  }
  const old=jobProfilePolicy(one.after,f.projection,{partition:{...scope,producerEpoch:"v1",policyDigest:f.projection.evaluation!.batch!.sourcePolicyDigest},evaluationPolicyDigest:f.projection.evaluation!.policyDigest} as any);
  expect(()=>authorizeProfileOperation(one.after,f.projection,old,"execute",{...boundary,baseUrl:"https://foreign.invalid"})).toThrow("PROFILE_PROVIDER_BOUNDARY_CHANGED");
  expect(()=>authorizeProfileOperation(one.after,f.projection,old,"consume")).not.toThrow();
});

for(const change of ["missing-check","wrong-contract","stale","wrong-budget"] as const)test("qualification rejects "+change,()=>{
  const f=fixture(),o=f.options();
  if(change==="missing-check")o.qualification.checks=[{id:"arbitrary",passed:true}];
  if(change==="wrong-contract")o.qualification.basePromptVersion="foreign-prompt";
  if(change==="stale")o.qualification.completedAt="2026-10-01T00:00:00.000Z";
  if(change==="wrong-budget")o.qualification.requestedTokenBudget=1;
  expect(()=>planProfileSwitch(o)).toThrow("PROFILE_QUALIFICATION_REQUIRED");
});

for(const stage of ["after_bridge_admission","after_publish"] as const)test("switch crash resumes through "+stage,()=>{
  const f=fixture(),plan=planProfileSwitch(f.options()),root=join(f.workspace,"journal");
  expect(()=>applyProfileSwitch(plan,boundary,root,{leasePath:join(f.workspace,"test-lease"),fault:p=>{if(p===stage)throw Error("crash");}})).toThrow("crash");
  expect(existsSync(profileStatePath(f.workspace))).toBe(stage==="after_publish");
  expect(applyProfileSwitch(plan,boundary,root,{leasePath:join(f.workspace,"test-lease")})).toMatchObject({readBackVerified:true});
});

test("a deferred first apply rechecks qualification TTL, but completed read-back remains idempotent",()=>{
 const f=fixture(),plan=planProfileSwitch(f.options()),root=join(f.workspace,'journal'),leasePath=join(f.workspace,'test-lease');
 const late=()=>new Date('2026-11-05T17:00:00.000Z');
 expect(()=>applyProfileSwitch(plan,boundary,root,{leasePath,now:late})).toThrow('PROFILE_QUALIFICATION_REQUIRED');
 expect(existsSync(profileStatePath(f.workspace))).toBe(false);
 const receipt=applyProfileSwitch(plan,boundary,root,{leasePath,now:()=>new Date(at)});
 expect(applyProfileSwitch(plan,boundary,root,{leasePath,now:late})).toEqual(receipt);
});

for(const kind of ["failure","reconciliation"] as const)test("per-revision retirement accepts typed completion: "+kind,()=>{
  const f=fixture(),one=planProfileSwitch(f.options());applyProfileSwitch(one,boundary,join(f.workspace,"ops"));
  const old=one.after.revisions[0]!.profile;
  const two=planProfileSwitch(f.options("openai/other"));applyProfileSwitch(two,boundary,join(f.workspace,"ops"));
  const bundleId=sha256("bundle"),traceId=sha256("trace"),partition={...scope,producerEpoch:"v1",policyDigest:old.template.sourcePolicyDigest};
  const schema="engram.memory-batch-live-job.v1",evaluationPolicyDigest=old.template.evaluationPolicyDigest;
  const jobId=sha256({schema,partition,evaluationPolicyDigest,bundleId});
  const root="memory-state/memory-observation/",batch=root+"batch-live-store/memory-batch-live/v1/";
  const profileRefs={profileId:old.profileId,authorityDigest:old.authorityDigest,contractDigest:old.contractDigest,executionDigest:old.executionDigest};
  f.put(batch+"jobs/"+jobId.slice(7)+".json",{schema,partition,jobId,profileRefs,bundle:{bundleId,sourceRefs:[{traceId}]},evaluationPolicyDigest});
  f.put(root+"v1/queues/evaluator/"+traceId.slice(7)+".json",{traceId,status:"terminal"});
  const body=kind==="failure"?{schema:"engram.memory-batch-live-failure.v1",jobId,bundleId,errorCode:"synthetic",traceIds:[traceId]}:
    {schema:"engram.memory-batch-live-reconciliation.v1",jobId,bundleId,evaluationPolicyDigest:old.template.evaluationPolicyDigest,sources:[{traceId}]};
  const done={...body,[kind==="failure"?"failureId":"reconciliationId"]:sha256(body)};
  f.put(batch+"done/"+jobId.slice(7)+".json",done);f.put(batch+(kind==="failure"?"failures/":"reconciliations/")+jobId.slice(7)+".json",done);
  expect(setProfileLifecycle(f.workspace,"alpha",old.profileId,"retired","operator")).toMatchObject({lifecycle:"retired"});
});
