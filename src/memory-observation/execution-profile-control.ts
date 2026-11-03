import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { acquireProcessLease } from "./process-lease.ts";
import { sha256, type Digest, type JsonValue } from "./ledger.ts";
import { resolveMemoryObservationProjection } from "./projection.ts";
import { evaluationQuality, readModelTransition } from "./model-transition.ts";
import { CONTEXTUAL_PROMPT_VERSION } from "./contextual-observation.ts";
import { BATCH_SHADOW_PROMPT_VERSION } from "./batch-shadow-runner.ts";
import { verifiedDoneJobId } from "./worker-health.ts";
import { planOllObserverBridge, applyOllObserverBridgePlan } from "../oll/observer-receipt-provisioning.ts";
import { createExecutionProfile, legacyProfileSnapshots, profileAnchors, profileStatePath, readExecutionProfiles, sealProfiles, validateExecutionProfiles,
  jobProfilePolicy, type ExecutionProfiles, type ProviderBoundary } from "./execution-profiles.ts";

const hash = (v: unknown) => sha256(v as JsonValue);
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const fileDigest = (p: string): Digest | null => existsSync(p) ? sha256(readFileSync(p, "utf8")) : null;
export type ModelQualification = {
  schema: "engram.memory-model-qualification.v1"; model: string; thinking: "medium" | "high";
  boundaryDigest: Digest; promptVersion: string; checks: { id: string; passed: boolean }[];
  basePromptVersion: string;
  passed: boolean; latencyMs: number; requestedTokenBudget: number; tokenBudgetEnforcement: "unavailable";
  thinkingReadback: "requested-only"; completedAt: string;
};
export type ProfileSwitchPlan = {
  schema: "engram.memory-profile-switch-plan.v1"; workspace: string; workspaceId: string;
  beforeDigest: Digest | null; beforeRaw: string | null; after: ExecutionProfiles; qualification: ModelQualification;
  boundary: ProviderBoundary; planId: Digest;
};
function assertQualification(q:ModelQualification,model:string,thinking:string,boundary:ProviderBoundary,at:string):void {
  if (!q || q.schema !== "engram.memory-model-qualification.v1" || !q.passed || q.model !== model || q.thinking !== thinking
    || q.boundaryDigest !== hash(boundary) || q.promptVersion!==CONTEXTUAL_PROMPT_VERSION || q.basePromptVersion!==BATCH_SHADOW_PROMPT_VERSION
    || q.checks.map(c=>c.id).sort().join(",")!==["negation","request-not-completion","actor-attribution","failure-not-success","untrusted-injection","base-contract"].sort().join(",") || q.checks.some(c => !c.passed)
    || q.requestedTokenBudget!==8192 || q.tokenBudgetEnforcement!=="unavailable" || q.thinkingReadback!=="requested-only"
    || !Number.isFinite(q.latencyMs) || q.latencyMs < 0 || !Number.isFinite(Date.parse(q.completedAt))
    || Date.parse(at)-Date.parse(q.completedAt)>86400000 || Date.parse(q.completedAt)>Date.parse(at)) throw Error("PROFILE_QUALIFICATION_REQUIRED");
}
export function planProfileSwitch(o: { workspace: string; workspaceId: string; model: string; thinking: "medium" | "high";
  boundary: ProviderBoundary; legacyBoundaries?:Record<string,ProviderBoundary>; approvedBy: string; approvedAt: string; qualification: ModelQualification }): ProfileSwitchPlan {
  if (realpathSync(o.workspace) !== o.workspace || !o.approvedBy || !Number.isFinite(Date.parse(o.approvedAt))) throw Error("PROFILE_OPERATOR_AUTHORITY_REQUIRED");
  const projection = resolveMemoryObservationProjection(o);
  if (projection.mode !== "canary" || projection.evaluation?.mode !== "batch-cron" || projection.captureOwnership?.owner !== "observer") throw Error("PROFILE_BATCH_OWNER_REQUIRED");
  // Fail closed on an unrelated stale legacy transition or quality rollout.
  readModelTransition(o.workspace, projection); evaluationQuality(o.workspace, projection);
  const legacy = legacyProfileSnapshots(o.workspace, projection);
  const current = readExecutionProfiles(o.workspace, projection);
  const legacyBoundaries=current?.legacyBoundaries??o.legacyBoundaries;
  const providerBoundary={provider:o.boundary.provider,baseUrl:o.boundary.baseUrl};
  if(!legacyBoundaries || legacy.some(s=>{
    const b=legacyBoundaries[s.projection.inference.model];
    return !b || hash({provider:b.provider,baseUrl:b.baseUrl})!==hash(providerBoundary);
  }) || (current && (!current.approvedBoundaries.some(b=>hash(b)===hash(o.boundary))
    || hash(current.approvedProviderBoundary)!==hash(providerBoundary)))) throw Error("PROFILE_PROVIDER_CHANGE_REQUIRES_AUTHORITY_ROLLOUT");
  const q = o.qualification;
  assertQualification(q,o.model,o.thinking,o.boundary,o.approvedAt);
  const base = createExecutionProfile(legacy[0]!, o.boundary, o.model, o.thinking, false);
  const contextual = legacy[0]!.quality ? createExecutionProfile(legacy[0]!, o.boundary, o.model, o.thinking, true) : null;
  const revisions = structuredClone(current?.revisions ?? []);
  for (const profile of [base, contextual].filter(p => p !== null)) {
    const old = revisions.find(r => r.profile.profileId === profile.profileId);
    if (old) old.lifecycle = "active"; else revisions.push({ profile, lifecycle: "active" });
  }
  const after = sealProfiles({ schema: "engram.memory-execution-profiles.v1", workspaceId: o.workspaceId,
    anchors: profileAnchors(o.workspace, projection), legacy, legacyBoundaries, approvedProviderBoundary:providerBoundary,
    approvedBoundaries:current?.approvedBoundaries??[...new Map([...Object.values(legacyBoundaries),o.boundary].map(b=>[hash(b),b])).values()],revisions,
    defaults: { base: base.profileId, contextual: contextual?.profileId ?? null }, approvedBy: o.approvedBy, approvedAt: o.approvedAt });
  validateExecutionProfiles(after, o.workspace, projection);
  const body = { schema: "engram.memory-profile-switch-plan.v1" as const, workspace: o.workspace, workspaceId: o.workspaceId,
    beforeDigest: fileDigest(profileStatePath(o.workspace)), beforeRaw:existsSync(profileStatePath(o.workspace))?readFileSync(profileStatePath(o.workspace),"utf8"):null,
    after, qualification: q, boundary: o.boundary };
  return { ...body, planId: hash(body) };
}
function flush(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
export function atomicProfileJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + ".tmp-" + randomUUID(), fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path); flush(dirname(path));
}
function immutable(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + ".tmp-" + randomUUID();
  atomicProfileJson(temp, value);
  try { linkSync(temp, path); }
  catch (e: any) { if (e.code !== "EEXIST" || hash(read(path)) !== hash(value)) throw Error("PROFILE_JOURNAL_CONFLICT"); }
  finally { unlinkSync(temp); }
  flush(dirname(path));
}
export function applyProfileSwitch(plan: ProfileSwitchPlan, boundary: ProviderBoundary, journalRoot: string,
  hooks:{leasePath?:string;now?:()=>Date;fault?:(stage:"after_bridge_admission"|"after_publish")=>void}={}) {
  const { planId, ...body } = plan;
  if (plan.schema !== "engram.memory-profile-switch-plan.v1" || planId !== hash(body) || hash(boundary) !== hash(plan.boundary)
    || realpathSync(plan.workspace) !== plan.workspace) throw Error("PROFILE_PLAN_CHANGED");
  const release = acquireProcessLease(hooks.leasePath??join(tmpdir(), "engram-memory-batch-inference-" + (process.getuid?.() ?? "user")));
  if (!release) throw Error("PROFILE_WORKER_BUSY");
  try {
    const projection = resolveMemoryObservationProjection({workspace:plan.workspace,workspaceId:plan.workspaceId});
    readModelTransition(plan.workspace,projection); evaluationQuality(plan.workspace,projection);
    validateExecutionProfiles(plan.after, plan.workspace, projection);
    const path = profileStatePath(plan.workspace), nextDigest = sha256(JSON.stringify(plan.after, null, 2) + "\n");
    if (![plan.beforeDigest, nextDigest].includes(fileDigest(path))) throw Error("PROFILE_PLAN_CAS_CONFLICT");
    const root = join(journalRoot, planId.slice(7));
    immutable(join(root, "plan.json"), plan);
    if(plan.beforeDigest!==(plan.beforeRaw===null?null:sha256(plan.beforeRaw))) throw Error("PROFILE_PLAN_CHANGED");
    const receiptPath=join(root,"receipt.json");
    if(existsSync(receiptPath)) {
      const receipt=read(receiptPath);
      const config=read(join(plan.workspace,"engram.json"));
      if(fileDigest(path)!==nextDigest || receipt.planId!==planId || receipt.registryDigest!==plan.after.digest
        || (receipt.ollRegistryDigest && config.oll?.observerReceiptProducerRegistry?.digest!==receipt.ollRegistryDigest)) throw Error("PROFILE_READBACK_FAILED");
      return receipt;
    }
    const defaultProfile=plan.after.revisions.find(r=>r.profile.profileId===plan.after.defaults.base)!.profile;
    assertQualification(plan.qualification,defaultProfile.template.runner.requestedModel,defaultProfile.template.runner.thinking!,boundary,(hooks.now?.()??new Date()).toISOString());
    let ollRegistryDigest:string|null=null;
    {
      const bridgePath=join(root,"oll-bridge-plan.json");
      const bridge=existsSync(bridgePath)?read(bridgePath):planOllObserverBridge(plan.workspace,new Date(),plan.after);
      if(bridge){
        immutable(bridgePath,bridge);
        const config=read(join(plan.workspace,"engram.json"));
        ollRegistryDigest=config.oll?.observerReceiptProducerRegistry?.digest===bridge.registry.digest
          ?bridge.registry.digest:applyOllObserverBridgePlan(bridge).registryDigest;
        flush(join(plan.workspace,"engram.json"));flush(plan.workspace);
      }
    }
    hooks.fault?.("after_bridge_admission");
    // Independent broaden-only OLL admission is durable BEFORE the one atomic
    // default publication. A crash can leave extra approved read authority,
    // never an executable default whose consumer admission is incomplete.
    if (fileDigest(path) !== nextDigest) atomicProfileJson(path, plan.after);
    hooks.fault?.("after_publish");
    const readback = readExecutionProfiles(plan.workspace, projection);
    if (hash(readback) !== hash(plan.after)) throw Error("PROFILE_READBACK_FAILED");
    const receipt = {schema:"engram.memory-profile-switch-receipt.v1",planId,workspaceId:plan.workspaceId,
      registryDigest:plan.after.digest,defaults:plan.after.defaults,qualificationDigest:hash(plan.qualification),
      sourceProjectionUnchanged:true,pluginRebuilt:false,sourceJobsMigrated:0,readBackVerified:true,ollRegistryDigest};
    immutable(join(root,"receipt.json"),receipt);
    return receipt;
  } finally { release(); }
}

/** Per-revision retirement, never a fleet/global drain. Drain stops execution
 * but leaves immutable saved results consumable; resume is explicit. */
export function setProfileLifecycle(workspace: string, workspaceId: string, profileId: Digest,
  lifecycle: "active" | "drain" | "retired", approvedBy: string) {
  if (!approvedBy) throw Error("PROFILE_OPERATOR_AUTHORITY_REQUIRED");
  const release = acquireProcessLease(join(tmpdir(), "engram-memory-batch-inference-" + (process.getuid?.() ?? "user")));
  if (!release) throw Error("PROFILE_WORKER_BUSY");
  try {
    const p = resolveMemoryObservationProjection({workspace,workspaceId}), registry = readExecutionProfiles(workspace,p);
    if(!registry) throw Error("PROFILE_REGISTRY_REQUIRED");
    const entry = registry.revisions.find(r=>r.profile.profileId===profileId);
    if(!entry || (lifecycle!=="active" && Object.values(registry.defaults).includes(profileId))) throw Error("PROFILE_DEFAULT_RETIRE_DENIED");
    const root = join(workspace,"memory-state/memory-observation"), batch = join(root,"batch-live-store/memory-batch-live/v1");
    const records=(dir:string):any[]=>existsSync(dir)?readdirSync(dir).filter(n=>n.endsWith(".json")).map(n=>read(join(dir,n))):[];
    if(lifecycle==="retired") {
      const jobs=records(join(batch,"jobs")).filter(j=>j.profileRefs?.profileId===profileId);
      const done = new Map(records(join(batch,"done")).map(d=>[d.jobId,d]));
      const queues = new Map(records(join(root,"v1/queues/evaluator")).map(q=>[q.traceId,q]));
      if(jobs.some(j=>!done.has(j.jobId)||j.bundle.sourceRefs.some((s:any)=>queues.get(s.traceId)?.status!=="terminal"))) throw Error("PROFILE_REVISION_DRAIN_REQUIRED");
      for(const j of jobs) {
        jobProfilePolicy(registry,p,j);
        if(j.jobId!==hash({schema:j.schema,partition:j.partition,evaluationPolicyDigest:j.evaluationPolicyDigest,bundleId:j.bundle.bundleId}))throw Error("PROFILE_REVISION_ACCOUNTING_INVALID");
        const d=done.get(j.jobId),errors:any[]=[];
        const verified=verifiedDoneJobId({path:join(batch,"done",j.jobId.slice(7)+".json"),value:d},
          jobs.map(value=>({path:join(batch,"jobs",value.jobId.slice(7)+".json"),value})),errors);
        if(verified!==j.jobId||errors.length) throw Error("PROFILE_REVISION_ACCOUNTING_INVALID");
        const kind=d.schema==="engram.memory-batch-live-failure.v1"?"failures":d.schema==="engram.memory-batch-live-reconciliation.v1"?"reconciliations":"terminals";
        const artifact=join(batch,kind,j.jobId.slice(7)+".json");
        if(!existsSync(artifact)||hash(read(artifact))!==hash(d))throw Error("PROFILE_REVISION_ACCOUNTING_INVALID");
      }
      const bundles=new Set(jobs.map(j=>j.bundle.bundleId));
      const observations=records(join(root,"v1/observations/batch")).filter(o=>bundles.has(o.bundleId)&&o.evaluationPolicyDigest===entry.profile.template.evaluationPolicyDigest);
      const daily=new Map(records(join(root,"v1/consumers/daily-note/queue")).map(q=>[q.observationId,q]));
      const receipts=records(join(root,"v1/receipts/by-operation"));
      for(const o of observations) {
        const receipt=receipts.find(r=>r.sourceObservationRef===o.observationId);
        if(daily.get(o.observationId)?.status!=="terminal"||!receipt||receipt.canonicalMutation!==true) throw Error("PROFILE_REVISION_CONSUME_REQUIRED");
        const binding=memoryObservationBindingForRetirement(p,o.scope.runtimeSessionKey);
        if(binding?.topicDomain||binding?.groupDomain) {
          const key=receipt.operationId.slice(7), domain=read(join(workspace,"memory-state/domain-effects/v1/receipts",key+".json"));
          const dirty=read(join(workspace,"memory-state/domain-effects/v1/dirty",key+".json"));
          if(domain.sourceReceiptId!==receipt.receiptId||domain.canonicalApplied!==true||dirty.domainApplyReceiptDigest!==hash(domain)||dirty.qmdDirtyMarked!==true) throw Error("PROFILE_REVISION_DOMAIN_DRAIN_REQUIRED");
        }
      }
    }
    const before=registry.digest,beforeRegistry=structuredClone(registry);
    entry.lifecycle=lifecycle;
    const {digest,...body}=registry;
    const after=sealProfiles({...body,approvedBy,approvedAt:new Date().toISOString()});
    validateExecutionProfiles(after,workspace,p);
    const receipt={schema:"engram.memory-profile-lifecycle.v1",profileId,lifecycle,before,after:after.digest,approvedBy};
    immutable(join(root,"profile-lifecycle",after.digest.slice(7)+".json"),{receipt,before:beforeRegistry,after});
    atomicProfileJson(profileStatePath(workspace),after);
    if(readExecutionProfiles(workspace,p)?.digest!==after.digest) throw Error("PROFILE_READBACK_FAILED");
    return receipt;
  } finally {release();}
}
import { memoryObservationBinding as memoryObservationBindingForRetirement } from "./projection.ts";
