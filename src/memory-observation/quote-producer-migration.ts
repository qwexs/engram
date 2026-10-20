/** Explicit operator-only migration for an exact exhausted v1 literal-quote
 * failure. This is NOT generic retry, automatic producer selection or relaxed
 * citation validation. Sources, evidence, TTL and the sealed bundle stay intact. */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acquireRecoveryLock, instant, readJson, valueDigest as hash, writeAtomic, writeImmutableExact } from "./batch-terminal-recovery.ts";
import { authorizeBatchArtifact, BATCH_LIVE_JOB_SCHEMA, type BatchLiveJobV1, type BatchLivePolicyV1 } from "./batch-live-worker.ts";
import { AdmissionStore } from "./admission-store.ts";
import { compileBatchFrame } from "./batch-compiler.ts";
import { CONTEXTUAL_BATCH_SCHEMA, CONTEXTUAL_EVALUATOR_AUTHORITY } from "./contextual-batch-observation.ts";
import { CONTEXTUAL_PROMPT_VERSION } from "./contextual-observation.ts";
import { deriveTraceId, sha256, type Digest, type LedgerQueueRecordV1, type ObservationScope } from "./ledger.ts";
import { memoryObservationBinding, memoryObservationCaptureOwner, resolveMemoryObservationProjection } from "./projection.ts";
import { contextualEvaluationDigest, qualityScopeEnabled, readQualityRollout } from "./quality-rollout.ts";
import { RUNTIME_AUTHORITY } from "./runtime-authority.ts";
import { scanSourceDebt } from "./source-debt.ts";
import { producerMigrationBarrier, producerMigrationIdentity, producerMigrationRoot, PRODUCER_MIGRATION_READY_SCHEMA, PRODUCER_MIGRATION_SCHEMA } from "./producer-migration-barrier.ts";

type Row = Record<string, any>;
export type QuoteProducerMigrationFault = "after_authorization" | "after_debt" | "after_failure_archive" | "after_done_archive" | "after_new_job" | "after_queue_requeue" | "before_completed" | "after_completed";
export type QuoteProducerMigrationOptions = {
  workspace: string; storeRoot: string; oldJobId: Digest; expectedFailureId: Digest; expectedSourceTraceIds: Digest[];
  targetPolicy: BatchLivePolicyV1; authorizedBy: string; authorizedAt: string; reason: string; apply?: boolean; now?: Date;
  faultAt?: QuoteProducerMigrationFault; beforeLock?: () => void;
};
export class QuoteProducerMigrationError extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code: string): never => { throw new QuoteProducerMigrationError(code); };
const key = (v: string) => { if (!/^sha256:[a-f0-9]{64}$/.test(v)) fail("MIGRATION_DIGEST_INVALID"); return v.slice(7); };
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const scopeOf = (p: Row): ObservationScope => ({ workspaceId: p.workspaceId, runtimeSessionKey: p.runtimeSessionKey, scopeClass: p.scopeClass, scopeId: p.scopeId });
const contractRoot = resolve(import.meta.dir, "../../contracts/memory-observation/v2");
function durableDirectory(path: string): void {
  if (existsSync(path)) { if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) fail("MIGRATION_NONCANONICAL_JOURNAL"); return; }
  durableDirectory(dirname(path)); mkdirSync(path, { mode: 0o700 });
  for (const dir of [path, dirname(path)]) { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
}
function readyContracts() {
  const contracts = { producerRegistry: readJson(join(contractRoot, "producer-registry.json")), authorityPolicy: readJson(join(contractRoot, "authority-policy.json")) };
  authorizeBatchArtifact(contracts, CONTEXTUAL_BATCH_SCHEMA, "advisory-batch-evaluation", ["immutable-batch-bundle", "full-source-coverage", "exact-scoped-citations", "batch-evaluation-policy"], ["episodic.event", "episodic.decision"], CONTEXTUAL_EVALUATOR_AUTHORITY);
  authorizeBatchArtifact(contracts, "engram.memory-trace-event.v1", "trace-append", ["stage-specific-authority", "trace-id", "policy-digest"], [], CONTEXTUAL_EVALUATOR_AUTHORITY);
  return contracts;
}
function canonicalWorkspace(options: QuoteProducerMigrationOptions) {
  const workspace = realpathSync(resolve(options.workspace)), expected = join(workspace, "memory-state/memory-observation/batch-live-store");
  if (resolve(options.storeRoot) !== expected || !existsSync(expected) || realpathSync(expected) !== expected) fail("MIGRATION_STORE_MISMATCH");
  return workspace;
}
function migrationQueue(q: LedgerQueueRecordV1, authorizedAt: string): LedgerQueueRecordV1 {
  return { ...q, status: "queued", attempt: 0, nextAttemptAt: authorizedAt, updatedAt: authorizedAt,
    claimedAt: null, claimToken: null, terminalAt: null, reasonCode: "operator_quote_producer_migration" };
}
function verifiedAuthorization(value: Row) {
  const { authorizationId, ...body } = value;
  if (value.schema !== PRODUCER_MIGRATION_SCHEMA || authorizationId !== hash(body) || value.migrationId !== producerMigrationIdentity(value)
    || !Array.isArray(value.queues) || !value.queues.length || !Array.isArray(value.sources) || value.sources.length !== value.queues.length
    || value.queues.some((q: Row) => q.originalDigest !== hash(q.original) || q.requeuedDigest !== hash(q.requeued)
      || q.traceId !== q.original.traceId || q.traceId !== q.requeued.traceId || q.original.status !== "terminal"
      || q.original.reasonCode !== "batch_source_quote_mismatch" || q.original.schema !== "engram.memory-observation-ledger-queue.v1" || q.original.queueClass !== "evaluator"
      || !Number.isSafeInteger(q.original.maxAttempts) || q.original.maxAttempts < 1 || !Number.isSafeInteger(q.original.attempt) || q.original.attempt < q.original.maxAttempts
      || q.original.claimedAt !== null || q.original.claimToken !== null || !instant(q.original.terminalAt)
      || !same(q.requeued, migrationQueue(q.original, value.authorizedAt)))) fail("MIGRATION_AUTHORIZATION_INVALID");
  return value;
}
/** Returned ready receipt means atomic handoff only, not restored memory. */
export function migrateQuoteFailureToContextual(options: QuoteProducerMigrationOptions) {
  const workspace = canonicalWorkspace(options), now = () => options.now ?? new Date();
  if (!options.authorizedBy?.trim() || !options.reason?.trim() || !instant(options.authorizedAt)
    || !Number.isFinite(now().getTime()) || Date.parse(options.authorizedAt) > now().getTime()) fail("MIGRATION_AUTHORIZATION_INVALID");
  const state = join(workspace, "memory-state/memory-observation/v1"), batch = join(options.storeRoot, "memory-batch-live/v1");
  const oldKey = key(options.oldJobId), oldJobFile = join(batch, "jobs", oldKey + ".json");
  const oldJob = readJson<BatchLiveJobV1>(oldJobFile), scope = scopeOf(oldJob.partition);
  if (oldJob.schema !== BATCH_LIVE_JOB_SCHEMA || oldJob.jobId !== options.oldJobId || !same(scope, options.targetPolicy.exactScope)
    || !Array.isArray(options.expectedSourceTraceIds) || !options.expectedSourceTraceIds.length || options.expectedSourceTraceIds.length > 2
    || !same(options.expectedSourceTraceIds, oldJob.bundle.sourceRefs.map(s => s.traceId))
    || new Set(options.expectedSourceTraceIds).size !== options.expectedSourceTraceIds.length) fail("MIGRATION_SOURCE_SET_MISMATCH");
  const operation = { schema: PRODUCER_MIGRATION_SCHEMA, oldJobId: options.oldJobId, targetEvaluationPolicyDigest: options.targetPolicy.evaluationPolicyDigest,
    scope, authorizedBy: options.authorizedBy, authorizedAt: options.authorizedAt, reason: options.reason };
  const migrationId = producerMigrationIdentity(operation), directory = join(producerMigrationRoot(options.storeRoot, scope), key(migrationId));
  const authFile = join(directory, "authorization.json"), completedFile = join(directory, "completed.json");
  const oldFailureFile = join(batch, "failures", oldKey + ".json"), oldDoneFile = join(batch, "done", oldKey + ".json");
  const oldFailure = readJson<Row>(oldFailureFile), oldDone = readJson<Row>(oldDoneFile), { failureId, ...failureBody } = oldFailure;
  if (oldFailure.schema !== "engram.memory-batch-live-failure.v1" || oldFailure.errorCode !== "batch_source_quote_mismatch"
    || failureId !== options.expectedFailureId || failureId !== hash(failureBody) || !same(oldFailure, oldDone)
    || oldFailure.jobId !== oldJob.jobId || oldFailure.bundleId !== oldJob.bundle.bundleId
    || !same(oldFailure.traceIds, options.expectedSourceTraceIds) || !Number.isSafeInteger(oldFailure.attempt) || !Number.isSafeInteger(oldFailure.maxAttempts)
    || oldFailure.maxAttempts < 1 || oldFailure.attempt < oldFailure.maxAttempts) fail("MIGRATION_FAILURE_INELIGIBLE");
  const targetJobBase = { schema: BATCH_LIVE_JOB_SCHEMA, partition: oldJob.partition, evaluationPolicyDigest: options.targetPolicy.evaluationPolicyDigest, bundleId: oldJob.bundle.bundleId };
  const targetJob: BatchLiveJobV1 = { schema: BATCH_LIVE_JOB_SCHEMA, jobId: sha256(targetJobBase), partition: oldJob.partition,
    evaluationPolicyDigest: options.targetPolicy.evaluationPolicyDigest, bundle: oldJob.bundle, createdAt: oldJob.createdAt };
  if (targetJob.jobId === oldJob.jobId) fail("MIGRATION_TARGET_INVALID");
  const targetJobFile = join(batch, "jobs", key(targetJob.jobId) + ".json");
  let authorization = existsSync(authFile) ? verifiedAuthorization(readJson<Row>(authFile)) : null;
  const checkAuthorizationRequest = (auth: Row) => {
    if (auth.migrationId !== migrationId || auth.oldJobId !== oldJob.jobId || auth.oldJobDigest !== hash(oldJob)
      || auth.failureDigest !== hash(oldFailure) || auth.doneDigest !== hash(oldDone) || auth.expectedFailureId !== options.expectedFailureId
      || auth.newJobId !== targetJob.jobId || auth.newJobDigest !== hash(targetJob) || auth.targetPolicyDigest !== hash(options.targetPolicy)
      || !same(auth.queues.map((q: Row) => q.traceId), options.expectedSourceTraceIds)) fail("MIGRATION_AUTHORIZATION_CONFLICT");
  };
  if (authorization) checkAuthorizationRequest(authorization);
  if (existsSync(completedFile)) {
    if (!authorization || producerMigrationBarrier(options.storeRoot, scope)) fail("MIGRATION_COMPLETION_INVALID");
    const completed = readJson<Row>(completedFile);
    if (!existsSync(targetJobFile) || hash(readJson(targetJobFile)) !== authorization!.newJobDigest || completed.migrationId !== migrationId) fail("MIGRATION_COMPLETION_INVALID");
    return completed; // Never reset queues that have advanced; expiry is irrelevant to immutable handoff replay.
  }
  const workspaceId = readJson<Row>(join(workspace, "engram.json")).workspace?.id;
  const projection = resolveMemoryObservationProjection({ workspace, workspaceId }), projectionDigest = hash(projection);
  const quality = () => readQualityRollout(workspace, { workspaceId, pluginDigest: projection.pluginDigest, baseEvaluationPolicyDigest: projection.evaluation!.policyDigest,
    sourcePolicyDigest: projection.evaluation!.batch!.sourcePolicyDigest as Digest, applyAfter: projection.consumers!.dailyNote.applyAfter });
  const initialQuality = quality(), contractsDigest = hash(readyContracts());
  const checkTarget = () => {
    canonicalWorkspace(options);
    const current = resolveMemoryObservationProjection({ workspace, workspaceId }), binding = memoryObservationBinding(current, scope.runtimeSessionKey);
    if (!binding) throw new QuoteProducerMigrationError("MIGRATION_TARGET_OR_SCOPE_CHANGED");
    const batchPolicy = current.evaluation?.batch, p = options.targetPolicy, expectedThinking = current.inference.model === "openai/gpt-6-luna" ? "high" : "medium";
    if (readJson<Row>(join(workspace, "engram.json")).workspace?.id !== scope.workspaceId || workspaceId !== scope.workspaceId
      || hash(current) !== projectionDigest || !binding || binding.scopeId !== scope.scopeId || binding.scopeClass !== scope.scopeClass
      || memoryObservationCaptureOwner(current, scope.runtimeSessionKey, now()) !== "observer" || current.mode !== "canary" || current.evaluation?.mode !== "batch-cron"
      || current.evaluation.policyDigest !== oldJob.evaluationPolicyDigest || batchPolicy?.sourcePolicyDigest !== oldJob.partition.policyDigest
      || initialQuality?.mode !== "active" || Date.parse(initialQuality.preparedAt) > now().getTime() || !qualityScopeEnabled(initialQuality, scope) || !same(quality(), initialQuality)
      || p.contextual !== true || p.contextualPromptVersion !== CONTEXTUAL_PROMPT_VERSION || p.contextualThinking !== expectedThinking
      || p.evaluationPolicyDigest !== contextualEvaluationDigest(current.evaluation.policyDigest, CONTEXTUAL_PROMPT_VERSION, expectedThinking)
      || p.sourcePolicyDigest !== oldJob.partition.policyDigest || p.workspaceId !== workspaceId || p.producerEpoch !== oldJob.partition.producerEpoch
      || p.runner.schema !== "engram.memory-batch-shadow-runner-config.v2" || p.runner.requestedModel !== current.inference.model
      || p.runner.messageMode !== "single-user" || p.runner.maxTokens !== 8192 || p.runner.temperature !== 0 || p.maxInferenceCallsPerRun !== 1
      || p.inactivityGapMs !== batchPolicy.inactivityGapSeconds * 1000 || p.maxTurns !== batchPolicy.maxTurns || p.maxEvidenceBytes !== batchPolicy.maxEvidenceBytes
      || p.flushMaxAgeMs !== batchPolicy.maxAgeSeconds * 1000 || p.evidenceTtlMs !== current.limits.evidenceTtlHours * 3600_000
      || p.deferDelayMs !== batchPolicy.inactivityGapSeconds * 1000 || oldJob.bundle.sourceRefs.length > p.maxTurns || oldJob.bundle.evidenceBytes > p.maxEvidenceBytes || contractsDigest !== hash(readyContracts())) fail("MIGRATION_TARGET_OR_SCOPE_CHANGED");
    return { binding, fingerprint: hash({ workspaceId, scopeClass: binding.scopeClass, scopeId: binding.scopeId, requireOwner: binding.requireOwner,
      ...(binding.topicDomain ? { topicDomain: binding.topicDomain } : {}), ...(binding.groupDomain ? { groupDomain: binding.groupDomain } : {}), allowedChannels: [...binding.allowedChannels].sort() }) };
  };
  const touchesSource = (v: any): boolean => typeof v === "string" ? v === oldJob.jobId || v === oldJob.bundle.bundleId || options.expectedSourceTraceIds.includes(v as Digest)
    || oldJob.bundle.sourceRefs.some(s => s.sourceTurnId === v) : Array.isArray(v) ? v.some(touchesSource) : !!v && typeof v === "object" && Object.values(v).some(touchesSource);
  const rejectEffects = (dir: string, traces = false) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name); if (entry.isSymbolicLink()) fail("MIGRATION_NONCANONICAL_EFFECT");
      if (entry.isDirectory()) rejectEffects(file, traces);
      else if (entry.name.endsWith(".json")) { const r = readJson<Row>(file); if ((!traces || r.stage !== "source_completed") && touchesSource(r)) fail("MIGRATION_EFFECTS_EXIST"); }
    }
  };
  const sourceSnapshots = () => {
    const { binding, fingerprint } = checkTarget(), checkpoints = new AdmissionStore(workspace, RUNTIME_AUTHORITY).scanCheckpoints();
    if (checkpoints.corrupt.length) fail("MIGRATION_CHECKPOINT_INVALID");
    if (hash(readJson(oldJobFile)) !== hash(oldJob) || hash(readJson(oldFailureFile)) !== hash(oldFailure) || hash(readJson(oldDoneFile)) !== hash(oldDone)) fail("MIGRATION_ORIGIN_CHANGED");
    const sources = oldJob.bundle.sourceRefs.map(source => {
      const cp = checkpoints.records.filter(c => c.sourceTurnId === source.sourceTurnId);
      if (cp.length !== 1 || cp[0]!.stage !== "ledger_admitted" || cp[0]!.bindingFingerprint !== fingerprint || !same(cp[0]!.scope, scope)
        || !binding.allowedChannels.includes(cp[0]!.channel)) fail("MIGRATION_BINDING_MISMATCH");
      const envelope = readJson<Row>(join(state, "envelopes", key(source.traceId) + ".json")), evidence = readJson<Row>(join(state, "evidence", key(source.traceId) + ".json"));
      if (envelope.traceId !== deriveTraceId(workspaceId, scope.runtimeSessionKey, source.sourceTurnId) || !same(envelope.scope, scope)
        || !instant(evidence.expiresAt) || Date.parse(evidence.expiresAt) <= Math.max(now().getTime(), Date.parse(options.authorizedAt))) fail("MIGRATION_EVIDENCE_EXPIRED_OR_CHANGED");
      return { envelope, evidence, checkpoint: cp[0]! };
    });
    const compiled = compileBatchFrame({ schema: "engram.memory-batch-source-frame.v1", partition: oldJob.partition, sealedAt: oldJob.createdAt,
      sources: sources.map(({ envelope, evidence }) => ({ envelope, evidence })) } as any,
      { schema: "engram.memory-batch-compiler-config.v1", inactivityGapMs: Number.MAX_SAFE_INTEGER, maxTurns: 100_000, maxEvidenceBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER });
    if (compiled.exclusions.length || compiled.bundles.length !== 1 || !same(compiled.bundles[0], oldJob.bundle)
      || oldJob.jobId !== hash({ schema: oldJob.schema, partition: oldJob.partition, evaluationPolicyDigest: oldJob.evaluationPolicyDigest, bundleId: oldJob.bundle.bundleId })) fail("MIGRATION_BUNDLE_CHANGED");
    for (const kind of ["contextual-results", "terminals", "reconciliations"]) for (const id of [oldJob.jobId, targetJob.jobId])
      if (existsSync(join(batch, kind, key(id) + ".json"))) fail("MIGRATION_EFFECTS_EXIST");
    rejectEffects(join(options.storeRoot, "memory-batch-shadow/v1/results")); rejectEffects(join(state, "observations"));
    rejectEffects(join(state, "receipts")); rejectEffects(join(state, "traces"), true); rejectEffects(join(workspace, "memory-state/domain-effects/v1"));
    const jobs = existsSync(join(batch, "jobs")) ? readdirSync(join(batch, "jobs")).filter(n => n.endsWith(".json")) : [];
    for (const name of jobs) {
      const job = readJson<BatchLiveJobV1>(join(batch, "jobs", name));
      if ([oldJob.jobId, targetJob.jobId].includes(job.jobId)) continue;
      if ((!existsSync(join(batch, "done", key(job.jobId) + ".json")) && same(scopeOf(job.partition), scope))
        || job.bundle.sourceRefs.some(s => options.expectedSourceTraceIds.includes(s.traceId))) fail("MIGRATION_SCOPE_OR_SOURCE_BUSY");
    }
    if (existsSync(targetJobFile) && !same(readJson(targetJobFile), targetJob)) fail("MIGRATION_TARGET_JOB_CONFLICT");
    return sources.map(({ envelope, evidence, checkpoint }) => ({ traceId: envelope.traceId, envelopeDigest: hash(envelope), evidenceDigest: hash(evidence),
      evidenceExpiresAt: evidence.expiresAt, checkpointDigest: checkpoint.checkpointDigest,
      sourceProofDigest: hash({ envelope, evidenceDigest: hash(evidence), checkpointDigest: checkpoint.checkpointDigest, jobDigest: hash(oldJob), projectionDigest, bindingFingerprint: fingerprint }) }));
  };
  const sources = sourceSnapshots();
  if (!authorization) {
    const queues = options.expectedSourceTraceIds.map(traceId => {
      const q = readJson<LedgerQueueRecordV1>(join(state, "queues/evaluator", key(traceId) + ".json"));
      if (q.schema !== "engram.memory-observation-ledger-queue.v1" || q.traceId !== traceId || q.status !== "terminal" || q.reasonCode !== oldFailure.errorCode
        || q.queueClass !== "evaluator" || q.claimToken !== null || q.claimedAt !== null || !instant(q.terminalAt!)
        || !Number.isSafeInteger(q.attempt) || !Number.isSafeInteger(q.maxAttempts) || q.maxAttempts < 1 || q.attempt < q.maxAttempts) fail("MIGRATION_QUEUE_INELIGIBLE");
      const requeued = migrationQueue(q, options.authorizedAt);
      return { traceId, original: q, originalDigest: hash(q), requeued, requeuedDigest: hash(requeued) };
    });
    const body = { ...operation, migrationId, oldJobDigest: hash(oldJob), failureDigest: hash(oldFailure), doneDigest: hash(oldDone), expectedFailureId: options.expectedFailureId,
      newJobId: targetJob.jobId, newJobDigest: hash(targetJob), targetPolicyDigest: hash(options.targetPolicy), projectionDigest, qualityDigest: hash(initialQuality), contractsDigest, sources, queues };
    authorization = { ...body, authorizationId: hash(body) };
  }
  const auth = authorization;
  const check = () => {
    checkAuthorizationRequest(auth); verifiedAuthorization(auth);
    if (producerMigrationBarrier(options.storeRoot, scope, migrationId)) fail("MIGRATION_OTHER_INCOMPLETE");
    if (auth.projectionDigest !== projectionDigest || auth.qualityDigest !== hash(initialQuality) || auth.contractsDigest !== contractsDigest
      || !same(sourceSnapshots(), auth.sources) || existsSync(authFile) && !same(readJson(authFile), auth)) fail("MIGRATION_PROOF_CHANGED");
    for (const q of auth.queues) {
      const current = hash(readJson(join(state, "queues/evaluator", key(q.traceId) + ".json")));
      if (current !== q.originalDigest && current !== q.requeuedDigest) fail("MIGRATION_QUEUE_CHANGED");
    }
  };
  check();
  const plan = { schema: PRODUCER_MIGRATION_SCHEMA, status: "planned", migrationId, scope, oldJobId: oldJob.jobId, newJobId: targetJob.jobId,
    targetEvaluationPolicyDigest: targetJob.evaluationPolicyDigest, originalBundleId: oldJob.bundle.bundleId, sourceTraceIds: options.expectedSourceTraceIds, canonicalWrites: 0, inferenceRun: false };
  if (!options.apply) return plan;
  options.beforeLock?.();
  const release = acquireRecoveryLock(join(state, "locks/evaluator.worker"), migrationId);
  const fault = (point: QuoteProducerMigrationFault) => { if (options.faultAt === point) fail("MIGRATION_FAULT_" + point); };
  try {
    check();
    durableDirectory(directory); writeImmutableExact(authFile, auth); fault("after_authorization");
    // Protect original per-source debt BEFORE replacing any failure queue.
    scanSourceDebt(workspace, now()); fault("after_debt");
    writeImmutableExact(join(directory, "original-failure.json"), oldFailure); fault("after_failure_archive");
    writeImmutableExact(join(directory, "original-done.json"), oldDone); fault("after_done_archive");
    writeImmutableExact(targetJobFile, targetJob); fault("after_new_job");
    for (const q of auth.queues) { if (hash(readJson(join(state, "queues/evaluator", key(q.traceId) + ".json"))) === q.originalDigest)
      writeAtomic(join(state, "queues/evaluator", key(q.traceId) + ".json"), q.requeued); fault("after_queue_requeue"); }
    fault("before_completed");
    const readyBody = { schema: PRODUCER_MIGRATION_READY_SCHEMA, status: "ready_for_evaluation", migrationId, authorizationId: auth.authorizationId,
      oldJobId: oldJob.jobId, newJobId: targetJob.jobId, newJobDigest: hash(targetJob), traceIds: options.expectedSourceTraceIds, canonicalWrites: 0, inferenceRun: false };
    const completed = { ...readyBody, readyId: hash(readyBody) }; writeImmutableExact(completedFile, completed); fault("after_completed");
    if (producerMigrationBarrier(options.storeRoot, scope)) fail("MIGRATION_COMPLETION_INVALID");
    return completed;
  } finally { release(); }
}
