import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  BATCH_FRAME_SCHEMA,
  compileBatchFrame,
  type BatchCompilerConfigV1,
  type BatchPartitionV1,
  type BatchSourceFrameV1,
  type BatchSourceRefV1,
  type CompiledBatchBundleV1,
} from "./batch-compiler.ts";
import {
  BATCH_SHADOW_OUTPUT_SCHEMA,
  BatchShadowRunnerError,
  runBatchShadow,
  type BatchScopedCitationV1,
  type BatchShadowCompletionRequest,
  type BatchShadowProviderResult,
  type BatchShadowResultV1,
  type BatchShadowRunnerConfigV2,
} from "./batch-shadow-runner.ts";
import {
  BATCH_EVALUATOR_AUTHORITY,
  BATCH_OBSERVATION_SCHEMA,
  deriveBatchObservationId,
  validateBatchObservation,
  type BatchObservationV1,
} from "./batch-observation.ts";
import {
  MemoryObservationLedger,
  sha256,
  type BatchEvaluationDispositionV1,
  type Digest,
  type EpisodicActorRef,
  type EpisodicOutcomeStatus,
  type EpisodicSection,
  type EvaluationEvidenceV1,
  type JsonValue,
  type ObservationScope,
  type ProducerRef,
} from "./ledger.ts";

export const BATCH_LIVE_JOB_SCHEMA = "engram.memory-batch-live-job.v1" as const;
export const BATCH_LIVE_TERMINAL_SCHEMA = "engram.memory-batch-live-terminal.v1" as const;
export const BATCH_LIVE_FAILURE_SCHEMA = "engram.memory-batch-live-failure.v1" as const;
const AUTHORITY_SCHEMA = "engram.memory-authority-policy.v1";
const AUTHORITY_VERSION = "memory-observation-authority-v1";
const REGISTRY_SCHEMA = "engram.memory-producer-registry.v1";
const TRACE_SCHEMA = "engram.memory-trace-event.v1";
const CONTRACT_ROOT = resolve(import.meta.dir, "..", "..", "contracts", "memory-observation", "v1");
const BATCH_TRUSTED_INPUTS = ["immutable-batch-bundle", "full-source-coverage", "exact-scoped-citations", "batch-evaluation-policy"];
const TRACE_TRUSTED_INPUTS = ["stage-specific-authority", "trace-id", "policy-digest"];
type Row = Record<string, unknown>;
export type BatchAuthorityContracts = { producerRegistry: unknown; authorityPolicy: unknown };

function row(value: unknown): Row | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }

function authorizeBatchArtifact(contracts: BatchAuthorityContracts, artifactSchema: string, stage: string, trustedInputs: string[], requiredObservationClasses: string[] = []): void {
  const registry = row(contracts.producerRegistry);
  const policy = row(contracts.authorityPolicy);
  const producers = registry?.producers;
  const rules = policy?.rules;
  if (!registry || registry.schema !== REGISTRY_SCHEMA || registry.registryVersion !== 1 || !Array.isArray(producers)
    || !policy || policy.schema !== AUTHORITY_SCHEMA || policy.policyVersion !== AUTHORITY_VERSION
    || policy.defaultDecision !== "deny" || policy.replayReauthorizationRequired !== true || !Array.isArray(rules)) {
    throw new BatchLiveWorkerError("AUTHORITY_DENIED", "current batch authority contracts are invalid or do not require replay reauthorization");
  }
  const producer = producers.map(row).find((entry) => entry?.id === BATCH_EVALUATOR_AUTHORITY.id
    && entry.version === BATCH_EVALUATOR_AUTHORITY.version && entry.digest === BATCH_EVALUATOR_AUTHORITY.digest);
  const rule = rules.map(row).find((entry) => entry?.artifactSchema === artifactSchema && entry.stage === stage);
  const artifactSchemas = producer?.artifactSchemas;
  const observationClasses = producer?.observationClasses;
  const allowedProducerIds = rule?.allowedProducerIds;
  const allowedAuthorityClasses = rule?.allowedAuthorityClasses;
  const requiredTrustedInputs = rule?.requiredTrustedInputs;
  if (!producer || !rule || !Array.isArray(artifactSchemas) || !artifactSchemas.includes(artifactSchema)
    || typeof producer.authorityClass !== "string"
    || !Array.isArray(allowedProducerIds) || !allowedProducerIds.includes(BATCH_EVALUATOR_AUTHORITY.id)
    || !Array.isArray(allowedAuthorityClasses) || !allowedAuthorityClasses.includes(producer.authorityClass)
    || !Array.isArray(requiredTrustedInputs) || requiredTrustedInputs.some((input) => typeof input !== "string" || !trustedInputs.includes(input))
    || (requiredObservationClasses.length > 0 && (!Array.isArray(observationClasses)
      || requiredObservationClasses.some((value) => !observationClasses.includes(value))))) {
    throw new BatchLiveWorkerError("AUTHORITY_DENIED", `current authority denies ${artifactSchema} at ${stage}`);
  }
}

export type BatchLivePolicyV1 = {
  workspaceId: string;
  exactScope: ObservationScope;
  producerEpoch: string;
  sourcePolicyDigest: Digest;
  evaluationPolicyDigest: Digest;
  inactivityGapMs: number;
  maxTurns: number;
  maxEvidenceBytes: number;
  flushMaxAgeMs: number;
  evidenceTtlMs: number;
  deferDelayMs: number;
  maxInferenceCallsPerRun: 1;
  runner: BatchShadowRunnerConfigV2;
};

export type BatchLiveJobV1 = {
  schema: typeof BATCH_LIVE_JOB_SCHEMA;
  jobId: Digest;
  partition: BatchPartitionV1;
  evaluationPolicyDigest: Digest;
  bundle: CompiledBatchBundleV1;
  createdAt: string;
};

export type BatchLiveTerminalV1 = {
  schema: typeof BATCH_LIVE_TERMINAL_SCHEMA;
  terminalId: Digest;
  jobId: Digest;
  bundleId: Digest;
  resultKey: Digest;
  resultDigest: Digest;
  dispositions: BatchEvaluationDispositionV1[];
  completedAt: string;
};

export type BatchLiveFailureV1 = {
  schema: typeof BATCH_LIVE_FAILURE_SCHEMA;
  failureId: Digest;
  jobId: Digest;
  bundleId: Digest;
  errorCode: string;
  attempt: number;
  maxAttempts: number;
  traceIds: Digest[];
  failedAt: string;
};

export type BatchLiveRunResult =
  | { status: "idle" | "busy"; reason?: string }
  | {
      status: "retry" | "terminal_failure";
      jobId: Digest;
      sourceCount: number;
      reason: string;
      attempt: number;
      maxAttempts: number;
    }
  | {
      status: "completed" | "duplicate";
      jobId: Digest;
      sourceCount: number;
      observationCount: number;
      deferredCount: number;
      resultKey: Digest;
    };

export type BatchLiveFaultPoint =
  | "after_job"
  | "after_result"
  | "after_observation"
  | "after_terminal"
  | "after_source"
  | "after_done";

export class BatchLiveWorkerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BatchLiveWorkerError";
  }
}

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

function fail(code: string, message: string): never {
  throw new BatchLiveWorkerError(code, message);
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left as JsonValue) === canonical(right as JsonValue);
}

function digestKey(value: Digest): string {
  if (!DIGEST_RE.test(value)) fail("INVALID_DIGEST", "digest is invalid");
  return value.slice("sha256:".length);
}

function readJson<T>(path: string): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { fail("STATE_CORRUPT", `invalid JSON artifact: ${path}`); }
}

function writeImmutable(path: string, value: JsonValue): "created" | "duplicate" {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temp, "wx", 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  try { linkSync(temp, path); }
  catch (error: any) {
    unlinkSync(temp);
    if (error?.code !== "EEXIST") throw error;
    if (!same(readJson(path), value)) fail("CONTENT_CONFLICT", `immutable artifact conflict: ${path}`);
    return "duplicate";
  }
  unlinkSync(temp);
  return "created";
}

function scopeFromPartition(partition: BatchPartitionV1): ObservationScope {
  return {
    workspaceId: partition.workspaceId,
    runtimeSessionKey: partition.runtimeSessionKey,
    scopeClass: partition.scopeClass,
    scopeId: partition.scopeId,
  };
}

function sameScope(left: ObservationScope, right: ObservationScope): boolean {
  return left.workspaceId === right.workspaceId
    && left.runtimeSessionKey === right.runtimeSessionKey
    && left.scopeClass === right.scopeClass
    && left.scopeId === right.scopeId;
}

function evidenceBytes(input: EvaluationEvidenceV1): number {
  return Buffer.byteLength(canonical(input.evidence.payload), "utf8");
}

function selectCandidate(
  due: EvaluationEvidenceV1[],
  policy: BatchLivePolicyV1,
  now: Date,
): EvaluationEvidenceV1[] {
  const exact = due.filter((entry) => sameScope(entry.envelope.scope, policy.exactScope)
    && entry.envelope.policyDigest === policy.sourcePolicyDigest)
    .sort((left, right) => left.envelope.sourceCompletedAt.localeCompare(right.envelope.sourceCompletedAt)
      || left.envelope.traceId.localeCompare(right.envelope.traceId));
  if (exact.length === 0) return [];
  const selected: EvaluationEvidenceV1[] = [];
  let bytes = 0;
  for (const entry of exact) {
    const previous = selected.at(-1);
    const nextBytes = evidenceBytes(entry);
    if (previous && Date.parse(entry.envelope.sourceCompletedAt) - Date.parse(previous.envelope.sourceCompletedAt) > policy.inactivityGapMs) break;
    if (selected.length >= policy.maxTurns || bytes + nextBytes > policy.maxEvidenceBytes) break;
    selected.push(entry);
    bytes += nextBytes;
  }
  if (selected.length === 0) return [];
  const firstAge = now.getTime() - Date.parse(selected[0]!.envelope.sourceCompletedAt);
  const lastIdle = now.getTime() - Date.parse(selected.at(-1)!.envelope.sourceCompletedAt);
  const flush = selected.length >= policy.maxTurns
    || bytes >= policy.maxEvidenceBytes
    || firstAge >= policy.flushMaxAgeMs
    || lastIdle >= policy.inactivityGapMs;
  return flush ? selected : [];
}

function makeJob(candidate: EvaluationEvidenceV1[], policy: BatchLivePolicyV1, now: Date): BatchLiveJobV1 {
  const partition: BatchPartitionV1 = {
    ...policy.exactScope,
    producerEpoch: policy.producerEpoch,
    policyDigest: policy.sourcePolicyDigest,
  };
  const frame: BatchSourceFrameV1 = {
    schema: BATCH_FRAME_SCHEMA,
    partition,
    sealedAt: now.toISOString(),
    sources: candidate,
  };
  const compiler: BatchCompilerConfigV1 = {
    schema: "engram.memory-batch-compiler-config.v1",
    inactivityGapMs: policy.inactivityGapMs,
    maxTurns: policy.maxTurns,
    maxEvidenceBytes: policy.maxEvidenceBytes,
    maxAgeMs: policy.evidenceTtlMs,
  };
  const compiled = compileBatchFrame(frame, compiler);
  if (compiled.exclusions.length !== 0 || compiled.bundles.length !== 1
    || compiled.bundles[0]!.sourceRefs.length !== candidate.length) {
    fail("LIVE_COMPILE_FAILED", "live compiler did not produce exactly one lossless bundle");
  }
  const bundle = compiled.bundles[0]!;
  const jobId = sha256({
    schema: BATCH_LIVE_JOB_SCHEMA,
    partition,
    evaluationPolicyDigest: policy.evaluationPolicyDigest,
    bundleId: bundle.bundleId,
  } as unknown as JsonValue);
  return {
    schema: BATCH_LIVE_JOB_SCHEMA,
    jobId,
    partition,
    evaluationPolicyDigest: policy.evaluationPolicyDigest,
    bundle,
    createdAt: now.toISOString(),
  };
}

function persistOrReuseJob(path: string, candidate: BatchLiveJobV1): BatchLiveJobV1 {
  if (!existsSync(path)) {
    writeImmutable(path, candidate as unknown as JsonValue);
    return candidate;
  }
  const current = readJson<BatchLiveJobV1>(path);
  if (current.schema !== BATCH_LIVE_JOB_SCHEMA
    || current.jobId !== candidate.jobId
    || current.bundle.bundleId !== candidate.bundle.bundleId
    || current.evaluationPolicyDigest !== candidate.evaluationPolicyDigest
    || !same(current.partition, candidate.partition)
    || !same(current.bundle.sourceRefs, candidate.bundle.sourceRefs)) {
    fail("CONTENT_CONFLICT", `immutable batch job identity conflict: ${path}`);
  }
  return current;
}

function observationFromAssertion(options: {
  job: BatchLiveJobV1;
  result: BatchShadowResultV1;
  groupId: string;
  assertionIndex: number;
  section: EpisodicSection;
  text: string;
  actorRef: EpisodicActorRef;
  outcomeStatus: EpisodicOutcomeStatus;
  confidence: number;
  reasonCodes: string[];
  citations: BatchScopedCitationV1[];
  completedAt: string;
}): BatchObservationV1 {
  const cited = new Set(options.citations.map((citation) => citation.traceId));
  const sourceRefs = options.job.bundle.sourceRefs.filter((source) => cited.has(source.traceId));
  if (sourceRefs.length === 0) fail("INVALID_CITATION", "batch assertion has no exact cited sources");
  const observationClass: BatchObservationV1["observationClass"] = options.section === "events"
    ? "episodic.event"
    : "episodic.decision";
  const observationId = deriveBatchObservationId({
    bundleId: options.job.bundle.bundleId,
    groupId: options.groupId,
    assertionIndex: options.assertionIndex,
    observationClass,
    evaluationPolicyDigest: options.job.evaluationPolicyDigest,
  });
  const base = {
    schema: BATCH_OBSERVATION_SCHEMA,
    observationId,
    bundleId: options.job.bundle.bundleId,
    groupId: options.groupId,
    assertionIndex: options.assertionIndex,
    scope: scopeFromPartition(options.job.partition),
    sourceRefs,
    producer: BATCH_EVALUATOR_AUTHORITY,
    observationClass,
    targetConsumer: "daily-note" as const,
    payload: {
      section: options.section,
      text: options.text,
      actorRef: options.actorRef,
      outcomeStatus: options.outcomeStatus,
    },
    citations: options.citations,
    sourceCompletedAt: sourceRefs.map((source) => source.sourceCompletedAt).sort().at(-1)!,
    confidence: options.confidence,
    reasonCodes: options.reasonCodes,
    evaluationPolicyDigest: options.job.evaluationPolicyDigest,
    completedAt: options.completedAt,
  };
  return { ...base, observationDigest: sha256(base as unknown as JsonValue) };
}

export class BatchLiveWorker {
  readonly root: string;

  constructor(private readonly options: {
    workspace: string;
    ledger: MemoryObservationLedger;
    policy: BatchLivePolicyV1;
    storeRoot: string;
    complete: (request: BatchShadowCompletionRequest) => Promise<BatchShadowProviderResult>;
    now?: () => Date;
    leaseTtlMs?: number;
    fault?: (point: BatchLiveFaultPoint) => void;
    resolveAuthorityContracts?: () => BatchAuthorityContracts;
  }) {
    this.root = join(resolve(options.storeRoot), "memory-batch-live", "v1");
    if (options.policy.maxInferenceCallsPerRun !== 1 || options.policy.runner.messageMode !== "single-user") {
      fail("INVALID_POLICY", "live batch policy must allow exactly one tool-free inference call per run");
    }
  }

  async processOne(): Promise<BatchLiveRunResult> {
    const now = this.options.now?.() ?? new Date();
    const ownerToken = `batch-live:${randomUUID()}`;
    if (!this.options.ledger.acquireWorkerLease("evaluator", ownerToken, this.options.leaseTtlMs ?? 300_000, now)) {
      return { status: "busy" };
    }
    try {
      const pending = this.pendingJob(this.options.policy);
      let job = pending;
      if (job) {
        const queueByTrace = new Map(this.options.ledger.listQueue().map((record) => [record.traceId, record]));
        const retryNotDue = job.bundle.sourceRefs.some((source) => {
          const record = queueByTrace.get(source.traceId);
          return record?.status === "queued" && Date.parse(record.nextAttemptAt) > now.getTime();
        });
        if (retryNotDue) return { status: "idle", reason: "pending_retry_not_due" };
      }
      if (!job) {
        const candidate = selectCandidate(this.options.ledger.peekDueEvaluationEvidence(now), this.options.policy, now);
        if (candidate.length === 0) return { status: "idle", reason: "flush_not_due" };
        job = makeJob(candidate, this.options.policy, now);
        job = persistOrReuseJob(this.jobPath(job.jobId), job);
        this.options.fault?.("after_job");
      }
      if (job.evaluationPolicyDigest !== this.options.policy.evaluationPolicyDigest
        || !sameScope(scopeFromPartition(job.partition), this.options.policy.exactScope)) {
        fail("POLICY_CONFLICT", "pending batch job is outside the active exact policy");
      }
      this.authorizeCurrentBatchEffects();
      let run: Awaited<ReturnType<typeof runBatchShadow>>;
      try {
        run = await runBatchShadow({
          bundle: job.bundle,
          config: this.options.policy.runner,
          storeRoot: resolve(this.options.storeRoot),
          complete: this.options.complete,
          now: this.options.now,
        });
      } catch (error) {
        const failedAt = this.options.now?.() ?? new Date();
        const errorCode = error instanceof BatchShadowRunnerError
          ? `batch_${error.code.toLowerCase()}`
          : "batch_provider_failure";
        const claimed = this.options.ledger.claimBatchExact(
          ownerToken,
          job.bundle.sourceRefs.map((source) => source.traceId),
          failedAt,
        );
        const retried = claimed.map((record) => this.options.ledger.retry(
          record,
          this.options.policy.deferDelayMs,
          errorCode,
          failedAt,
        ));
        const terminal = retried.every((record) => record.status === "terminal");
        if (terminal) {
          const failureBase = {
            schema: BATCH_LIVE_FAILURE_SCHEMA,
            jobId: job.jobId,
            bundleId: job.bundle.bundleId,
            errorCode,
            attempt: Math.max(...retried.map((record) => record.attempt)),
            maxAttempts: Math.max(...retried.map((record) => record.maxAttempts)),
            traceIds: job.bundle.sourceRefs.map((source) => source.traceId),
            failedAt: failedAt.toISOString(),
          };
          const failure: BatchLiveFailureV1 = {
            ...failureBase,
            failureId: sha256(failureBase as unknown as JsonValue),
          };
          writeImmutable(this.failurePath(job.jobId), failure as unknown as JsonValue);
          writeImmutable(this.donePath(job.jobId), failure as unknown as JsonValue);
        }
        return {
          status: terminal ? "terminal_failure" : "retry",
          jobId: job.jobId,
          sourceCount: job.bundle.sourceRefs.length,
          reason: errorCode,
          attempt: Math.max(...retried.map((record) => record.attempt)),
          maxAttempts: Math.max(...retried.map((record) => record.maxAttempts)),
        };
      }
      this.options.fault?.("after_result");
      this.authorizeCurrentBatchEffects();
      const observations: BatchObservationV1[] = [];
      for (const group of run.result.groups) {
        if (group.decision !== "write") continue;
        group.assertions.forEach((assertion, assertionIndex) => {
          observations.push(observationFromAssertion({
            job: job!,
            result: run.result,
            groupId: group.groupId,
            assertionIndex,
            section: assertion.section,
            text: assertion.text,
            actorRef: assertion.actorRef,
            outcomeStatus: assertion.outcomeStatus,
            confidence: assertion.confidence,
            reasonCodes: assertion.reasonCodes,
            citations: assertion.citations,
            completedAt: run.result.completedAt,
          }));
        });
      }
      for (const observation of observations) {
        validateBatchObservation(observation);
        this.authorizeCurrentArtifact(BATCH_OBSERVATION_SCHEMA, "advisory-batch-evaluation", BATCH_TRUSTED_INPUTS, ["episodic.event", "episodic.decision"]);
        writeImmutable(this.observationPath(observation.observationId), observation as unknown as JsonValue);
        this.options.fault?.("after_observation");
      }
      const observationRefsByTrace = new Map<Digest, Digest[]>();
      for (const observation of observations) {
        for (const source of observation.sourceRefs) {
          const values = observationRefsByTrace.get(source.traceId) ?? [];
          values.push(observation.observationId);
          observationRefsByTrace.set(source.traceId, values);
        }
      }
      const groupByTrace = new Map(run.result.groups.flatMap((group) => group.sourceRefs.map((traceId) => [traceId, group] as const)));
      const dispositions: BatchLiveTerminalV1["dispositions"] = job.bundle.sourceRefs.map((source) => {
        const group = groupByTrace.get(source.traceId);
        if (!group) fail("SOURCE_COVERAGE", "validated result lost a source group");
        if (group.decision === "defer") {
          return { traceId: source.traceId, decision: "defer", reasonCode: "semantic_batch_defer", observationRefs: [] };
        }
        const refs = observationRefsByTrace.get(source.traceId) ?? [];
        if (group.decision === "write" && refs.length > 0) {
          return { traceId: source.traceId, decision: "write", reasonCode: "semantic_batch_write", observationRefs: refs };
        }
        return {
          traceId: source.traceId,
          decision: "skip",
          reasonCode: group.decision === "skip" ? "semantic_batch_skip" : "semantic_batch_grouped_no_assertion",
          observationRefs: [],
        };
      });
      const terminalBase = {
        schema: BATCH_LIVE_TERMINAL_SCHEMA,
        jobId: job.jobId,
        bundleId: job.bundle.bundleId,
        resultKey: run.result.resultKey,
        resultDigest: sha256(run.result as unknown as JsonValue),
        dispositions,
        completedAt: run.result.completedAt,
      };
      const terminal: BatchLiveTerminalV1 = {
        ...terminalBase,
        terminalId: sha256(terminalBase as unknown as JsonValue),
      };
      this.authorizeCurrentArtifact(TRACE_SCHEMA, "trace-append", TRACE_TRUSTED_INPUTS);
      writeImmutable(this.terminalPath(job.jobId), terminal as unknown as JsonValue);
      this.options.fault?.("after_terminal");

      const previouslyDeferred = new Set(this.options.ledger.listQueue()
        .filter((record) => record.status === "queued" && record.reasonCode === "semantic_batch_defer")
        .map((record) => record.traceId));
      const claimed = this.options.ledger.claimBatchExact(
        ownerToken,
        dispositions.map((entry) => entry.traceId),
        this.options.now?.() ?? new Date(),
        new Map(dispositions.map((entry) => [entry.traceId, entry.reasonCode])),
      );
      const claimedByTrace = new Map(claimed.map((entry) => [entry.traceId, entry]));
      for (const disposition of dispositions) {
        const record = claimedByTrace.get(disposition.traceId)!;
        if (record.status !== "claimed") continue;
        if (disposition.decision === "defer" && !previouslyDeferred.has(disposition.traceId)) {
          this.options.ledger.deferBatchClaim(
            ownerToken,
            record,
            this.options.policy.deferDelayMs,
            disposition.reasonCode,
            this.options.now?.() ?? new Date(),
          );
        } else {
          this.authorizeCurrentArtifact(TRACE_SCHEMA, "trace-append", TRACE_TRUSTED_INPUTS);
          this.options.ledger.completeBatchClaim(
            ownerToken,
            record,
            BATCH_EVALUATOR_AUTHORITY,
            { ref: terminal.terminalId, digest: terminal.resultDigest },
            disposition,
            this.options.now?.() ?? new Date(),
          );
        }
        this.options.fault?.("after_source");
      }
      writeImmutable(this.donePath(job.jobId), terminal as unknown as JsonValue);
      this.options.fault?.("after_done");
      return {
        status: run.status === "duplicate" ? "duplicate" : "completed",
        jobId: job.jobId,
        sourceCount: job.bundle.sourceRefs.length,
        observationCount: observations.length,
        deferredCount: dispositions.filter((entry) => entry.decision === "defer").length,
        resultKey: run.result.resultKey,
      };
    } finally {
      this.options.ledger.releaseWorkerLease("evaluator", ownerToken);
    }
  }

  private pendingJob(policy: BatchLivePolicyV1): BatchLiveJobV1 | null {
    const directory = join(this.root, "jobs");
    if (!existsSync(directory)) return null;
    const jobs = readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort();
    for (const name of jobs) {
      const job = readJson<BatchLiveJobV1>(join(directory, name));
      if (!existsSync(this.donePath(job.jobId))
        && job.evaluationPolicyDigest === policy.evaluationPolicyDigest
        && sameScope(scopeFromPartition(job.partition), policy.exactScope)) return job;
    }
    return null;
  }

  private currentAuthorityContracts(): BatchAuthorityContracts {
    if (this.options.resolveAuthorityContracts) return this.options.resolveAuthorityContracts();
    return {
      producerRegistry: readJson(join(CONTRACT_ROOT, "producer-registry.json")),
      authorityPolicy: readJson(join(CONTRACT_ROOT, "authority-policy.json")),
    };
  }

  private authorizeCurrentArtifact(artifactSchema: string, stage: string, trustedInputs: string[], observationClasses: string[] = []): void {
    authorizeBatchArtifact(this.currentAuthorityContracts(), artifactSchema, stage, trustedInputs, observationClasses);
  }

  private authorizeCurrentBatchEffects(): void {
    this.authorizeCurrentArtifact(BATCH_OBSERVATION_SCHEMA, "advisory-batch-evaluation", BATCH_TRUSTED_INPUTS, ["episodic.event", "episodic.decision"]);
    this.authorizeCurrentArtifact(TRACE_SCHEMA, "trace-append", TRACE_TRUSTED_INPUTS);
  }

  private jobPath(jobId: Digest): string {
    return join(this.root, "jobs", `${digestKey(jobId)}.json`);
  }

  private terminalPath(jobId: Digest): string {
    return join(this.root, "terminals", `${digestKey(jobId)}.json`);
  }

  private failurePath(jobId: Digest): string {
    return join(this.root, "failures", `${digestKey(jobId)}.json`);
  }

  private donePath(jobId: Digest): string {
    return join(this.root, "done", `${digestKey(jobId)}.json`);
  }

  private observationPath(observationId: Digest): string {
    return join(this.options.workspace, "memory-state", "memory-observation", "v1", "observations", "batch", `${digestKey(observationId)}.json`);
  }
}
