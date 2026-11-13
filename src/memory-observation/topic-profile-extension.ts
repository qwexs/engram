/** Operator-owned additive authority publication. Old jobs/revisions are never
 * rewritten. A durable CAS journal resumes a torn multi-file publication before
 * normal provisioning; Worker inference and domain application are leased. */
import {existsSync,readFileSync,unlinkSync,openSync,fsyncSync,closeSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {sha256,type JsonValue} from "./ledger.ts";
import {acquireProcessLease} from "./process-lease.ts";
import {atomicProfileJson} from "./execution-profile-control.ts";
import {readExecutionProfiles,legacyProfileSnapshots,profileAnchors,rebindExecutionProfilesForTopics,validateExecutionProfiles,
  type ExecutionProfiles,type Snapshot} from "./execution-profiles.ts";
import {readModelTransition,extendHistoricalModelTransition,evaluationQuality} from "./model-transition.ts";
import type {MemoryObservationProjectionV1 as Projection} from "./projection.ts";
import {planOllObserverBridge,applyOllObserverBridgePlan} from "../oll/observer-receipt-provisioning.ts";

const hash=(v:unknown)=>sha256(v as JsonValue);
const read=(p:string)=>JSON.parse(readFileSync(p,"utf8"));
const names=["quality-rollout.json","model-transition.json","projection.json","execution-profiles.json"] as const;
type Values=Record<typeof names[number],any>;
type Plan={schema:"engram.memory-topic-authority-plan.v1";workspace:string;before:Values;after:Values;approvedBy:string;approvedAt:string;planId:string};
type Hooks={fault?:(stage:"after_projection"|"after_bridge"|"after_profiles")=>void;leasePath?:string};
const root=(w:string)=>join(w,"memory-state/memory-observation");
const pending=(w:string)=>join(root(w),"topic-authority-pending.json");
const values=(w:string):Values=>Object.fromEntries(names.map(n=>[n,existsSync(join(root(w),n))?read(join(root(w),n)):null])) as Values;
const plainQuality=(q:any)=>{if(!q)return null;const{digest,...body}=q;return body;};
const anchors=(v:Values):ExecutionProfiles["anchors"]=>({projection:hash(v["projection.json"]),quality:v["quality-rollout.json"]?hash(v["quality-rollout.json"]):null,
  transition:v["model-transition.json"]?hash(v["model-transition.json"]):null});
const legacy=(v:Values):Snapshot[]=>[{projection:v["projection.json"],quality:plainQuality(v["quality-rollout.json"])},
  ...(v["model-transition.json"]?[{projection:v["model-transition.json"].previousProjection,quality:plainQuality(v["model-transition.json"].previousQuality)}]:[])];

function buildAfter(before:Values,projection:Projection,approvedBy:string,approvedAt:string):Values {
  const after=structuredClone(before);after["projection.json"]=projection;
  const quality=plainQuality(before["quality-rollout.json"]);
  if(quality){
    const added=projection.bindings.filter(b=>!before["projection.json"].bindings.some((a:any)=>hash(a)===hash(b)))
      .map(({runtimeSessionKey,scopeClass,scopeId})=>({workspaceId:projection.workspaceId,runtimeSessionKey,scopeClass,scopeId}));
    const next={...quality,exactScopes:[...quality.exactScopes,...added].sort((a,b)=>a.runtimeSessionKey.localeCompare(b.runtimeSessionKey))};
    after["quality-rollout.json"]={...next,digest:hash(next)};
  }
  if(before["model-transition.json"]) after["model-transition.json"]=extendHistoricalModelTransition(before["model-transition.json"],before["projection.json"],projection);
  after["execution-profiles.json"]=rebindExecutionProfilesForTopics({before:before["execution-profiles.json"],beforeAnchors:anchors(before),beforeLegacy:legacy(before),
    afterAnchors:anchors(after),afterLegacy:legacy(after),approvedBy,approvedAt});
  return after;
}
function validatePlan(plan:Plan,workspace:string):void {
  const {planId,...body}=plan;
  if(plan.schema!=="engram.memory-topic-authority-plan.v1"||plan.workspace!==workspace||planId!==hash(body)
    ||hash(plan.after)!==hash(buildAfter(plan.before,plan.after["projection.json"],plan.approvedBy,plan.approvedAt))) throw Error("PROFILE_TOPIC_PLAN_CHANGED");
}
function applyPlan(plan:Plan,hooks:Hooks={}):void {
  const workspace=plan.workspace;validatePlan(plan,workspace);
  const release=acquireProcessLease(hooks.leasePath??join(tmpdir(),"engram-memory-batch-inference-"+(process.getuid?.()??"user")));
  if(!release)throw Error("PROFILE_TOPIC_WORKER_BUSY");
  let releaseDomain:(()=>void)|null=null;
  try{
    releaseDomain=acquireProcessLease(join(workspace,"memory-state/domain-effects/consumer-lock"));
    if(!releaseDomain)throw Error("PROFILE_TOPIC_WORKER_BUSY");
    const current=values(workspace);
    for(const n of names)if(![hash(plan.before[n]),hash(plan.after[n])].includes(hash(current[n])))throw Error("PROFILE_TOPIC_CAS_CONFLICT");
    if(existsSync(pending(workspace))&&hash(read(pending(workspace)))!==hash(plan))throw Error("PROFILE_TOPIC_JOURNAL_CONFLICT");
    atomicProfileJson(pending(workspace),plan);
    const journal=join(root(workspace),"topic-authority-extensions",plan.planId.slice(7));
    const planPath=join(journal,"plan.json");
    if(existsSync(planPath)&&hash(read(planPath))!==hash(plan))throw Error("PROFILE_TOPIC_JOURNAL_CONFLICT");
    atomicProfileJson(planPath,plan);
    for(const n of names.filter(n=>n!=="execution-profiles.json")){
      if(plan.after[n]===null)continue;
      if(hash(current[n])!==hash(plan.after[n]))atomicProfileJson(join(root(workspace),n),plan.after[n]);
    }
    hooks.fault?.("after_projection");
    // Existing positive OLL sources only. Admission of the new policy digests
    // is durable before the new executable defaults become visible.
    const profiles=plan.after["execution-profiles.json"] as ExecutionProfiles;
    const bridge=planOllObserverBridge(workspace,new Date(),profiles);
    if(bridge)applyOllObserverBridgePlan(bridge);
    hooks.fault?.("after_bridge");
    if(hash(current["execution-profiles.json"])!==hash(profiles))atomicProfileJson(join(root(workspace),"execution-profiles.json"),profiles);
    hooks.fault?.("after_profiles");
    validateExecutionProfiles(profiles,workspace,plan.after["projection.json"]);
    readModelTransition(workspace,plan.after["projection.json"]);evaluationQuality(workspace,plan.after["projection.json"]);
    if(hash(values(workspace))!==hash(plan.after))throw Error("PROFILE_TOPIC_READBACK_FAILED");
    atomicProfileJson(join(journal,"receipt.json"),{schema:"engram.memory-topic-authority-receipt.v1",planId:plan.planId,workspaceId:profiles.workspaceId,
      beforeRegistryDigest:plan.before["execution-profiles.json"].digest,registryDigest:profiles.digest,defaults:profiles.defaults,
      oldRevisionsUnchanged:true,sourceJobsMigrated:0,readBackVerified:true,ollRegistryDigest:bridge?.registry.digest??null});
    unlinkSync(pending(workspace));
    const directory=openSync(root(workspace),"r");try{fsyncSync(directory);}finally{closeSync(directory);}
  }finally{releaseDomain?.();release();}
}
/** Resume only a previously sealed operator plan; unknown files never become
 * authority merely because an active registry has mismatching anchors. */
export function resumeTopicProfileExtension(workspace:string,hooks:Hooks={}):boolean {
  if(!existsSync(pending(workspace)))return false;
  const plan=read(pending(workspace)) as Plan;validatePlan(plan,workspace);applyPlan(plan,hooks);return true;
}
export function publishTopicProfileExtension(workspace:string,before:Projection,after:Projection,approvedBy:string,hooks:Hooks={}):void {
  if(!approvedBy?.trim())throw Error("PROFILE_TOPIC_OPERATOR_REQUIRED");
  if(hash(before)===hash(after)){readExecutionProfiles(workspace,before);return;}
  readModelTransition(workspace,before);evaluationQuality(workspace,before);
  const registry=readExecutionProfiles(workspace,before);
  if(!registry)throw Error("PROFILE_REGISTRY_REQUIRED");
  const original=values(workspace);
  if(hash(original["projection.json"])!==hash(before)||hash(original["execution-profiles.json"])!==hash(registry)
    ||hash(anchors(original))!==hash(profileAnchors(workspace,before))||hash(legacy(original))!==hash(legacyProfileSnapshots(workspace,before)))throw Error("PROFILE_TOPIC_CAS_CONFLICT");
  const approvedAt=new Date().toISOString();
  const body={schema:"engram.memory-topic-authority-plan.v1" as const,workspace,before:original,after:buildAfter(original,after,approvedBy,approvedAt),approvedBy,approvedAt};
  applyPlan({...body,planId:hash(body)},hooks);
}
