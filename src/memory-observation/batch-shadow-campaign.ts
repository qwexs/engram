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
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  BATCH_FRAME_SCHEMA,
  compileBatchFrame,
  type BatchCompileArtifactV1,
  type BatchCompilerConfigV1,
  type BatchPartitionV1,
  type BatchSourceFrameEntryV1,
  type BatchSourceFrameV1,
} from "./batch-compiler.ts";
import {
  BATCH_OBSERVATION_SCHEMA,
  validateBatchObservation,
  type BatchObservationV1,
} from "./batch-observation.ts";
import {
  openClawGatewayModelRunProvider,
  openClawRawModelRunProvider,
} from "./batch-shadow-openclaw-provider.ts";
import {
  BatchShadowRunnerError,
  batchShadowPrompt,
  runBatchShadow,
  type BatchShadowCompletionRequest,
  type BatchShadowProviderResult,
  type BatchShadowResultV1,
  type BatchShadowRunnerConfigV2,
  type BatchShadowRunnerConfigV3,
} from "./batch-shadow-runner.ts";
import { sha256, type Digest, type JsonValue, type ObservationScope } from "./ledger.ts";

type Row = Record<string, unknown>;

export const BATCH_CAMPAIGN_CONFIG_SCHEMA = "engram.memory-batch-shadow-campaign-config.v1" as const;
export const BATCH_CAMPAIGN_CONFIG_SCHEMA_V2 = "engram.memory-batch-shadow-campaign-config.v2" as const;
export const BATCH_CAMPAIGN_MANIFEST_SCHEMA = "engram.memory-batch-shadow-campaign.v1" as const;

export type BatchShadowCampaignConfigV1 = {
  schema: typeof BATCH_CAMPAIGN_CONFIG_SCHEMA;
  ledgerRoot: string;
  storeRoot: string;
  modelRunCwd: string;
  partition: BatchPartitionV1;
  fromInclusive: string;
  throughInclusive: string;
  sealedAt: string;
  targetTurns: number;
  compiler: BatchCompilerConfigV1;
  runner: BatchShadowRunnerConfigV2;
};

export type BatchShadowCampaignConfigV2 = Omit<BatchShadowCampaignConfigV1, "schema" | "runner"> & {
  schema: typeof BATCH_CAMPAIGN_CONFIG_SCHEMA_V2;
  gatewayAgentId: string;
  runner: BatchShadowRunnerConfigV3;
};

export type BatchShadowCampaignConfig = BatchShadowCampaignConfigV1 | BatchShadowCampaignConfigV2;

export type HistoricalDecisionV1 = {
  traceId: Digest;
  sourceCompletedAt: string;
  decision: "write" | "skip" | "defer" | "failed";
  reasonCode: string;
  observationId: Digest | null;
};

export type BatchShadowCampaignSnapshotV1 = {
  frame: BatchSourceFrameV1;
  compile: BatchCompileArtifactV1;
  historical: HistoricalDecisionV1[];
};

export type BatchShadowCampaignManifestV1 = {
  schema: typeof BATCH_CAMPAIGN_MANIFEST_SCHEMA;
  campaignId: Digest;
  createdAt: string;
  partition: BatchPartitionV1;
  cutoff: {
    fromInclusive: string;
    throughInclusive: string;
    firstSourceCompletedAt: string;
    lastSourceCompletedAt: string;
  };
  target: { requiredTurns: number; observedTurns: number; complete: boolean };
  sourceFrame: { frameDigest: Digest; path: string; retainedEvidenceCount: number };
  compiler: {
    configDigest: Digest;
    coverageDigest: Digest;
    bundleCount: number;
    exclusionCount: number;
    bundleIds: Digest[];
  };
  historical: {
    write: number;
    skip: number;
    defer: number;
    failed: number;
    reasonCodes: Record<string, number>;
    decisions: HistoricalDecisionV1[];
  };
  shadow: {
    calls: number;
    validatedCalls: number;
    failedCalls: number;
    resultKeys: Digest[];
    coveredTurns: number;
    usageReadback: "measured" | "unavailable";
    inputTokens: number | null;
    outputTokens: number | null;
    monetaryCost: "unknown" | {
      provenance: "gateway-agent-meta";
      shadowUsd: number;
    } | {
      provenance: "provider-measured";
      historicalUsd: number;
      shadowUsd: number;
      reductionPercent: number;
    };
  };
  diagnostics: {
    sourceCoverage: "met" | "not_met";
    callReductionPercent: number;
    callReductionGate: "met" | "not_met";
    corpusGate: "met" | "not_met";
    adjudicationGate: "pending";
    economicsGate: "pending_usage" | "pending_baseline_cost";
    acceptanceVerdict: "not_evaluated";
  };
};

export class BatchShadowCampaignError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BatchShadowCampaignError";
  }
}

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,299}$/;
const CONFIG_KEYS = new Set([
  "schema", "ledgerRoot", "storeRoot", "modelRunCwd", "partition", "fromInclusive", "throughInclusive",
  "sealedAt", "targetTurns", "compiler", "runner",
]);
const CONFIG_KEYS_V2 = new Set([...CONFIG_KEYS, "gatewayAgentId"]);
const PARTITION_KEYS = new Set(["workspaceId", "runtimeSessionKey", "scopeClass", "scopeId", "producerEpoch", "policyDigest"]);
const SCOPE_CLASSES = new Set(["self", "managers", "company", "project"]);

function row(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function exactKeys(value: Row, expected: Set<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left as JsonValue) === canonical(right as JsonValue);
}

function fail(code: string, message: string): never {
  throw new BatchShadowCampaignError(code, message);
}

function validInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST_RE.test(value);
}

function readJson(path: string, code = "INVALID_ARTIFACT"): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { fail(code, `invalid or missing JSON artifact: ${path}`); }
}

function validateConfig(value: unknown): BatchShadowCampaignConfig {
  const config = row(value);
  const partition = row(config?.partition);
  const v1 = config?.schema === BATCH_CAMPAIGN_CONFIG_SCHEMA;
  const v2 = config?.schema === BATCH_CAMPAIGN_CONFIG_SCHEMA_V2;
  if (!config || (!v1 && !v2) || !exactKeys(config, v2 ? CONFIG_KEYS_V2 : CONFIG_KEYS)
    || typeof config.ledgerRoot !== "string" || !isAbsolute(config.ledgerRoot)
    || typeof config.storeRoot !== "string" || !isAbsolute(config.storeRoot)
    || typeof config.modelRunCwd !== "string" || !isAbsolute(config.modelRunCwd)
    || !partition || !exactKeys(partition, PARTITION_KEYS)
    || typeof partition.workspaceId !== "string" || !TOKEN_RE.test(partition.workspaceId)
    || typeof partition.runtimeSessionKey !== "string" || !TOKEN_RE.test(partition.runtimeSessionKey)
    || typeof partition.scopeClass !== "string" || !SCOPE_CLASSES.has(partition.scopeClass)
    || typeof partition.scopeId !== "string" || !TOKEN_RE.test(partition.scopeId)
    || typeof partition.producerEpoch !== "string" || !TOKEN_RE.test(partition.producerEpoch)
    || !validDigest(partition.policyDigest)
    || !validInstant(config.fromInclusive) || !validInstant(config.throughInclusive) || !validInstant(config.sealedAt)
    || config.fromInclusive > config.throughInclusive || config.throughInclusive > config.sealedAt
    || !Number.isSafeInteger(config.targetTurns) || (config.targetTurns as number) < 1
    || !row(config.compiler) || !row(config.runner)
    || (v1 && (config.runner as Row).schema !== "engram.memory-batch-shadow-runner-config.v2")
    || (v2 && (config.runner as Row).schema !== "engram.memory-batch-shadow-runner-config.v3")
    || (config.runner as Row).messageMode !== "single-user"
    || (v2 && (typeof config.gatewayAgentId !== "string" || !TOKEN_RE.test(config.gatewayAgentId)
      || (config.runner as Row).providerMode !== "gateway-agent-meta"
      || (config.runner as Row).gatewayAgentId !== config.gatewayAgentId))) {
    fail("INVALID_CONFIG", "campaign config is not exact, bounded, or single-user tool-free");
  }
  return config as unknown as BatchShadowCampaignConfig;
}

function fileName(traceId: Digest): string {
  return `${traceId.slice("sha256:".length)}.json`;
}

function exactScope(partition: BatchPartitionV1): ObservationScope {
  return {
    workspaceId: partition.workspaceId,
    runtimeSessionKey: partition.runtimeSessionKey,
    scopeClass: partition.scopeClass,
    scopeId: partition.scopeId,
  };
}

function batchObservationForSource(root: string, entry: BatchSourceFrameEntryV1): BatchObservationV1 | null {
  const directory = join(root, "observations", "batch");
  if (!existsSync(directory)) return null;
  for (const name of readdirSync(directory).filter((value) => /^[a-f0-9]{64}\.json$/.test(value)).sort()) {
    const candidate = row(readJson(join(directory, name)));
    if (!candidate || candidate.schema !== BATCH_OBSERVATION_SCHEMA || !Array.isArray(candidate.sourceRefs)
      || !candidate.sourceRefs.some((source) => row(source)?.traceId === entry.envelope.traceId)) continue;
    let observation: BatchObservationV1;
    try {
      observation = validateBatchObservation(candidate as unknown as BatchObservationV1);
    } catch {
      continue;
    }
    const source = observation.sourceRefs.find((value) => value.traceId === entry.envelope.traceId);
    if (fileName(observation.observationId) === name && source
      && same(observation.scope, entry.envelope.scope)
      && source.sourceTurnId === entry.envelope.sourceTurnId
      && source.sourceDigest === entry.envelope.sourceDigest
      && source.evidenceDigest === entry.envelope.evidenceDigest
      && source.sourceCompletedAt === entry.envelope.sourceCompletedAt) return observation;
  }
  return null;
}

function historicalDecision(root: string, entry: BatchSourceFrameEntryV1): HistoricalDecisionV1 {
  const traceId = entry.envelope.traceId;
  const queue = row(readJson(join(root, "queues", "evaluator", fileName(traceId))));
  if (!queue || queue.schema !== "engram.memory-observation-ledger-queue.v1" || queue.traceId !== traceId
    || queue.queueClass !== "evaluator" || queue.status !== "terminal" || typeof queue.reasonCode !== "string"
    || !TOKEN_RE.test(queue.reasonCode)) {
    fail("NON_TERMINAL_BASELINE", `historical evaluator record is not terminal for ${traceId}`);
  }
  const reasonCode = queue.reasonCode as string;
  if (reasonCode === "semantic_write" || reasonCode === "semantic_batch_write") {
    let observationId: Digest;
    if (reasonCode === "semantic_write") {
      const observation = row(readJson(join(root, "observations", "typed", fileName(traceId))));
      if (!observation || observation.schema !== "engram.memory-observation.v1" || observation.traceId !== traceId
        || !validDigest(observation.observationId) || !same(observation.scope, entry.envelope.scope)) {
        fail("INVALID_BASELINE_WRITE", `historical write has no exact typed observation for ${traceId}`);
      }
      observationId = observation.observationId;
    } else {
      const observation = batchObservationForSource(root, entry);
      if (!observation) fail("INVALID_BASELINE_WRITE", `historical write has no exact batch observation for ${traceId}`);
      observationId = observation.observationId;
    }
    return {
      traceId,
      sourceCompletedAt: entry.envelope.sourceCompletedAt,
      decision: "write",
      reasonCode,
      observationId,
    };
  }
  const decision = reasonCode.startsWith("semantic_skip_")
    || reasonCode === "semantic_batch_skip"
    || reasonCode === "semantic_batch_grouped_no_assertion"
    ? "skip"
    : reasonCode === "semantic_batch_defer" ? "defer" : "failed";
  return { traceId, sourceCompletedAt: entry.envelope.sourceCompletedAt, decision, reasonCode, observationId: null };
}

export function snapshotBatchShadowCampaign(configValue: unknown): BatchShadowCampaignSnapshotV1 {
  const config = validateConfig(configValue);
  const root = resolve(config.ledgerRoot);
  const scope = exactScope(config.partition);
  const entries = readdirSync(join(root, "envelopes"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name))
    .map((entry) => readJson(join(root, "envelopes", entry.name)))
    .map((value) => row(value))
    .filter((value): value is Row => Boolean(value && same(value.scope, scope)
      && typeof value.sourceCompletedAt === "string"
      && value.sourceCompletedAt >= config.fromInclusive && value.sourceCompletedAt <= config.throughInclusive))
    .sort((left, right) => (left.sourceCompletedAt as string).localeCompare(right.sourceCompletedAt as string)
      || (left.traceId as string).localeCompare(right.traceId as string));
  if (entries.length === 0) fail("EMPTY_SNAPSHOT", "campaign cutoff contains no exact-scope source turns");
  const sources = entries.map((envelopeValue) => {
    if (!validDigest(envelopeValue.traceId)) fail("INVALID_ENVELOPE", "snapshot envelope traceId is invalid");
    const evidence = readJson(join(root, "evidence", fileName(envelopeValue.traceId)));
    return { envelope: envelopeValue, evidence } as unknown as BatchSourceFrameEntryV1;
  });
  const frame: BatchSourceFrameV1 = {
    schema: BATCH_FRAME_SCHEMA,
    partition: config.partition,
    sealedAt: config.sealedAt,
    sources,
  };
  const compile = compileBatchFrame(frame, config.compiler);
  const historical = sources.map((entry) => historicalDecision(root, entry));
  if (historical.length !== compile.sourceCount) fail("COVERAGE_FAILURE", "historical baseline does not cover the source frame");
  return { frame, compile, historical };
}

function createOnlyJson(path: string, value: JsonValue): "created" | "duplicate" {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path)) {
    const current = readJson(path);
    if (!same(current, value)) fail("ARTIFACT_CONFLICT", `create-only artifact conflict: ${path}`);
    return "duplicate";
  }
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  try { linkSync(temp, path); }
  catch (error: any) {
    unlinkSync(temp);
    if (error?.code !== "EEXIST") throw error;
    const current = readJson(path);
    if (!same(current, value)) fail("ARTIFACT_CONFLICT", `create-only artifact conflict: ${path}`);
    return "duplicate";
  }
  unlinkSync(temp);
  return "created";
}

function counts(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function buildManifest(
  config: BatchShadowCampaignConfig,
  snapshot: BatchShadowCampaignSnapshotV1,
  framePath: string,
  results: BatchShadowResultV1[],
  attempts: { calls: number; validated: number; failed: number },
): BatchShadowCampaignManifestV1 {
  const resultKeys = results.map((result) => result.resultKey);
  const covered = results.flatMap((result) => result.sourceRefs.map((source) => source.traceId));
  const sourceIds = snapshot.frame.sources.map((entry) => entry.envelope.traceId);
  const sourceCoverage = covered.length === sourceIds.length && new Set(covered).size === sourceIds.length
    && sourceIds.every((traceId) => covered.includes(traceId));
  const measured = results.length > 0 && results.every((result) => result.usageReadback === "measured" && result.usage !== null);
  const measuredCost = measured && results.every((result) => result.monetaryCost !== "unknown");
  const calls = attempts.calls;
  const callReductionPercent = Number((((sourceIds.length - calls) / sourceIds.length) * 100).toFixed(2));
  const frameDigest = snapshot.compile.frameDigest;
  const campaignId = sha256({
    schema: BATCH_CAMPAIGN_MANIFEST_SCHEMA,
    frameDigest,
    compilerConfigDigest: snapshot.compile.configDigest,
    runnerConfigDigest: sha256(config.runner as unknown as JsonValue),
    targetTurns: config.targetTurns,
    resultKeys,
  } as unknown as JsonValue);
  return {
    schema: BATCH_CAMPAIGN_MANIFEST_SCHEMA,
    campaignId,
    createdAt: config.sealedAt,
    partition: config.partition,
    cutoff: {
      fromInclusive: config.fromInclusive,
      throughInclusive: config.throughInclusive,
      firstSourceCompletedAt: snapshot.frame.sources[0].envelope.sourceCompletedAt,
      lastSourceCompletedAt: snapshot.frame.sources.at(-1)!.envelope.sourceCompletedAt,
    },
    target: {
      requiredTurns: config.targetTurns,
      observedTurns: sourceIds.length,
      complete: sourceIds.length >= config.targetTurns,
    },
    sourceFrame: { frameDigest, path: framePath, retainedEvidenceCount: sourceIds.length },
    compiler: {
      configDigest: snapshot.compile.configDigest,
      coverageDigest: snapshot.compile.coverageDigest,
      bundleCount: snapshot.compile.bundles.length,
      exclusionCount: snapshot.compile.exclusions.length,
      bundleIds: snapshot.compile.bundles.map((bundle) => bundle.bundleId),
    },
    historical: {
      write: snapshot.historical.filter((entry) => entry.decision === "write").length,
      skip: snapshot.historical.filter((entry) => entry.decision === "skip").length,
      defer: snapshot.historical.filter((entry) => entry.decision === "defer").length,
      failed: snapshot.historical.filter((entry) => entry.decision === "failed").length,
      reasonCodes: counts(snapshot.historical.map((entry) => entry.reasonCode)),
      decisions: snapshot.historical,
    },
    shadow: {
      calls,
      validatedCalls: attempts.validated,
      failedCalls: attempts.failed,
      resultKeys,
      coveredTurns: new Set(covered).size,
      usageReadback: measured ? "measured" : "unavailable",
      inputTokens: measured ? results.reduce((total, result) => total + result.usage!.inputTokens, 0) : null,
      outputTokens: measured ? results.reduce((total, result) => total + result.usage!.outputTokens, 0) : null,
      monetaryCost: measuredCost ? {
        provenance: "gateway-agent-meta",
        shadowUsd: Number(results.reduce((total, result) => total
          + (result.monetaryCost === "unknown" ? 0 : result.monetaryCost.amount), 0).toFixed(12)),
      } : "unknown",
    },
    diagnostics: {
      sourceCoverage: sourceCoverage ? "met" : "not_met",
      callReductionPercent,
      callReductionGate: callReductionPercent >= 60 ? "met" : "not_met",
      corpusGate: sourceIds.length >= config.targetTurns ? "met" : "not_met",
      adjudicationGate: "pending",
      economicsGate: measuredCost ? "pending_baseline_cost" : "pending_usage",
      acceptanceVerdict: "not_evaluated",
    },
  };
}

function campaignKey(config: BatchShadowCampaignConfig, snapshot: BatchShadowCampaignSnapshotV1): Digest {
  const promptDigest = batchShadowPrompt(snapshot.compile.bundles[0], config.runner, new Date(config.sealedAt)).promptDigest;
  return sha256({
    schema: "engram.memory-batch-shadow-campaign-key.v1",
    frameDigest: snapshot.compile.frameDigest,
    compilerConfigDigest: snapshot.compile.configDigest,
    runnerConfigDigest: sha256(config.runner as unknown as JsonValue),
    promptDigest,
    targetTurns: config.targetTurns,
  } as unknown as JsonValue);
}

function attemptDirectory(storeRoot: string, key: Digest): string {
  return join(storeRoot, "memory-batch-shadow", "v1", "attempts", key.slice(7));
}

function attemptCounts(storeRoot: string, key: Digest): { calls: number; validated: number; failed: number } {
  const root = attemptDirectory(storeRoot, key);
  if (!existsSync(root)) return { calls: 0, validated: 0, failed: 0 };
  const files = readdirSync(root).filter((name) => /^\d{6}\.(started|terminal)\.json$/.test(name));
  const calls = files.filter((name) => name.endsWith(".started.json")).length;
  let validated = 0;
  let failed = 0;
  for (const name of files.filter((entry) => entry.endsWith(".terminal.json"))) {
    const terminal = row(readJson(join(root, name)));
    if (terminal?.status === "validated") validated++;
    else if (terminal?.status === "failed") failed++;
    else fail("ATTEMPT_JOURNAL_CORRUPT", `invalid attempt terminal: ${name}`);
  }
  if (validated + failed > calls) fail("ATTEMPT_JOURNAL_CORRUPT", "attempt terminal count exceeds started calls");
  return { calls, validated, failed };
}

function nextAttemptIndex(storeRoot: string, key: Digest): number {
  return attemptCounts(storeRoot, key).calls + 1;
}

export async function runBatchShadowCampaign(configValue: unknown, options: {
  complete?: (request: BatchShadowCompletionRequest) => Promise<BatchShadowProviderResult>;
} = {}): Promise<{
  manifest: BatchShadowCampaignManifestV1;
  manifestPath: string;
}> {
  const config = validateConfig(configValue);
  const snapshot = snapshotBatchShadowCampaign(config);
  if (snapshot.compile.exclusions.length > 0) fail("TERMINAL_EXCLUSION", "campaign requires zero compiler exclusions");
  const storeRoot = resolve(config.storeRoot);
  const framePath = join(storeRoot, "memory-batch-shadow", "v1", "source-frames", `${snapshot.compile.frameDigest.slice(7)}.json`);
  createOnlyJson(framePath, snapshot.frame as unknown as JsonValue);
  const provider = options.complete ?? (config.schema === BATCH_CAMPAIGN_CONFIG_SCHEMA_V2
    ? openClawGatewayModelRunProvider({ cwd: config.modelRunCwd, agentId: config.gatewayAgentId })
    : openClawRawModelRunProvider({ cwd: config.modelRunCwd }));
  const key = campaignKey(config, snapshot);
  const results: BatchShadowResultV1[] = [];
  for (const bundle of snapshot.compile.bundles) {
    let attemptIndex: number | null = null;
    let outputDigest: Digest | null = null;
    let requestDigest: Digest | null = null;
    try {
      const run = await runBatchShadow({
        bundle,
        config: config.runner,
        storeRoot,
        complete: async (request) => {
          attemptIndex = nextAttemptIndex(storeRoot, key);
          const prompt = batchShadowPrompt(bundle, config.runner);
          requestDigest = prompt.requestDigest;
          const prefix = attemptIndex.toString().padStart(6, "0");
          createOnlyJson(join(attemptDirectory(storeRoot, key), `${prefix}.started.json`), {
            schema: "engram.memory-batch-shadow-attempt-started.v1",
            campaignKey: key,
            attemptIndex,
            bundleId: bundle.bundleId,
            requestDigest,
            startedAt: new Date().toISOString(),
          } as unknown as JsonValue);
          const completion = await provider(request);
          outputDigest = sha256(completion.output);
          return completion;
        },
      });
      results.push(run.result);
      if (attemptIndex !== null) {
        const prefix = (attemptIndex as number).toString().padStart(6, "0");
        createOnlyJson(join(attemptDirectory(storeRoot, key), `${prefix}.terminal.json`), {
          schema: "engram.memory-batch-shadow-attempt-terminal.v1",
          campaignKey: key,
          attemptIndex,
          bundleId: bundle.bundleId,
          requestDigest,
          outputDigest,
          status: "validated",
          errorCode: null,
          terminalAt: new Date().toISOString(),
        } as unknown as JsonValue);
      }
    } catch (error) {
      if (attemptIndex !== null) {
        const prefix = (attemptIndex as number).toString().padStart(6, "0");
        const errorCode = error instanceof BatchShadowRunnerError
          ? error.code
          : error instanceof Error ? error.name : "UNKNOWN_ERROR";
        createOnlyJson(join(attemptDirectory(storeRoot, key), `${prefix}.terminal.json`), {
          schema: "engram.memory-batch-shadow-attempt-terminal.v1",
          campaignKey: key,
          attemptIndex,
          bundleId: bundle.bundleId,
          requestDigest,
          outputDigest,
          status: "failed",
          errorCode,
          terminalAt: new Date().toISOString(),
        } as unknown as JsonValue);
      }
      throw error;
    }
  }
  const manifest = buildManifest(config, snapshot, framePath, results, attemptCounts(storeRoot, key));
  const manifestPath = join(storeRoot, "memory-batch-shadow", "v1", "campaigns", `${manifest.campaignId.slice(7)}.json`);
  createOnlyJson(manifestPath, manifest as unknown as JsonValue);
  return { manifest, manifestPath };
}

if (import.meta.main) {
  if (process.argv.length !== 4 || process.argv[2] !== "--config") fail("INVALID_CLI", "usage: --config <campaign.json>");
  const result = await runBatchShadowCampaign(readJson(process.argv[3], "INVALID_CONFIG"));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
