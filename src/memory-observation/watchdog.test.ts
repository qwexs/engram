import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256 } from "./ledger.ts";
import { auditMemoryObservation } from "./watchdog.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const now = new Date("2026-09-08T12:00:00Z");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "worker-watchdog-")); roots.push(root);
  const put = (path: string, value: any) => { const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, JSON.stringify(value)); };
  const state = (path: string, value: any) => put(`memory-state/memory-observation/v1/${path}`, value);
  put("engram.json", { workspace: { id: "main" } });
  const projection = { schema: "engram.memory-observation-rollout.v1", workspaceId: "main", enabled: true, mode: "canary",
    bindings: [{ runtimeSessionKey: "agent:main:telegram:direct:100000001", scopeClass: "self", scopeId: "telegram:100000001", requireOwner: true, allowedChannels: ["telegram"] }],
    pluginDigest: `sha256:${"a".repeat(64)}`, inference: { provider: "openai", model: "openai/gpt-5.6-sol", evaluateAfter: "2026-08-24T19:00:00.000Z" },
    limits: { evidenceTtlHours: 72, maxJobs: 1000, maxBytes: 67108864, maxQueueAgeHours: 168, maxAttempts: 2, claimTtlSeconds: 300, maxInferenceCalls: 0 },
    consumers: { dailyNote: { mode: "canary", applyAfter: "2026-08-27T00:00:00.000Z", timezone: "Europe/Moscow", allowedObservationClasses: ["episodic.event", "episodic.decision"], maxAppliesPerWake: 1 } },
    captureOwnership: { owner: "observer", effectiveAfter: "2026-08-27T00:00:00.000Z", foregroundDailyNoteCapture: "disabled" },
    approvedBy: "operator", approvedAt: "2026-08-24T19:00:00.000Z" };
  put("memory-state/memory-observation/projection.json", projection);
  return { root, put, state, projection, audit: () => auditMemoryObservation(root, { now, expectedPluginDigest: projection.pluginDigest }) };
}
function hashes(root: string, path = ""): any[] {
  return readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const next = join(path, entry.name); return entry.isDirectory() ? hashes(root, next) : [[next, sha256(readFileSync(join(root, next), "utf8"))]];
  });
}
test("valid empty ownership remains capture-unverified and all audit reads are immutable", () => {
  const f = fixture(), before = hashes(f.root), report = f.audit();
  expect(report.some(row => row.code === "WD-MW-005")).toBe(false);
  expect(report.some(row => row.code === "WD-MW-020")).toBe(true);
  expect(hashes(f.root)).toEqual(before);
});
test("intentional disable is not an invalid projection; unfinished work remains visible", () => {
  const f = fixture();
  f.put("memory-state/memory-observation/projection.json", { ...f.projection, enabled: false });
  expect(f.audit().some(row => row.level === "error")).toBe(false);
  f.state("queues/evaluator/pending.json", { schema: "engram.memory-observation-ledger-queue.v1", status: "queued", traceId: "pending", createdAt: now.toISOString() });
  expect(f.audit().some(row => row.code === "WD-MW-025")).toBe(true);
  expect(f.audit().some(row => row.code === "WD-MW-005")).toBe(false);
});
test("projection digest drift and malformed JSON stay visible", () => {
  const f = fixture(); f.state("queues/evaluator/bad.json", {});
  writeFileSync(join(f.root, "memory-state/memory-observation/v1/queues/evaluator/bad.json"), "{");
  const report = auditMemoryObservation(f.root, { now, expectedPluginDigest: `sha256:${"b".repeat(64)}` });
  expect(report.some(row => row.code === "WD-MW-005" && row.level === "error")).toBe(true);
  expect(report.some(row => row.code === "WD-MW-007" && row.level === "error")).toBe(true);
});
test("publication joins allow fresh artifacts but expose old missing queue and terminal receipt", () => {
  const f = fixture();
  f.state("envelopes/old.json", { traceId: "old", admittedAt: "2026-09-08T11:00:00Z" });
  f.state("envelopes/fresh.json", { traceId: "fresh", admittedAt: "2026-09-08T11:59:00Z" });
  f.state("consumers/daily-note/queue/done.json", { observationId: "lost", status: "terminal", reasonCode: "canonical_applied", terminalAt: "2026-09-08T11:00:00Z" });
  const report = f.audit();
  expect(report.filter(row => row.code === "WD-MW-011").length).toBe(1);
  expect(report.filter(row => row.code === "WD-MW-015").length).toBe(1);
});
test("old receipt requires identical alias and canonical entry readback, without source retention assumptions", () => {
  const f = fixture(), observationId = sha256("observation"), destinationEntryId = sha256(`engram.daily-note-entry.v1\0${observationId}`);
  const operationId = sha256(`engram.memory-apply.v1\0daily-note\0${observationId}\0${destinationEntryId}`);
  const rendered = `<!-- engram-entry:${destinationEntryId} -->\n- Retained source note`;
  const receipt = { schema: "engram.memory-apply-receipt.v1", status: "applied", canonicalMutation: true, sourceObservationRef: observationId,
    operationId, destinationEntryId, receiptId: sha256(`engram.memory-apply-receipt.v1\0${operationId}`), completedAt: "2026-09-08T10:00:00Z", destinationRef: `memory/note.md#engram-entry:${destinationEntryId}`, readBackDigest: sha256(rendered) };
  f.put("memory/note.md", "unused"); writeFileSync(join(f.root, "memory/note.md"), `# Daily\n\n${rendered}\n`);
  f.state("receipts/by-operation/receipt.json", receipt); f.state("receipts/by-entry/receipt.json", receipt);
  const before = hashes(f.root);
  expect(f.audit().some(row => ["WD-MW-016", "WD-MW-019"].includes(row.code))).toBe(false);
  expect(hashes(f.root)).toEqual(before);
  writeFileSync(join(f.root, "memory/note.md"), "# entry removed");
  expect(f.audit().some(row => row.code === "WD-MW-019")).toBe(true);
});
test("pending evaluator work in a revoked scope is visible", () => {
  const f = fixture();
  f.state("envelopes/pending.json", { traceId: "pending", admittedAt: now.toISOString(), scope: { workspaceId: "main", runtimeSessionKey: "agent:main:telegram:direct:999", scopeClass: "self", scopeId: "telegram:999" } });
  f.state("queues/evaluator/pending.json", { traceId: "pending", status: "queued", createdAt: now.toISOString() });
  expect(f.audit().some(row => row.code === "WD-MW-014")).toBe(true);
});

test("group daily receipts reconcile through domain readback and durable dirty publication", async () => {
  const { configuredTopicBindings } = await import("./topic-bindings.ts");
  const f = fixture(), hash = sha256("policy"), at = "2026-08-27T00:00:00.000Z";
  f.put("engram.json", { workspace: { id: "project" } });
  f.put("memory/domains/registry.json", { domains: { smm: { type: "topic-thread", topic: { chatId: "-100123", topicId: "2" } } } });
  mkdirSync(join(f.root, "memory/domains/smm"), { recursive: true });
  const host = { agents: { entries: { project: { workspace: f.root } } },
    channels: { telegram: { groups: { "-100123": { enabled: true, topics: { "2": { enabled: true, agentId: "project" } } } } } } };
  const bindings = configuredTopicBindings(host, f.root, "project", ["smm"]);
  const projection = { ...f.projection, workspaceId: "project", schema: "engram.memory-observation-rollout.v4", bindings,
    evaluation: { mode: "batch-cron", policyDigest: hash, batch: { sourcePolicyDigest: hash, inactivityGapSeconds: 300, maxTurns: 8, maxEvidenceBytes: 262144, maxAgeSeconds: 900, maxInferenceCallsPerRun: 1, schedulerId: "group-worker" } },
    limits: { ...f.projection.limits, maxInferenceCalls: 1 }, consumers: { dailyNote: { ...f.projection.consumers.dailyNote, qmdBinding: { resolver: "exact-session-registry", manifestPath: join(f.root, "manifest.json"), workspaceRegistryDigest: hash } } } };
  f.put("memory-state/memory-observation/projection.json", projection);
  const scope = { workspaceId: "project", runtimeSessionKey: bindings[0]!.runtimeSessionKey, scopeClass: bindings[0]!.scopeClass, scopeId: bindings[0]!.scopeId };
  const observationId = sha256("domain-observation"), destinationEntryId = sha256(`engram.daily-note-entry.v1\0${observationId}`), operationId = sha256(`engram.memory-apply.v1\0daily-note\0${observationId}\0${destinationEntryId}`);
  const rendered = `<!-- engram-entry:${destinationEntryId} -->\n- Captured event`, block = `<!-- engram-domain-entry:${operationId} -->\n- Event\n  Source: note\n`;
  const receipt = { schema: "engram.memory-apply-receipt.v1", status: "applied", canonicalMutation: true, sourceObservationRef: observationId, scope, sourceProvenance: { observationDigest: hash }, operationId, destinationEntryId,
    receiptId: sha256(`engram.memory-apply-receipt.v1\0${operationId}`), completedAt: at, destinationRef: `memory/note.md#engram-entry:${destinationEntryId}`, readBackDigest: sha256(rendered) };
  f.put("memory/note.md", "placeholder"); writeFileSync(join(f.root, "memory/note.md"), rendered);
  f.state("receipts/by-operation/receipt.json", receipt); f.state("receipts/by-entry/receipt.json", receipt);
  expect(f.audit().some(row => row.code === "WD-MW-005")).toBe(false);
  expect(f.audit().some(row => row.code === "WD-MW-021")).toBe(true);
  const domainReceipt = { schema: "engram.domain-apply-receipt.v1", operationId, sourceReceiptId: receipt.receiptId, sourceObservationId: observationId, sourceObservationDigest: hash, scope, domain: "smm", canonicalApplied: true, entryDigest: sha256(block) };
  writeFileSync(join(f.root, "memory/domains/smm/changelog.md"), block);
  f.put("memory-state/domain-effects/v1/receipts/receipt.json", domainReceipt);
  expect(f.audit().some(row => row.code === "WD-MW-022")).toBe(true);
  f.put("memory-state/domain-effects/v1/dirty/receipt.json", { schema: "engram.domain-dirty-receipt.v1", operationId, domainApplyReceiptDigest: sha256(domainReceipt), canonicalApplied: true, qmdDirtyMarked: true, generation: 1, indexKey: "index", collections: ["main-domains"] });
  const before = hashes(f.root), report = f.audit();
  expect(report.filter(row => ["WD-MW-021", "WD-MW-022", "WD-MW-023", "WD-MW-024"].includes(row.code))).toEqual([]);
  expect(hashes(f.root)).toEqual(before);
  writeFileSync(join(f.root, "memory/domains/smm/changelog.md"), "removed");
  expect(f.audit().some(row => row.code === "WD-MW-024")).toBe(true);
});
