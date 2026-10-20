import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BATCH_LIVE_FAILURE_SCHEMA, BATCH_LIVE_JOB_SCHEMA } from "./batch-live-worker.ts";
import { recoverTerminalBatch, recoverReconciledBatch, type BatchTerminalRecoveryFaultPoint } from "./batch-terminal-recovery.ts";
import {publishReconciledCompletion} from './reconciled-completion.ts';
import {buildContextualObservation} from './contextual-observation.ts';
import { deriveAdmissionCandidateId } from "./admission-store.ts";
import { compileBatchFrame } from "./batch-compiler.ts";
import { deriveSourceDigest, deriveTraceId, sha256, type JsonValue } from "./ledger.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(errorCode = "batch_invalid_json") {
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

function recoveryInput(input: ReturnType<typeof fixture>) {
  return {
    ...input,
    now: new Date("2026-09-03T20:00:00.000Z"),
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
    symlinkSync(JSON.stringify({ pid: 2_147_483_647 }), staleLock);
    expect(recoverTerminalBatch({ ...staleCommon, apply: true }).status).toBe("requeued");

    const live = fixture();
    const liveCommon = recoveryInput(live);
    const liveLock = join(live.workspace, "memory-state", "memory-observation", "v1", "locks", "evaluator.worker");
    mkdirSync(dirname(liveLock), { recursive: true });
    symlinkSync(JSON.stringify({ pid: process.pid }), liveLock);
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


describe("terminal recovery admission guards", () => {
  const state = (f: ReturnType<typeof fixture>) => join(f.workspace, "memory-state/memory-observation/v1");
  const projectionPath = (f: ReturnType<typeof fixture>) => join(f.workspace, "memory-state/memory-observation/projection.json");
  const change = (path: string, update: (value: any) => any) => write(path, update(JSON.parse(readFileSync(path, "utf8"))));

  test("expiry is checked at actual now, not old authorization", () => {
    const f = fixture(), common = recoveryInput(f);
    expect(() => recoverTerminalBatch({...common, apply: true, now: new Date("2026-09-07T00:00:00.000Z")})).toThrow("expired");
    expect(() => recoverTerminalBatch({...common, apply: true, now: new Date("2026-09-03T18:00:00.000Z")})).toThrow("authorizedBy");
  });

  test("default clock cannot replay retained historical evidence", () => {
    const f = fixture(), {now, ...common} = recoveryInput(f);
    expect(() => recoverTerminalBatch({...common, apply: true})).toThrow("expired");
  });

  test("rejects foreign or symlinked stores", () => {
    const f = fixture(), other = fixture();
    expect(() => recoverTerminalBatch({...recoveryInput(f), storeRoot: other.storeRoot})).toThrow("workspace-owned");
    rmSync(f.storeRoot, {recursive:true});
    symlinkSync(other.storeRoot, f.storeRoot);
    expect(() => recoverTerminalBatch(recoveryInput(f))).toThrow("workspace-owned");
  });

  for (const mode of ["disabled", "foreign-workspace", "binding", "binding-fingerprint", "foreground", "not-yet-effective", "policy", "evaluation-policy"] as const) {
    test("rejects inactive or mismatched scope: " + mode, () => {
      const f = fixture();
      change(projectionPath(f), p => {
        if(mode === "disabled") p.enabled = false;
        if(mode === "foreign-workspace") p.workspaceId = "foreign";
        if(mode === "binding") p.bindings[0].scopeId = "telegram:2";
        if(mode === "binding-fingerprint") p.bindings[0].requireOwner = false;
        if(mode === "foreground") delete p.captureOwnership;
        if(mode === "not-yet-effective") {p.captureOwnership.effectiveAfter = "2026-09-04T00:00:00.000Z"; p.consumers.dailyNote.applyAfter = p.captureOwnership.effectiveAfter;}
        if(mode === "policy") p.evaluation.batch.sourcePolicyDigest = sha256("changed-policy");
        if(mode === "evaluation-policy") p.evaluation.policyDigest = sha256("changed-evaluation");
        return p;
      });
      expect(() => recoverTerminalBatch({...recoveryInput(f), apply: true})).toThrow();
    });
  }

  for (const mode of ["evidence", "envelope", "checkpoint", "scope", "failure", "job", "queue", "result", "observation", "receipt"] as const) {
    test("rechecks changed " + mode + " under evaluator lock before any mutation", () => {
      const f = fixture(), common = recoveryInput(f);
      const failurePath = join(f.storeRoot, "memory-batch-live/v1/failures", f.jobId.slice(7)+".json");
      const before = readFileSync(failurePath, "utf8");
      const mutate = () => {
        if(mode === "evidence") change(join(state(f), "evidence", f.traceId.slice(7)+".json"), e => ({...e, payload: {user:"changed"}}));
        if(mode === "envelope") change(join(state(f), "envelopes", f.traceId.slice(7)+".json"), e => ({...e, admittedAt:"2026-09-03T10:00:01.000Z"}));
        if(mode === "checkpoint") {
          const directory = join(state(f), "pre-admission/checkpoints");
          rmSync(join(directory, readdirSync(directory)[0]!));
        }
        if(mode === "scope") change(projectionPath(f), p => ({...p, approvedBy:"changed-approval"}));
        if(mode === "failure") change(failurePath, p => ({...p, attempt:9}));
        if(mode === "job") change(join(f.storeRoot, "memory-batch-live/v1/jobs", f.jobId.slice(7)+".json"), p => ({...p, createdAt:"2026-09-03T10:00:01.000Z"}));
        if(mode === "queue") change(join(state(f), "queues/evaluator", f.traceId.slice(7)+".json"), p => ({...p, attempt:1}));
        if(mode === "result") write(join(f.storeRoot, "memory-batch-shadow/v1/results/result.json"), {sourceRefs:[{traceId:f.traceId}]});
        if(mode === "observation") write(join(state(f), "observations/batch/observation.json"), {sourceRefs:[{traceId:f.traceId}]});
        if(mode === "receipt") write(join(state(f), "receipts/by-operation/receipt.json"), {provenance:{sourceTurnId:"channel-user:v1:"+"a".repeat(64)}});
      };
      expect(() => recoverTerminalBatch({...common, apply:true, beforeLock:mutate})).toThrow();
      if(mode !== "failure") expect(readFileSync(failurePath, "utf8")).toBe(before);
      expect(() => readFileSync(join(f.storeRoot, "memory-batch-live/v1/recoveries", f.jobId.slice(7)), "utf8")).toThrow();
    });
  }

  test("completed operation remains idempotent after downstream advancement and evidence purge", () => {
    const f = fixture(), common = recoveryInput(f), result = recoverTerminalBatch({...common, apply:true});
    const queuePath = join(state(f), "queues/evaluator", f.traceId.slice(7)+".json");
    change(queuePath, q => ({...q, status:"terminal", attempt:1, reasonCode:"semantic_batch_asserted"}));
    const advanced = readFileSync(queuePath,"utf8");
    rmSync(join(state(f), "evidence", f.traceId.slice(7)+".json"));
    rmSync(join(state(f), "envelopes", f.traceId.slice(7)+".json"));
    write(join(state(f), "observations/batch/observation.json"), {sourceRefs:[{traceId:f.traceId}]});
    expect(recoverTerminalBatch({...common, apply:true, now:new Date("2026-09-08T00:00:00.000Z")})).toEqual(result);
    expect(readFileSync(queuePath,"utf8")).toBe(advanced);
  });

  test("retained source needs original binding fingerprint, not just matching scope", () => {
    const f = fixture(), directory = join(state(f), "pre-admission/checkpoints");
    const path = join(directory, readdirSync(directory)[0]!);
    change(path, checkpoint => {
      const {checkpointDigest, ...body} = {...checkpoint, bindingFingerprint:sha256("revoked-binding")};
      return {...body, checkpointDigest:sha256(body)};
    });
    expect(() => recoverTerminalBatch({...recoveryInput(f), apply:true})).toThrow("binding fingerprint");
  });

  test("crash authorization pins envelope provenance across a later process invocation", () => {
    const f = fixture(), common = recoveryInput(f);
    expect(() => recoverTerminalBatch({...common, apply:true, faultAt:"after_authorization"})).toThrow("fault injection");
    change(join(state(f), "envelopes", f.traceId.slice(7)+".json"), envelope => ({...envelope,
      authority: {...envelope.authority, digest:sha256("changed-authority")}}));
    expect(() => recoverTerminalBatch({...common, apply:true})).toThrow("changed since recovery authorization");
  });

  test("quote mismatch is still excluded from generic recovery", () => {
    expect(() => recoverTerminalBatch(recoveryInput(fixture("batch_quote_mismatch")))).toThrow("not eligible");
  });
});

function recoveredCompletionFixture(){
 const f=reconciledFixture(),recovery=recoverReconciledBatch({...recoveryInput(f),now:f.now,apply:true});
 const job=JSON.parse(readFileSync(join(f.root,'jobs',f.jobId.slice(7)+'.json'),'utf8'));
 const output={schema:'engram.memory-contextual-output.v2' as const,assertions:[],dispositions:[{traceId:f.traceId,kind:'skip' as const,assertionIds:[],reason:'Synthetic non-durable acknowledgement.'}]};
 const observed=buildContextualObservation(output,job.bundle,sha256('inner contextual model contract'),new Date('2026-09-03T20:01:00.000Z'));
 const evaluated={requestDigest:sha256('synthetic request'),observation:observed};
 const saved={schema:'engram.memory-contextual-result.v2',jobId:f.jobId,policyDigest:job.evaluationPolicyDigest,evaluated};
 write(join(f.root,'contextual-results',f.jobId.slice(7)+'.json'),{...saved,digest:sha256(saved)});
 const base={schema:'engram.memory-batch-live-terminal.v2',jobId:f.jobId,bundleId:job.bundle.bundleId,resultKey:sha256({schema:'engram.memory-contextual-result-key.v2',requestDigest:evaluated.requestDigest}),resultDigest:sha256(evaluated),dispositions:[{traceId:f.traceId,decision:'skip',reasonCode:'semantic_contextual_skip',observationRefs:[]}],sourceDispositions:observed.dispositions,completedAt:observed.recordedAt};
 const terminal={...base,terminalId:sha256(base)};write(join(f.root,'terminals',f.jobId.slice(7)+'.json'),terminal);
 const qpath=join(f.state,'queues/evaluator',f.traceId.slice(7)+'.json'),q=JSON.parse(readFileSync(qpath,'utf8'));
 write(qpath,{...q,status:'terminal',reasonCode:'semantic_contextual_skip',terminalAt:observed.recordedAt,claimToken:null});
 const donePath=join(f.root,'done',f.jobId.slice(7)+'.json'),old=readFileSync(donePath,'utf8');
 const journal=join(f.root,'recoveries',f.jobId.slice(7),recovery.recoveryId.slice(7));
 return {f,options:{workspace:f.workspace,batchRoot:f.root,job,terminal},donePath,old,journal};
}
for(const faultAt of [undefined,'after_archive','after_publish'] as const)test('same-job recovery publishes proven completion and preserves exhaustion after '+faultAt,()=>{
 const {options,donePath,old,journal}=recoveredCompletionFixture();
 if(faultAt)expect(()=>publishReconciledCompletion({...options,faultAt})).toThrow('FAULT_INJECTED');
 publishReconciledCompletion(options);
 expect(JSON.parse(readFileSync(donePath,'utf8'))).toEqual(options.terminal);
 expect(JSON.parse(readFileSync(join(journal,'superseded-done.json'),'utf8'))).toEqual(JSON.parse(old));
 expect(publishReconciledCompletion(options)).toBe(false);
});
for(const mode of ['missing_authorization','changed_queue','changed_result','changed_terminal','changed_recovery'] as const)test('same-job completion refuses '+mode+' before replacing history',()=>{
 const {f,options,donePath,old,journal}=recoveredCompletionFixture();
 const change=(path:string,mutate:(v:any)=>any)=>write(path,mutate(JSON.parse(readFileSync(path,'utf8'))));
 if(mode==='missing_authorization')rmSync(join(journal,'completed.json'));
 if(mode==='changed_queue')change(join(f.state,'queues/evaluator',f.traceId.slice(7)+'.json'),q=>({...q,reasonCode:'semantic_contextual_asserted'}));
 if(mode==='changed_result')change(join(f.root,'contextual-results',f.jobId.slice(7)+'.json'),r=>({...r,digest:sha256('foreign')}));
 if(mode==='changed_terminal')options.terminal.completedAt='2026-09-03T20:02:00.000Z';
 if(mode==='changed_recovery')change(join(journal,'authorization.json'),a=>({...a,reason:'foreign'}));
 expect(()=>publishReconciledCompletion(options)).toThrow();expect(readFileSync(donePath,'utf8')).toBe(old);
 expect(existsSync(join(journal,'superseded-done.json'))).toBe(false);
});
