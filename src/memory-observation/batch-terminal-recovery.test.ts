import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BATCH_LIVE_FAILURE_SCHEMA, BATCH_LIVE_JOB_SCHEMA } from "./batch-live-worker.ts";
import { recoverTerminalBatch, type BatchTerminalRecoveryFaultPoint } from "./batch-terminal-recovery.ts";
import { sha256, type JsonValue } from "./ledger.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(errorCode = "batch_invalid_json") {
  const workspace = mkdtempSync(join(tmpdir(), "batch-recovery-workspace-"));
  const storeRoot = mkdtempSync(join(tmpdir(), "batch-recovery-store-"));
  roots.push(workspace, storeRoot);
  const traceId = sha256("recovery-trace");
  const bundleId = sha256("recovery-bundle");
  const jobId = sha256("recovery-job");
  const job = {
    schema: BATCH_LIVE_JOB_SCHEMA,
    jobId,
    partition: { workspaceId: "main", runtimeSessionKey: "agent:main:telegram:direct:1", scopeClass: "self", scopeId: "telegram:1", producerEpoch: "v1", policyDigest: sha256("policy") },
    evaluationPolicyDigest: sha256("evaluation-policy"),
    bundle: { schema: "engram.memory-batch-bundle.v1", bundleId, partitionId: sha256("partition"), sourceRefs: [{ traceId }] },
    createdAt: "2026-09-03T10:00:00.000Z",
  };
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
  write(join(stateRoot, "evidence", `${traceId.slice(7)}.json`), { traceId, expiresAt: "2026-09-06T10:00:00.000Z" });
  return { workspace, storeRoot, jobId, traceId };
}

function recoveryInput(input: ReturnType<typeof fixture>) {
  return {
    ...input,
    authorizedBy: "operator",
    authorizedAt: "2026-09-03T19:00:00.000Z",
    reason: "retry after provider stabilization",
  };
}

const FAULT_POINTS: BatchTerminalRecoveryFaultPoint[] = [
  "after_authorization", "after_failure_archive", "after_done_archive",
  "after_queue_requeue", "before_completed", "after_completed",
];

describe("bounded terminal batch recovery", () => {
  test("plans without mutation and requeues only the authorized terminal job", () => {
    const input = fixture();
    const common = recoveryInput(input);
    expect(recoverTerminalBatch(common).status).toBe("planned");
    const applied = recoverTerminalBatch({ ...common, apply: true });
    expect(applied.status).toBe("requeued");
    const queue = JSON.parse(readFileSync(join(input.workspace, "memory-state", "memory-observation", "v1", "queues", "evaluator", `${input.traceId.slice(7)}.json`), "utf8"));
    expect(queue).toMatchObject({ status: "queued", attempt: 0, terminalAt: null, reasonCode: "operator_recovery_requeued" });
    expect(recoverTerminalBatch({ ...common, apply: true })).toEqual(applied);
  });

  test("requeues an authorized assertion-format failure with unchanged history", () => {
    const input = fixture("batch_invalid_assertion");
    const original = readFileSync(join(input.storeRoot, "memory-batch-live", "v1", "failures", `${input.jobId.slice(7)}.json`), "utf8");
    const common = recoveryInput(input);
    expect(recoverTerminalBatch(common).status).toBe("planned");
    const result = recoverTerminalBatch({ ...common, apply: true });
    expect(result.status).toBe("requeued");
    expect(readFileSync(result.archivedFailureRef, "utf8")).toBe(original);
    expect(recoverTerminalBatch({ ...common, apply: true })).toEqual(result);
  });

  test("does not admit arbitrary failure codes", () => {
    expect(() => recoverTerminalBatch(recoveryInput(fixture("unknown_failure")))).toThrow(/not eligible/);
  });

  for (const faultAt of FAULT_POINTS) {
    test(`resumes the exact authorized state after ${faultAt}`, () => {
      const input = fixture();
      const common = recoveryInput(input);
      expect(() => recoverTerminalBatch({ ...common, apply: true, faultAt })).toThrow(`fault injection at ${faultAt}`);
      const resumed = recoverTerminalBatch({ ...common, apply: true });
      expect(resumed.status).toBe("requeued");
      expect(recoverTerminalBatch({ ...common, apply: true })).toEqual(resumed);
      const queue = JSON.parse(readFileSync(join(input.workspace, "memory-state", "memory-observation", "v1", "queues", "evaluator", `${input.traceId.slice(7)}.json`), "utf8"));
      expect(queue).toMatchObject({ status: "queued", attempt: 0, terminalAt: null, reasonCode: "operator_recovery_requeued" });
    });
  }

  test("rejects a changed queue after authorization without archiving terminal artifacts", () => {
    const input = fixture();
    const common = recoveryInput(input);
    const plan = recoverTerminalBatch(common);
    expect(() => recoverTerminalBatch({ ...common, apply: true, faultAt: "after_authorization" })).toThrow(/fault injection/);
    const queuePath = join(input.workspace, "memory-state", "memory-observation", "v1", "queues", "evaluator", `${input.traceId.slice(7)}.json`);
    const queue = JSON.parse(readFileSync(queuePath, "utf8"));
    write(queuePath, { ...queue, attempt: 1 });
    expect(() => recoverTerminalBatch({ ...common, apply: true })).toThrow(/queue state changed/);
    expect(readFileSync(join(input.storeRoot, "memory-batch-live", "v1", "failures", `${input.jobId.slice(7)}.json`), "utf8")).toBeTruthy();
    expect(() => readFileSync(plan.archivedFailureRef, "utf8")).toThrow();
  });

  test("rejects changed archived failure content on resume", () => {
    const input = fixture();
    const common = recoveryInput(input);
    const plan = recoverTerminalBatch(common);
    expect(() => recoverTerminalBatch({ ...common, apply: true, faultAt: "after_failure_archive" })).toThrow(/fault injection/);
    const failure = JSON.parse(readFileSync(plan.archivedFailureRef, "utf8"));
    write(plan.archivedFailureRef, { ...failure, failedAt: "2026-09-03T19:01:00.000Z" });
    expect(() => recoverTerminalBatch({ ...common, apply: true })).toThrow();
  });

  test("rejects a completed marker whose identity or content changed", () => {
    const input = fixture();
    const common = recoveryInput(input);
    const applied = recoverTerminalBatch({ ...common, apply: true });
    const completedPath = join(dirname(applied.archivedFailureRef), "completed.json");
    write(completedPath, { ...applied, reason: "different authorization" });
    expect(() => recoverTerminalBatch({ ...common, apply: true })).toThrow(/completed recovery artifact does not match/);
  });

  test("reclaims a stale abrupt-crash lock but preserves a live owner lock", () => {
    const stale = fixture();
    const staleCommon = recoveryInput(stale);
    const staleLock = join(stale.workspace, "memory-state", "memory-observation", "v1", "locks", "evaluator.worker");
    mkdirSync(dirname(staleLock), { recursive: true });
    writeFileSync(staleLock, JSON.stringify({ pid: 2_147_483_647 }));
    expect(recoverTerminalBatch({ ...staleCommon, apply: true }).status).toBe("requeued");

    const live = fixture();
    const liveCommon = recoveryInput(live);
    const liveLock = join(live.workspace, "memory-state", "memory-observation", "v1", "locks", "evaluator.worker");
    mkdirSync(dirname(liveLock), { recursive: true });
    writeFileSync(liveLock, JSON.stringify({ pid: process.pid }));
    expect(() => recoverTerminalBatch({ ...liveCommon, apply: true })).toThrow(/worker lock is held/);
  });

  test("rejects expired evidence before moving immutable failure artifacts", () => {
    const input = fixture();
    expect(() => recoverTerminalBatch({
      ...input,
      authorizedBy: "operator",
      authorizedAt: "2026-09-07T19:00:00.000Z",
      reason: "too late",
      apply: true,
    })).toThrow(/expired/);
  });
});

function reconciledFixture() {
 const f=fixture('batch_contextual_evaluation_failed');
 const root=join(f.storeRoot,'memory-batch-live/v1'),state=join(f.workspace,'memory-state/memory-observation/v1');
 const job=JSON.parse(readFileSync(join(root,'jobs',f.jobId.slice(7)+'.json'),'utf8'));
 const queue=JSON.parse(readFileSync(join(state,'queues/evaluator',f.traceId.slice(7)+'.json'),'utf8'));
 const base={schema:'engram.memory-batch-live-reconciliation.v1',jobId:f.jobId,bundleId:job.bundle.bundleId,evaluationPolicyDigest:job.evaluationPolicyDigest,sources:[{traceId:f.traceId,status:'terminal',reasonCode:queue.reasonCode,attempt:2,maxAttempts:2,queueDigest:sha256(queue)}],reconciledAt:'2026-09-03T10:05:00.000Z'};
 const rec={...base,reconciliationId:sha256(base)};
 write(join(root,'reconciliations',f.jobId.slice(7)+'.json'),rec);write(join(root,'done',f.jobId.slice(7)+'.json'),rec);
 return {...f,root,state,now:new Date('2026-09-03T20:00:00.000Z')};
}
for(const faultAt of [undefined,'after_authorization','after_queue_requeue','before_completed','after_completed'] as const) test('reconciled contextual recovery preserves done/evidence and resumes '+faultAt,async()=>{
 const {recoverReconciledBatch}=await import('./batch-terminal-recovery.ts');const f=reconciledFixture();
 const input={...recoveryInput(f),now:f.now,apply:true};
 const paths=[join(f.root,'done',f.jobId.slice(7)+'.json'),join(f.state,'evidence',f.traceId.slice(7)+'.json')];const before=paths.map(p=>readFileSync(p,'utf8'));
 expect(recoverReconciledBatch({...input,apply:false}).status).toBe('planned');
 if(faultAt)expect(()=>recoverReconciledBatch({...input,faultAt})).toThrow();
 const result=recoverReconciledBatch(input);expect(result.status).toBe('requeued');expect(recoverReconciledBatch(input)).toEqual(result);
 expect(paths.map(p=>readFileSync(p,'utf8'))).toEqual(before);
 expect(JSON.parse(readFileSync(join(f.state,'queues/evaluator',f.traceId.slice(7)+'.json'),'utf8')).attempt).toBe(0);
});
test('reconciled recovery rejects expiry, changed queue and existing effects',async()=>{
 const {recoverReconciledBatch}=await import('./batch-terminal-recovery.ts');
 for(const mode of ['expired','changed','effects']) {
  const f=reconciledFixture(),input={...recoveryInput(f),now:f.now,apply:true};
  if(mode==='expired')input.now=new Date('2026-09-07T00:00:00.000Z');
  if(mode==='effects')write(join(f.root,'contextual-results',f.jobId.slice(7)+'.json'),{});
  if(mode==='changed') {const p=join(f.state,'queues/evaluator',f.traceId.slice(7)+'.json');const q=JSON.parse(readFileSync(p,'utf8'));q.reasonCode='semantic_contextual_asserted';write(p,q);}
  expect(()=>recoverReconciledBatch(input)).toThrow();
 }
});

test('reviewed skip recovery preserves other batch effects and survives partial recovery',async()=>{
 const {recoverReviewedSkip}=await import('./batch-terminal-recovery.ts');
 for(const faultAt of [undefined,'after_authorization','after_queue_requeue'] as const){
 const f=fixture('semantic_contextual_skip'),root=join(f.storeRoot,'memory-batch-live/v1'),state=join(f.workspace,'memory-state/memory-observation/v1');
 const job=JSON.parse(readFileSync(join(root,'jobs',f.jobId.slice(7)+'.json'),'utf8'));
 const base={schema:'engram.memory-batch-live-terminal.v2',jobId:f.jobId,bundleId:job.bundle.bundleId,dispositions:[{traceId:f.traceId,decision:'skip',reasonCode:'semantic_contextual_skip',observationRefs:[]}]};const terminal={...base,terminalId:sha256(base)};
 write(join(root,'terminals',f.jobId.slice(7)+'.json'),terminal);write(join(root,'done',f.jobId.slice(7)+'.json'),terminal);
 const other=join(state,'observations/batch',sha256('other').slice(7)+'.json');write(other,{bundleId:job.bundle.bundleId,sourceRefs:[{traceId:sha256('other')}]});
 const input={...recoveryInput(f),now:new Date('2026-09-03T20:00:00.000Z'),traceId:f.traceId,apply:true};
 const targetObs=join(state,'observations/batch',sha256('target').slice(7)+'.json');write(targetObs,{sourceRefs:[{traceId:f.traceId}]});
 expect(()=>recoverReviewedSkip({...input,apply:false})).toThrow('already has observations');rmSync(targetObs);
 expect(()=>recoverReviewedSkip({...input,apply:false,now:new Date('2026-09-07T00:00:00.000Z')})).toThrow('expired');
 expect(recoverReviewedSkip({...input,apply:false}).status).toBe('planned');
 if(faultAt)expect(()=>recoverReviewedSkip({...input,faultAt})).toThrow();
 const result=recoverReviewedSkip(input);expect(result.status).toBe('requeued');expect(recoverReviewedSkip(input)).toEqual(result);
 expect(JSON.parse(readFileSync(join(root,'done',f.jobId.slice(7)+'.json'),'utf8'))).toEqual(terminal);expect(JSON.parse(readFileSync(other,'utf8')).sourceRefs[0].traceId).toBe(sha256('other'));
 }
});
test('skip review cannot requeue written sources or another source',async()=>{
 const {recoverReviewedSkip}=await import('./batch-terminal-recovery.ts');const f=fixture();
 expect(()=>recoverReviewedSkip({...recoveryInput(f),traceId:sha256('foreign'),apply:true})).toThrow();
});
