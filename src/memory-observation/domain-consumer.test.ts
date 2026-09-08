import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { consumeTopicDomainReceipts, type DomainConsumerOptions } from "./domain-consumer.ts";
import { BATCH_EVALUATOR_AUTHORITY, deriveBatchObservationId } from "./batch-observation.ts";
import { DAILY_NOTE_APPLICATOR, renderDailyNoteEntry } from "./daily-note-applicator.ts";
import { sha256 } from "./ledger.ts";
import { configuredGroupDirectBindings } from "./group-bindings.ts";
import { configuredTopicBindings } from "./topic-bindings.ts";
import { scanDomains, applyDomainWriteHandoff } from "../../scripts/domains-runner.js";
import { refreshAutoDerivedStatus } from "../../scripts/heartbeat-runner.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function put(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); }
function fixture(groupDirect = false) {
  const workspace = mkdtempSync(join(tmpdir(), "engram-domain-consumer-")); roots.push(workspace);
  const domainDir = join(workspace, "memory/domains/smm");
  mkdirSync(domainDir, { recursive: true });
  put(join(workspace, "engram.json"), { workspace: { id: "project" } });
  put(join(workspace, "memory/domains/registry.json"), { domains: { smm: groupDirect ? { type: "group-direct", group: { chatId: "-100123" } } : { type: "topic-thread", topic: { chatId: "-100123", topicId: "2" } } } });
  put(join(domainDir, "status.md"), "# Ручная передача\n\nСохранить назначенного исполнителя.\n");
  put(join(domainDir, "decisions.md"), "# Решения руководителя\n");
  put(join(domainDir, "changelog.md"), "# История\n");
  const config = { agents: { entries: { project: { workspace } } }, channels: { telegram: { groups: { "-100123": {
    enabled: true, topics: { "2": { enabled: true, agentId: "project" } } } } } } };
  const groupConfig = { agents: config.agents, channels: { telegram: { groups: { "-100123": { enabled: true } } } },
    bindings: [{ type: "route", agentId: "project", match: { channel: "telegram", peer: { kind: "group", id: "-100123" } } }] };
  const bindings = groupDirect ? configuredGroupDirectBindings(groupConfig, workspace, "project", ["smm"]) : configuredTopicBindings(config, workspace, "project", ["smm"]), hash = sha256("policy");
  const at = "2026-09-01T00:00:00.000Z", completedAt = "2026-09-07T10:30:00.000Z";
  const p = { schema: groupDirect ? "engram.memory-observation-rollout.v5" : "engram.memory-observation-rollout.v4", workspaceId: "project", enabled: true, mode: "canary", bindings,
    pluginDigest: hash, inference: { provider: "openai", model: "openai/gpt-5.6-terra", evaluateAfter: at },
    evaluation: { mode: "batch-cron", policyDigest: hash, batch: { sourcePolicyDigest: hash, inactivityGapSeconds: 300, maxTurns: 8,
      maxEvidenceBytes: 262144, maxAgeSeconds: 900, maxInferenceCallsPerRun: 1, schedulerId: "group-worker" } },
    limits: { evidenceTtlHours: 72, maxJobs: 1000, maxBytes: 67108864, maxQueueAgeHours: 168, maxAttempts: 2, claimTtlSeconds: 300, maxInferenceCalls: 1 },
    consumers: { dailyNote: { mode: "canary", applyAfter: at, timezone: "UTC", allowedObservationClasses: ["episodic.event", "episodic.decision"], maxAppliesPerWake: 1,
      qmdBinding: { resolver: "exact-session-registry", manifestPath: join(workspace, "manifest.json"), workspaceRegistryDigest: hash } } },
    captureOwnership: { owner: "observer", effectiveAfter: at, foregroundDailyNoteCapture: "disabled" }, approvedBy: "operator", approvedAt: at };
  put(join(workspace, "memory-state/memory-observation/projection.json"), p);
  const scope = { workspaceId: "project", runtimeSessionKey: bindings[0]!.runtimeSessionKey, scopeClass: "project", scopeId: bindings[0]!.scopeId };
  const identity: any = { bundleId: sha256("bundle"), groupId: "decision", assertionIndex: 0, observationClass: "episodic.decision", evaluationPolicyDigest: hash };
  const sourceTurnId = "channel-user:v1:" + "a".repeat(64), traceId = sha256("trace"), sourceCompletedAt = "2026-09-04T20:00:00.000Z";
  const base: any = { schema: "engram.memory-batch-observation.v1", ...identity, observationId: deriveBatchObservationId(identity), scope,
    sourceRefs: [{ traceId, sourceTurnId, sourceDigest: sha256("source"), evidenceDigest: sha256("evidence"), sourceCompletedAt }],
    producer: BATCH_EVALUATOR_AUTHORITY, targetConsumer: "daily-note",
    payload: { section: "decisions", text: "Участник Telegram 111 (собственное высказывание): Согласовал срок.", actorRef: "user", outcomeStatus: "decided" },
    citations: [{ traceId, evidenceRef: { kind: "source-turn", ref: sourceTurnId, digest: sha256("evidence") } }],
    sourceCompletedAt, confidence: 1, reasonCodes: ["explicit_decision"], completedAt };
  const observation = { ...base, observationDigest: sha256(base) };
  const destinationEntryId = sha256("engram.daily-note-entry.v1\0" + observation.observationId);
  const operationId = sha256("engram.memory-apply.v1\0daily-note\0" + observation.observationId + "\0" + destinationEntryId);
  const rendered = renderDailyNoteEntry(observation, destinationEntryId);
  const destinationRef = "memory/agent-project/telegram-group--100123" + (groupDirect ? "" : "-topic-2") + "/2026-09-04.md#engram-entry:" + destinationEntryId;
  const receipt: any = { schema: "engram.memory-apply-receipt.v1", receiptId: sha256("engram.memory-apply-receipt.v1\0" + operationId),
    traceId, sourceObservationRef: observation.observationId, scope, producer: DAILY_NOTE_APPLICATOR, sourceProvenance: { observationDigest: observation.observationDigest },
    consumer: "daily-note", operationId, destinationDate: "2026-09-04", destinationRef, destinationEntryId, status: "applied",
    canonicalMutation: true, readBackDigest: sha256(rendered), policyDigest: hash, completedAt };
  put(join(workspace, destinationRef.split("#")[0]!), "# 2026-09-04\n\n## Decisions\n\n" + rendered + "\n");
  const root = join(workspace, "memory-state/memory-observation/v1");
  put(join(root, "observations/batch", observation.observationId.slice(7) + ".json"), observation);
  const receiptPath = join(root, "receipts/by-operation", operationId.slice(7) + ".json"); put(receiptPath, receipt);
  let dirtyCalls = 0;
  const options: DomainConsumerOptions = { workspace, workspaceId: "project", qmdPreflight: () => ({ indexKey: "index-key", collections: ["domain-smm", "project-domains"] }),
    dirtyMarker: async input => { dirtyCalls++; return { schema: "engram.qmd.dirty-mark.v1", status: "marked", mode: "coordinated", workspace,
      indexKey: "index-key", generation: dirtyCalls, collections: input.collections }; } };
  return { workspace, domainDir, options, receipt, receiptPath, dirtyCalls: () => dirtyCalls };
}

test("legacy auto-derived refresh respects domain ownership and resumes after rollback", async () => {
  const f = fixture(), status = join(f.domainDir, "status.md");
  const original = "<!-- auto-derived from 2026-09-01.md at 2026-09-01 -->\n# Сохраненный контекст\n";
  put(status, original); utimesSync(status, 1, 1);
  expect((await refreshAutoDerivedStatus({ root: f.workspace, workspaceAgentId: "project" })).refreshed).toBe(0);
  expect(readFileSync(status, "utf8")).toBe(original);
  const p = join(f.workspace, "memory-state/memory-observation/projection.json");
  const projection = JSON.parse(readFileSync(p, "utf8")); put(p, { ...projection, enabled: false });
  const registryPath = join(f.workspace, "memory/domains/registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  registry.domains.smm.pending = true; put(registryPath, registry);
  expect((await refreshAutoDerivedStatus({ root: f.workspace, workspaceAgentId: "project" })).refreshed).toBe(0);
  expect(readFileSync(status, "utf8")).toBe(original);
  registry.domains.smm.pending = false; put(registryPath, registry);
  expect((await refreshAutoDerivedStatus({ root: f.workspace, workspaceAgentId: "project" })).refreshed).toBe(1);
  expect(readFileSync(status, "utf8")).toContain("Согласовал срок");
});

test("delayed source dates reach their exact domain once without replacing handover", async () => {
  const f = fixture(); expect((await consumeTopicDomainReceipts(f.options)).applied).toBe(1);
  expect((await consumeTopicDomainReceipts(f.options)).applied).toBe(0);
  expect(f.dirtyCalls()).toBe(1);
  expect(readFileSync(join(f.domainDir, "status.md"), "utf8")).toContain("Сохранить назначенного исполнителя");
  expect(readFileSync(join(f.domainDir, "changelog.md"), "utf8")).toContain("2026-09-04T20:00:00.000Z");
  expect((await scanDomains({ workspace: f.workspace, dryRun: true })).domains[0].due).toBe(false);
  const result = await applyDomainWriteHandoff({ body: "Domain: smm\nRun-Id: old-worker\n" }, { workspace: f.workspace });
  expect(result.reason).toBe("observer-domain-consumer-owns-projection");
});

for (const point of ["after_changelog", "after_status", "after_receipt", "after_dirty"] as const) {
  test("recovers " + point + " without duplicate canonical text", async () => {
    const f = fixture();
    await expect(consumeTopicDomainReceipts({ ...f.options, fault: p => { if (p === point) throw new Error("simulated crash"); } })).rejects.toThrow("simulated crash");
    await consumeTopicDomainReceipts(f.options);
    const log = readFileSync(join(f.domainDir, "changelog.md"), "utf8");
    expect(log.split("Согласовал срок.")).toHaveLength(2);
    expect(readdirSync(join(f.workspace, "memory-state/domain-effects/v1/receipts"))).toHaveLength(1);
    expect(readdirSync(join(f.workspace, "memory-state/domain-effects/v1/dirty"))).toHaveLength(1);
  });
}

test("dirty failure remains recoverable independently from applied domain text", async () => {
  const f = fixture();
  const failed = await consumeTopicDomainReceipts({ ...f.options, dirtyMarker: async () => ({ schema: "engram.qmd.dirty-mark.v1", status: "error", mode: "coordinated", workspace: f.workspace }) });
  expect(failed.indexedPending).toBe(1);
  await consumeTopicDomainReceipts(f.options);
  expect(readFileSync(join(f.domainDir, "changelog.md"), "utf8").split("Согласовал срок.")).toHaveLength(2);
});

test("tampered source receipt does not authorize a domain write", async () => {
  const f = fixture(); f.receipt.readBackDigest = sha256("wrong"); put(f.receiptPath, f.receipt);
  await expect(consumeTopicDomainReceipts(f.options)).rejects.toThrow("join failed");
  expect(readFileSync(join(f.domainDir, "changelog.md"), "utf8")).toBe("# История\n");
});

test("dirty-only recovery survives source batch and daily receipt retention", async () => {
  const f = fixture();
  await consumeTopicDomainReceipts({ ...f.options, dirtyMarker: async () => ({ schema: "engram.qmd.dirty-mark.v1", status: "error", mode: "coordinated", workspace: f.workspace }) });
  rmSync(join(f.workspace, "memory-state/memory-observation/v1"), { recursive: true });
  expect((await consumeTopicDomainReceipts(f.options)).indexedPending).toBe(0);
  expect(f.dirtyCalls()).toBe(1);
  expect(readFileSync(join(f.domainDir, "changelog.md"), "utf8").split("Согласовал срок.")).toHaveLength(2);
});

for (const point of [null, "after_changelog", "after_status", "after_receipt", "after_dirty"] as const) {
  test("group-direct v5 exact domain projection and retry: " + point, async () => {
    const f = fixture(true);
    if (point) await expect(consumeTopicDomainReceipts({ ...f.options, fault: p => { if (p === point) throw new Error("group crash"); } })).rejects.toThrow("group crash");
    await consumeTopicDomainReceipts(f.options);
    expect((await consumeTopicDomainReceipts(f.options)).applied).toBe(0);
    const log = readFileSync(join(f.domainDir, "changelog.md"), "utf8");
    expect(log.split("<!-- engram-domain-entry:")).toHaveLength(2);
    expect(log).toContain("Участник Telegram 111");
    expect(readFileSync(join(f.domainDir, "status.md"), "utf8")).toContain("Сохранить назначенного исполнителя");
    expect(readFileSync(join(f.domainDir, "decisions.md"), "utf8")).toBe("# Решения руководителя\n");
    expect((await scanDomains({ workspace: f.workspace, dryRun: true })).domains[0].due).toBe(false);
  });
}
