import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { BATCH_EVALUATOR_AUTHORITY } from "../memory-observation/batch-observation.ts";
import { CONTEXTUAL_EVALUATOR_AUTHORITY } from "../memory-observation/contextual-batch-observation.ts";
import { DAILY_NOTE_APPLICATOR } from "../memory-observation/daily-note-applicator.ts";
import { memoryObservationBinding, memoryObservationCaptureOwner, resolveMemoryObservationProjection } from "../memory-observation/projection.ts";
import { compileMemoryCandidateReportV2, verifyObserverReceiptAdmission } from "./memory-candidate-compiler-v2.ts";
import { canonicalizeJcs, sha256Digest } from "./handoff-v2.ts";
import { observerBridgeRuntimeKey } from "./observer-receipt-watchdog.ts";
import { observerBridgeLiveAuthorities } from "./observer-receipt-authorities.ts";
import {
  observerReceiptProducerRegistryDigestV1, validateObserverReceiptProducerRegistryV1,
  type ObserverReceiptProducerRegistryV1, type ObserverReceiptScopeV1, type ObserverReceiptProducerRefV1,
} from "./observer-receipt-bridge-v1.ts";

const supported = [
  { producer: BATCH_EVALUATOR_AUTHORITY, schema: "engram.memory-batch-observation.v1" as const },
  { producer: CONTEXTUAL_EVALUATOR_AUTHORITY, schema: "engram.memory-batch-observation.v2" as const },
];
const same = (a: unknown, b: unknown) => canonicalizeJcs(a) === canonicalizeJcs(b);
const fingerprint = (path: string) => sha256Digest(readFileSync(path, "utf8"));
export type OllObserverBridgePlan = {
  schema: "oll.observer-bridge-plan.v1"; workspace: string; workspaceId: string; createdAt: string;
  configDigest: string; projectionDigest: string; previousRegistryDigest: string | null;
  sidecarDigests: { quality: string | null; transition: string | null };
  registry: ObserverReceiptProducerRegistryV1;
  evidence: { compilerBefore: Record<string, unknown>; compilerAfter: Record<string, unknown>; verifiedHistoricalReceiptPolicies: number; sourceScopes: number };
  planDigest: string;
};
export const observerBridgePlanDigest = (plan: Omit<OllObserverBridgePlan, "planDigest"> | OllObserverBridgePlan) => {
  const { planDigest: _ignored, ...body } = plan as OllObserverBridgePlan; return sha256Digest(canonicalizeJcs(body));
};
const metrics = (r: ReturnType<typeof compileMemoryCandidateReportV2>) => ({
  considered: r.considered, eligible: r.eligible, selected: r.selected, rejected: r.rejected,
  sourceCounts: r.sourceCounts, rejectionCounts: r.rejectionCounts, projectedModelSpawns: r.projectedModelSpawns,
});
function sidecarDigests(workspace: string) {
  const digest = (name: string) => {
    const p = join(workspace, "memory-state/memory-observation", name); return existsSync(p) ? fingerprint(p) : null;
  };
  return { quality: digest("quality-rollout.json"), transition: digest("model-transition.json") };
}

/** Explicit operator plan, never auto-called by a Worker/cron. Existing source/scope policy is unchanged. */
export function planOllObserverBridge(workspaceInput: string, now = new Date()): OllObserverBridgePlan | null {
  const workspace = realpathSync(resolve(workspaceInput)), configPath = join(workspace, "engram.json");
  const projectionPath = join(workspace, "memory-state/memory-observation/projection.json");
  const configDigest = fingerprint(configPath), config = JSON.parse(readFileSync(configPath, "utf8")), oll = config.oll;
  if (oll?.enabled === false || oll?.nightly?.enabled !== true || !["shadow", "materialize"].includes(oll?.candidateCompiler?.mode)) return null;
  const workspaceId = config.workspace?.id, policy = oll.candidateCompiler, mode = policy.mode;
  const projectionDigest = fingerprint(projectionPath), projection = resolveMemoryObservationProjection({ workspace, workspaceId });
  const sidecars = sidecarDigests(workspace);
  if (projection.mode !== "canary" || projection.evaluation?.mode !== "batch-cron") throw Error("bridge provisioning requires an active batch Worker projection");
  const scopes: ObserverReceiptScopeV1[] = [];
  for (const source of policy.daily) {
    if (!source.sections.includes("decisions")) continue;
    const key = observerBridgeRuntimeKey(workspaceId, source.session), binding = key && memoryObservationBinding(projection, key);
    if (!binding || memoryObservationCaptureOwner(projection, key!, now) !== "observer") continue;
    scopes.push({ workspaceId, runtimeSessionKey: key!, scopeClass: binding.scopeClass, scopeId: binding.scopeId });
  }
  if (!scopes.length) return null;
  const previous = oll.observerReceiptProducerRegistry
    ? validateObserverReceiptProducerRegistryV1(oll.observerReceiptProducerRegistry) : undefined;
  if (previous && previous.workspaceId !== workspaceId) throw Error("foreign observer receipt registry");
  const registry: ObserverReceiptProducerRegistryV1 = previous ? structuredClone(previous) : {
    schema: "oll.memory-observer-receipt-producer-registry.v1", workspaceId, registryVersion: 1,
    canonicalApplicator: DAILY_NOTE_APPLICATOR, entries: [], digest: "sha256:" + "0".repeat(64) as any,
  };
  registry.canonicalApplicator = DAILY_NOTE_APPLICATOR;
  const grant = (producer: ObserverReceiptProducerRefV1, scope: ObserverReceiptScopeV1, policyDigest: any) => {
    const known = supported.find(p => same(p.producer, producer));
    if (!known || !/^sha256:[a-f0-9]{64}$/.test(policyDigest) || !scopes.some(s => same(s, scope))) throw Error("untrusted or out-of-policy receipt grant");
    let entry = registry.entries.find(e => same(e.producer, producer));
    if (!entry) {
      entry = { producer, observationSchemas: [known.schema], allowedObservationClasses: ["episodic.decision"], allowedScopeClasses: [], exactScopeAllowlist: [],
        requiredReceiptSchema: "engram.memory-apply-receipt.v1", requireCanonicalReadBack: true, allowedEvaluationPolicyDigests: [], rolloutState: mode };
      registry.entries.push(entry);
    }
    if (!entry.observationSchemas.includes(known.schema)) entry.observationSchemas.push(known.schema);
    if (!entry.allowedObservationClasses.includes("episodic.decision")) entry.allowedObservationClasses.push("episodic.decision");
    if (!entry.allowedScopeClasses.includes(scope.scopeClass)) entry.allowedScopeClasses.push(scope.scopeClass);
    if (!entry.exactScopeAllowlist.some(s => same(s, scope))) entry.exactScopeAllowlist.push(scope);
    if (!entry.allowedEvaluationPolicyDigests.includes(policyDigest)) entry.allowedEvaluationPolicyDigests.push(policyDigest);
    entry.rolloutState = mode;
  };
  // Use actual readable base/contextual/transition policies; do not infer v2
  // authority solely from the projection's v1-compatible base policy digest.
  for (const scope of scopes) for (const authority of observerBridgeLiveAuthorities(workspace, projection, scope))
    grant(authority.producer, scope, authority.policyDigest);
  const baseRegistry = structuredClone(registry);
  const receiptRoot = join(workspace, "memory-state/memory-observation/v1/receipts/by-entry");
  const receipts = new Map<string, any>();
  if (existsSync(receiptRoot)) for (const name of readdirSync(receiptRoot).sort()) {
    if (!name.endsWith(".json")) continue;
    const file = realpathSync(join(receiptRoot, name)), rel = relative(workspace, file);
    if (rel === ".." || rel.startsWith(`..${sep}`)) throw Error("receipt outside workspace");
    const r = JSON.parse(readFileSync(file, "utf8")), p = r.sourceProvenance;
    if (r.schema !== "engram.memory-apply-receipt.v1" || r.status !== "applied" || r.canonicalMutation !== true
      || p?.observationClass !== "episodic.decision" || !Array.isArray(p.batchSourceRefs)
      || !supported.some(s => same(s.producer, p.producer)) || !scopes.some(s => same(s, r.scope))) continue;
    if (typeof p.batchEvaluationPolicyDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(p.batchEvaluationPolicyDigest)) continue;
    receipts.set(r.destinationEntryId, r);
    // Provisional in-memory authority only. Never persisted before compiler
    // validation of receipt identity/provenance and canonical note read-back.
    grant(p.producer, r.scope, p.batchEvaluationPolicyDigest);
  }
  const compile = (candidateRegistry: ObserverReceiptProducerRegistryV1 | undefined) => compileMemoryCandidateReportV2({
    workspace, workspaceId, policy, scopeRegistry: oll.candidateScopeRegistry, observerReceiptProducerRegistry: candidateRegistry,
    snapshotAt: now.toISOString(), batchId: `observer-bridge-plan:${now.toISOString()}`, executionMode: "report-only",
  });
  registry.digest = observerReceiptProducerRegistryDigestV1(registry); validateObserverReceiptProducerRegistryV1(registry);
  const compilerBefore = compile(previous);
  const verified = [...receipts.values()].filter(receipt => verifyObserverReceiptAdmission({
    workspace, workspaceId, observerReceiptProducerRegistry: registry, executionMode: "report-only",
  }, String(receipt.destinationRef).split("#", 1)[0]!, "decisions", receipt.destinationEntryId).status === "admitted");
  registry.entries = baseRegistry.entries;
  let verifiedHistoricalReceiptPolicies = 0;
  for (const receipt of verified) {
    grant(receipt.sourceProvenance.producer, receipt.scope, receipt.sourceProvenance.batchEvaluationPolicyDigest);
    verifiedHistoricalReceiptPolicies++;
  }
  for (const e of registry.entries) {
    e.allowedEvaluationPolicyDigests.sort(); e.allowedScopeClasses.sort();
    e.exactScopeAllowlist.sort((a, b) => a.runtimeSessionKey.localeCompare(b.runtimeSessionKey));
  }
  registry.entries.sort((a, b) => `${a.producer.id}:${a.producer.version}`.localeCompare(`${b.producer.id}:${b.producer.version}`));
  if (previous && !same({ ...registry, registryVersion: previous.registryVersion, digest: previous.digest }, previous)) registry.registryVersion = previous.registryVersion + 1;
  registry.digest = observerReceiptProducerRegistryDigestV1(registry); validateObserverReceiptProducerRegistryV1(registry);
  const compilerAfter = compile(registry);
  if ((compilerAfter.rejectionCounts.unsupported_source ?? 0) > 0) throw Error("unsupported observer sources remain after provisional bridge repair");
  if (fingerprint(configPath) !== configDigest || fingerprint(projectionPath) !== projectionDigest || !same(sidecarDigests(workspace), sidecars)) throw Error("bridge inputs changed while planning");
  const body: Omit<OllObserverBridgePlan, "planDigest"> = { schema: "oll.observer-bridge-plan.v1", workspace, workspaceId, createdAt: now.toISOString(), configDigest, projectionDigest,
    previousRegistryDigest: previous?.digest ?? null, sidecarDigests: sidecars, registry,
    evidence: { compilerBefore: metrics(compilerBefore), compilerAfter: metrics(compilerAfter), verifiedHistoricalReceiptPolicies, sourceScopes: scopes.length } };
  return { ...body, planDigest: observerBridgePlanDigest(body) };
}

/** Apply only the reviewed registry under exact config+Worker CAS; no other config field changes. */
export function applyOllObserverBridgePlan(plan: OllObserverBridgePlan): { status: "applied" | "unchanged"; workspaceId: string; registryDigest: string } {
  if (plan.schema !== "oll.observer-bridge-plan.v1" || plan.planDigest !== observerBridgePlanDigest(plan)) throw Error("bridge plan digest mismatch");
  const workspace = realpathSync(plan.workspace), configPath = join(workspace, "engram.json"), projectionPath = join(workspace, "memory-state/memory-observation/projection.json");
  const registry = validateObserverReceiptProducerRegistryV1(plan.registry);
  if (workspace !== plan.workspace || registry.workspaceId !== plan.workspaceId) throw Error("bridge plan workspace mismatch");
  const inputsMatch = () => fingerprint(configPath) === plan.configDigest && fingerprint(projectionPath) === plan.projectionDigest && same(sidecarDigests(workspace), plan.sidecarDigests);
  if (!inputsMatch()) throw Error("bridge plan CAS failed; re-plan required");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (config.workspace?.id !== plan.workspaceId || config.oll?.nightly?.enabled !== true || !["shadow", "materialize"].includes(config.oll?.candidateCompiler?.mode)) throw Error("bridge activation changed since plan");
  if (same(config.oll.observerReceiptProducerRegistry ?? null, registry)) return { status: "unchanged", workspaceId: plan.workspaceId, registryDigest: registry.digest };
  config.oll.observerReceiptProducerRegistry = registry;
  const temp = configPath + `.bridge-${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: statSync(configPath).mode & 0o777 });
    if (!inputsMatch()) throw Error("bridge apply CAS failed");
    renameSync(temp, configPath);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
  const checked = JSON.parse(readFileSync(configPath, "utf8"));
  if (!same(checked, config)) throw Error("bridge configuration read-back failed");
  validateObserverReceiptProducerRegistryV1(checked.oll.observerReceiptProducerRegistry);
  return { status: "applied", workspaceId: plan.workspaceId, registryDigest: registry.digest };
}
