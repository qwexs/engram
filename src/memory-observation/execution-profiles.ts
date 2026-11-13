/** Model-only control plane. Source admission, plugin bytes, routes, ownership,
 * QMD and evaluator contracts are not changed by moving a default pointer. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { sha256, type Digest, type JsonValue, type ObservationScope } from "./ledger.ts";
import { memoryObservationBinding, type MemoryObservationProjectionV1 as Projection } from "./projection.ts";
import { BATCH_SHADOW_PROMPT_VERSION, batchShadowPrompt } from "./batch-shadow-runner.ts";
import { CONTEXTUAL_PROMPT_VERSION, CONTEXTUAL_PROMPT_VERSIONS, type ContextualPromptVersion } from "./contextual-observation.ts";
import { contextualEvaluationDigest, qualityScopeEnabled, type QualityRollout } from "./quality-rollout.ts";
import type { BatchLiveJobV1, BatchLivePolicyV1 } from "./batch-live-worker.ts";
import { assertAdditiveTopics } from "./model-transition.ts";

const hash = (v: unknown) => sha256(v as JsonValue);
const equal = (a: unknown, b: unknown) => hash(a) === hash(b);
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
export const profileStatePath = (w: string) => join(w, "memory-state/memory-observation/execution-profiles.json");
export type ProviderBoundary = { provider: string; baseUrl: string; api: string; runtime: string };
export type ProfileRefs = { profileId: Digest; authorityDigest: Digest; contractDigest: Digest; executionDigest: Digest };
export type Snapshot = { projection: Projection; quality: QualityRollout | null };
type PluginCodeCompatibility = {
  schema: "engram.memory-profile-plugin-compatibility.v1";
  origin: Snapshot;
  releases: Array<{from:Digest;to:Digest;beforeRegistryDigest:Digest;releaseAttestationDigest:Digest;approvedBy:string;approvedAt:string;digest:Digest}>;
  digest: Digest;
};
type TopicAuthorityRevision = {
  before: Snapshot;
  after: Snapshot;
  pluginCodeCompatibility?: PluginCodeCompatibility;
  beforeRegistryDigest: Digest;
  approvedBy: string;
  approvedAt: string;
  digest: Digest;
};
type Template = Omit<BatchLivePolicyV1, "exactScope" | "profileRefs">;
export type ExecutionProfile = ProfileRefs & {
  boundary: ProviderBoundary;
  template: Template;
  bindings: Projection["bindings"];
  contextualScopes: ObservationScope[];
};
export type ExecutionProfiles = {
  schema: "engram.memory-execution-profiles.v1";
  workspaceId: string;
  anchors: { projection: Digest; quality: Digest | null; transition: Digest | null };
  legacy: Snapshot[];
  legacyBoundaries: Record<string, ProviderBoundary>;
  approvedProviderBoundary: { provider: string; baseUrl: string };
  approvedBoundaries: ProviderBoundary[];
  defaults: { base: Digest; contextual: Digest | null };
  revisions: { profile: ExecutionProfile; lifecycle: "active" | "drain" | "retired" }[];
  approvedBy: string;
  approvedAt: string;
  pluginCodeCompatibility?: PluginCodeCompatibility;
  topicAuthorityHistory?: TopicAuthorityRevision[];
  digest: Digest;
};
/** A code release changes installed bytes, not the immutable authority basis
 * of existing jobs. Every other projection/quality field must stay identical. */
export function profileReconstructionOrigin(saved: ExecutionProfiles): Snapshot {
  return codeReconstructionOrigin(saved.legacy[0]!, saved.pluginCodeCompatibility);
}
function codeReconstructionOrigin(current: Snapshot, c?: PluginCodeCompatibility): Snapshot {
  if(!c)return current;
  const {digest,...body}=c;
  if(c.schema!=="engram.memory-profile-plugin-compatibility.v1" || digest!==hash(body)
    || !Array.isArray(c.releases) || !c.releases.length || c.releases.length>32 || !c.origin?.projection)
    throw Error("PROFILE_CODE_COMPATIBILITY_INVALID");
  let plugin=c.origin.projection.pluginDigest;
  for(const r of c.releases){const {digest,...release}=r;
    if(digest!==hash(release)||r.from!==plugin||r.from===r.to||![r.from,r.to,r.beforeRegistryDigest,r.releaseAttestationDigest].every(v=>/^sha256:[a-f0-9]{64}$/.test(v))
      || !r.approvedBy?.trim() || !Number.isFinite(Date.parse(r.approvedAt)))throw Error("PROFILE_CODE_COMPATIBILITY_INVALID");
    plugin=r.to;
  }
  if(plugin!==current.projection.pluginDigest
    ||!equal({...c.origin.projection,pluginDigest:plugin},current.projection)
    ||!equal(c.origin.quality?{...c.origin.quality,pluginDigest:plugin}:null,current.quality))
    throw Error("PROFILE_CODE_COMPATIBILITY_AUTHORITY_CHANGED");
  return c.origin;
}
/** Only append exact topics. No model, epoch, owner, endpoint or existing
 * binding/quality permission changes can be hidden in an authority revision. */
export function assertTopicProfileAuthority(before: Snapshot, after: Snapshot): void {
  assertAdditiveTopics(before.projection, after.projection);
  const comparable = structuredClone(after.projection);
  comparable.schema = before.projection.schema;
  comparable.bindings = before.projection.bindings;
  comparable.consumers!.dailyNote.qmdBinding = before.projection.consumers!.dailyNote.qmdBinding;
  if (!equal(comparable, before.projection)) throw Error("PROFILE_TOPIC_AUTHORITY_CHANGED");
  const resolver = after.projection.consumers!.dailyNote.qmdBinding;
  if (!resolver || !("resolver" in resolver) || resolver.resolver !== "exact-session-registry") throw Error("PROFILE_TOPIC_AUTHORITY_CHANGED");
  if (!before.quality) {
    if (after.quality) throw Error("PROFILE_TOPIC_AUTHORITY_CHANGED");
    return;
  }
  const added = after.projection.bindings.filter(b => !before.projection.bindings.some(a => equal(a, b)))
    .map(({runtimeSessionKey,scopeClass,scopeId}) => ({workspaceId:after.projection.workspaceId,runtimeSessionKey,scopeClass,scopeId}));
  const expected = [...before.quality.exactScopes, ...added].sort((a,b) => a.runtimeSessionKey.localeCompare(b.runtimeSessionKey));
  if (!after.quality || !equal({...after.quality,exactScopes:before.quality.exactScopes},before.quality)
    || !equal(after.quality.exactScopes, expected)) throw Error("PROFILE_TOPIC_AUTHORITY_CHANGED");
}
function reconstructionOrigins(saved: ExecutionProfiles): Snapshot[] {
  const origins: Snapshot[] = [];
  let previous: Snapshot | undefined;
  if (saved.topicAuthorityHistory && (!saved.topicAuthorityHistory.length || saved.topicAuthorityHistory.length > 20)) throw Error("PROFILE_TOPIC_HISTORY_INVALID");
  for (const revision of saved.topicAuthorityHistory ?? []) {
    const {digest,...body} = revision;
    if (digest !== hash(body) || !/^sha256:[a-f0-9]{64}$/.test(revision.beforeRegistryDigest)
      || !revision.approvedBy?.trim() || !Number.isFinite(Date.parse(revision.approvedAt))) throw Error("PROFILE_TOPIC_HISTORY_INVALID");
    const origin = codeReconstructionOrigin(revision.before,revision.pluginCodeCompatibility);
    if (previous && !equal(origin,previous)) throw Error("PROFILE_TOPIC_HISTORY_INVALID");
    assertTopicProfileAuthority(revision.before,revision.after);
    origins.push(origin,revision.before,revision.after);
    previous = revision.after;
  }
  const currentOrigin = profileReconstructionOrigin(saved);
  if (previous && !equal(previous,currentOrigin)) throw Error("PROFILE_TOPIC_HISTORY_INVALID");
  origins.push(currentOrigin);
  return origins;
}
export function profileAnchors(workspace: string, projection: Projection): ExecutionProfiles["anchors"] {
  const root = join(workspace, "memory-state/memory-observation");
  const optional = (n: string) => existsSync(join(root, n)) ? hash(read(join(root, n))) : null;
  return { projection: hash(projection), quality: optional("quality-rollout.json"), transition: optional("model-transition.json") };
}
export function sealProfiles(body: Omit<ExecutionProfiles, "digest">): ExecutionProfiles { return { ...body, digest: hash(body) }; }
export function legacyProfileSnapshots(workspace: string, projection: Projection): Snapshot[] {
  const root = join(workspace, "memory-state/memory-observation");
  const quality = (v: any): QualityRollout | null => { if (!v) return null; const { digest, ...body } = v; return body; };
  const q = existsSync(join(root, "quality-rollout.json")) ? read(join(root, "quality-rollout.json")) : null;
  const snapshots: Snapshot[] = [{ projection, quality: quality(q) }];
  if (existsSync(join(root, "model-transition.json"))) {
    const transition = read(join(root, "model-transition.json"));
    snapshots.push({ projection: transition.previousProjection, quality: quality(transition.previousQuality) });
  }
  return snapshots;
}

export function modelAuthorityDigest(projection: Projection): Digest {
  const p = structuredClone(projection);
  // Provider identity and the complete admission/consumer authority stay pinned.
  delete (p.inference as Partial<Projection["inference"]>).model;
  if (p.evaluation) delete (p.evaluation as Partial<NonNullable<Projection["evaluation"]>>).policyDigest;
  return hash({ schema: "engram.memory-model-authority.v1", projection: p });
}

/** Compatibility reconstruction only. New profiles always have explicit thinking. */
export function legacyPolicy(snapshot: Snapshot, scope: ObservationScope, policyDigest?: Digest): BatchLivePolicyV1 {
  const p = snapshot.projection, batch = p.evaluation!.batch!;
  const base = p.evaluation!.policyDigest;
  let contextual = qualityScopeEnabled(snapshot.quality, scope) && policyDigest !== base;
  let prompt: ContextualPromptVersion = CONTEXTUAL_PROMPT_VERSION;
  let thinking: "medium" | "high" = p.inference.model === "openai/gpt-6-luna" ? "high" : "medium";
  if (contextual && policyDigest) {
    const match = CONTEXTUAL_PROMPT_VERSIONS.flatMap(v => (["medium", "high"] as const).map(t => ({ v, t })))
      .find(({ v, t }) => contextualEvaluationDigest(base, v, t) === policyDigest);
    if (!match) throw Error("PROFILE_LEGACY_POLICY_DENIED");
    prompt = match.v; thinking = match.t;
  }
  if (policyDigest && policyDigest !== base && !contextual) throw Error("PROFILE_LEGACY_POLICY_DENIED");
  return {
    workspaceId: p.workspaceId, exactScope: scope, producerEpoch: "v1", sourcePolicyDigest: batch.sourcePolicyDigest,
    evaluationPolicyDigest: policyDigest ?? (contextual ? contextualEvaluationDigest(base, prompt, thinking) : base),
    ...(contextual ? { contextual: true, contextualPromptVersion: prompt, contextualThinking: thinking } : {}),
    inactivityGapMs: batch.inactivityGapSeconds * 1000, maxTurns: batch.maxTurns, maxEvidenceBytes: batch.maxEvidenceBytes,
    flushMaxAgeMs: batch.maxAgeSeconds * 1000, evidenceTtlMs: p.limits.evidenceTtlHours * 3600000,
    deferDelayMs: batch.inactivityGapSeconds * 1000, maxInferenceCallsPerRun: 1,
    runner: { schema: "engram.memory-batch-shadow-runner-config.v2", requestedModel: p.inference.model,
      maxTokens: 8192, temperature: 0, messageMode: "single-user",
      // Preserve old v1 request bytes, including the absence of --thinking.
      ...(p.inference.model === "openai/gpt-6-luna" ? { thinking: "high" as const } : {}) },
  };
}

export function createExecutionProfile(snapshot: Snapshot, boundary: ProviderBoundary, model: string,
  thinking: "medium" | "high", contextual: boolean, promptVersion:ContextualPromptVersion=CONTEXTUAL_PROMPT_VERSION): ExecutionProfile {
  const p = snapshot.projection;
  if (!model.startsWith(p.inference.provider + "/") || boundary.provider !== p.inference.provider
    || !/^[a-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(model) || !["medium", "high"].includes(thinking)) throw Error("PROFILE_PROVIDER_CHANGE_REQUIRES_AUTHORITY_ROLLOUT");
  const first = p.bindings[0]!;
  const scope: ObservationScope = { workspaceId: p.workspaceId, runtimeSessionKey: first.runtimeSessionKey, scopeClass: first.scopeClass, scopeId: first.scopeId };
  const { exactScope, ...template } = legacyPolicy(snapshot, scope, p.evaluation!.policyDigest);
  delete template.contextual; delete template.contextualPromptVersion; delete template.contextualThinking;
  if(!CONTEXTUAL_PROMPT_VERSIONS.includes(promptVersion))throw Error("PROFILE_CONTRACT_UNSUPPORTED");
  if (contextual) Object.assign(template, { contextual: true, contextualPromptVersion: promptVersion, contextualThinking: thinking });
  template.runner = { ...template.runner, requestedModel: model, thinking };
  const authorityDigest = hash({projectionAuthority:modelAuthorityDigest(p),provider:boundary.provider,baseUrl:boundary.baseUrl});
  const contractDigest = hash({ schema: "engram.memory-evaluator-contract.v1", contextual,
    promptVersion: contextual ? promptVersion : BATCH_SHADOW_PROMPT_VERSION, output: contextual ? "contextual-v2" : "batch-v1", toolPolicy: "none" });
  const executionDigest = hash({ schema: "engram.memory-model-execution.v1", boundary, model, thinking,
    requestedMaxTokens: template.runner.maxTokens, tokenBudgetEnforcement: "unavailable", temperature: 0 });
  // Model and thinking are deliberately absent. Request/result digests still
  // bind the exact model, thinking and bytes; job/effect identity stays stable.
  template.evaluationPolicyDigest = hash({ schema: "engram.memory-evaluation-contract.v1", authorityDigest, contractDigest });
  const body = { authorityDigest, contractDigest, executionDigest, boundary, template,
    bindings: p.bindings, contextualScopes: contextual ? snapshot.quality?.exactScopes ?? [] : [] };
  return { profileId: hash(body), ...body };
}

function admits(profile: Pick<ExecutionProfile, "bindings" | "contextualScopes" | "template">, scope: ObservationScope): boolean {
  const b = memoryObservationBinding({ enabled:true,mode:"canary",schema:"engram.memory-observation-rollout.v6",bindings: profile.bindings } as Projection, scope.runtimeSessionKey);
  return !!b && b.scopeClass === scope.scopeClass && b.scopeId === scope.scopeId
    && (!profile.template.contextual || profile.contextualScopes.some(s => equal(s, scope)));
}
function assertScope(projection: Projection, scope: ObservationScope): void {
  const b = memoryObservationBinding(projection, scope.runtimeSessionKey);
  if (scope.workspaceId !== projection.workspaceId || !b || b.scopeClass !== scope.scopeClass || b.scopeId !== scope.scopeId) throw Error("PROFILE_SCOPE_REVOKED");
}
export function validateExecutionProfiles(saved: ExecutionProfiles, workspace: string, projection: Projection): ExecutionProfiles {
  return validateProfileState(saved,profileAnchors(workspace,projection),legacyProfileSnapshots(workspace,projection));
}
export function validateProfileState(saved:ExecutionProfiles,anchors:ExecutionProfiles['anchors'],legacy:Snapshot[]):ExecutionProfiles {
  const projection=legacy[0]!.projection;
  const { digest, ...body } = saved;
  if (saved.schema !== "engram.memory-execution-profiles.v1" || digest !== hash(body)
    || saved.workspaceId !== projection.workspaceId || !equal(saved.anchors, anchors)
    || !saved.approvedBy || !Number.isFinite(Date.parse(saved.approvedAt)) || !Array.isArray(saved.revisions)
    || saved.revisions.length < 1 || saved.revisions.length > 128 || !Array.isArray(saved.legacy) || saved.legacy.length < 1 || saved.legacy.length > 2
    || new Set(saved.revisions.map(r => r.profile.profileId)).size !== saved.revisions.length
    || !equal(saved.legacy, legacy)) throw Error("PROFILE_REGISTRY_IDENTITY_CHANGED");
  const origins=reconstructionOrigins(saved);
  if(saved.approvedProviderBoundary.provider!==projection.inference.provider || saved.legacy.some(s=>{
    const b=saved.legacyBoundaries[s.projection.inference.model];
    return !b || !equal({provider:b.provider,baseUrl:b.baseUrl},saved.approvedProviderBoundary);
  })) throw Error("PROFILE_PROVIDER_BOUNDARY_CHANGED");
  for (const r of saved.revisions) {
    const p = r.profile;
    if(!equal({provider:p.boundary.provider,baseUrl:p.boundary.baseUrl},saved.approvedProviderBoundary)) throw Error("PROFILE_PROVIDER_BOUNDARY_CHANGED");
    if(!saved.approvedBoundaries.some(b=>equal(b,p.boundary)))throw Error("PROFILE_PROVIDER_BOUNDARY_CHANGED");
    if (!["active", "drain", "retired"].includes(r.lifecycle)) throw Error("PROFILE_LIFECYCLE_INVALID");
    if (!origins.some(origin => equal(createExecutionProfile(origin, p.boundary, p.template.runner.requestedModel,
      p.template.runner.thinking as "medium" | "high", !!p.template.contextual,p.template.contextualPromptVersion),p))) throw Error("PROFILE_REVISION_CHANGED");
  }
  for (const id of [saved.defaults.base, saved.defaults.contextual].filter(Boolean)) {
    if (!saved.revisions.some(r => r.profile.profileId === id && r.lifecycle === "active")) throw Error("PROFILE_DEFAULT_NOT_EXECUTABLE");
  }
  if(saved.revisions.find(r=>r.profile.profileId===saved.defaults.base)?.profile.template.contextual
    || (saved.defaults.contextual && !saved.revisions.find(r=>r.profile.profileId===saved.defaults.contextual)?.profile.template.contextual))throw Error("PROFILE_DEFAULT_CONTRACT_CHANGED");
  return saved;
}
/** Authority rollout, not a model switch: immutable old revisions stay readable;
 * only future defaults receive the additive scope set. */
export function rebindExecutionProfilesForTopics(o:{before:ExecutionProfiles;beforeAnchors:ExecutionProfiles['anchors'];beforeLegacy:Snapshot[];
  afterAnchors:ExecutionProfiles['anchors'];afterLegacy:Snapshot[];approvedBy:string;approvedAt:string}):ExecutionProfiles {
  validateProfileState(o.before,o.beforeAnchors,o.beforeLegacy);
  assertTopicProfileAuthority(o.beforeLegacy[0]!,o.afterLegacy[0]!);
  if (!equal(o.beforeLegacy.slice(1),o.afterLegacy.slice(1)) || !o.approvedBy?.trim() || !Number.isFinite(Date.parse(o.approvedAt))) throw Error("PROFILE_TOPIC_AUTHORITY_CHANGED");
  const revisionBody = {before:o.beforeLegacy[0]!,after:o.afterLegacy[0]!,beforeRegistryDigest:o.before.digest,
    approvedBy:o.approvedBy,approvedAt:o.approvedAt,
    ...(o.before.pluginCodeCompatibility ? {pluginCodeCompatibility:o.before.pluginCodeCompatibility} : {})};
  const {digest,pluginCodeCompatibility,...before} = o.before;
  const revisions = structuredClone(before.revisions);
  const defaults = {...before.defaults};
  for (const kind of ["base","contextual"] as const) {
    const id = defaults[kind];
    if (!id) continue;
    const old = revisions.find(r => r.profile.profileId === id)!.profile;
    const thinking = old.template.runner.thinking;
    if (thinking !== "medium" && thinking !== "high") throw Error("PROFILE_TOPIC_EXECUTION_CHANGED");
    const profile = createExecutionProfile(o.afterLegacy[0]!,old.boundary,old.template.runner.requestedModel,
      thinking,!!old.template.contextual,old.template.contextualPromptVersion);
    if (profile.contractDigest !== old.contractDigest || profile.executionDigest !== old.executionDigest) throw Error("PROFILE_TOPIC_EXECUTION_CHANGED");
    revisions.push({profile,lifecycle:"active"}); defaults[kind] = profile.profileId;
  }
  const after = sealProfiles({...before,anchors:o.afterAnchors,legacy:o.afterLegacy,revisions,defaults,
    topicAuthorityHistory:[...(before.topicAuthorityHistory ?? []),{...revisionBody,digest:hash(revisionBody)}],approvedBy:o.approvedBy,approvedAt:o.approvedAt});
  return validateProfileState(after,o.afterAnchors,o.afterLegacy);
}
/** Only the canonical code-only release planner calls this pure staged-state
 * operation. Its CAS journal publishes profiles together with all pinned files. */
export function rebindExecutionProfilesForPlugin(o:{before:ExecutionProfiles;beforeAnchors:ExecutionProfiles['anchors'];beforeLegacy:Snapshot[];
  afterAnchors:ExecutionProfiles['anchors'];afterLegacy:Snapshot[];releaseAttestationDigest:Digest;approvedBy:string;approvedAt:string}):ExecutionProfiles {
  validateProfileState(o.before,o.beforeAnchors,o.beforeLegacy);
  const from=o.beforeLegacy[0]!,to=o.afterLegacy[0]!;
  if(from.projection.pluginDigest===to.projection.pluginDigest || !equal({...from.projection,pluginDigest:to.projection.pluginDigest},to.projection)
    || !equal(from.quality?{...from.quality,pluginDigest:to.projection.pluginDigest}:null,to.quality)
    || !equal(o.beforeLegacy.slice(1),o.afterLegacy.slice(1)) || !o.approvedBy?.trim() || !Number.isFinite(Date.parse(o.approvedAt))
    || !/^sha256:[a-f0-9]{64}$/.test(o.releaseAttestationDigest))throw Error("PROFILE_CODE_COMPATIBILITY_AUTHORITY_CHANGED");
  const releaseBody={from:from.projection.pluginDigest,to:to.projection.pluginDigest,beforeRegistryDigest:o.before.digest,
    releaseAttestationDigest:o.releaseAttestationDigest,approvedBy:o.approvedBy,approvedAt:o.approvedAt};
  const compatibilityBody={schema:"engram.memory-profile-plugin-compatibility.v1" as const,origin:profileReconstructionOrigin(o.before),
    releases:[...(o.before.pluginCodeCompatibility?.releases??[]),{...releaseBody,digest:hash(releaseBody)}]};
  const {digest,...before}=o.before;
  const after=sealProfiles({...before,anchors:o.afterAnchors,legacy:o.afterLegacy,
    pluginCodeCompatibility:{...compatibilityBody,digest:hash(compatibilityBody)}});
  return validateProfileState(after,o.afterAnchors,o.afterLegacy);
}
export function readExecutionProfiles(workspace: string, projection: Projection): ExecutionProfiles | null {
  if (!existsSync(profileStatePath(workspace))) return null;
  return validateExecutionProfiles(read(profileStatePath(workspace)), workspace, projection);
}
export function defaultProfilePolicy(registry: ExecutionProfiles, projection: Projection, scope: ObservationScope): BatchLivePolicyV1 {
  assertScope(projection, scope);
  const contextual = registry.legacy[0]!.quality?.mode === "active" && qualityScopeEnabled(registry.legacy[0]!.quality, scope);
  const id = contextual ? registry.defaults.contextual : registry.defaults.base;
  const entry = registry.revisions.find(r => r.profile.profileId === id);
  if (!entry || entry.lifecycle !== "active" || !admits(entry.profile, scope)) throw Error("PROFILE_DEFAULT_DENIED");
  const p = entry.profile;
  return { ...p.template, exactScope: scope, profileRefs: { profileId: p.profileId, authorityDigest: p.authorityDigest, contractDigest: p.contractDigest, executionDigest: p.executionDigest } };
}
export function jobProfilePolicy(registry: ExecutionProfiles, projection: Projection, job: BatchLiveJobV1, historicalProof=false): BatchLivePolicyV1 {
  const { producerEpoch, policyDigest, ...scope } = job.partition;
  assertScope(projection, scope);
  if (producerEpoch !== "v1") throw Error("PROFILE_JOB_EPOCH_DENIED");
  if (job.profileRefs) {
    const entry = registry.revisions.find(r => r.profile.profileId === job.profileRefs!.profileId);
    if (!entry || (!historicalProof && entry.lifecycle === "retired") || !admits(entry.profile, scope)) throw Error("PROFILE_JOB_DENIED");
    const p = entry.profile;
    const refs = { profileId: p.profileId, authorityDigest: p.authorityDigest, contractDigest: p.contractDigest, executionDigest: p.executionDigest };
    if (!equal(job.profileRefs, refs) || job.evaluationPolicyDigest !== p.template.evaluationPolicyDigest || policyDigest !== p.template.sourcePolicyDigest) throw Error("PROFILE_JOB_REVISION_CHANGED");
    return { ...p.template, exactScope: scope, profileRefs: refs };
  }
  for (const old of registry.legacy) {
    const b = memoryObservationBinding(old.projection, scope.runtimeSessionKey);
    if (!b || b.scopeClass !== scope.scopeClass || b.scopeId !== scope.scopeId || policyDigest !== old.projection.evaluation!.batch!.sourcePolicyDigest) continue;
    try { return legacyPolicy(old, scope, job.evaluationPolicyDigest); } catch { /* Exact historical digest only. */ }
  }
  throw Error("PROFILE_LEGACY_JOB_DENIED");
}
export function batchJobHasSavedResult(workspace:string,job:BatchLiveJobV1,policy:BatchLivePolicyV1):boolean {
  const root=join(workspace,"memory-state/memory-observation/batch-live-store");
  if(policy.contextual)return existsSync(join(root,"memory-batch-live/v1/contextual-results",job.jobId.slice(7)+".json"));
  const request=batchShadowPrompt(job.bundle,policy.runner,new Date(job.createdAt));
  return existsSync(join(root,"memory-batch-shadow/v1/results",request.resultKey.slice(7)+".json"));
}
export function profileReadablePolicies(registry: ExecutionProfiles | null, projection: Projection, scope: ObservationScope, historical = false): Digest[] {
  if (!registry) return [];
  assertScope(projection, scope);
  return [...new Set(registry.revisions.filter(r => (historical || r.lifecycle !== "retired") && admits(r.profile, scope)).map(r => r.profile.template.evaluationPolicyDigest))];
}

/** Only non-secret endpoint/protocol/runtime identity is retained. Never retain
 * headers, keys or the rest of the effective provider configuration. */
export function configuredProviderBoundary(model: string): ProviderBoundary {
  const provider = model.split("/")[0]!;
  if (!/^[a-z0-9._-]+$/.test(provider)) throw Error("PROFILE_PROVIDER_INVALID");
  const result = spawnSync("openclaw", ["config", "get", `models.providers.${provider}`, "--json"], { encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw Error("PROFILE_PROVIDER_READBACK_FAILED");
  let config: any;
  try { config = JSON.parse(result.stdout); } catch { throw Error("PROFILE_PROVIDER_READBACK_FAILED"); }
  const entry = config.models?.find((m: any) => m.id === model.slice(provider.length + 1));
  const baseUrl = config.baseUrl ?? "host-default";
  if (typeof baseUrl !== "string" || baseUrl.length > 2048 || (baseUrl && baseUrl !== "host-default" && (() => {
    try { const url = new URL(baseUrl); return !["https:", "http:"].includes(url.protocol) || !!url.username || !!url.password || !!url.search || !!url.hash; } catch { return true; }
  })())) throw Error("PROFILE_PROVIDER_BOUNDARY_INVALID");
  return { provider, baseUrl, api: entry?.api ?? config.api ?? "host-default", runtime: entry?.agentRuntime?.id ?? "host-default" };
}
export function authorizeProfileOperation(registry: ExecutionProfiles, projection: Projection, policy: BatchLivePolicyV1,
  operation: "execute" | "consume", boundary?: ProviderBoundary): void {
  assertScope(projection, policy.exactScope);
  if (!policy.profileRefs) {
    const expected=registry.legacyBoundaries[policy.runner.requestedModel];
    if(!expected || (boundary && !equal(boundary,expected))) throw Error("PROFILE_PROVIDER_BOUNDARY_CHANGED");
    return; // Caller additionally validates the exact legacy reconstruction.
  }
  const entry = registry.revisions.find(r => r.profile.profileId === policy.profileRefs!.profileId);
  const refs=entry?{profileId:entry.profile.profileId,authorityDigest:entry.profile.authorityDigest,contractDigest:entry.profile.contractDigest,executionDigest:entry.profile.executionDigest}:null;
  if (!entry || entry.lifecycle === "retired" || (operation === "execute" && entry.lifecycle !== "active")
    || !equal(refs,policy.profileRefs)
    || !admits(entry.profile, policy.exactScope) || !equal({ ...entry.profile.template, exactScope: policy.exactScope, profileRefs: policy.profileRefs }, policy)) throw Error("PROFILE_OPERATION_REVOKED");
  if (boundary && !equal(boundary, entry.profile.boundary)) throw Error("PROFILE_PROVIDER_BOUNDARY_CHANGED");
}
