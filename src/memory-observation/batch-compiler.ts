import { readFileSync } from "node:fs";
import {
  deriveSourceDigest,
  sha256,
  type Digest,
  type EvidenceRef,
  type JsonValue,
  type ObservationJobV1,
  type ObservationScope,
} from "./ledger.ts";

type Row = Record<string, unknown>;

export const BATCH_FRAME_SCHEMA = "engram.memory-batch-source-frame.v1" as const;
export const BATCH_CONFIG_SCHEMA = "engram.memory-batch-compiler-config.v1" as const;
export const BATCH_COMPILE_SCHEMA = "engram.memory-batch-compile.v1" as const;
export const BATCH_BUNDLE_SCHEMA = "engram.memory-batch-bundle.v1" as const;

export type BatchPartitionV1 = ObservationScope & {
  producerEpoch: string;
  policyDigest: Digest;
};

export type BatchSourceFrameEntryV1 = {
  envelope: ObservationJobV1;
  evidence: {
    schema: "engram.memory-evidence-envelope.v1";
    traceId: Digest;
    scope: ObservationScope;
    payload: JsonValue;
    createdAt: string;
    expiresAt: string;
  };
};

export type BatchSourceFrameV1 = {
  schema: typeof BATCH_FRAME_SCHEMA;
  partition: BatchPartitionV1;
  sealedAt: string;
  sources: BatchSourceFrameEntryV1[];
};

export type BatchCompilerConfigV1 = {
  schema: typeof BATCH_CONFIG_SCHEMA;
  inactivityGapMs: number;
  maxTurns: number;
  maxEvidenceBytes: number;
  maxAgeMs: number;
};

export type BatchSourceRefV1 = {
  traceId: Digest;
  sourceTurnId: string;
  sourceDigest: Digest;
  evidenceDigest: Digest;
  sourceCompletedAt: string;
};

export type CompiledBatchInputV1 = {
  traceId: Digest;
  evidenceRefs: EvidenceRef[];
  evidence: JsonValue;
  expiresAt: string;
};

export type CompiledBatchBundleV1 = {
  schema: typeof BATCH_BUNDLE_SCHEMA;
  bundleId: Digest;
  partition: BatchPartitionV1;
  policyDigest: Digest;
  sourceRefs: BatchSourceRefV1[];
  inputs: CompiledBatchInputV1[];
  evidenceBytes: number;
};

export type BatchExclusionV1 = {
  traceId: Digest;
  reason: "source_too_old" | "evidence_bytes_exceeded";
};

export type BatchCompileArtifactV1 = {
  schema: typeof BATCH_COMPILE_SCHEMA;
  frameDigest: Digest;
  configDigest: Digest;
  partition: BatchPartitionV1;
  sealedAt: string;
  sourceCount: number;
  bundles: CompiledBatchBundleV1[];
  exclusions: BatchExclusionV1[];
  coverageDigest: Digest;
};

export class BatchCompilerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BatchCompilerError";
  }
}

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,299}$/;
const SCOPE_CLASSES = new Set(["self", "managers", "company", "project"]);
const EVIDENCE_KINDS = new Set(["source-turn", "message", "approved-tool-outcome"]);
const FRAME_KEYS = new Set(["schema", "partition", "sealedAt", "sources"]);
const PARTITION_KEYS = new Set(["workspaceId", "runtimeSessionKey", "scopeClass", "scopeId", "producerEpoch", "policyDigest"]);
const CONFIG_KEYS = new Set(["schema", "inactivityGapMs", "maxTurns", "maxEvidenceBytes", "maxAgeMs"]);
const ENTRY_KEYS = new Set(["envelope", "evidence"]);
const ENVELOPE_KEYS = new Set([
  "schema", "traceId", "sourceTurnId", "scope", "sourceCompletedAt", "sourceDigest", "evidenceDigest",
  "policyVersion", "policyDigest", "evidenceRefs", "authority", "admittedAt",
]);
const SCOPE_KEYS = new Set(["workspaceId", "runtimeSessionKey", "scopeClass", "scopeId"]);
const AUTHORITY_KEYS = new Set(["id", "version", "digest"]);
const EVIDENCE_KEYS = new Set(["schema", "traceId", "scope", "payload", "createdAt", "expiresAt"]);
const EVIDENCE_REF_KEYS = new Set(["kind", "ref", "digest"]);

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

function validInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST_RE.test(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function fail(code: string, message: string): never {
  throw new BatchCompilerError(code, message);
}

function validateScope(value: unknown, label: string): asserts value is ObservationScope {
  const scope = row(value);
  if (!scope || !exactKeys(scope, SCOPE_KEYS)
    || typeof scope.workspaceId !== "string" || !TOKEN_RE.test(scope.workspaceId)
    || typeof scope.runtimeSessionKey !== "string" || !TOKEN_RE.test(scope.runtimeSessionKey)
    || typeof scope.scopeId !== "string" || !TOKEN_RE.test(scope.scopeId)
    || typeof scope.scopeClass !== "string" || !SCOPE_CLASSES.has(scope.scopeClass)) {
    fail("INVALID_SCOPE", `${label} is not an exact supported scope`);
  }
}

function validatePartition(value: unknown): asserts value is BatchPartitionV1 {
  const partition = row(value);
  if (!partition || !exactKeys(partition, PARTITION_KEYS)) fail("UNKNOWN_FIELD", "partition has unknown or missing fields");
  const scope = {
    workspaceId: partition.workspaceId,
    runtimeSessionKey: partition.runtimeSessionKey,
    scopeClass: partition.scopeClass,
    scopeId: partition.scopeId,
  };
  validateScope(scope, "partition");
  if (typeof partition.producerEpoch !== "string" || !TOKEN_RE.test(partition.producerEpoch)
    || !validDigest(partition.policyDigest)) fail("INVALID_PARTITION", "partition epoch or policy digest is invalid");
}

function validateConfig(value: unknown): asserts value is BatchCompilerConfigV1 {
  const config = row(value);
  if (!config || !exactKeys(config, CONFIG_KEYS) || config.schema !== BATCH_CONFIG_SCHEMA) {
    fail("INVALID_CONFIG", "compiler config schema or fields are invalid");
  }
  for (const key of ["inactivityGapMs", "maxTurns", "maxEvidenceBytes", "maxAgeMs"] as const) {
    if (!Number.isSafeInteger(config[key]) || (config[key] as number) < 1) fail("INVALID_CONFIG", `${key} must be a positive integer`);
  }
}

function validateEvidenceRef(value: unknown): value is EvidenceRef {
  const ref = row(value);
  return Boolean(ref && exactKeys(ref, EVIDENCE_REF_KEYS)
    && typeof ref.kind === "string" && EVIDENCE_KINDS.has(ref.kind)
    && typeof ref.ref === "string" && ref.ref.length >= 1 && ref.ref.length <= 500
    && validDigest(ref.digest));
}

function validateEntry(entryValue: unknown, frame: BatchSourceFrameV1, sealedAtMs: number): BatchSourceFrameEntryV1 {
  const entry = row(entryValue);
  if (!entry || !exactKeys(entry, ENTRY_KEYS)) fail("UNKNOWN_FIELD", "source entry has unknown or missing fields");
  const envelope = row(entry.envelope);
  const evidence = row(entry.evidence);
  if (!envelope || !exactKeys(envelope, ENVELOPE_KEYS) || envelope.schema !== "engram.memory-observation-job.v1") {
    fail("INVALID_ENVELOPE", "source envelope schema or fields are invalid");
  }
  if (!evidence || !exactKeys(evidence, EVIDENCE_KEYS) || evidence.schema !== "engram.memory-evidence-envelope.v1") {
    fail("INVALID_EVIDENCE", "source evidence schema or fields are invalid");
  }
  validateScope(envelope.scope, "envelope scope");
  validateScope(evidence.scope, "evidence scope");
  const authority = row(envelope.authority);
  if (!authority || !exactKeys(authority, AUTHORITY_KEYS)
    || typeof authority.id !== "string" || !TOKEN_RE.test(authority.id)
    || authority.version !== frame.partition.producerEpoch || !validDigest(authority.digest)) {
    fail("PRODUCER_EPOCH_MISMATCH", "source authority does not match the sealed producer epoch");
  }
  if (!validDigest(envelope.traceId) || evidence.traceId !== envelope.traceId
    || typeof envelope.sourceTurnId !== "string" || !/^channel-user:v1:[a-f0-9]{64}$/.test(envelope.sourceTurnId)
    || !validDigest(envelope.sourceDigest) || !validDigest(envelope.evidenceDigest)
    || !validInstant(envelope.sourceCompletedAt) || !validInstant(envelope.admittedAt)
    || !validInstant(evidence.createdAt) || !validInstant(evidence.expiresAt) || !isJsonValue(evidence.payload)
    || !Array.isArray(envelope.evidenceRefs) || envelope.evidenceRefs.length < 1 || envelope.evidenceRefs.length > 8
    || envelope.evidenceRefs.some((ref) => !validateEvidenceRef(ref))) {
    fail("INVALID_SOURCE", "source identity, timestamps, digests, or evidence refs are invalid");
  }
  const partitionScope: ObservationScope = {
    workspaceId: frame.partition.workspaceId,
    runtimeSessionKey: frame.partition.runtimeSessionKey,
    scopeClass: frame.partition.scopeClass,
    scopeId: frame.partition.scopeId,
  };
  if (!same(envelope.scope, partitionScope) || !same(evidence.scope, partitionScope)
    || envelope.policyDigest !== frame.partition.policyDigest) {
    fail("CROSS_PARTITION_SOURCE", "source is outside the exact batch partition");
  }
  if (envelope.sourceDigest !== deriveSourceDigest(envelope.sourceTurnId as string, envelope.scope as ObservationScope, envelope.sourceCompletedAt as string)) {
    fail("SOURCE_DIGEST_MISMATCH", "source digest does not bind the envelope identity");
  }
  const evidenceIdentity = {
    schema: evidence.schema,
    traceId: evidence.traceId,
    scope: evidence.scope,
    payload: evidence.payload,
  } as JsonValue;
  if (envelope.evidenceDigest !== sha256(evidenceIdentity)) fail("EVIDENCE_DIGEST_MISMATCH", "evidence does not match the envelope digest");
  if (Date.parse(evidence.expiresAt as string) <= sealedAtMs) fail("EVIDENCE_EXPIRED", "sealed frame contains expired evidence");
  if (Date.parse(envelope.sourceCompletedAt as string) > sealedAtMs
    || Date.parse(envelope.admittedAt as string) > sealedAtMs
    || Date.parse(evidence.createdAt as string) > sealedAtMs) {
    fail("FUTURE_SOURCE", "sealed frame contains a source from the future");
  }
  return entry as unknown as BatchSourceFrameEntryV1;
}

function sourceRef(entry: BatchSourceFrameEntryV1): BatchSourceRefV1 {
  return {
    traceId: entry.envelope.traceId,
    sourceTurnId: entry.envelope.sourceTurnId,
    sourceDigest: entry.envelope.sourceDigest,
    evidenceDigest: entry.envelope.evidenceDigest,
    sourceCompletedAt: entry.envelope.sourceCompletedAt,
  };
}

function sourceOrder(left: BatchSourceFrameEntryV1, right: BatchSourceFrameEntryV1): number {
  return left.envelope.sourceCompletedAt.localeCompare(right.envelope.sourceCompletedAt)
    || left.envelope.traceId.localeCompare(right.envelope.traceId);
}

function bundleId(partition: BatchPartitionV1, refs: BatchSourceRefV1[]): Digest {
  return sha256({
    schema: BATCH_BUNDLE_SCHEMA,
    partition,
    policyDigest: partition.policyDigest,
    sourceRefs: refs,
  } as unknown as JsonValue);
}

function makeBundle(partition: BatchPartitionV1, entries: BatchSourceFrameEntryV1[]): CompiledBatchBundleV1 {
  const sourceRefs = entries.map(sourceRef);
  const inputs = entries.map((entry) => ({
    traceId: entry.envelope.traceId,
    evidenceRefs: entry.envelope.evidenceRefs,
    evidence: entry.evidence.payload,
    expiresAt: entry.evidence.expiresAt,
  }));
  const evidenceBytes = inputs.reduce((total, input) => total + Buffer.byteLength(canonical(input.evidence), "utf8"), 0);
  return {
    schema: BATCH_BUNDLE_SCHEMA,
    bundleId: bundleId(partition, sourceRefs),
    partition,
    policyDigest: partition.policyDigest,
    sourceRefs,
    inputs,
    evidenceBytes,
  };
}

export function compileBatchFrame(frameValue: unknown, configValue: unknown): BatchCompileArtifactV1 {
  const frameRow = row(frameValue);
  if (!frameRow || !exactKeys(frameRow, FRAME_KEYS) || frameRow.schema !== BATCH_FRAME_SCHEMA) {
    fail("INVALID_FRAME", "source frame schema or fields are invalid");
  }
  validatePartition(frameRow.partition);
  if (!validInstant(frameRow.sealedAt) || !Array.isArray(frameRow.sources)) fail("INVALID_FRAME", "frame seal or sources are invalid");
  const frame = frameRow as unknown as BatchSourceFrameV1;
  validateConfig(configValue);
  const config = configValue as BatchCompilerConfigV1;
  const sealedAtMs = Date.parse(frame.sealedAt);
  const entries = frame.sources.map((entry) => validateEntry(entry, frame, sealedAtMs));
  const traceIds = entries.map((entry) => entry.envelope.traceId);
  if (new Set(traceIds).size !== traceIds.length) fail("DUPLICATE_SOURCE", "frame contains a duplicate traceId");
  for (let index = 1; index < entries.length; index++) {
    if (sourceOrder(entries[index - 1], entries[index]) >= 0) {
      fail("REORDERED_SOURCE", "sources must be strictly ordered by (sourceCompletedAt, traceId)");
    }
  }

  const bundles: CompiledBatchBundleV1[] = [];
  const exclusions: BatchExclusionV1[] = [];
  let current: BatchSourceFrameEntryV1[] = [];
  let currentBytes = 0;
  const flush = () => {
    if (current.length > 0) bundles.push(makeBundle(frame.partition, current));
    current = [];
    currentBytes = 0;
  };

  for (const entry of entries) {
    const ageMs = sealedAtMs - Date.parse(entry.envelope.sourceCompletedAt);
    const entryBytes = Buffer.byteLength(canonical(entry.evidence.payload), "utf8");
    if (ageMs > config.maxAgeMs) {
      flush();
      exclusions.push({ traceId: entry.envelope.traceId, reason: "source_too_old" });
      continue;
    }
    if (entryBytes > config.maxEvidenceBytes) {
      flush();
      exclusions.push({ traceId: entry.envelope.traceId, reason: "evidence_bytes_exceeded" });
      continue;
    }
    const previous = current[current.length - 1];
    const gapExceeded = previous
      ? Date.parse(entry.envelope.sourceCompletedAt) - Date.parse(previous.envelope.sourceCompletedAt) > config.inactivityGapMs
      : false;
    if (gapExceeded || current.length >= config.maxTurns || currentBytes + entryBytes > config.maxEvidenceBytes) flush();
    current.push(entry);
    currentBytes += entryBytes;
  }
  flush();

  const covered = bundles.flatMap((bundle) => bundle.sourceRefs.map((ref) => ref.traceId));
  const excluded = exclusions.map((entry) => entry.traceId);
  const terminal = [...covered, ...excluded];
  if (terminal.length !== entries.length || new Set(terminal).size !== entries.length
    || terminal.some((traceId) => !traceIds.includes(traceId))) {
    fail("COVERAGE_FAILURE", "compiler did not terminally account for every source exactly once");
  }
  return {
    schema: BATCH_COMPILE_SCHEMA,
    frameDigest: sha256(frame as unknown as JsonValue),
    configDigest: sha256(config as unknown as JsonValue),
    partition: frame.partition,
    sealedAt: frame.sealedAt,
    sourceCount: entries.length,
    bundles,
    exclusions,
    coverageDigest: sha256({
      schema: "engram.memory-batch-coverage.v1",
      sources: traceIds,
      bundles: bundles.map((bundle) => ({ bundleId: bundle.bundleId, sourceRefs: bundle.sourceRefs.map((ref) => ref.traceId) })),
      exclusions,
    } as unknown as JsonValue),
  };
}

function cliArgument(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) fail("INVALID_CLI", `missing ${name}`);
  return process.argv[index + 1];
}

if (import.meta.main) {
  const allowed = new Set(["--frame", "--config"]);
  for (let index = 2; index < process.argv.length; index += 2) {
    if (!allowed.has(process.argv[index]) || !process.argv[index + 1]) fail("INVALID_CLI", `unknown or incomplete argument: ${process.argv[index]}`);
  }
  const frame = JSON.parse(readFileSync(cliArgument("--frame"), "utf8"));
  const config = JSON.parse(readFileSync(cliArgument("--config"), "utf8"));
  process.stdout.write(`${JSON.stringify(compileBatchFrame(frame, config), null, 2)}\n`);
}
