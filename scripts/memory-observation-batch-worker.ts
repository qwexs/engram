#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { BatchLiveWorker, type BatchLivePolicyV1 } from "../src/memory-observation/batch-live-worker.ts";
import { openClawRawModelRunProvider } from "../src/memory-observation/batch-shadow-openclaw-provider.ts";
import {
  buildDailyNoteCanaryPolicy,
  DailyNoteCanaryApplicator,
} from "../src/memory-observation/daily-note-applicator.ts";
import { MemoryObservationLedger, purgeMemoryObservationLifecycle, sha256, type Digest, type JsonValue, type ObservationScope } from "../src/memory-observation/ledger.ts";
import {
  MEMORY_OBSERVATION_PROJECTION_SCHEMA_V2,
  MEMORY_OBSERVATION_PROJECTION_SCHEMA_V3,
  memoryObservationBinding,
  memoryObservationDailyNoteCanary,
  memoryObservationEvaluationMode,
  resolveMemoryObservationProjection,
} from "../src/memory-observation/projection.ts";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1]!;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function sourcePluginDigest(repository: string): Promise<`sha256:${string}`> {
  const previous = process.cwd();
  let build: Awaited<ReturnType<typeof Bun.build>>;
  try {
    process.chdir(repository);
    build = await Bun.build({
      entrypoints: ["./integrations/openclaw-memory-observation/index.ts"],
      target: "node",
      format: "esm",
      external: ["openclaw/plugin-sdk/core"],
      minify: false,
      sourcemap: "none",
      write: false,
    });
  } finally { process.chdir(previous); }
  if (!build!.success || build!.outputs.length !== 1) throw new Error("memory observation plugin build failed");
  return `sha256:${createHash("sha256").update(Buffer.from(await build!.outputs[0]!.arrayBuffer())).digest("hex")}`;
}

if (process.argv.length !== 4 || process.argv[2] !== "--workspace") {
  throw new Error("usage: memory-observation-batch-worker.ts --workspace <absolute-workspace>");
}
const workspaceArgument = argument("--workspace");
if (!isAbsolute(workspaceArgument)) throw new Error("--workspace must be absolute");
const workspace = resolve(workspaceArgument);
const workspaceId = readJson(join(workspace, "engram.json"))?.workspace?.id;
if (typeof workspaceId !== "string" || !workspaceId) throw new Error("workspace id is unavailable");
purgeMemoryObservationLifecycle(workspace);
const projectionPath = join(workspace, "memory-state", "memory-observation", "projection.json");
if (!existsSync(projectionPath) || readJson(projectionPath)?.enabled !== true) {
  process.stdout.write(`${JSON.stringify({ status: "disabled", reason: "projection_inactive", workspaceId })}\n`);
  process.exit(0);
}
const repository = resolve(import.meta.dir, "..");
const expectedPluginDigest = await sourcePluginDigest(repository);
const projection = resolveMemoryObservationProjection({ workspace, workspaceId, expectedPluginDigest });
if (![MEMORY_OBSERVATION_PROJECTION_SCHEMA_V2, MEMORY_OBSERVATION_PROJECTION_SCHEMA_V3].includes(projection.schema as any)
  || projection.mode !== "canary"
  || memoryObservationEvaluationMode(projection) !== "batch-cron"
  || projection.bindings.length !== 1
  || projection.limits.maxInferenceCalls !== 1
  || !projection.evaluation?.batch) {
  process.stdout.write(`${JSON.stringify({ status: "disabled", reason: "batch_canary_inactive", workspaceId })}\n`);
  process.exit(0);
}
const batch = projection.evaluation.batch;
const dailyNote = memoryObservationDailyNoteCanary(projection);
if (!dailyNote || projection.captureOwnership?.owner !== "observer") {
  throw new Error("batch canary binding, daily-note consumer, or observer ownership is unavailable");
}
const contracts = join(repository, "contracts", "memory-observation", "v1");
const producerRegistry = readJson(join(contracts, "producer-registry.json"));
const authorityPolicy = readJson(join(contracts, "authority-policy.json"));
const storeRoot = join(workspace, "memory-state", "memory-observation", "batch-live-store");

type ScopeCandidate = { scope: ObservationScope; firstAt: string };

function sameScope(left: ObservationScope, right: ObservationScope): boolean {
  return left.workspaceId === right.workspaceId
    && left.runtimeSessionKey === right.runtimeSessionKey
    && left.scopeClass === right.scopeClass
    && left.scopeId === right.scopeId;
}

function admittedScope(value: any): ObservationScope | null {
  const scope = value?.scope as ObservationScope | undefined;
  if (!scope || scope.workspaceId !== workspaceId || typeof scope.runtimeSessionKey !== "string") return null;
  const binding = memoryObservationBinding(projection, scope.runtimeSessionKey);
  if (!binding || binding.scopeClass !== scope.scopeClass || binding.scopeId !== scope.scopeId) return null;
  return scope;
}

function currentlyBoundScope(value: any): ObservationScope | null {
  const runtimeSessionKey = value?.scope?.runtimeSessionKey;
  if (typeof runtimeSessionKey !== "string") return null;
  const binding = memoryObservationBinding(projection, runtimeSessionKey);
  if (!binding) return null;
  return {
    workspaceId,
    runtimeSessionKey,
    scopeClass: binding.scopeClass,
    scopeId: binding.scopeId,
  };
}

function collectScopes(): ScopeCandidate[] {
  const candidates = new Map<string, ScopeCandidate>();
  const add = (scope: ObservationScope | null, firstAt: unknown) => {
    if (!scope || typeof firstAt !== "string" || !Number.isFinite(Date.parse(firstAt))) return;
    const key = JSON.stringify(scope);
    const current = candidates.get(key);
    if (!current || firstAt < current.firstAt) candidates.set(key, { scope, firstAt });
  };
  const envelopeDirectory = join(workspace, "memory-state", "memory-observation", "v1", "envelopes");
  if (existsSync(envelopeDirectory)) {
    for (const name of readdirSync(envelopeDirectory).filter((entry) => entry.endsWith(".json"))) {
      const value = readJson(join(envelopeDirectory, name));
      if (value?.policyDigest === batch.sourcePolicyDigest
        && Date.parse(value?.admittedAt) >= Date.parse(projection.inference.evaluateAfter)) {
        add(admittedScope(value), value.sourceCompletedAt);
      }
    }
  }
  const dailyQueueDirectory = join(workspace, "memory-state", "memory-observation", "v1", "consumers", "daily-note", "queue");
  const pendingDailyObservationIds = new Set(existsSync(dailyQueueDirectory)
    ? readdirSync(dailyQueueDirectory).filter((entry) => entry.endsWith(".json"))
      .map((name) => readJson(join(dailyQueueDirectory, name)))
      .filter((value) => value?.status !== "terminal" && typeof value?.observationId === "string")
      .map((value) => value.observationId)
    : []);
  const observationDirectory = join(workspace, "memory-state", "memory-observation", "v1", "observations", "batch");
  if (existsSync(observationDirectory)) {
    for (const name of readdirSync(observationDirectory).filter((entry) => entry.endsWith(".json"))) {
      const value = readJson(join(observationDirectory, name));
      if (value?.evaluationPolicyDigest === projection.evaluation!.policyDigest
        && Date.parse(value?.completedAt) >= Date.parse(dailyNote.applyAfter)) {
        add(admittedScope(value), value.completedAt);
      } else if (pendingDailyObservationIds.has(value?.observationId)) {
        add(currentlyBoundScope(value), value.completedAt);
      }
    }
  }
  const typedObservationDirectory = join(workspace, "memory-state", "memory-observation", "v1", "observations", "typed");
  if (existsSync(typedObservationDirectory) && pendingDailyObservationIds.size > 0) {
    for (const name of readdirSync(typedObservationDirectory).filter((entry) => entry.endsWith(".json"))) {
      const value = readJson(join(typedObservationDirectory, name));
      if (pendingDailyObservationIds.has(value?.observationId)) {
        add(currentlyBoundScope(value), value.completedAt);
      }
    }
  }
  return [...candidates.values()].sort((left, right) => left.firstAt.localeCompare(right.firstAt)
    || left.scope.runtimeSessionKey.localeCompare(right.scope.runtimeSessionKey));
}

function ledgerFor(scope: ObservationScope, current = projection): MemoryObservationLedger {
  return new MemoryObservationLedger({
    workspace,
    workspaceId,
    exactSessionKeys: [scope.runtimeSessionKey],
    producerRegistry,
    authorityPolicy,
    limits: {
      evidenceTtlMs: current.limits.evidenceTtlHours * 60 * 60 * 1_000,
      maxJobs: current.limits.maxJobs,
      maxBytes: current.limits.maxBytes,
      maxQueueAgeMs: current.limits.maxQueueAgeHours * 60 * 60 * 1_000,
      maxAttempts: current.limits.maxAttempts,
      claimTtlMs: current.limits.claimTtlSeconds * 1_000,
      maxInferenceCalls: 1,
    },
    evaluatorEnabled: true,
    evaluationStartedAt: current.inference.evaluateAfter,
  });
}

function livePolicy(scope: ObservationScope, current = projection): BatchLivePolicyV1 {
  const currentBatch = current.evaluation!.batch!;
  return {
    workspaceId,
    exactScope: scope,
    producerEpoch: "v1",
    sourcePolicyDigest: currentBatch.sourcePolicyDigest as Digest,
    evaluationPolicyDigest: current.evaluation!.policyDigest,
    inactivityGapMs: currentBatch.inactivityGapSeconds * 1_000,
    maxTurns: currentBatch.maxTurns,
    maxEvidenceBytes: currentBatch.maxEvidenceBytes,
    flushMaxAgeMs: currentBatch.maxAgeSeconds * 1_000,
    evidenceTtlMs: current.limits.evidenceTtlHours * 60 * 60 * 1_000,
    deferDelayMs: currentBatch.inactivityGapSeconds * 1_000,
    maxInferenceCallsPerRun: 1,
    runner: {
      schema: "engram.memory-batch-shadow-runner-config.v2",
      requestedModel: current.inference.model,
      maxTokens: 8_192,
      temperature: 0,
      messageMode: "single-user",
    },
  };
}

function dailyPolicy(scope: ObservationScope, current = projection) {
  const currentDaily = memoryObservationDailyNoteCanary(current)!;
  return buildDailyNoteCanaryPolicy({
    workspaceId,
    exactScope: scope,
    applyAfter: currentDaily.applyAfter,
    timezone: currentDaily.timezone,
    allowedObservationClasses: currentDaily.allowedObservationClasses,
    maxAppliesPerWake: currentDaily.maxAppliesPerWake,
    allowedBatchEvaluationPolicyDigest: current.evaluation!.policyDigest,
    ...(currentDaily.qmdBinding ? { qmdBinding: currentDaily.qmdBinding } : {}),
  });
}

function currentProjectionForScope(scope: ObservationScope) {
  const current = resolveMemoryObservationProjection({ workspace, workspaceId, expectedPluginDigest });
  const binding = memoryObservationBinding(current, scope.runtimeSessionKey);
  const currentDaily = memoryObservationDailyNoteCanary(current);
  if (current.mode !== "canary" || memoryObservationEvaluationMode(current) !== "batch-cron"
    || current.bindings.length !== 1 || current.limits.maxInferenceCalls !== 1 || !current.evaluation?.batch
    || !currentDaily || current.captureOwnership?.owner !== "observer"
    || current.captureOwnership.effectiveAfter !== currentDaily.applyAfter || !binding
    || !sameScope(scope, { workspaceId, runtimeSessionKey: scope.runtimeSessionKey, scopeClass: binding.scopeClass, scopeId: binding.scopeId })) {
    throw new Error("batch canary live policy is unavailable or changed");
  }
  return current;
}

function applicatorFor(scope: ObservationScope): DailyNoteCanaryApplicator {
  return new DailyNoteCanaryApplicator({
    workspace,
    resolveActivePolicy: () => {
      if (!existsSync(join(workspace, "memory-state", "memory-observation", "projection.json"))) return null;
      try {
        return dailyPolicy(scope, currentProjectionForScope(scope));
      } catch { return null; }
    },
  });
}

let evaluation: Awaited<ReturnType<BatchLiveWorker["processOne"]>> = { status: "idle" };
let evaluationScope: ObservationScope | null = null;
const rawComplete = openClawRawModelRunProvider({ cwd: workspace });
for (const candidate of collectScopes()) {
  const current = currentProjectionForScope(candidate.scope);
  const workerPolicy = livePolicy(candidate.scope, current);
  const policyDigest = sha256(workerPolicy as unknown as JsonValue);
  const worker = new BatchLiveWorker({
    workspace,
    ledger: ledgerFor(candidate.scope, current),
    policy: workerPolicy,
    storeRoot,
    complete: async (request) => {
      if (sha256(livePolicy(candidate.scope, currentProjectionForScope(candidate.scope)) as unknown as JsonValue) !== policyDigest) throw new Error("batch canary policy changed before inference");
      const result = await rawComplete(request);
      if (sha256(livePolicy(candidate.scope, currentProjectionForScope(candidate.scope)) as unknown as JsonValue) !== policyDigest) throw new Error("batch canary policy changed during inference");
      return result;
    },
    leaseTtlMs: current.limits.claimTtlSeconds * 1_000,
  });
  const result = await worker.processOne();
  if (result.status !== "idle") {
    evaluation = result;
    evaluationScope = candidate.scope;
    break;
  }
}

const dueApplicators = collectScopes().map((candidate) => {
  const applicator = applicatorFor(candidate.scope);
  applicator.reconcile();
  return { ...candidate, applicator, dueAt: applicator.nextDueAt() };
}).filter((candidate) => candidate.dueAt !== null)
  .sort((left, right) => left.dueAt!.getTime() - right.dueAt!.getTime()
    || left.scope.runtimeSessionKey.localeCompare(right.scope.runtimeSessionKey));
const applyTarget = dueApplicators[0] ?? null;
const apply = applyTarget ? await applyTarget.applicator.processOne() : { status: "idle" as const };
process.stdout.write(`${JSON.stringify({
  schema: "engram.memory-batch-live-run.v1",
  workspaceId,
  schedulerId: batch.schedulerId,
  evaluation,
  evaluationScope,
  apply,
  applyScope: applyTarget?.scope ?? null,
})}\n`);
