import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveSourceDigest, deriveTraceId, purgeMemoryObservationLifecycle, sha256 } from "./ledger.ts";
import { assertSourceDebtPurgeSafe, scanSourceDebt, sourceDebtSnapshot } from "./source-debt.ts";
import { AdmissionStore } from "./admission-store.ts";
import { RUNTIME_AUTHORITY, RUNTIME_POLICY } from "./runtime-authority.ts";
import { memoryWorkerHealth } from "./worker-health.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "debt-synthetic-")); roots.push(workspace);
  const base = join(workspace, "memory-state/memory-observation"), op = join(base, "v1"), at = "2026-01-01T00:00:00.000Z";
  const scope = { workspaceId: "alpha", runtimeSessionKey: "agent:alpha:telegram:group:-1000000001:topic:2", scopeClass: "project" as const, scopeId: "domain:alpha:synthetic" };
  const sourceTurnId = "channel-user:v1:" + "a".repeat(64), traceId = deriveTraceId(scope.workspaceId, scope.runtimeSessionKey, sourceTurnId);
  const put = (file: string, value: any) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };
  put(join(workspace, "engram.json"), { workspace: { id: "alpha" } });
  const evidence = { source: { role: "user", text: "Synthetic status confirmation.", actorId: "100000001" }, outcome: { role: "assistant", text: "Acknowledged.", status: "reported_not_verified" } };
  const evidenceRef = { kind: "source-turn", ref: sourceTurnId, digest: sha256("evidence-ref") };
  const envelope = { schema: "engram.memory-observation-job.v1", traceId, sourceTurnId, scope, sourceCompletedAt: at,
    sourceDigest: deriveSourceDigest(sourceTurnId, scope, at), evidenceDigest: sha256({ schema: "engram.memory-evidence-envelope.v1", traceId, scope, payload: evidence }),
    policyVersion: "v1", policyDigest: sha256(RUNTIME_POLICY), evidenceRefs: [evidenceRef], authority: RUNTIME_AUTHORITY, admittedAt: at };
  const queueFile = join(op, "queues/evaluator", traceId.slice(7) + ".json"), envelopeFile = join(op, "envelopes", traceId.slice(7) + ".json");
  const queue = { schema: "engram.memory-observation-ledger-queue.v1", traceId, queueClass: "evaluator", status: "terminal", reasonCode: "batch_invalid_json", createdAt: at, updatedAt: at, terminalAt: at };
  put(envelopeFile, envelope); put(queueFile, queue);
  function skip(reasonCode = "semantic_batch_skip") {
    put(queueFile, { ...queue, reasonCode });
    const partition = { ...scope, policyDigest: envelope.policyDigest, producerEpoch: "v1" }, evaluationPolicyDigest = sha256("evaluation");
    const source = { traceId, sourceTurnId, sourceDigest: envelope.sourceDigest, evidenceDigest: envelope.evidenceDigest, sourceCompletedAt: at };
    const bundleId = sha256({ schema: "engram.memory-batch-bundle.v1", partition, policyDigest: envelope.policyDigest, sourceRefs: [source] });
    const bundle = { schema: "engram.memory-batch-bundle.v1", bundleId, partition, policyDigest: envelope.policyDigest, sourceRefs: [source],
      inputs: [{ traceId, evidenceRefs: [evidenceRef], evidence, expiresAt: "2026-01-04T00:00:00.000Z" }], evidenceBytes: Buffer.byteLength(JSON.stringify(evidence)) };
    const jobId = sha256({ schema: "engram.memory-batch-live-job.v1", partition, evaluationPolicyDigest, bundleId });
    const job = { schema: "engram.memory-batch-live-job.v1", jobId, partition, evaluationPolicyDigest, bundle, createdAt: at };
    const group = { groupId: "g1", decision: "skip", sourceRefs: [traceId], reason: "status_acknowledgement" };
    const requestDigest = sha256("request"), resultKey = sha256("engram.memory-batch-shadow-result-key.v1\0" + requestDigest);
    const result = { schema: "engram.memory-batch-shadow-result.v1", resultKey, requestDigest, bundleId, partition, sourceRefs: [source], groups: [group],
      outputDigest: sha256({ schema: "engram.memory-batch-shadow-output.v1", groups: [group] }), completedAt: at };
    put(join(base, "batch-live-store/memory-batch-shadow/v1/results", resultKey.slice(7) + ".json"), result);
    const body = { schema: "engram.memory-batch-live-terminal.v1", jobId, bundleId, resultKey, resultDigest: sha256(result), dispositions: [{ traceId, decision: "skip", reasonCode, observationRefs: [] }], completedAt: at };
    const done = { ...body, terminalId: sha256(body) }, batch = join(base, "batch-live-store/memory-batch-live/v1");
    put(join(batch, "jobs", jobId.slice(7) + ".json"), job);
    put(join(batch, "terminals", jobId.slice(7) + ".json"), done);
    put(join(batch, "done", jobId.slice(7) + ".json"), done);
    return { batch, job, done, doneFile: join(batch, "done", jobId.slice(7) + ".json") };
  }
  return { workspace, base, op, at, scope, sourceTurnId, traceId, envelope, envelopeFile, queueFile, queue, put, skip };
}
test("immutable exact source failure survives empty queues, 72h evidence and 31d queue purge", () => {
  const f = fixture(), initial = scanSourceDebt(f.workspace, new Date(f.at));
  expect(initial.openIds).toHaveLength(1); expect(initial.closedIds).toHaveLength(0);
  expect(scanSourceDebt(f.workspace, new Date("2026-01-02T00:00:00Z")).openIds).toEqual(initial.openIds);
  const failures = join(f.base, "source-debt/v1/failures"); expect(readdirSync(failures)).toHaveLength(1);
  f.put(join(f.op, "evidence", f.traceId.slice(7) + ".json"), { traceId: f.traceId, createdAt: f.at, expiresAt: "2026-01-04T00:00:00Z", payload: "synthetic-secret-not-to-copy" });
  purgeMemoryObservationLifecycle(f.workspace, new Date("2026-02-02T00:00:00Z"));
  expect(existsSync(f.queueFile)).toBe(false); expect(existsSync(f.envelopeFile)).toBe(false);
  expect(sourceDebtSnapshot(f.workspace).openIds).toEqual(initial.openIds);
  expect(memoryWorkerHealth(f.workspace)).toMatchObject({ status: "degraded", pending: 0, sourceDebtOpen: 1 });
  expect(readFileSync(join(failures, readdirSync(failures)[0]!), "utf8")).not.toContain("synthetic-secret-not-to-copy");
});
test("requeued, successful process and broad semantic terminal reason cannot close exact source debt", () => {
  const f = fixture(); scanSourceDebt(f.workspace);
  for (const reasonCode of [null, "semantic_batch_write", "semantic_contextual_supports", "semantic_contextual_duplicate", "semantic_batch_grouped_no_assertion"]) {
    f.put(f.queueFile, { ...f.queue, status: reasonCode ? "terminal" : "queued", reasonCode });
    expect(scanSourceDebt(f.workspace).openIds).toHaveLength(1);
  }
});
test("exact immutable semantic skip closes debt; certificate survives purging proof artifacts", () => {
  const f = fixture(); scanSourceDebt(f.workspace); f.skip();
  const closed = scanSourceDebt(f.workspace);
  expect(closed.closedIds).toHaveLength(1); expect(closed.openIds).toHaveLength(0);
  rmSync(f.op, { recursive: true }); rmSync(join(f.base, "batch-live-store"), { recursive: true });
  expect(sourceDebtSnapshot(f.workspace).closedIds).toEqual(closed.closedIds);
});
test("tampered terminal, wrong source, wrong scope and absent immutable terminal remain open", () => {
  for (const mode of ["tampered", "wrong_source", "wrong_scope", "missing"]) {
    const f = fixture(); scanSourceDebt(f.workspace); const proof = f.skip();
    if (mode === "tampered") f.put(proof.doneFile, { ...proof.done, completedAt: "2027-01-01T00:00:00Z" });
    if (mode === "wrong_source") { proof.job.bundle.sourceRefs[0]!.sourceTurnId = "channel-user:v1:" + "b".repeat(64); f.put(join(proof.batch, "jobs", proof.job.jobId.slice(7) + ".json"), proof.job); }
    if (mode === "wrong_scope") { proof.job.partition.scopeId = "domain:alpha:other"; f.put(join(proof.batch, "jobs", proof.job.jobId.slice(7) + ".json"), proof.job); }
    if (mode === "missing") rmSync(join(proof.batch, "terminals"), { recursive: true });
    expect(scanSourceDebt(f.workspace).openIds).toHaveLength(1);
  }
});
test("corrupt administrative metadata degrades health and blocks guard before raw evidence deletion", () => {
  const f = fixture(); scanSourceDebt(f.workspace);
  f.put(join(f.base, "source-debt/v1/failures/bad.json"), { schema: "wrong" });
  expect(sourceDebtSnapshot(f.workspace).corrupt).toBe(true);
  expect(memoryWorkerHealth(f.workspace).status).toBe("degraded");
  expect(() => assertSourceDebtPurgeSafe(f.workspace)).toThrow(); expect(existsSync(f.envelopeFile)).toBe(true);
});
test("record and byte caps fail closed; never evict unresolved metadata", () => {
  const f = fixture();
  expect(() => scanSourceDebt(f.workspace, new Date(), { maxRecords: 0 })).toThrow("DEBT_CAPACITY_EXCEEDED");
  expect(() => scanSourceDebt(f.workspace, new Date(), { maxBytes: 1 })).toThrow("DEBT_CAPACITY_EXCEEDED");
  scanSourceDebt(f.workspace); expect(sourceDebtSnapshot(f.workspace).openIds).toHaveLength(1);
  expect(() => scanSourceDebt(f.workspace, new Date(), { maxRecords: 0 })).toThrow("DEBT_CAPACITY_EXCEEDED");
  expect(sourceDebtSnapshot(f.workspace).openIds).toHaveLength(1);
});
test("expired unfinished source remains distinct debt rather than justified skip", () => {
  const f = fixture(); f.put(f.queueFile, { ...f.queue, status: "queued", terminalAt: null, reasonCode: null });
  expect(scanSourceDebt(f.workspace, new Date("2026-01-02T00:00:00Z")).debtIds).toHaveLength(0);
  expect(scanSourceDebt(f.workspace, new Date("2026-01-04T00:00:01Z")).openIds).toHaveLength(1);
});
test("admission gaps are completion-unverified; failed run is not claimed a completed source", () => {
  const f = fixture(); rmSync(f.queueFile);
  for (const reasonCode of ["run_failed", "restart_before_completion"]) {
    const candidateId = sha256(reasonCode), body = { schema: "engram.memory-admission-gap-receipt.v1", candidateId, scope: f.scope, reasonCode, terminalAt: f.at };
    f.put(join(f.op, "receipts/admission-gap", candidateId.slice(7) + ".json"), { ...body, receiptDigest: sha256(body) });
  }
  expect(scanSourceDebt(f.workspace).openIds).toHaveLength(2);
  const directory = join(f.base, "source-debt/v1/failures"), records = readdirSync(directory).map(n => JSON.parse(readFileSync(join(directory, n), "utf8")));
  expect(records.map(r => r.classification).sort()).toEqual(["completion_unverified_gap", "failed_run"]);
  expect(records.every(r => r.identity.kind === "candidate" && r.sourceTurnId === null)).toBe(true);
});
test("scope mismatch fails closed instead of moving debt across workspace ownership", () => {
  const f = fixture(); f.put(f.envelopeFile, { ...f.envelope, scope: { ...f.scope, workspaceId: "foreign" } });
  expect(() => scanSourceDebt(f.workspace)).toThrow(); expect(existsSync(f.queueFile)).toBe(true);
});
test("snapshot digest binds exactly the exported technical completeness envelope", () => {
  const f = fixture(); const { snapshotDigest, ...base } = scanSourceDebt(f.workspace);
  expect(snapshotDigest).toBe(sha256(base)); expect(base.workspaceId).toBe("alpha");
});

test("exclusive writer protocol never steals a live writer lease", async () => {
  const f = fixture(), { acquireProcessLease } = await import("./process-lease.ts");
  const release = acquireProcessLease(join(f.base, "source-debt/v1/writer.lock"))!;
  try { expect(() => scanSourceDebt(f.workspace)).toThrow("DEBT_WRITER_BUSY"); }
  finally { release(); }
  expect(scanSourceDebt(f.workspace).openIds).toHaveLength(1);
});
test("expired checkpoint and a terminal gap with lost receipt get candidate debt, never completed-source status", () => {
  const f = fixture(); rmSync(f.queueFile);
  for (const stage of ["received", "terminal_gap"]) {
    const candidateId = sha256(stage), body = { schema: "engram.memory-admission-checkpoint.v1", candidateId, scope: f.scope,
      sourceText: "synthetic-business-text-must-not-be-copied", stage, createdAt: f.at, updatedAt: f.at, expiresAt: "2026-01-04T00:00:00Z" };
    f.put(join(f.op, "pre-admission/checkpoints", candidateId.slice(7) + ".json"), { ...body, checkpointDigest: sha256(body) });
  }
  expect(scanSourceDebt(f.workspace, new Date("2026-01-05T00:00:00Z")).openIds).toHaveLength(2);
  const directory = join(f.base, "source-debt/v1/failures");
  for (const file of readdirSync(directory)) {
    const saved = readFileSync(join(directory, file), "utf8"); expect(saved).not.toContain("synthetic-business-text");
    expect(JSON.parse(saved).classification).toBe("completion_unverified_gap");
  }
});

test("same exact source identity with changed source proof fails closed, preserving original failure", () => {
  const f = fixture(), before = scanSourceDebt(f.workspace);
  f.put(f.envelopeFile, { ...f.envelope, evidenceDigest: sha256("changed-evidence") });
  expect(() => scanSourceDebt(f.workspace)).toThrow("DEBT_SOURCE_CONFLICT");
  expect(sourceDebtSnapshot(f.workspace).openIds).toEqual(before.openIds);
});

test("orphan temporary metadata blocks destructive lifecycle rather than hiding failed publication", () => {
  const f = fixture(); scanSourceDebt(f.workspace);
  f.put(join(f.base, "source-debt/v1/failures/orphan.tmp-synthetic"), { administrative: "metadata-only" });
  expect(sourceDebtSnapshot(f.workspace)).toMatchObject({ corrupt: true, errors: ["DEBT_UNEXPECTED_METADATA"] });
  expect(() => assertSourceDebtPurgeSafe(f.workspace)).toThrow("DEBT_UNEXPECTED_METADATA");
  expect(existsSync(f.queueFile)).toBe(true);
});
test("capacity is checked before attempting to parse oversized administrative records", () => {
  const f = fixture(), file = join(f.base, "source-debt/v1/failures", "f".repeat(64) + ".json");
  mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "invalid-json".repeat(50));
  expect(() => scanSourceDebt(f.workspace, new Date(), { maxBytes: 20 })).toThrow("DEBT_CAPACITY_EXCEEDED");
});

test("authorized recovery archive seeds original exact failure even when every live queue is already requeued", () => {
  const f = fixture(), { batch, job } = f.skip();
  rmSync(join(batch, "done"), { recursive: true }); rmSync(join(batch, "terminals"), { recursive: true });
  f.put(f.queueFile, { ...f.queue, status: "queued", terminalAt: null, attempt: 0, reasonCode: "operator_recovery_requeued" });
  const failureBody = { schema: "engram.memory-batch-live-failure.v1", jobId: job.jobId, bundleId: job.bundle.bundleId,
    errorCode: "batch_invalid_json", traceIds: [f.traceId], completedAt: f.at };
  const failure = { ...failureBody, failureId: sha256(failureBody) };
  const authorizedBy = "operator", authorizedAt = "2026-01-02T00:00:00.000Z", reason = "synthetic recovery";
  const recoveryId = sha256({ schema: "engram.memory-batch-terminal-recovery.v1", jobId: job.jobId, authorizedBy, authorizedAt, reason });
  const original = f.queue, requeued = { ...f.queue, status: "queued", terminalAt: null, attempt: 0, reasonCode: "operator_recovery_requeued" };
  const auth = { schema: "engram.memory-batch-terminal-recovery-authorization.v1", recoveryId, jobId: job.jobId,
    bundleId: job.bundle.bundleId, failureCode: "batch_invalid_json", traceIds: [f.traceId], authorizedBy, authorizedAt, reason,
    failureDigest: sha256(failure), doneDigest: sha256(failure), queues: [{ traceId: f.traceId, original, originalDigest: sha256(original), requeued, requeuedDigest: sha256(requeued) }] };
  const archive = join(batch, "recoveries", job.jobId.slice(7), recoveryId.slice(7));
  f.put(join(archive, "authorization.json"), auth); f.put(join(archive, "failure.json"), failure); f.put(join(archive, "done.json"), failure);
  const snapshot = scanSourceDebt(f.workspace, new Date(authorizedAt));
  expect(snapshot.openIds).toHaveLength(1); expect(snapshot.closedIds).toHaveLength(0);
  expect(scanSourceDebt(f.workspace, new Date(authorizedAt)).debtIds).toEqual(snapshot.debtIds);
  const failures = join(f.base, "source-debt/v1/failures"), record = JSON.parse(readFileSync(join(failures, readdirSync(failures)[0]!), "utf8"));
  expect(record.reasonCode).toBe("batch_invalid_json"); expect(record.batchParents[0].failureDigest).toBe(sha256(failure));
  rmSync(f.envelopeFile); rmSync(f.queueFile);
  expect(scanSourceDebt(f.workspace, new Date("2026-02-03T00:00:00Z")).openIds).toEqual(snapshot.openIds);
});

test("candidate identity only links through exact immutable admission recovery and closes after verified disposition, not admission", () => {
  const f = fixture(), store = new AdmissionStore(f.workspace, RUNTIME_AUTHORITY);
  f.put(f.queueFile, { ...f.queue, status: "queued", terminalAt: null, reasonCode: null });
  const cp = store.recordCheckpoint({ scope: f.scope, bindingFingerprint: sha256("binding"), channel: "telegram", inboundMessageId: "42", actorId: "100000001",
    replyToId: null, sourceTurnId: null, runId: null, sessionId: null, sourceText: null, stage: "received", now: new Date(f.at) }).checkpoint;
  store.publishGapReceipt({ checkpoint: cp, failureStage: "received", reasonCode: "identity_ambiguous", terminalAt: new Date("2026-01-01T00:01:00.000Z") });
  const checkpoint = store.readCheckpoint(cp.candidateId)!, gap = store.readGapReceiptForCandidate(cp.candidateId)!;
  const body = { schema: "engram.memory-admission-gap-recovery.v1", candidateId: cp.candidateId, gapReceiptDigest: gap.receiptDigest, checkpointDigest: checkpoint.checkpointDigest,
    inventoryDigest: sha256("inventory"), recordDigest: sha256("record"), scope: f.scope, sourceTurnId: f.sourceTurnId, runId: "run", sessionId: "session",
    authorizedBy: "operator", authorizedAt: "2026-01-01T00:02:00.000Z", reason: "synthetic exact source recovery" };
  const recoveryId = sha256(body), authorization = { ...body, recoveryId, traceId: f.traceId, sourceDigest: sha256("trustedSource") };
  const result = { schema: body.schema, status: "admitted", candidateId: cp.candidateId, recoveryId, traceId: f.traceId, messageId: "42", canonicalWrites: 0, inferenceRun: false };
  const recoveryRoot = join(f.op, "receipts/admission-recovery", cp.candidateId.slice(7));
  f.put(join(recoveryRoot, "authorization.json"), authorization);
  f.put(join(recoveryRoot, "completed.json"), { result, authorizationDigest: sha256(authorization), envelopeDigest: sha256(f.envelope) });
  const at = new Date("2026-01-01T00:05:00.000Z");
  const admitted = scanSourceDebt(f.workspace, at); expect(admitted.openIds).toHaveLength(1); expect(admitted.closedIds).toHaveLength(0);
  expect(readdirSync(join(f.base, "source-debt/v1/links"))).toHaveLength(1);
  f.skip(); const closed = scanSourceDebt(f.workspace, at); expect(closed.openIds).toHaveLength(0); expect(closed.closedIds).toEqual(admitted.debtIds);
  rmSync(f.op, { recursive: true }); rmSync(join(f.base, "batch-live-store"), { recursive: true });
  expect(sourceDebtSnapshot(f.workspace, at)).toMatchObject({ corrupt: false, openIds: [], closedIds: closed.closedIds });
});


test("exact legacy fourteen-field debt retains original hash and immutable bytes through closure and proof retention", () => {
  const f = fixture(); scanSourceDebt(f.workspace, new Date(f.at));
  const failures = join(f.base, "source-debt/v1/failures"), currentPath = join(failures, readdirSync(failures)[0]!);
  const current = JSON.parse(readFileSync(currentPath, "utf8")), { recordId, batchParents, ...legacyBody } = current;
  const legacy = { ...legacyBody, recordId: sha256(legacyBody) }, legacyPath = join(failures, sha256(legacyBody).slice(7) + ".json");
  rmSync(currentPath); f.put(legacyPath, legacy);
  const bytes = readFileSync(legacyPath, "utf8"); expect(Object.keys(legacy)).toHaveLength(14);
  expect(sourceDebtSnapshot(f.workspace, new Date(f.at))).toMatchObject({ corrupt: false, openIds: [legacy.debtId] });
  f.skip(); const closed = scanSourceDebt(f.workspace, new Date("2026-01-02T00:00:00Z"));
  expect(closed.closedIds).toEqual([legacy.debtId]); expect(readFileSync(legacyPath, "utf8")).toBe(bytes);
  rmSync(f.op, { recursive: true, force: true });
  expect(sourceDebtSnapshot(f.workspace, new Date("2026-03-01T00:00:00Z"))).toMatchObject({ corrupt: false, closedIds: [legacy.debtId] });
  expect(readFileSync(legacyPath, "utf8")).toBe(bytes);
});
test("legacy debt compatibility rejects unknown fields and mismatched original digest", () => {
  for (const change of ["unknown", "digest", "null-parents"] as const) {
    const f = fixture(); scanSourceDebt(f.workspace, new Date(f.at));
    const failures = join(f.base, "source-debt/v1/failures"), file = join(failures, readdirSync(failures)[0]!);
    const { recordId, batchParents, ...body } = JSON.parse(readFileSync(file, "utf8"));
    const altered = { ...body, ...(change === "unknown" ? { payload: "forbidden" } : change === "null-parents" ? { batchParents: null } : {}) };
    const record = { ...altered, recordId: change === "digest" ? recordId : sha256(altered) };
    rmSync(file); f.put(join(failures, record.recordId.slice(7) + ".json"), record);
    expect(sourceDebtSnapshot(f.workspace, new Date(f.at)).corrupt).toBe(true);
    expect(() => scanSourceDebt(f.workspace, new Date(f.at))).toThrow();
  }
});
