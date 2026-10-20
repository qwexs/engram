import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BatchLiveWorker, BATCH_LIVE_FAILURE_SCHEMA, BATCH_LIVE_JOB_SCHEMA, type BatchLivePolicyV1 } from "./batch-live-worker.ts";
import { recoverTerminalBatch, acquireRecoveryLock } from "./batch-terminal-recovery.ts";
import { deriveAdmissionCandidateId } from "./admission-store.ts";
import { compileBatchFrame } from "./batch-compiler.ts";
import { buildContextualObservation, CONTEXTUAL_PROMPT_VERSION } from "./contextual-observation.ts";
import { contextualEvaluationDigest } from "./quality-rollout.ts";
import { deriveSourceDigest, deriveTraceId, sha256, type Digest, type JsonValue } from "./ledger.ts";
import { migrateQuoteFailureToContextual, type QuoteProducerMigrationFault } from "./quote-producer-migration.ts";
import { producerMigrationBarrier, producerMigrationRoot } from "./producer-migration-barrier.ts";
import { scanSourceDebt, sourceDebtSnapshot } from "./source-debt.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function write(path: string, value: any) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); }
const read = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
function fixture(errorCode = "batch_source_quote_mismatch") {
  const workspace = mkdtempSync(join(tmpdir(), "batch-recovery-workspace-"));
  const storeRoot = join(workspace, "memory-state/memory-observation/batch-live-store");
  mkdirSync(storeRoot, {recursive: true});
  roots.push(workspace);
  const scope = { workspaceId: "main", runtimeSessionKey: "agent:main:telegram:direct:1", scopeClass: "self" as const, scopeId: "telegram:1" };
  const partition = {...scope, producerEpoch: "v1", policyDigest: sha256("policy")};
  const sourceTurnId = "channel-user:v1:" + "a".repeat(64);
  const traceId = deriveTraceId("main", scope.runtimeSessionKey, sourceTurnId);
  const timestamp = "2026-09-03T10:00:00.000Z";
  const identity = {schema: "engram.memory-evidence-envelope.v1", traceId, scope, payload: {user: "synthetic source"}};
  const evidence = {...identity, createdAt: timestamp, expiresAt: "2026-09-06T10:00:00.000Z"};
  const envelope = {schema: "engram.memory-observation-job.v1", traceId, sourceTurnId, scope,
    sourceCompletedAt: timestamp, sourceDigest: deriveSourceDigest(sourceTurnId, scope, timestamp), evidenceDigest: sha256(identity),
    policyVersion: "memory-observation-authority-v1", policyDigest: partition.policyDigest,
    evidenceRefs: [{kind: "source-turn", ref: sourceTurnId, digest: sha256("synthetic source")}],
    authority: {id: "synthetic-source", version: "v1", digest: sha256("producer")}, admittedAt: timestamp};
  const bundle = compileBatchFrame({schema: "engram.memory-batch-source-frame.v1", partition, sealedAt: timestamp,
    sources: [{envelope, evidence}]}, {schema: "engram.memory-batch-compiler-config.v1", inactivityGapMs: 1000,
    maxTurns: 100, maxEvidenceBytes: 100000, maxAgeMs: 1000}).bundles[0]!;
  const bundleId = bundle.bundleId;
  const evaluationPolicyDigest = sha256("evaluation-policy");
  const jobId = sha256({schema: BATCH_LIVE_JOB_SCHEMA, partition, evaluationPolicyDigest, bundleId});
  const job = {schema: BATCH_LIVE_JOB_SCHEMA, jobId, partition, evaluationPolicyDigest, bundle, createdAt: timestamp};
  write(join(workspace, "engram.json"), {workspace: {id: "main"}});
  const activation = "2026-09-01T00:00:00.000Z";
  write(join(workspace, "memory-state/memory-observation/projection.json"), {
    schema: "engram.memory-observation-rollout.v2", workspaceId: "main", enabled: true, mode: "canary",
    bindings: [{runtimeSessionKey: scope.runtimeSessionKey, scopeClass: scope.scopeClass, scopeId: scope.scopeId,
      requireOwner: true, allowedChannels: ["telegram"]}], pluginDigest: sha256("plugin"),
    inference: {provider: "openai", model: "openai/synthetic", evaluateAfter: activation},
    evaluation: {mode: "batch-cron", policyDigest: evaluationPolicyDigest, batch: {sourcePolicyDigest: partition.policyDigest,
      inactivityGapSeconds: 1, maxTurns: 100, maxEvidenceBytes: 100000, maxAgeSeconds: 1000,
      maxInferenceCallsPerRun: 1, schedulerId: "synthetic"}},
    limits: {evidenceTtlHours: 72, maxJobs: 1000, maxBytes: 67108864, maxQueueAgeHours: 168,
      maxAttempts: 2, claimTtlSeconds: 300, maxInferenceCalls: 1},
    consumers: {dailyNote: {mode: "canary", applyAfter: activation, timezone: "UTC",
      allowedObservationClasses: ["episodic.event", "episodic.decision"], maxAppliesPerWake: 1,
      qmdBinding: {collection: "synthetic-memory"}}},
    captureOwnership: {owner: "observer", effectiveAfter: activation, foregroundDailyNoteCapture: "disabled"},
    approvedBy: "operator", approvedAt: activation,
  });
  const bindingFingerprint = sha256({workspaceId: "main", scopeClass: scope.scopeClass, scopeId: scope.scopeId,
    requireOwner: true, allowedChannels: ["telegram"]});
  const candidateId = deriveAdmissionCandidateId({workspaceId: "main", runtimeSessionKey: scope.runtimeSessionKey, channel: "telegram", inboundMessageId: "1"});
  const checkpointBody = {schema: "engram.memory-admission-checkpoint.v1", candidateId, scope, bindingFingerprint,
    channel: "telegram", inboundMessageId: "1", actorId: "1", replyToId: null, sourceTurnId,
    runId: "synthetic-run", sessionId: "synthetic-session", sourceText: null, stage: "ledger_admitted",
    createdAt: timestamp, updatedAt: timestamp, expiresAt: evidence.expiresAt};
  write(join(workspace, "memory-state/memory-observation/v1/pre-admission/checkpoints", candidateId.slice(7)+".json"),
    {...checkpointBody, checkpointDigest: sha256(checkpointBody)});
  const failureBase = {
    schema: BATCH_LIVE_FAILURE_SCHEMA,
    jobId,
    bundleId,
    errorCode,
    attempt: 2,
    maxAttempts: 2,
    traceIds: [traceId],
    failedAt: "2026-09-03T10:05:00.000Z",
  };
  const failure = { ...failureBase, failureId: sha256(failureBase as unknown as JsonValue) };
  const batchRoot = join(storeRoot, "memory-batch-live", "v1");
  write(join(batchRoot, "jobs", `${jobId.slice(7)}.json`), job);
  write(join(batchRoot, "failures", `${jobId.slice(7)}.json`), failure);
  write(join(batchRoot, "done", `${jobId.slice(7)}.json`), failure);
  const stateRoot = join(workspace, "memory-state", "memory-observation", "v1");
  write(join(stateRoot, "queues", "evaluator", `${traceId.slice(7)}.json`), {
    schema: "engram.memory-observation-ledger-queue.v1", traceId, queueClass: "evaluator", status: "terminal",
    attempt: 2, maxAttempts: 2, nextAttemptAt: "2026-09-03T10:00:00.000Z", createdAt: "2026-09-03T10:00:00.000Z",
    updatedAt: "2026-09-03T10:05:00.000Z", claimedAt: null, claimToken: null, terminalAt: "2026-09-03T10:05:00.000Z", reasonCode: errorCode,
  });
  write(join(stateRoot, "evidence", `${traceId.slice(7)}.json`), evidence);
  write(join(stateRoot, "envelopes", `${traceId.slice(7)}.json`), envelope);
  return { workspace, storeRoot, jobId, traceId };
}

function setup(errorCode?: string) {
  const f = fixture(errorCode), state = join(f.workspace, "memory-state/memory-observation"), base = join(f.storeRoot, "memory-batch-live/v1");
  const projectionPath = join(state, "projection.json"), projection = read(projectionPath), scope = { workspaceId: "main", ...projection.bindings[0] };
  delete scope.requireOwner; delete scope.allowedChannels;
  const qualityBody = { schema: "engram.memory-quality-rollout.v1", mode: "active", workspaceId: "main", pluginDigest: projection.pluginDigest,
    baseEvaluationPolicyDigest: projection.evaluation.policyDigest, sourcePolicyDigest: projection.evaluation.batch.sourcePolicyDigest,
    applyAfter: projection.consumers.dailyNote.applyAfter, exactScopes: [scope], preparedAt: "2026-09-03T19:00:00.000Z", inventoryDigest: sha256("quality-inventory") };
  const qualityPath = join(state, "quality-rollout.json"); write(qualityPath, { ...qualityBody, digest: sha256(qualityBody) });
  const targetPolicy: BatchLivePolicyV1 = { workspaceId: "main", exactScope: scope, producerEpoch: "v1", sourcePolicyDigest: projection.evaluation.batch.sourcePolicyDigest,
    evaluationPolicyDigest: contextualEvaluationDigest(projection.evaluation.policyDigest, CONTEXTUAL_PROMPT_VERSION, "medium"),
    contextual: true, contextualPromptVersion: CONTEXTUAL_PROMPT_VERSION, contextualThinking: "medium",
    inactivityGapMs: 1000, maxTurns: 100, maxEvidenceBytes: 100000, flushMaxAgeMs: 1000000, evidenceTtlMs: 72 * 3600000, deferDelayMs: 1000, maxInferenceCallsPerRun: 1,
    runner: { schema: "engram.memory-batch-shadow-runner-config.v2", requestedModel: projection.inference.model, maxTokens: 8192, temperature: 0, messageMode: "single-user" } };
  const failurePath = join(base, "failures", f.jobId.slice(7) + ".json"), oldJobPath = join(base, "jobs", f.jobId.slice(7) + ".json");
  const input = { workspace: f.workspace, storeRoot: f.storeRoot, oldJobId: f.jobId, expectedFailureId: read(failurePath).failureId as Digest,
    expectedSourceTraceIds: [f.traceId], targetPolicy, authorizedBy: "operator", authorizedAt: "2026-09-03T19:00:00.000Z", reason: "explicit quote producer repair",
    now: new Date("2026-09-03T20:00:00.000Z") };
  return { ...f, base, state, projection, projectionPath, qualityBody, qualityPath, targetPolicy, failurePath, oldJobPath, input,
    queuePath: join(state, "v1/queues/evaluator", f.traceId.slice(7) + ".json"), envelopePath: join(state, "v1/envelopes", f.traceId.slice(7) + ".json"),
    evidencePath: join(state, "v1/evidence", f.traceId.slice(7) + ".json") };
}
function snapshot(path: string): any { return Object.fromEntries(readdirSync(path, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name)).map(d => [d.name, d.isDirectory() ? snapshot(join(path,d.name)) : d.isSymbolicLink() ? readlinkSync(join(path,d.name)) : readFileSync(join(path,d.name),"utf8")])); }
function blockedWorker(f: ReturnType<typeof setup>) {
  return new BatchLiveWorker({ workspace: f.workspace, storeRoot: f.storeRoot, policy: f.targetPolicy,
    ledger: { acquireWorkerLease: () => true, releaseWorkerLease: () => {}, listQueue: () => { throw Error("ordinary_discovery_must_not_run"); } } as any,
    complete: async () => { throw Error("provider_must_not_run"); }, now: () => f.input.now });
}
test("dry run is read-only; explicit migration preserves original source/bundle/failure and creates only a new contextual job identity", () => {
  const f = setup(), before = snapshot(f.workspace), planned = migrateQuoteFailureToContextual(f.input);
  expect(planned.status).toBe("planned"); expect(snapshot(f.workspace)).toEqual(before);
  const origin = { envelope: read(f.envelopePath), evidence: read(f.evidencePath), job: read(f.oldJobPath), failure: read(f.failurePath), done: read(join(f.base, "done", f.jobId.slice(7) + ".json")) };
  const ready = migrateQuoteFailureToContextual({ ...f.input, apply: true });
  expect(ready.status).toBe("ready_for_evaluation"); expect(ready.canonicalWrites).toBe(0); expect(ready.inferenceRun).toBe(false);
  expect(ready.newJobId).not.toBe(f.jobId); const job = read(join(f.base, "jobs", ready.newJobId.slice(7) + ".json"));
  expect(job.bundle).toEqual(origin.job.bundle); expect(job.partition).toEqual(origin.job.partition); expect(job.createdAt).toBe(origin.job.createdAt);
  expect(read(f.envelopePath)).toEqual(origin.envelope); expect(read(f.evidencePath)).toEqual(origin.evidence);
  expect(read(f.failurePath)).toEqual(origin.failure); expect(read(join(f.base, "done", f.jobId.slice(7) + ".json"))).toEqual(origin.done);
  expect(read(f.queuePath)).toMatchObject({ status: "queued", attempt: 0, reasonCode: "operator_quote_producer_migration" });
  expect(sourceDebtSnapshot(f.workspace).openIds).toHaveLength(1); expect(producerMigrationBarrier(f.storeRoot, f.targetPolicy.exactScope)).toBeNull();
});
const stages: QuoteProducerMigrationFault[] = ["after_authorization", "after_debt", "after_failure_archive", "after_done_archive", "after_new_job", "after_queue_requeue", "before_completed", "after_completed"];
for (const faultAt of stages) test("crash-safe handoff and ordinary Worker barrier: " + faultAt, async () => {
  const f = setup(); expect(() => migrateQuoteFailureToContextual({ ...f.input, apply: true, faultAt })).toThrow("MIGRATION_FAULT_");
  if (faultAt !== "after_completed") {
    expect(producerMigrationBarrier(f.storeRoot, f.targetPolicy.exactScope)).toEqual({ reason: "producer_migration_incomplete" });
    expect(await blockedWorker(f).processOne()).toEqual({ status: "blocked", reason: "producer_migration_incomplete" });
  }
  const completed = migrateQuoteFailureToContextual({ ...f.input, apply: true });
  expect(completed.status).toBe("ready_for_evaluation"); expect(producerMigrationBarrier(f.storeRoot, f.targetPolicy.exactScope)).toBeNull();
  expect(readdirSync(join(f.base, "jobs"))).toHaveLength(2);
});
test("completed replay does not reset progressed queues, including after evidence TTL", () => {
  const f = setup(), ready = migrateQuoteFailureToContextual({ ...f.input, apply: true });
  const queue = { ...read(f.queuePath), status: "claimed", attempt: 1, claimToken: "new-worker", claimedAt: "2026-09-03T20:01:00.000Z" }; write(f.queuePath, queue);
  rmSync(f.evidencePath); expect(migrateQuoteFailureToContextual({ ...f.input, apply: true, now: new Date("2026-10-01T00:00:00Z") })).toEqual(ready);
  expect(read(f.queuePath)).toEqual(queue);
});
test("generic recovery still rejects literal quote mismatches; new path rejects every other failure", () => {
  const f = setup(); expect(() => recoverTerminalBatch({ workspace: f.workspace, storeRoot: f.storeRoot, jobId: f.jobId, authorizedBy: "operator", authorizedAt: f.input.authorizedAt, reason: "retry", now: f.input.now })).toThrow("not eligible");
  const wrong = setup("batch_invalid_json"); expect(() => migrateQuoteFailureToContextual({ ...wrong.input, apply: true })).toThrow("MIGRATION_FAILURE_INELIGIBLE");
});
for (const problem of ["expiry", "effects", "binding", "target_policy", "quality_drain", "target_model", "source_set", "future_authorization", "foreign_store"] as const)
test("negative preflight is nonmutating: " + problem, () => {
  const f = setup();
  if (problem === "expiry") f.input.now = new Date("2026-09-06T10:00:00Z");
  if (problem === "effects") write(join(f.state, "v1/observations/batch", sha256("obs").slice(7) + ".json"), { traceId: f.traceId });
  if (problem === "binding") { f.projection.bindings[0].scopeId = "changed"; write(f.projectionPath, f.projection); }
  if (problem === "target_policy") f.input.targetPolicy = { ...f.targetPolicy, evaluationPolicyDigest: sha256("wrong") };
  if (problem === "quality_drain") { const q = { ...f.qualityBody, mode: "drain" }; write(f.qualityPath, { ...q, digest: sha256(q) }); }
  if (problem === "target_model") f.input.targetPolicy = { ...f.targetPolicy, runner: { ...f.targetPolicy.runner, requestedModel: "openai/other" } };
  if (problem === "source_set") f.input.expectedSourceTraceIds = [sha256("foreign")];
  if (problem === "future_authorization") f.input.authorizedAt = "2026-09-04T20:00:00.000Z";
  if (problem === "foreign_store") f.input.storeRoot = f.workspace;
  const before = snapshot(f.workspace); expect(() => migrateQuoteFailureToContextual({ ...f.input, apply: true })).toThrow(); expect(snapshot(f.workspace)).toEqual(before);
});
test("a live evaluator lease rejects migration before any journal mutation", () => {
  const f = setup(), release = acquireRecoveryLock(join(f.state, "v1/locks/evaluator.worker"), sha256("regular-worker"));
  const before = snapshot(f.workspace);
  try { expect(() => migrateQuoteFailureToContextual({ ...f.input, apply: true })).toThrow("held"); expect(snapshot(f.workspace)).toEqual(before); }
  finally { release(); }
});
function twoSources() {
  const f = setup(), job = read(f.oldJobPath), envelope = read(f.envelopePath), evidence = read(f.evidencePath), queue = read(f.queuePath);
  const sourceTurnId = "channel-user:v1:" + "b".repeat(64), traceId = deriveTraceId("main", envelope.scope.runtimeSessionKey, sourceTurnId);
  const evidence2 = { ...evidence, traceId, payload: { user: "synthetic second source" } };
  const identity2 = { schema: evidence2.schema, traceId, scope: evidence2.scope, payload: evidence2.payload };
  const envelope2 = { ...envelope, traceId, sourceTurnId, sourceDigest: deriveSourceDigest(sourceTurnId, envelope.scope, envelope.sourceCompletedAt), evidenceDigest: sha256(identity2),
    evidenceRefs: [{ kind: "source-turn", ref: sourceTurnId, digest: sha256("second source") }] };
  const cpDir = join(f.state, "v1/pre-admission/checkpoints"), cp = read(join(cpDir, readdirSync(cpDir)[0]!));
  const candidateId = deriveAdmissionCandidateId({ workspaceId: "main", runtimeSessionKey: envelope.scope.runtimeSessionKey, channel: "telegram", inboundMessageId: "2" });
  const { checkpointDigest, ...cpBase } = cp, next = { ...cpBase, candidateId, inboundMessageId: "2", sourceTurnId, runId: "run-second" };
  write(join(cpDir, candidateId.slice(7) + ".json"), { ...next, checkpointDigest: sha256(next) });
  write(join(f.state, "v1/envelopes", traceId.slice(7) + ".json"), envelope2);
  write(join(f.state, "v1/evidence", traceId.slice(7) + ".json"), evidence2);
  write(join(f.state, "v1/queues/evaluator", traceId.slice(7) + ".json"), { ...queue, traceId });
  const bundle = compileBatchFrame({ schema: "engram.memory-batch-source-frame.v1", partition: job.partition, sealedAt: job.createdAt,
    sources: [{ envelope, evidence }, { envelope: envelope2, evidence: evidence2 }].sort((a,b) => a.envelope.traceId.localeCompare(b.envelope.traceId)) }, { schema: "engram.memory-batch-compiler-config.v1", inactivityGapMs: 1000,
    maxTurns: 100, maxEvidenceBytes: 100000, maxAgeMs: 1000 }).bundles[0]!;
  const oldJobId = sha256({ schema: job.schema, partition: job.partition, evaluationPolicyDigest: job.evaluationPolicyDigest, bundleId: bundle.bundleId });
  const nextJob = { ...job, jobId: oldJobId, bundle }, { failureId, ...oldFailureBase } = read(f.failurePath);
  const failureBase = { ...oldFailureBase, jobId: oldJobId, bundleId: bundle.bundleId, traceIds: bundle.sourceRefs.map(s => s.traceId) }, failure = { ...failureBase, failureId: sha256(failureBase) };
  rmSync(f.oldJobPath); rmSync(f.failurePath); rmSync(join(f.base, "done", f.jobId.slice(7) + ".json"));
  const oldJobPath = join(f.base, "jobs", oldJobId.slice(7) + ".json"), failurePath = join(f.base, "failures", oldJobId.slice(7) + ".json");
  write(oldJobPath, nextJob); write(failurePath, failure); write(join(f.base, "done", oldJobId.slice(7) + ".json"), failure);
  return { ...f, jobId: oldJobId, oldJobPath, failurePath, input: { ...f.input, oldJobId, expectedFailureId: failure.failureId, expectedSourceTraceIds: failureBase.traceIds } };
}
test("crash halfway through a two-source queue reset cannot be claimed by a regular Worker", async () => {
  const f = twoSources(); expect(() => migrateQuoteFailureToContextual({ ...f.input, apply: true, faultAt: "after_queue_requeue" })).toThrow();
  const statuses = f.input.expectedSourceTraceIds.map(id => read(join(f.state, "v1/queues/evaluator", id.slice(7) + ".json")).status).sort();
  expect(statuses).toEqual(["queued", "terminal"]); expect(await blockedWorker(f).processOne()).toEqual({ status: "blocked", reason: "producer_migration_incomplete" });
  expect(migrateQuoteFailureToContextual({ ...f.input, apply: true }).status).toBe("ready_for_evaluation");
  expect(sourceDebtSnapshot(f.workspace).openIds).toHaveLength(2);
  expect(f.input.expectedSourceTraceIds.map(id => read(join(f.state, "v1/queues/evaluator", id.slice(7) + ".json")).status)).toEqual(["queued", "queued"]);
});
for (const change of ["evidence", "binding", "effects", "expiry"] as const) test("mutation preconditions are repeated inside evaluator lock: " + change, () => {
  const f = setup(), originalQueue = read(f.queuePath);
  const beforeLock = () => {
    if (change === "evidence") write(f.evidencePath, { ...read(f.evidencePath), expiresAt: "2026-09-05T10:00:00.000Z" });
    if (change === "binding") { f.projection.bindings[0].scopeId = "changed"; write(f.projectionPath, f.projection); }
    if (change === "effects") write(join(f.state, "v1/receipts/by-operation", sha256("effect").slice(7) + ".json"), { traceId: f.traceId });
    if (change === "expiry") f.input.now.setTime(Date.parse("2026-09-06T10:00:00Z"));
  };
  expect(() => migrateQuoteFailureToContextual({ ...f.input, apply: true, beforeLock })).toThrow();
  expect(read(f.queuePath)).toEqual(originalQueue); expect(existsSync(producerMigrationRoot(f.storeRoot, f.targetPolicy.exactScope))).toBe(false);
});
test("a different operation cannot bypass an already incomplete exact-scope journal", () => {
  const f = setup(); expect(() => migrateQuoteFailureToContextual({ ...f.input, apply: true, faultAt: "after_authorization" })).toThrow();
  expect(() => migrateQuoteFailureToContextual({ ...f.input, apply: true, reason: "another operation" })).toThrow("MIGRATION_OTHER_INCOMPLETE");
  expect(readdirSync(producerMigrationRoot(f.storeRoot, f.targetPolicy.exactScope))).toHaveLength(1);
  expect(read(f.queuePath).status).toBe("terminal");
});
test("corrupt durable handoff receipt stays blocked and cannot be replayed", async () => {
  const f = setup(), ready = migrateQuoteFailureToContextual({ ...f.input, apply: true });
  const dir = join(producerMigrationRoot(f.storeRoot, f.targetPolicy.exactScope), ready.migrationId.slice(7));
  const completed = read(join(dir, "completed.json")); write(join(dir, "completed.json"), { ...completed, newJobDigest: sha256("forged") });
  expect(await blockedWorker(f).processOne()).toEqual({ status: "blocked", reason: "producer_migration_invalid" });
  expect(() => migrateQuoteFailureToContextual({ ...f.input, apply: true })).toThrow("MIGRATION_COMPLETION_INVALID");
});
test("migration then a valid v2 semantic skip closes original exact debt while original failure remains readable", () => {
  const f = setup(), beforeFailure = read(f.failurePath), ready = migrateQuoteFailureToContextual({ ...f.input, apply: true });
  expect(sourceDebtSnapshot(f.workspace).openIds).toHaveLength(1);
  const job = read(join(f.base, "jobs", ready.newJobId.slice(7) + ".json"));
  // Same exact immutable artifacts generated by the existing contextual evaluator
  // for this synthetic semantic skip; this is not an injected queue-only success.
  const output = { schema: "engram.memory-contextual-output.v2", assertions: [], dispositions: [{ traceId: f.traceId, kind: "skip", assertionIds: [], reason: "Synthetic acknowledgement has no durable fact." }] };
  const observation = buildContextualObservation(output, job.bundle, sha256("contextual-request-policy"), f.input.now);
  const evaluated = { observation, requestDigest: sha256("validated-contextual-request"), usage: null, latencyMs: 0 };
  const body = { schema: "engram.memory-contextual-result.v2", jobId: job.jobId, policyDigest: job.evaluationPolicyDigest, evaluated };
  write(join(f.base, "contextual-results", job.jobId.slice(7) + ".json"), { ...body, digest: sha256(body) });
  const terminalBase = { schema: "engram.memory-batch-live-terminal.v2", jobId: job.jobId, bundleId: job.bundle.bundleId,
    resultKey: sha256({ schema: "engram.memory-contextual-result-key.v2", requestDigest: evaluated.requestDigest }), resultDigest: sha256(evaluated),
    dispositions: [{ traceId: f.traceId, decision: "skip", reasonCode: "semantic_contextual_skip", observationRefs: [] }], sourceDispositions: observation.dispositions, completedAt: observation.recordedAt };
  const terminal = { ...terminalBase, terminalId: sha256(terminalBase) };
  write(join(f.base, "terminals", job.jobId.slice(7) + ".json"), terminal); write(join(f.base, "done", job.jobId.slice(7) + ".json"), terminal);
  write(f.queuePath, { ...read(f.queuePath), status: "terminal", attempt: 1, reasonCode: "semantic_contextual_skip", terminalAt: observation.recordedAt });
  const closed = scanSourceDebt(f.workspace, f.input.now); expect(closed).toMatchObject({ corrupt: false, openIds: [] }); expect(closed.closedIds).toHaveLength(1);
  expect(read(f.failurePath)).toEqual(beforeFailure); expect(read(join(f.base, "done", f.jobId.slice(7) + ".json"))).toEqual(beforeFailure);
  expect(readdirSync(join(f.base, "done"))).toHaveLength(2);
});
test("self-consistent retry snapshot tampering cannot alter deterministic queue reset on resume", () => {
  const f = setup(); expect(() => migrateQuoteFailureToContextual({ ...f.input, apply: true, faultAt: "after_authorization" })).toThrow();
  const scopeDir = producerMigrationRoot(f.storeRoot, f.targetPolicy.exactScope), dir = join(scopeDir, readdirSync(scopeDir)[0]!), file = join(dir, "authorization.json");
  const auth = read(file); auth.queues[0].requeued.maxAttempts = 1000; auth.queues[0].requeuedDigest = sha256(auth.queues[0].requeued);
  const { authorizationId, ...body } = auth; auth.authorizationId = sha256(body); write(file, auth);
  expect(() => migrateQuoteFailureToContextual({ ...f.input, apply: true })).toThrow("MIGRATION_AUTHORIZATION_INVALID");
  expect(read(f.queuePath)).toMatchObject({ status: "terminal", maxAttempts: 2 });
});
