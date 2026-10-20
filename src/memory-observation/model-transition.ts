import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sha256, type JsonValue, type ObservationScope } from "./ledger.ts";
import { validMainFamilyBinding, type MemoryObservationProjectionV1 } from "./projection.ts";
import { readQualityRollout, rebindQualityRollout, qualityScopeEnabled, qualityTransitionInventory, readableContextualDigests, type QualityRollout } from "./quality-rollout.ts";

// Operator-approved lineage only. Old immutable jobs/results retain their exact
// model and reasoning; new bundles use the live projection. This is not fallback.
export type ModelTransition = {
  schema: "engram.memory-model-transition.v1";
  targetProjectionDigest: ReturnType<typeof sha256>;
  previousProjection: MemoryObservationProjectionV1;
  previousQuality: (QualityRollout & {digest: ReturnType<typeof sha256>}) | null;
  approvedBy: string;
  approvedAt: string;
  authorityExtension?: { baselineProjection: MemoryObservationProjectionV1 };
  digest: ReturnType<typeof sha256>;
};
const hash = (v: unknown) => sha256(v as JsonValue);
const identity = (p: MemoryObservationProjectionV1) => ({workspaceId:p.workspaceId,pluginDigest:p.pluginDigest,
  baseEvaluationPolicyDigest:p.evaluation!.policyDigest,sourcePolicyDigest:p.evaluation!.batch!.sourcePolicyDigest as ReturnType<typeof sha256>,
  applyAfter:p.consumers!.dailyNote.applyAfter});
export function readModelTransition(workspace: string, current: MemoryObservationProjectionV1): ModelTransition | null {
  const path=join(workspace,"memory-state/memory-observation/model-transition.json");
  if (!existsSync(path)) return null;
  const saved=JSON.parse(readFileSync(path,"utf8")); const {digest,...body}=saved;
  if (saved.schema!=="engram.memory-model-transition.v1" || digest!==hash(body)
    || Object.keys(body).filter(key=>key!=="authorityExtension").sort().join(",")!=="approvedAt,approvedBy,previousProjection,previousQuality,schema,targetProjectionDigest"
    || saved.targetProjectionDigest!==hash(current) || !saved.approvedBy || !Number.isFinite(Date.parse(saved.approvedAt)))
    throw Error("MODEL_TRANSITION_IDENTITY_CHANGED");
  const old=saved.previousProjection as MemoryObservationProjectionV1;
  if (!old?.evaluation?.batch || !old.consumers || !current.evaluation?.batch) throw Error("MODEL_TRANSITION_IDENTITY_CHANGED");
  let authority = current;
  if (saved.authorityExtension !== undefined) {
    const baseline = saved.authorityExtension?.baselineProjection;
    if (!baseline || Object.keys(saved.authorityExtension).join(",") !== "baselineProjection") throw Error("MODEL_TRANSITION_SCOPE_CHANGED");
    assertAdditiveMainTopics(baseline, current);
    authority = baseline;
  }
  const comparable=JSON.parse(JSON.stringify(authority));
  comparable.pluginDigest=old.pluginDigest; comparable.inference.model=old.inference.model; comparable.inference.provider=old.inference.provider;
  comparable.evaluation.policyDigest=old.evaluation.policyDigest;
  if (hash(comparable)!==hash(old)) throw Error("MODEL_TRANSITION_SCOPE_CHANGED");
  if (saved.previousQuality) rebindQualityRollout(saved.previousQuality,identity(old),identity(old),saved.previousQuality.inventoryDigest,saved.previousQuality.preparedAt);
  return saved;
}
export function evaluationQuality(workspace: string, selected: MemoryObservationProjectionV1, live=selected): QualityRollout | null {
  if (hash(selected)!==hash(live)) {
    const transition=readModelTransition(workspace,live);
    if (!transition || hash(selected)!==hash(transition.previousProjection)) throw Error("MODEL_TRANSITION_IDENTITY_CHANGED");
    return transition.previousQuality;
  }
  return readQualityRollout(workspace,identity(live));
}
export function readableEvaluationPolicies(workspace: string, current: MemoryObservationProjectionV1, scope: ObservationScope) {
  const policies=(p:MemoryObservationProjectionV1,q:QualityRollout|null)=>[p.evaluation!.policyDigest,
    ...(qualityScopeEnabled(q,scope)?readableContextualDigests(p.evaluation!.policyDigest):[])];
  const transition=readModelTransition(workspace,current);
  return [...new Set([...policies(current,evaluationQuality(workspace,current)),
    ...(transition?policies(transition.previousProjection,transition.previousQuality):[])])];
}
export function evaluationProjectionForScope(workspace: string, current: MemoryObservationProjectionV1, scope: ObservationScope): MemoryObservationProjectionV1 {
  const transition=readModelTransition(workspace,current);
  if (!transition) return current;
  const root=join(workspace,"memory-state/memory-observation");
  const queues=new Map(readdirSync(join(root,"v1/queues/evaluator")).filter(f=>f.endsWith(".json"))
    .map(f=>JSON.parse(readFileSync(join(root,"v1/queues/evaluator",f),"utf8"))).map(q=>[q.traceId,q]));
  const match=(j:any)=>hash({workspaceId:j.partition.workspaceId,runtimeSessionKey:j.partition.runtimeSessionKey,scopeClass:j.partition.scopeClass,scopeId:j.partition.scopeId})===hash(scope);
  const old=transition.previousProjection;
  const oldPolicies=[old.evaluation!.policyDigest,...(qualityScopeEnabled(transition.previousQuality,scope)?readableContextualDigests(old.evaluation!.policyDigest):[])];
  const pending=qualityTransitionInventory(workspace).batches.filter(match).filter(j=>
    j.sourceRefs.some((s:any)=>queues.get(s.traceId)?.status!=="terminal")
    || existsSync(join(root,"batch-live-store/memory-batch-live/v1/contextual-results",j.jobId.slice(7)+".json")));
  const allowed=readableEvaluationPolicies(workspace,current,scope);
  if (pending.some(j=>!allowed.includes(j.policyDigest))) throw Error("MODEL_TRANSITION_PENDING_POLICY_DENIED");
  return pending.some(j=>oldPolicies.includes(j.policyDigest)) ? old : current;
}

/** Explicit additive main-topic authority only; no epoch, ownership, model,
 * scheduler or existing exact-binding changes may hide in this transition. */
export function assertAdditiveMainTopics(before: MemoryObservationProjectionV1, after: MemoryObservationProjectionV1): void {
  if (before.workspaceId !== "main" || after.workspaceId !== "main"
    || !["engram.memory-observation-rollout.v3", "engram.memory-observation-rollout.v6"].includes(before.schema)
    || after.schema !== "engram.memory-observation-rollout.v6"
    || before.bindings.filter(validMainFamilyBinding).length !== 1
    || after.bindings.filter(validMainFamilyBinding).length !== 1
    || after.bindings.length <= before.bindings.length
    || before.bindings.some(b => !after.bindings.some(a => hash(a) === hash(b)))
    || after.bindings.some(b => !validMainFamilyBinding(b) && (!b.topicDomain || b.groupDomain
      || !b.runtimeSessionKey.startsWith("agent:main:telegram:group:") || b.scopeClass !== "project"
      || b.scopeId !== `domain:main:${b.topicDomain.domain}` || b.requireOwner !== false))) throw Error("MODEL_TRANSITION_SCOPE_CHANGED");
  const comparable = structuredClone(after);
  comparable.schema = before.schema; comparable.bindings = before.bindings;
  // A release may rebind installed bytes and model identity separately.
  comparable.pluginDigest = before.pluginDigest; comparable.inference.model = before.inference.model;
  comparable.inference.provider = before.inference.provider; comparable.evaluation!.policyDigest = before.evaluation!.policyDigest;
  const resolver = comparable.consumers?.dailyNote.qmdBinding;
  if (!resolver || !("resolver" in resolver) || resolver.resolver !== "exact-session-registry") throw Error("MODEL_TRANSITION_SCOPE_CHANGED");
  comparable.consumers!.dailyNote.qmdBinding = before.consumers!.dailyNote.qmdBinding;
  if (hash(comparable) !== hash(before)) throw Error("MODEL_TRANSITION_SCOPE_CHANGED");
}

/** Preserve immutable model lineage while adding exact main-topic authority. */
export function extendModelTransitionForMainTopics(workspace: string, before: MemoryObservationProjectionV1, after: MemoryObservationProjectionV1): ModelTransition | null {
  const current = readModelTransition(workspace, before);
  if (!current || hash(before) === hash(after)) return current;
  const { digest, ...body } = current;
  const baselineProjection = current.authorityExtension?.baselineProjection ?? before;
  assertAdditiveMainTopics(baselineProjection, after);
  const next = { ...body, targetProjectionDigest: hash(after), authorityExtension: { baselineProjection } };
  return { ...next, digest: hash(next) };
}
