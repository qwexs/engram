import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256 } from "../memory-observation/ledger.ts";
import { DAILY_NOTE_APPLICATOR } from "../memory-observation/daily-note-applicator.ts";
import { BATCH_EVALUATOR_AUTHORITY } from "../memory-observation/batch-observation.ts";
import { observerReceiptProducerRegistryDigestV1 } from "./observer-receipt-bridge-v1.ts";
import { auditOllObserverBridge } from "./observer-receipt-watchdog.ts";

const roots: string[] = [], now = new Date("2026-10-21T12:00:00Z");
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "oll-bridge-watchdog-")); roots.push(root);
  const scope = { workspaceId: "main", runtimeSessionKey: "agent:main:telegram:direct:123", scopeClass: "self", scopeId: "telegram:123" };
  const policy = sha256("policy");
  const put = (p: string, d: any) => { const f = join(root, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(d)); };
  const config: any = { workspace: { id: "main" }, oll: { enabled: true, nightly: { enabled: true }, candidateCompiler: {
    mode: "materialize", forwardOnlySince: "2026-08-14T00:00:00Z", daily: [{ session: "telegram-direct-123", sections: ["decisions", "learnings"] }],
  } } };
  const projection: any = { schema: "engram.memory-observation-rollout.v2", workspaceId: "main", enabled: true, mode: "canary",
    bindings: [{ ...scope, workspaceId: undefined, requireOwner: true, allowedChannels: ["telegram"] }],
    pluginDigest: sha256("plugin"), inference: { provider: "openai", model: "openai/test", evaluateAfter: "2026-08-27T00:00:00Z" },
    evaluation: { mode: "batch-cron", policyDigest: policy, batch: { sourcePolicyDigest: sha256("source"), inactivityGapSeconds: 60, maxTurns: 20, maxEvidenceBytes: 32768, maxAgeSeconds: 3600, maxInferenceCallsPerRun: 1, schedulerId: "worker" } },
    limits: { evidenceTtlHours: 72, maxJobs: 1000, maxBytes: 10000, maxQueueAgeHours: 168, maxAttempts: 2, claimTtlSeconds: 300, maxInferenceCalls: 1 },
    consumers: { dailyNote: { mode: "canary", applyAfter: "2026-08-27T00:00:00Z", timezone: "UTC", allowedObservationClasses: ["episodic.event", "episodic.decision"], maxAppliesPerWake: 1 } },
    captureOwnership: { owner: "observer", effectiveAfter: "2026-08-27T00:00:00Z", foregroundDailyNoteCapture: "disabled" }, approvedBy: "operator", approvedAt: "2026-08-27T00:00:00Z" };
  put("engram.json", config); put("memory-state/memory-observation/projection.json", projection);
  const registry: any = { schema: "oll.memory-observer-receipt-producer-registry.v1", workspaceId: "main", registryVersion: 1, canonicalApplicator: DAILY_NOTE_APPLICATOR,
    entries: [{ producer: BATCH_EVALUATOR_AUTHORITY, observationSchemas: ["engram.memory-batch-observation.v1"], allowedObservationClasses: ["episodic.decision"], allowedScopeClasses: ["self"], exactScopeAllowlist: [scope], requiredReceiptSchema: "engram.memory-apply-receipt.v1", requireCanonicalReadBack: true, allowedEvaluationPolicyDigests: [policy], rolloutState: "materialize" }] };
  const saveRegistry = () => { registry.digest = observerReceiptProducerRegistryDigestV1(registry); config.oll.observerReceiptProducerRegistry = registry; put("engram.json", config); };
  const receipt: any = { schema: "engram.memory-apply-receipt.v1", status: "applied", canonicalMutation: true, consumer: "daily-note", producer: DAILY_NOTE_APPLICATOR, scope,
    destinationRef: "memory/agent-main/telegram-direct-123/2026-10-20.md#engram-entry:synthetic", sourceCompletedAt: "2026-10-20T12:00:00Z",
    sourceProvenance: { producer: BATCH_EVALUATOR_AUTHORITY, observationClass: "episodic.decision", batchSourceRefs: [], batchEvaluationPolicyDigest: policy } };
  const entryId = sha256("synthetic-entry"), traceId = sha256("trace"), operationId = sha256("operation");
  const turn = `channel-user:v1:${"a".repeat(64)}`, ref = { kind: "source-turn", ref: turn, digest: sha256("evidence") };
  const relativePath = "memory/agent-main/telegram-direct-123/2026-10-20.md";
  const rendered = `<!-- engram-entry:${entryId} -->\n- Synthetic local decision.`;
  Object.assign(receipt, { destinationEntryId: entryId, destinationDate: "2026-10-20", destinationRef: `${relativePath}#engram-entry:${entryId}`,
    traceId, operationId, receiptId: sha256(`engram.memory-apply-receipt.v1\0${operationId}`), sourceObservationRef: sha256("observation"), readBackDigest: sha256(rendered), policyDigest: sha256("daily-policy"), completedAt: "2026-10-20T12:01:00Z" });
  Object.assign(receipt.sourceProvenance, { sourceTurnId: turn, evidenceRefs: [ref], observationDigest: sha256("observation-digest"), batchSourceRefs: [{ traceId, sourceTurnId: turn, sourceDigest: sha256("source"), evidenceDigest: sha256("evidence"), sourceCompletedAt: receipt.sourceCompletedAt }], batchCitations: [{ traceId, evidenceRef: ref }] });
  const receiptFile = join(root, "memory-state/memory-observation/v1/receipts/by-entry", entryId.slice(7) + ".json");
  const saveReceipt = () => {
    mkdirSync(dirname(join(root, relativePath)), { recursive: true }); writeFileSync(join(root, relativePath), "## Decisions\n" + rendered + "\n");
    put("memory-state/memory-observation/v1/receipts/by-entry/" + entryId.slice(7) + ".json", receipt);
  };
  return { root, config, projection, registry, receipt, receiptFile, put, saveRegistry, saveReceipt, audit: () => auditOllObserverBridge(root, { now }) };
}
const codes = (rows: ReturnType<typeof auditOllObserverBridge>) => rows.filter(r => r.level === "error").map(r => r.code);
function hashes(root: string): any[] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(f => f.isFile()).map(f => {
    const p = join(f.parentPath, f.name); return [p, sha256(readFileSync(p, "utf8"))];
  }).sort();
}

test("missing registry fails before first receipt; successful empty cron cannot hide it", () => {
  const f = fixture(); expect(codes(f.audit())).toEqual(["WD-OLL-016"]);
  f.saveReceipt(); expect(codes(f.audit())).toContain("WD-OLL-019");
});
test("healthy authority gates stay content-free and strictly read-only", () => {
  const f = fixture(); f.saveRegistry(); f.saveReceipt(); const before = hashes(f.root), rows = f.audit();
  expect(codes(rows)).toEqual([]); expect(hashes(f.root)).toEqual(before);
  expect(rows.find(r => r.code === "WD-OLL-022")?.details).toMatchObject({ receiptsChecked: 1, receiptsGateRejected: 0 });
  expect(JSON.stringify(rows)).not.toContain("sourceProvenance");
});
test("disabled nightly/compiler, foreground future ownership and nonallowlisted sessions are not false missing-registry errors", () => {
  const f = fixture(); f.config.oll.nightly.enabled = false; f.put("engram.json", f.config);
  expect(codes(f.audit())).toEqual([]); expect(f.audit()[0]?.code).toBe("WD-OLL-021");
  f.config.oll.nightly.enabled = true; f.config.oll.candidateCompiler.mode = "disabled"; f.put("engram.json", f.config);
  expect(codes(f.audit())).toEqual([]);
  f.config.oll.candidateCompiler.mode = "materialize"; f.put("engram.json", f.config);
  f.projection.captureOwnership.effectiveAfter = "2026-10-22T00:00:00Z"; f.projection.consumers.dailyNote.applyAfter = "2026-10-22T00:00:00Z";
  f.put("memory-state/memory-observation/projection.json", f.projection); expect(codes(f.audit())).toEqual([]);
  f.receipt.destinationRef = "memory/agent-main/telegram-direct-456/2026-10-20.md#entry"; f.saveReceipt();
  expect(codes(f.audit())).toEqual([]);
});
test("registry digest corruption and foreign workspace fail closed", () => {
  const f = fixture(); f.saveRegistry(); f.config.oll.observerReceiptProducerRegistry.digest = sha256("bad"); f.put("engram.json", f.config);
  expect(codes(f.audit())).toContain("WD-OLL-017");
  f.registry.workspaceId = "other"; f.registry.entries[0].exactScopeAllowlist[0].workspaceId = "other"; f.saveRegistry();
  expect(codes(f.audit())).toContain("WD-OLL-017");
});
for (const [label, mutate, reason] of [
  ["new producer epoch", (r: any) => r.sourceProvenance.producer = { ...BATCH_EVALUATOR_AUTHORITY, version: "v2" }, "producer_identity"],
  ["new evaluation policy", (r: any) => r.sourceProvenance.batchEvaluationPolicyDigest = sha256("new"), "evaluation_policy"],
  ["foreign exact scope", (r: any) => r.scope = { ...r.scope, scopeId: "other" }, "exact_scope"],
  ["wrong applicator", (r: any) => r.producer = { ...DAILY_NOTE_APPLICATOR, digest: sha256("other") }, "applicator_identity"],
] as const) test(`persisted receipt detects ${label}`, () => {
  const f = fixture(); f.saveRegistry(); mutate(f.receipt); f.saveReceipt();
  const finding = f.audit().find(r => r.code === "WD-OLL-019");
  expect(finding?.details?.rejectionCounts).toMatchObject({ [reason]: 1 });
});
test("current policy/scope and rollout-mode drift fail even without new receipts", () => {
  const f = fixture(); f.registry.entries[0].allowedEvaluationPolicyDigests = []; f.saveRegistry();
  expect(codes(f.audit())).toContain("WD-OLL-018");
  f.registry.entries[0].rolloutState = "shadow"; f.saveRegistry();
  expect(codes(f.audit())).toContain("WD-OLL-018");
});
test("legacy single-turn receipts stay explicitly excluded instead of auto-granting authority", () => {
  const f = fixture(); f.saveRegistry(); delete f.receipt.sourceProvenance.batchSourceRefs; f.saveReceipt();
  expect(codes(f.audit())).toEqual([]);
  expect(f.audit().find(r => r.code === "WD-OLL-022")?.details?.legacyNonBatchExcluded).toBe(1);
});
test("malformed JSON and symlink escapes never silently pass or leak content", () => {
  const f = fixture(); f.saveRegistry(); f.saveReceipt();
  const p = f.receiptFile;
  writeFileSync(p, "{sensitive invalid content");
  expect(codes(f.audit())).toContain("WD-OLL-020"); expect(JSON.stringify(f.audit())).not.toContain("sensitive");
  rmSync(p); const other = fixture(); symlinkSync(join(other.root, "engram.json"), p);
  expect(codes(f.audit())).toContain("WD-OLL-020");
});
test("corrupt historical canonical evidence is warned, never repaired by broadening trust", () => {
  const f = fixture(); f.saveRegistry(); f.receipt.sourceProvenance.batchEvaluationPolicyDigest = sha256("untrusted");
  f.receipt.readBackDigest = sha256("bad"); f.saveReceipt();
  expect(codes(f.audit())).not.toContain("WD-OLL-019");
  expect(f.audit().find(r => r.code === "WD-OLL-023")?.details?.count).toBe(1);
});
