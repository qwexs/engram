import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryWorkerHealth } from "./worker-health.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "worker-health-")); roots.push(root);
  const put = (dir: string, name: string, value: any) => { const path = join(root, "memory-state/memory-observation/v1", dir);
    mkdirSync(path, { recursive: true }); const schemas: Record<string, string> = { "queues/evaluator": "engram.memory-observation-ledger-queue.v1", "consumers/daily-note/queue": "engram.memory-observation-consumer-queue.v1", "pre-admission/checkpoints": "engram.memory-admission-checkpoint.v1" };
    writeFileSync(join(path, name + ".json"), JSON.stringify(value && typeof value === "object" && schemas[dir] ? { schema: schemas[dir], ...value } : value)); };
  return { root, put };
}
test("terminal JSON failure and pre-admission gap remain visible even with an empty pending queue", () => {
  const f = fixture();
  f.put("queues/evaluator", "a", { status: "terminal", reasonCode: "batch_invalid_json" });
  f.put("pre-admission/checkpoints", "b", { stage: "terminal_gap" });
  expect(memoryWorkerHealth(f.root)).toMatchObject({ status: "degraded", pending: 0, terminalFailures: 1, admissionGaps: 1 });
});
test("legitimate skips and successful applications are not failures", () => {
  const f = fixture();
  f.put("queues/evaluator", "a", { status: "terminal", reasonCode: "semantic_batch_skip" });
  f.put("consumers/daily-note/queue", "b", { status: "terminal", reasonCode: "canonical_applied" });
  expect(memoryWorkerHealth(f.root).status).toBe("ok");
});
test("historical native-command gaps remain visible separately from conversational loss", () => {
  const f = fixture();
  f.put("pre-admission/checkpoints", "command", { stage: "terminal_gap", scope: { runtimeSessionKey: "agent:alpha:telegram:slash:100000001" } });
  expect(memoryWorkerHealth(f.root)).toMatchObject({ status: "ok", admissionGaps: 0, historicalAdmissionGaps: 1, nativeCommandGaps: 1 });
  f.put("pre-admission/checkpoints", "conversation", { stage: "terminal_gap", scope: { runtimeSessionKey: "agent:alpha:telegram:direct:100000001" } });
  expect(memoryWorkerHealth(f.root)).toMatchObject({ status: "degraded", admissionGaps: 1, historicalAdmissionGaps: 2, nativeCommandGaps: 1 });
});
test("waiting context is distinguished from technical failure and reports age", () => {
  const f = fixture(), traceId = "sha256:" + "a".repeat(64);
  f.put("queues/evaluator", "a", { traceId, status: "queued", reasonCode: "semantic_batch_defer", createdAt: "2026-09-07T12:00:00Z" });
  f.put("evidence", traceId.slice(7), { traceId, expiresAt: "2026-09-10T12:00:00.000Z" });
  expect(memoryWorkerHealth(f.root, new Date("2026-09-07T14:00:00Z"))).toMatchObject({ status: "waiting_context", waitingContext: 1, expiredWaitingContext: 0,
    oldestPendingAgeSeconds: 7200, stages: { evaluator: { stale: 0, overdue: 0 } } });
  expect(memoryWorkerHealth(f.root, new Date("2026-09-11T12:00:00Z"))).toMatchObject({ status: "degraded", expiredWaitingContext: 1,
    stages: { evaluator: { stale: 1, overdue: 1 } }, reasons: ["semantic_batch_defer_expired"] });
});
test("absent state is not observed, not an empty healthy worker", () => {
  expect(memoryWorkerHealth(fixture().root).status).toBe("not_observed");
});
test("fresh technical pending is pending, while old evaluator work is degraded", () => {
  const f = fixture();
  f.put("queues/evaluator", "a", { status: "queued", createdAt: "2026-09-07T12:00:00Z" });
  expect(memoryWorkerHealth(f.root, new Date("2026-09-07T12:01:00Z")).status).toBe("pending");
  expect(memoryWorkerHealth(f.root, new Date("2026-09-14T12:00:00Z"))).toMatchObject({ status: "degraded", pending: 1 });
});
test("QMD-only pending, expired claims, admission and jobs without done are accounted independently", () => {
  const f = fixture(), now = new Date("2026-09-07T14:00:00Z"), createdAt = "2026-09-07T12:00:00Z";
  f.put("consumers/daily-note/queue", "qmd", { status: "qmd_pending", createdAt });
  f.put("consumers/daily-note/queue", "claim", { status: "claimed", claimedAt: createdAt, createdAt });
  f.put("pre-admission/checkpoints", "admission", { stage: "received", createdAt });
  f.put("../batch-live-store/memory-batch-live/v1/jobs", "job", { jobId: "job", createdAt });
  expect(memoryWorkerHealth(f.root, now)).toMatchObject({ status: "degraded", pending: 0, totalPending: 4, qmdPending: 1, expiredClaims: 1, admissionPending: 1, batchPending: 1 });
});
test("one corrupt record cannot suppress another queue's failures", () => {
  const f = fixture(); f.put("queues/evaluator", "bad", null);
  f.put("consumers/daily-note/queue", "failure", { status: "terminal", reasonCode: "terminal_readback_failed" });
  expect(memoryWorkerHealth(f.root)).toMatchObject({ status: "degraded", corruptRecords: 1, dailyFailures: 1 });
});
test("duplicate receipt completion is a successful terminal", () => {
  const f = fixture(); f.put("consumers/daily-note/queue", "duplicate", { status: "terminal", reasonCode: "duplicate_receipt" });
  expect(memoryWorkerHealth(f.root)).toMatchObject({ status: "ok", dailyFailures: 0 });
});
test("missing done is pending unless a complete digest-verified recovery replaced the historical job", async () => {
  const { sha256 } = await import("./ledger.ts");
  const f = fixture(), jobId = sha256("job"), bundleId = sha256("bundle"), traceId = sha256("trace");
  const authorizedAt = "2026-09-07T12:00:00.000Z", authorizedBy = "operator", reason = "confirmed repair";
  const recoveryId = sha256({ schema: "engram.memory-batch-terminal-recovery.v1", jobId, authorizedBy, authorizedAt, reason });
  const base = "../batch-live-store/memory-batch-live/v1";
  f.put(`${base}/jobs`, jobId.slice(7), { jobId, bundle: { bundleId }, createdAt: authorizedAt });
  const recovery = `${base}/recoveries/${jobId.slice(7)}/${recoveryId.slice(7)}`;
  const completed = { schema: "engram.memory-batch-terminal-recovery.v1", status: "requeued", recoveryId, jobId, bundleId, traceIds: [traceId], authorizedAt, authorizedBy, reason };
  f.put(recovery, "completed", completed);
  expect(memoryWorkerHealth(f.root).batchPending).toBe(1);
  const failure = { jobId, traceIds: [traceId], errorCode: "batch_invalid_json" };
  const original = { traceId, status: "terminal" }, requeued = { traceId, status: "queued" };
  f.put(recovery, "failure", failure); f.put(recovery, "done", failure);
  f.put(recovery, "authorization", { recoveryId, jobId, doneDigest: sha256(failure), failureDigest: sha256(failure), traceIds: [traceId], queues: [{ traceId, original, originalDigest: sha256(original), requeued, requeuedDigest: sha256(requeued) }] });
  expect(memoryWorkerHealth(f.root)).toMatchObject({ batchPending: 0, recoveredBatchJobs: 1 });
  f.put(recovery, "done", { ...failure, errorCode: "tampered" });
  expect(memoryWorkerHealth(f.root)).toMatchObject({ batchPending: 1, recoveredBatchJobs: 0 });
});

test('completion deadline debt is degraded; invalid feed data cannot look healthy',async()=>{
 const {sha256}=await import('./ledger.ts');const f=fixture();
 const feed={schema:'engram.completion-mirror-feed.v1',target:{agentId:'alpha',sessionKey:'agent:alpha:main',sessionId:'a'},pending:[{registeredAt:'2026-09-01T12:00:00.000Z'}],blocked:null};
 f.put('completion-mirrors','feed',{...feed,digest:sha256(feed)});
 expect(memoryWorkerHealth(f.root)).toMatchObject({status:'pending',completionPending:1});
 f.put('completion-mirrors','unresolved',{schema:'engram.completion-unresolved.v1',reason:'final_wait_deadline'});
 expect(memoryWorkerHealth(f.root)).toMatchObject({status:'degraded',completionUnresolved:1});
 f.put('completion-mirrors','feed',{...feed,digest:sha256('wrong')});
 expect(memoryWorkerHealth(f.root).corruptRecords).toBe(1);
});

test('canonically applied source accounts for completion deadline without deleting its history',async()=>{
 const {sha256}=await import('./ledger.ts');const f=fixture(),candidateId=sha256('candidate'),traceId=sha256('trace');
 const sourceTurnId='channel-user:v1:'+'a'.repeat(64);
 f.put('completion-mirrors','unresolved',{schema:'engram.completion-unresolved.v1',reason:'final_wait_deadline',
  request:{candidateId,sourceTurnId,agentId:'alpha',sessionKey:'agent:alpha:main',sessionId:'a',runId:'run-a'}});
 f.put('pre-admission/checkpoints','candidate',{candidateId,sourceTurnId,stage:'ledger_admitted'});
 f.put('envelopes','trace',{schema:'engram.memory-observation-job.v1',traceId,sourceTurnId});
 f.put('queues/evaluator','trace',{traceId,status:'terminal',reasonCode:'semantic_contextual_asserted'});
 expect(memoryWorkerHealth(f.root)).toMatchObject({status:'degraded',completionUnresolved:1,
  historicalCompletionUnresolved:1,accountedCompletionUnresolved:0});
 f.put('consumers/daily-note/queue','applied',{traceId,status:'terminal',reasonCode:'canonical_applied'});
 expect(memoryWorkerHealth(f.root)).toMatchObject({status:'ok',completionUnresolved:0,
  historicalCompletionUnresolved:1,accountedCompletionUnresolved:1});
});

test("only digest-verified accounting reconciliation closes batch backlog", async () => {
  const { sha256 } = await import("./ledger.ts");
  const f = fixture(), jobId = sha256("accounted-job"), bundleId = sha256("accounted-bundle"), traceId = sha256("accounted-trace");
  const base = "../batch-live-store/memory-batch-live/v1";
  const job = { schema: "engram.memory-batch-live-job.v1", jobId, bundle: { bundleId, sourceRefs: [{ traceId }] }, evaluationPolicyDigest: sha256("evaluation"), createdAt: "2026-09-07T12:00:00.000Z" };
  f.put(`${base}/jobs`, jobId.slice(7), job);
  const body = { schema: "engram.memory-batch-accounting-reconciliation.v1", outcome: "terminal_failure_accounted", jobId, jobDigest: sha256(job), bundleId,
    evaluationPolicyDigest: job.evaluationPolicyDigest, sourceStates: [{ traceId }], supersedingJobId: null, supersedingDoneDigest: null,
    authorizedBy: "operator", authorizedAt: "2026-09-07T13:00:00.000Z", reason: "verified", reconciledAt: "2026-09-07T13:00:00.000Z" };
  const done = { ...body, reconciliationId: sha256(body) };
  f.put(`${base}/done`, jobId.slice(7), done);
  expect(memoryWorkerHealth(f.root)).toMatchObject({ batchPending: 0, corruptRecords: 0 });
  f.put(`${base}/done`, jobId.slice(7), { ...done, reason: "tampered" });
  expect(memoryWorkerHealth(f.root)).toMatchObject({ batchPending: 1, corruptRecords: 1, status: "degraded" });
});
