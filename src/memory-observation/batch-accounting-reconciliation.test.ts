import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileBatchAccounting, BatchAccountingReconciliationError } from "./batch-accounting-reconciliation.ts";
import { sha256, type Digest } from "./ledger.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "batch-accounting-"));
  roots.push(workspace);
  const storeRoot = join(workspace, "memory-state/memory-observation/batch-live-store");
  const batchRoot = join(storeRoot, "memory-batch-live/v1");
  const queueRoot = join(workspace, "memory-state/memory-observation/v1/queues/evaluator");
  const write = (path: string, value: unknown) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
  const traceId = sha256("trace"), bundleId = sha256("bundle"), jobId = sha256("old-job"), supersedingJobId = sha256("new-job");
  const partition = { workspaceId: "test", runtimeSessionKey: "agent:test:main", scopeClass: "self", scopeId: "workspace:test", producerEpoch: "v1", policyDigest: sha256("policy") };
  const bundle = { schema: "engram.memory-batch-bundle.v1", bundleId, partition, policyDigest: partition.policyDigest,
    sourceRefs: [{ traceId, sourceTurnId: "turn", sourceDigest: sha256("source"), evidenceDigest: sha256("evidence"), sourceCompletedAt: "2026-09-01T10:00:00.000Z" }],
    inputs: [], evidenceBytes: 0 };
  const job = { schema: "engram.memory-batch-live-job.v1", jobId, partition, evaluationPolicyDigest: sha256("evaluation-v1"), bundle, createdAt: "2026-09-01T10:01:00.000Z" };
  write(join(batchRoot, "jobs", `${jobId.slice(7)}.json`), job);
  const queue = { schema: "engram.memory-observation-ledger-queue.v1", traceId, queueClass: "evaluator", status: "terminal", attempt: 2, maxAttempts: 2,
    nextAttemptAt: null, createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-01T10:03:00.000Z", claimedAt: null, claimToken: null,
    terminalAt: "2026-09-01T10:03:00.000Z", reasonCode: "batch_invalid_json" };
  write(join(queueRoot, `${traceId.slice(7)}.json`), queue);
  return { workspace, storeRoot, batchRoot, queueRoot, traceId, bundleId, jobId, supersedingJobId, partition, bundle, job, queue, write };
}

const authorization = { authorizedBy: "operator:example", authorizedAt: "2026-09-11T17:50:00.000Z", reason: "account verified orphan without replay", now: new Date("2026-09-11T17:51:00.000Z") };

test("accounts an exhausted orphaned failure without changing its source queue", () => {
  const f = fixture();
  const planned = reconcileBatchAccounting({ ...authorization, workspace: f.workspace, storeRoot: f.storeRoot, jobId: f.jobId });
  expect(planned).toMatchObject({ status: "planned", outcome: "terminal_failure_accounted", supersedingJobId: null });
  const applied = reconcileBatchAccounting({ ...authorization, workspace: f.workspace, storeRoot: f.storeRoot, jobId: f.jobId, apply: true });
  expect(applied.status).toBe("accounted");
  expect(JSON.parse(readFileSync(join(f.queueRoot, `${f.traceId.slice(7)}.json`), "utf8"))).toEqual(f.queue);
  const done = JSON.parse(readFileSync(join(f.batchRoot, "done", `${f.jobId.slice(7)}.json`), "utf8"));
  expect(done).toMatchObject({ schema: "engram.memory-batch-accounting-reconciliation.v1", outcome: "terminal_failure_accounted", jobId: f.jobId });
  expect(reconcileBatchAccounting({ ...authorization, workspace: f.workspace, storeRoot: f.storeRoot, jobId: f.jobId, apply: true }).status).toBe("accounted");
});

test("refuses failure accounting when the bundle already has observations", () => {
  const f = fixture();
  f.write(join(f.workspace, "memory-state/memory-observation/v1/observations/batch", `${sha256("observation").slice(7)}.json`), { bundleId: f.bundleId });
  expect(() => reconcileBatchAccounting({ ...authorization, workspace: f.workspace, storeRoot: f.storeRoot, jobId: f.jobId }))
    .toThrow(new BatchAccountingReconciliationError("EFFECTS_EXIST", "persisted observations require explicit supersession reconciliation"));
});

test("accounts an old job only through a completed later job for the identical bundle", () => {
  const f = fixture();
  const queue = { ...f.queue, reasonCode: "semantic_batch_write" };
  f.write(join(f.queueRoot, `${f.traceId.slice(7)}.json`), queue);
  const superseding = { ...f.job, jobId: f.supersedingJobId, evaluationPolicyDigest: sha256("evaluation-v2"), createdAt: "2026-09-01T10:04:00.000Z" };
  f.write(join(f.batchRoot, "jobs", `${f.supersedingJobId.slice(7)}.json`), superseding);
  const terminalBase = { schema: "engram.memory-batch-live-terminal.v1", jobId: f.supersedingJobId, bundleId: f.bundleId,
    resultKey: sha256("result"), resultDigest: sha256("result-body"), dispositions: [{ traceId: f.traceId, decision: "write", reasonCode: "semantic_batch_write", observationRefs: [sha256("observation")] }],
    completedAt: "2026-09-01T10:05:00.000Z" };
  const terminal = { ...terminalBase, terminalId: sha256(terminalBase) };
  f.write(join(f.batchRoot, "terminals", `${f.supersedingJobId.slice(7)}.json`), terminal);
  f.write(join(f.batchRoot, "done", `${f.supersedingJobId.slice(7)}.json`), terminal);
  const applied = reconcileBatchAccounting({ ...authorization, workspace: f.workspace, storeRoot: f.storeRoot, jobId: f.jobId,
    supersedingJobId: f.supersedingJobId, apply: true });
  expect(applied).toMatchObject({ status: "accounted", outcome: "superseded_by_completed_job", supersedingJobId: f.supersedingJobId });
  expect(applied.supersedingDoneDigest).toBe(sha256(terminal));
});

test("refuses supersession when the completed disposition and source state differ", () => {
  const f = fixture();
  const superseding = { ...f.job, jobId: f.supersedingJobId, createdAt: "2026-09-01T10:04:00.000Z" };
  f.write(join(f.batchRoot, "jobs", `${f.supersedingJobId.slice(7)}.json`), superseding);
  const terminalBase = { schema: "engram.memory-batch-live-terminal.v1", jobId: f.supersedingJobId, bundleId: f.bundleId,
    resultKey: sha256("result"), resultDigest: sha256("result-body"), dispositions: [{ traceId: f.traceId, decision: "skip", reasonCode: "semantic_batch_skip", observationRefs: [] }],
    completedAt: "2026-09-01T10:05:00.000Z" };
  const terminal = { ...terminalBase, terminalId: sha256(terminalBase) };
  f.write(join(f.batchRoot, "terminals", `${f.supersedingJobId.slice(7)}.json`), terminal);
  f.write(join(f.batchRoot, "done", `${f.supersedingJobId.slice(7)}.json`), terminal);
  expect(() => reconcileBatchAccounting({ ...authorization, workspace: f.workspace, storeRoot: f.storeRoot, jobId: f.jobId, supersedingJobId: f.supersedingJobId }))
    .toThrow(new BatchAccountingReconciliationError("SUPERSESSION_INVALID", "superseding dispositions do not match current terminal source state"));
});
