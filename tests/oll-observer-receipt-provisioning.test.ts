import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { planOllObserverBridge, applyOllObserverBridgePlan, observerBridgePlanDigest } from "../src/oll/observer-receipt-provisioning.ts";
import { auditOllObserverBridge } from "../src/oll/observer-receipt-watchdog.ts";
import { candidateScopeRegistryDigestV1, MEMORY_CANDIDATE_RANKING_POLICY_V1_SCHEMA } from "../src/oll/memory-candidate-contracts-v2.ts";
import { digestFileTree } from "../src/oll/memory-candidate-compiler-v2.ts";
import { sha256Digest } from "../src/oll/handoff-v2.ts";
import { sha256, type JsonValue } from "../src/memory-observation/ledger.ts";
import { observerReceiptProducerRegistryDigestV1, validateObserverReceiptProducerRegistryV1 } from "../src/oll/observer-receipt-bridge-v1.ts";
const roots: string[] = [], now = new Date("2026-10-21T12:00:00Z");
afterEach(() => roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "oll-bridge-provisioning-")); roots.push(root);
  const put = (p: string, data: any) => { const f = join(root, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(data)); };
  const scope = { workspaceId: "main", runtimeSessionKey: "agent:main:telegram:direct:123", scopeClass: "self", scopeId: "telegram:123" };
  const registry: any = { schema: "oll.memory-candidate-scope-registry.v1", workspaceId: "main", revision: 1, selfToDomain: { "telegram:123": "main-direct" }, domainToWorkspace: { "main-direct": "main" }, sourceAuthorities: { daily: { "telegram-direct-123": { level: "self", subject: "telegram:123" } }, domains: {}, kgScopes: {} } };
  registry.digest = candidateScopeRegistryDigestV1(registry);
  const policy: any = { schema: "oll.memory-candidate-policy.v2", mode: "materialize", forwardOnlySince: "2026-08-14T00:00:00Z", workspaceTimezone: "UTC", legacyTimestampParser: { version: "legacy-local-v1", daylightSavingAmbiguity: "reject" },
    daily: [{ session: "telegram-direct-123", sections: ["decisions", "learnings"], scopeCeiling: { level: "self", subject: "telegram:123" } }], domains: [], kg: [],
    limits: { maxCandidatesPerRun: 20, maxContextBytes: 32768, maxOccurrencesPerCluster: 8, sourceQuotas: { "daily-decision": 10, "daily-learning": 10, "retrieval-card": 0, "domain-decision": 0, "domain-proposal": 0, "kg-assertion": 0 } },
    decayPolicy: { schema: "oll.memory-candidate-decay-policy.v1", hotDays: 7, warmDays: 30, accessCountCap: 10, warmScorePenalty: 12, coldKgContribution: "provenance-only", trustedAccessEventSchema: "engram.kg-v3-access-event.v1" },
    rankingPolicy: { schema: MEMORY_CANDIDATE_RANKING_POLICY_V1_SCHEMA, eligibilityThreshold: 55, baseScores: { decision: 70, learning: 55, preference: 78, constraint: 74, proposal: 68 }, recencyBoostMax: 10, recencyBoostPerDay: 2, distinctRootBoostPerRoot: 3, distinctRootBoostMax: 12 }, sensitiveTextPolicyVersion: "privacy-v1" };
  const config: any = { workspace: { id: "main" }, untouched: { purpose: "must remain identical" }, oll: { enabled: true, nightly: { enabled: true }, adaptation: { mode: "active" }, candidateCompiler: policy, candidateScopeRegistry: registry } };
  const projection: any = { schema: "engram.memory-observation-rollout.v2", workspaceId: "main", enabled: true, mode: "canary", bindings: [{ ...scope, workspaceId: undefined, requireOwner: true, allowedChannels: ["telegram"] }],
    pluginDigest: sha256Digest("plugin"), inference: { provider: "openai", model: "openai/test", evaluateAfter: "2026-08-27T00:00:00Z" },
    evaluation: { mode: "batch-cron", policyDigest: sha256Digest("evaluation"), batch: { sourcePolicyDigest: sha256Digest("source"), inactivityGapSeconds: 60, maxTurns: 20, maxEvidenceBytes: 32768, maxAgeSeconds: 3600, maxInferenceCallsPerRun: 1, schedulerId: "worker" } },
    limits: { evidenceTtlHours: 72, maxJobs: 1000, maxBytes: 10000, maxQueueAgeHours: 168, maxAttempts: 2, claimTtlSeconds: 300, maxInferenceCalls: 1 },
    consumers: { dailyNote: { mode: "canary", applyAfter: "2026-08-27T00:00:00Z", timezone: "UTC", allowedObservationClasses: ["episodic.event", "episodic.decision"], maxAppliesPerWake: 1 } }, captureOwnership: { owner: "observer", effectiveAfter: "2026-08-27T00:00:00Z", foregroundDailyNoteCapture: "disabled" }, approvedBy: "operator", approvedAt: "2026-08-27T00:00:00Z" };
  put("engram.json", config); put("memory-state/memory-observation/projection.json", projection);
  const quality = { schema: "engram.memory-quality-rollout.v1", mode: "active", workspaceId: "main", pluginDigest: projection.pluginDigest,
    baseEvaluationPolicyDigest: projection.evaluation.policyDigest, sourcePolicyDigest: projection.evaluation.batch.sourcePolicyDigest,
    applyAfter: projection.consumers.dailyNote.applyAfter, exactScopes: [scope], preparedAt: "2026-10-20T00:00:00Z", inventoryDigest: sha256Digest("inventory") };
  put("memory-state/memory-observation/quality-rollout.json", { ...quality, digest: sha256(quality as JsonValue) });
  return { root, put, config, projection, plan: () => planOllObserverBridge(root, now)! };
}
test("plan is read-only, provisions pinned v1/v2 exact sources, and apply changes only the registry", () => {
  const f = fixture(), before = digestFileTree(f.root), plan = f.plan();
  expect(digestFileTree(f.root)).toBe(before);
  expect(plan.registry.entries.map(e => e.producer.version)).toEqual(["v1", "v2"]);
  expect(plan.registry.entries[1]?.observationSchemas).toEqual(["engram.memory-batch-observation.v2"]);
  expect(plan.registry.entries.every(e => e.exactScopeAllowlist.length === 1 && !e.exactScopeAllowlist[0]!.runtimeSessionKey.includes("*"))).toBe(true);
  expect(applyOllObserverBridgePlan(plan).status).toBe("applied");
  const after = JSON.parse(readFileSync(join(f.root, "engram.json"), "utf8")); delete after.oll.observerReceiptProducerRegistry;
  expect(after).toEqual(f.config);
  expect(auditOllObserverBridge(f.root, { now }).filter(f => f.level === "error")).toEqual([]);
  const again = f.plan(); expect(again.registry.digest).toBe(plan.registry.digest);
  expect(applyOllObserverBridgePlan(again).status).toBe("unchanged");
});
test("disabled OLL is never activated or provisioned", () => {
  const f = fixture(); f.config.oll.nightly.enabled = false; f.put("engram.json", f.config);
  expect(f.plan()).toBeNull();
});
test("plan/config/Worker changes fail CAS without writing a registry", () => {
  const f = fixture(), plan = f.plan();
  const corrupt = structuredClone(plan); corrupt.registry.registryVersion++; expect(() => applyOllObserverBridgePlan(corrupt)).toThrow("plan digest");
  f.config.untouched.changed = true; f.put("engram.json", f.config);
  expect(() => applyOllObserverBridgePlan(plan)).toThrow("CAS");
  expect(JSON.parse(readFileSync(join(f.root, "engram.json"), "utf8")).oll.observerReceiptProducerRegistry).toBeUndefined();
  f.put("engram.json", { ...f.config, untouched: { purpose: "must remain identical" } });
  const next = f.plan(); f.projection.evaluation.policyDigest = sha256Digest("changed"); f.put("memory-state/memory-observation/projection.json", f.projection);
  expect(() => applyOllObserverBridgePlan(next)).toThrow("CAS");
});
test("unverified historical metadata never grants an evaluation policy", () => {
  const f = fixture(), template = f.plan().registry.entries[1]!;
  f.put("memory-state/memory-observation/v1/receipts/by-entry/fake.json", {
    schema: "engram.memory-apply-receipt.v1", status: "applied", canonicalMutation: true, scope: template.exactScopeAllowlist[0],
    destinationEntryId: sha256Digest("fake"), destinationRef: "memory/agent-main/telegram-direct-123/2026-10-20.md#fake",
    sourceProvenance: { observationClass: "episodic.decision", producer: template.producer, batchSourceRefs: [], batchEvaluationPolicyDigest: sha256Digest("unverified") },
  });
  const plan = f.plan(); expect(plan.evidence.verifiedHistoricalReceiptPolicies).toBe(0);
  expect(plan.registry.entries.every(e => !e.allowedEvaluationPolicyDigests.includes(sha256Digest("unverified")))).toBe(true);
  expect(plan.planDigest).toBe(observerBridgePlanDigest(plan));
});
test("contextual policy/producer drift is detected before its first receipt", () => {
  const f = fixture(), plan = f.plan(); applyOllObserverBridgePlan(plan);
  const c = JSON.parse(readFileSync(join(f.root, "engram.json"), "utf8"));
  c.oll.observerReceiptProducerRegistry.entries = c.oll.observerReceiptProducerRegistry.entries.filter((e: any) => e.producer.version === "v1");
  c.oll.observerReceiptProducerRegistry.digest = observerReceiptProducerRegistryDigestV1(c.oll.observerReceiptProducerRegistry);
  f.put("engram.json", c);
  expect(auditOllObserverBridge(f.root, { now }).some(f => f.code === "WD-OLL-018")).toBe(true);
});
test("quality sidecar changes invalidate a reviewed plan", () => {
  const f = fixture(), plan = f.plan();
  const p = "memory-state/memory-observation/quality-rollout.json", q = JSON.parse(readFileSync(join(f.root, p), "utf8"));
  q.mode = "drain"; f.put(p, q);
  expect(() => applyOllObserverBridgePlan(plan)).toThrow("CAS");
});
test("a v2 producer cannot be mislabeled as a v1 source schema", () => {
  const f = fixture(), registry = f.plan().registry;
  registry.entries.find(e => e.producer.version === "v2")!.observationSchemas = ["engram.memory-batch-observation.v1"];
  registry.digest = observerReceiptProducerRegistryDigestV1(registry);
  expect(() => validateObserverReceiptProducerRegistryV1(registry)).toThrow("producer/schema mismatch");
});
