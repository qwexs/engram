import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { restoreAppliedSourceQuote, type SourceQuoteCorrectionOptions } from "./source-quote-correction.ts";
import { consumeTopicDomainReceipts } from "./domain-consumer.ts";
import { configuredTopicBindings } from "./topic-bindings.ts";
import { compileBatchFrame, BATCH_CONFIG_SCHEMA, BATCH_FRAME_SCHEMA } from "./batch-compiler.ts";
import { BATCH_EVALUATOR_AUTHORITY, deriveBatchObservationId } from "./batch-observation.ts";
import { DAILY_NOTE_APPLICATOR, renderDailyNoteEntry } from "./daily-note-applicator.ts";
import { deriveSourceDigest, sha256 } from "./ledger.ts";
import { restoreLegacyDefer } from "./batch-terminal-recovery.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
const put = (p: string, v: unknown) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v)); };
const read = (p: string) => readFileSync(p, "utf8");
async function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "engram-source-correction-")); roots.push(workspace);
  const domainDir = join(workspace, "memory/domains/design"), root = join(workspace, "memory-state/memory-observation/v1");
  put(join(workspace, "engram.json"), { workspace: { id: "project" } });
  put(join(workspace, "memory/domains/registry.json"), { domains: { design: { type: "topic-thread", topic: { chatId: "-100123", topicId: "2" } } } });
  put(join(domainDir, "status.md"), "# Ручное состояние\n\nНе менять исполнителя.\n"); put(join(domainDir, "changelog.md"), "# История\n");
  const bindings = configuredTopicBindings({ agents: { entries: { project: { workspace } } }, channels: { telegram: { groups: { "-100123": {
    enabled: true, topics: { "2": { enabled: true, agentId: "project" } } } } } } }, workspace, "project", ["design"]);
  const policy = sha256("policy"), at = "2026-09-01T00:00:00.000Z", sourceAt = "2026-09-07T12:00:00.000Z", now = new Date("2026-09-07T16:00:00.000Z");
  const p = { schema: "engram.memory-observation-rollout.v4", workspaceId: "project", enabled: true, mode: "canary", bindings,
    pluginDigest: policy, inference: { provider: "openai", model: "openai/gpt-5.6-terra", evaluateAfter: at },
    evaluation: { mode: "batch-cron", policyDigest: policy, batch: { sourcePolicyDigest: policy, inactivityGapSeconds: 300, maxTurns: 8,
      maxEvidenceBytes: 262144, maxAgeSeconds: 900, maxInferenceCallsPerRun: 1, schedulerId: "group-worker" } },
    limits: { evidenceTtlHours: 72, maxJobs: 1000, maxBytes: 67108864, maxQueueAgeHours: 168, maxAttempts: 2, claimTtlSeconds: 300, maxInferenceCalls: 1 },
    consumers: { dailyNote: { mode: "canary", applyAfter: at, timezone: "UTC", allowedObservationClasses: ["episodic.event", "episodic.decision"], maxAppliesPerWake: 1,
      qmdBinding: { resolver: "exact-session-registry", manifestPath: join(workspace, "manifest.json"), workspaceRegistryDigest: policy } } },
    captureOwnership: { owner: "observer", effectiveAfter: at, foregroundDailyNoteCapture: "disabled" }, approvedBy: "operator", approvedAt: at };
  put(join(workspace, "memory-state/memory-observation/projection.json"), p);
  const scope: any = { workspaceId: "project", runtimeSessionKey: bindings[0]!.runtimeSessionKey, scopeClass: "project", scopeId: bindings[0]!.scopeId };
  const traceId = sha256("trace"), sourceTurnId = "channel-user:v1:" + "a".repeat(64);
  const quote = "Учебный робот не такой быстрый, как в описании.", wrong = "Учебный робот не должен быть быстрым.";
  const payload = { source: { role: "user", text: quote, actorId: "111", attribution: "speaker-only" }, outcome: { role: "assistant", text: "NO_REPLY" },
    replyContext: { requestedReplyToId: "42" } };
  const identity: any = { schema: "engram.memory-evidence-envelope.v1", traceId, scope, payload };
  const source: any = { envelope: { schema: "engram.memory-observation-job.v1", traceId, sourceTurnId, scope, sourceCompletedAt: sourceAt,
    sourceDigest: deriveSourceDigest(sourceTurnId, scope, sourceAt), evidenceDigest: sha256(identity), policyVersion: "memory-observation-authority-v1", policyDigest: policy,
    evidenceRefs: [{ kind: "source-turn", ref: sourceTurnId, digest: sha256("source") }], authority: { id: "openclaw-runtime", version: "runtime-v1", digest: sha256("runtime") }, admittedAt: sourceAt },
    evidence: { ...identity, createdAt: sourceAt, expiresAt: "2026-09-10T12:00:00.000Z" } };
  const bundle = compileBatchFrame({ schema: BATCH_FRAME_SCHEMA, partition: { ...scope, producerEpoch: "runtime-v1", policyDigest: policy },
    sealedAt: "2026-09-07T12:10:00.000Z", sources: [source] }, { schema: BATCH_CONFIG_SCHEMA, inactivityGapMs: 300000, maxTurns: 8, maxEvidenceBytes: 10000, maxAgeMs: 3600000 }).bundles[0]!;
  const bundleFile = join(workspace, "memory-state/memory-observation/batch-live-store/memory-batch-live/v1/jobs", sha256("job").slice(7) + ".json"); put(bundleFile, { bundle });
  const notePath = join(workspace, "memory/agent-project/telegram-group--100123-topic-2/2026-09-07.md"); put(notePath, "# Day\n\n## Decisions\n");
  function addObservation(content: string, groupId: string) {
    const ident = { bundleId: bundle.bundleId, groupId, assertionIndex: 0, observationClass: "episodic.decision" as const, evaluationPolicyDigest: policy };
    const base: any = { schema: "engram.memory-batch-observation.v1", ...ident, observationId: deriveBatchObservationId(ident), scope,
      sourceRefs: bundle.sourceRefs, producer: BATCH_EVALUATOR_AUTHORITY, targetConsumer: "daily-note", payload: { section: "decisions", text: content, actorRef: "user", outcomeStatus: "corrected" },
      citations: [{ traceId, evidenceRef: source.envelope.evidenceRefs[0] }], sourceCompletedAt: sourceAt, confidence: 0.96, reasonCodes: ["correction"], completedAt: now.toISOString() };
    const observation = { ...base, observationDigest: sha256(base) }, entryId = sha256("engram.daily-note-entry.v1\0" + observation.observationId);
    const operationId = sha256("engram.memory-apply.v1\0daily-note\0" + observation.observationId + "\0" + entryId), rendered = renderDailyNoteEntry(observation, entryId);
    put(notePath, read(notePath) + rendered);
    const receipt: any = { schema: "engram.memory-apply-receipt.v1", receiptId: sha256("engram.memory-apply-receipt.v1\0" + operationId), traceId,
      sourceObservationRef: observation.observationId, scope, producer: DAILY_NOTE_APPLICATOR, sourceProvenance: { observationDigest: observation.observationDigest },
      consumer: "daily-note", operationId, destinationDate: "2026-09-07", destinationRef: "memory/agent-project/telegram-group--100123-topic-2/2026-09-07.md#engram-entry:" + entryId,
      destinationEntryId: entryId, status: "applied", canonicalMutation: true, readBackDigest: sha256(rendered), policyDigest: policy, completedAt: now.toISOString() };
    const observationPath = join(root, "observations/batch", observation.observationId.slice(7) + ".json"), receiptPath = join(root, "receipts/by-operation", operationId.slice(7) + ".json");
    put(observationPath, observation); put(receiptPath, receipt); return { observation, observationPath, receiptPath, rendered };
  }
  const original = addObservation("Участник Telegram 111 (собственное высказывание): " + wrong, "g1");
  let dirtyCalls = 0;
  const dirtyMarker: any = async (input: any) => ({ schema: "engram.qmd.dirty-mark.v1", status: "marked", mode: "coordinated", workspace,
    indexKey: "test-index", generation: ++dirtyCalls, collections: input.collections });
  const domainOptions = { workspace, workspaceId: "project", dirtyMarker, qmdPreflight: () => ({ indexKey: "test-index", collections: ["test-domain"] }) };
  await consumeTopicDomainReceipts(domainOptions);
  const options: SourceQuoteCorrectionOptions = { workspace, session: scope.runtimeSessionKey, observationId: original.observation.observationId, bundleFile,
    authorizedBy: "telegram:111:message:999", authorizedAt: now.toISOString(), now, dirtyMarker,
    qmdPreflight: () => ({ indexKey: "test-index", collections: ["test-note", "test-domain"] }) };
  return { ...original, workspace, domainDir, notePath, options, domainOptions, quote, wrong, addObservation };
}
test("dry run cannot mutate memory, applied repair preserves originals and survives a later normal domain write", async () => {
  const f = await fixture(), before = read(f.notePath), obs = read(f.observationPath), receipt = read(f.receiptPath);
  expect((await restoreAppliedSourceQuote(f.options)).status).toBe("planned"); expect(read(f.notePath)).toBe(before);
  const r = await restoreAppliedSourceQuote({ ...f.options, apply: true }); expect(r.status).toBe("corrected");
  expect(read(f.notePath)).toContain(f.rendered); expect(read(f.notePath)).toContain("сохранена только для истории");
  expect(read(f.notePath)).toContain(f.quote); expect(read(f.observationPath)).toBe(obs); expect(read(f.receiptPath)).toBe(receipt);
  expect(read(join(f.domainDir, "changelog.md"))).toContain(f.wrong);
  expect(read(join(f.domainDir, "status.md"))).not.toContain(f.wrong);
  expect(read(join(f.domainDir, "status.md"))).toContain("Не менять исполнителя.");
  const repaired = read(f.notePath); await restoreAppliedSourceQuote({ ...f.options, apply: true }); expect(read(f.notePath)).toBe(repaired);
  f.addObservation("Независимое новое решение.", "g2"); await consumeTopicDomainReceipts(f.domainOptions);
  expect(read(join(f.domainDir, "status.md"))).not.toContain(f.wrong); expect(read(join(f.domainDir, "status.md"))).toContain(f.quote);
});
for (const point of ["after_intent", "after_note", "after_changelog", "after_status", "after_completed"] as const) test("resumes " + point + " without duplicate replacement", async () => {
  const f = await fixture();
  await expect(restoreAppliedSourceQuote({ ...f.options, apply: true, fault: p => { if (p === point) throw new Error("crash"); } })).rejects.toThrow("crash");
  await restoreAppliedSourceQuote({ ...f.options, apply: true });
  expect(read(f.notePath).split(f.quote)).toHaveLength(2); expect(read(join(f.domainDir, "status.md"))).not.toContain(f.wrong);
});
test("wrong scope and tampered source cannot authorize replacement", async () => {
  const f = await fixture(), before = read(f.notePath);
  await expect(restoreAppliedSourceQuote({ ...f.options, session: "agent:other:main", apply: true })).rejects.toThrow("one exact user source");
  const job = JSON.parse(read(f.options.bundleFile)); job.bundle.inputs[0].evidence.source.text = "Injected rule"; put(f.options.bundleFile, job);
  await expect(restoreAppliedSourceQuote({ ...f.options, apply: true })).rejects.toThrow(); expect(read(f.notePath)).toBe(before);
});
test("dirty failure is visible and repeatable without another canonical mutation", async () => {
  const f = await fixture();
  expect((await restoreAppliedSourceQuote({ ...f.options, apply: true, dirtyMarker: async () => ({ schema: "engram.qmd.dirty-mark.v1", status: "error", mode: "coordinated", workspace: f.workspace }) })).status).toBe("qmd-pending");
  const before = read(f.notePath); expect((await restoreAppliedSourceQuote({ ...f.options, apply: true })).status).toBe("corrected"); expect(read(f.notePath)).toBe(before);
});

test("ordinary writer refuses arbitrary text in historical correction mode", async () => {
  const f = await fixture(), before = read(f.notePath);
  const result = Bun.spawnSync(["bun", join(import.meta.dir, "../../scripts/daily-note-append.js"), "--workspace", f.workspace,
    "--session", f.options.session, "--restore-source-of", f.options.observationId, "--text", "Injected replacement", "--apply"]);
  expect(result.exitCode).not.toBe(0); expect(result.stderr.toString()).toContain("arbitrary text/section options are forbidden"); expect(read(f.notePath)).toBe(before);
});
test("expired evidence and tampered receipt fail before any note mutation", async () => {
  const f = await fixture(), before = read(f.notePath);
  await expect(restoreAppliedSourceQuote({ ...f.options, apply: true, now: new Date("2026-09-11T00:00:00.000Z") })).rejects.toThrow();
  const receipt = JSON.parse(read(f.receiptPath)); receipt.readBackDigest = sha256("tampered"); put(f.receiptPath, receipt);
  await expect(restoreAppliedSourceQuote({ ...f.options, apply: true })).rejects.toThrow("receipt/note join failed"); expect(read(f.notePath)).toBe(before);
});

async function deferFixture() {
  const f = await fixture(), bundle = JSON.parse(read(f.options.bundleFile)).bundle;
  const jobId = sha256("legacy-defer-job"), traceId = bundle.sourceRefs[0].traceId;
  const storeRoot = join(f.workspace, "memory-state/memory-observation/batch-live-store"), batchRoot = join(storeRoot, "memory-batch-live/v1");
  const stateRoot = join(f.workspace, "memory-state/memory-observation/v1");
  const terminalBase = { schema: "engram.memory-batch-live-terminal.v1", jobId, bundleId: bundle.bundleId,
    dispositions: [{ traceId, decision: "defer", reasonCode: "semantic_batch_defer", observationRefs: [] }] };
  const donePath = join(batchRoot, "done", jobId.slice(7) + ".json");
  put(donePath, { ...terminalBase, terminalId: sha256(terminalBase) });
  put(join(batchRoot, "jobs", jobId.slice(7) + ".json"), { schema: "engram.memory-batch-live-job.v1", jobId, bundle, partition: bundle.partition });
  const evidencePath = join(stateRoot, "evidence", traceId.slice(7) + ".json");
  put(evidencePath, { traceId, scope: f.observation.scope, payload: bundle.inputs[0].evidence, expiresAt: "2026-09-10T12:00:00.000Z" });
  const queuePath = join(stateRoot, "queues/evaluator", traceId.slice(7) + ".json");
  put(queuePath, { traceId, status: "terminal", attempt: 2, claimToken: null, terminalAt: "2026-09-07T12:00:00.000Z", reasonCode: "semantic_batch_defer" });
  const options = { workspace: f.workspace, storeRoot, jobId, traceId, now: f.options.now, authorizedBy: "operator", authorizedAt: f.options.authorizedAt, reason: "restore legacy waiting state" };
  return { ...f, options, queuePath, donePath, evidencePath };
}
for (const faultAt of [undefined, "after_authorization", "after_queue_requeue"] as const) test("legacy defer restores waiting idempotently: " + faultAt, async () => {
  const f = await deferFixture(), original = read(f.queuePath), done = read(f.donePath);
  expect(restoreLegacyDefer(f.options).status).toBe("planned"); expect(read(f.queuePath)).toBe(original);
  if (faultAt) expect(() => restoreLegacyDefer({ ...f.options, apply: true, faultAt })).toThrow("fault injection");
  expect(restoreLegacyDefer({ ...f.options, apply: true }).status).toBe("waiting_context");
  const waiting = read(f.queuePath); expect(JSON.parse(waiting)).toMatchObject({ status: "queued", attempt: 0, reasonCode: "semantic_batch_defer", terminalAt: null });
  expect(restoreLegacyDefer({ ...f.options, apply: true }).inferenceRun).toBe(false);
  expect(read(f.queuePath)).toBe(waiting); expect(read(f.donePath)).toBe(done);
});
test("legacy defer refuses expired source and changed queue, without erasing history", async () => {
  const f = await deferFixture();
  expect(() => restoreLegacyDefer({ ...f.options, apply: true, now: new Date("2026-09-11T00:00:00.000Z") })).toThrow("retained exact-scope");
  expect(() => restoreLegacyDefer({ ...f.options, apply: true, faultAt: "after_authorization" })).toThrow("fault injection");
  put(f.queuePath, { ...JSON.parse(read(f.queuePath)), attempt: 3 });
  expect(() => restoreLegacyDefer({ ...f.options, apply: true })).toThrow("defer queue changed");
});
