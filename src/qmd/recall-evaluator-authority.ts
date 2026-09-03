import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { contextError } from "../cli/errors.ts";
import {
  DAILY_NOTE_APPLICATOR,
  POST_TURN_OBSERVER,
  renderDailyNoteEntry,
  validateDailyNoteObservation,
  type MemoryApplyReceiptV1,
} from "../memory-observation/daily-note-applicator.ts";
import {
  deriveSourceDigest,
  deriveTraceEventId,
  deriveTraceId,
  sha256,
  type Digest,
  type EpisodicObservationV1,
  type JsonValue,
  type LedgerQueueRecordV1,
  type ObservationJobV1,
  type ObservationScope,
  type ProducerRef,
  type TraceEventV1,
} from "../memory-observation/ledger.ts";
import { BATCH_EVALUATOR_AUTHORITY, type BatchObservationV1 } from "../memory-observation/batch-observation.ts";
import {
  memoryObservationBinding,
  resolveMemoryObservationProjection,
} from "../memory-observation/projection.ts";
import { splitCanonicalSessionKey } from "../session-key.ts";
import type { RecallApprovedEpisode } from "./recall-evaluator-baseline.ts";
import type { RecallExactScope } from "./recall-evaluator-contracts.ts";

export const RECALL_CAPTURE_FRAME_SCHEMA = "engram.recall-capture-frame.v1" as const;
export const RECALL_AUTHORITY_MANIFEST_SCHEMA = "engram.recall-authority-manifest.v1" as const;

export type RecallCaptureFrameTurn = {
  sourceTurnId: string;
  sourceCompletedAt: string;
};

export type RecallCaptureFrame = {
  schema: typeof RECALL_CAPTURE_FRAME_SCHEMA;
  frame: { id: Digest; digest: Digest; sealedAt: string };
  scope: RecallExactScope;
  approval: {
    source: "human" | "deterministic-check";
    verifierRef: string;
    digest: Digest;
  };
  turns: RecallCaptureFrameTurn[];
};

export type RecallCaptureFrameDraft = Omit<RecallCaptureFrame, "frame"> & {
  frame: { sealedAt: string };
};

export type RecallCaptureOutcome = "not-admitted" | "write" | "skip" | "failed";

export type RecallAuthorityCaptureTurn = RecallCaptureFrameTurn & {
  traceId: Digest;
  sourceDigest: Digest;
  outcome: RecallCaptureOutcome;
  reasonCode: string;
  envelopePolicyDigest: Digest | null;
  observationRef: Digest | null;
  observationDigest: Digest | null;
  receiptId: Digest | null;
  observationRefs: Digest[];
  observationDigests: Digest[];
  receiptIds: Digest[];
};

export type RecallAuthorityManifest = {
  schema: typeof RECALL_AUTHORITY_MANIFEST_SCHEMA;
  manifest: { id: Digest; digest: Digest; compiledAt: string };
  scope: RecallExactScope;
  projection: {
    digest: Digest;
    effectiveAfter: string;
    approvedBy: string;
    approvedAt: string;
    qmdCollection: string;
  };
  captureFrame: {
    id: Digest;
    digest: Digest;
    counts: Record<RecallCaptureOutcome, number>;
    turns: RecallAuthorityCaptureTurn[];
  };
  receiptPolicyDigest: Digest | null;
  approvedEpisodes: RecallApprovedEpisode[];
};

export class RecallAuthorityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RecallAuthorityError";
  }
}

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const SOURCE_TURN_RE = /^channel-user:v1:[a-f0-9]{64}$/;

function fail(code: string, message: string): never {
  throw new RecallAuthorityError(code, message);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function assertKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail("UNKNOWN_FIELD", `${label} contains unknown field ${key}.`);
}

function token(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) fail("INVALID_FIELD", `${field} is required.`);
  return value;
}

function digest(value: unknown, field: string): Digest {
  const parsed = token(value, field);
  if (!DIGEST_RE.test(parsed)) fail("INVALID_DIGEST", `${field} must be a sha256 digest.`);
  return parsed as Digest;
}

function instant(value: unknown, field: string): string {
  const parsed = token(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(parsed)
    || !Number.isFinite(Date.parse(parsed))) fail("INVALID_INSTANT", `${field} must be an RFC3339 timestamp.`);
  return parsed;
}

function scope(value: unknown, field = "scope"): RecallExactScope {
  const parsed = asRecord(value);
  if (!parsed) fail("INVALID_SCOPE", `${field} must be an object.`);
  assertKeys(parsed, ["workspaceId", "runtimeSessionKey", "scopeClass", "scopeId"], field);
  const scopeClass = token(parsed.scopeClass, `${field}.scopeClass`);
  if (!["self", "managers", "company", "project"].includes(scopeClass)) fail("INVALID_SCOPE", `${field}.scopeClass is invalid.`);
  const runtimeSessionKey = token(parsed.runtimeSessionKey, `${field}.runtimeSessionKey`);
  if (!runtimeSessionKey.startsWith("agent:")) fail("INVALID_SCOPE", `${field}.runtimeSessionKey is invalid.`);
  return {
    workspaceId: token(parsed.workspaceId, `${field}.workspaceId`),
    runtimeSessionKey,
    scopeClass: scopeClass as RecallExactScope["scopeClass"],
    scopeId: token(parsed.scopeId, `${field}.scopeId`),
  };
}

function same(left: unknown, right: unknown): boolean {
  try {
    return sha256(left as JsonValue) === sha256(right as JsonValue);
  } catch {
    return false;
  }
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("ARTIFACT_UNREADABLE", `${label} is unreadable.`);
  }
}

function digestKey(value: Digest): string {
  return value.slice("sha256:".length);
}

function captureFrameIdentity(value: RecallCaptureFrame | RecallCaptureFrameDraft): JsonValue {
  return {
    schema: value.schema,
    frame: { sealedAt: value.frame.sealedAt },
    scope: value.scope,
    approval: value.approval,
    turns: value.turns,
  } as unknown as JsonValue;
}

function captureFrameId(value: RecallCaptureFrame | RecallCaptureFrameDraft): Digest {
  return sha256({ schema: value.schema, scope: value.scope, turns: value.turns } as unknown as JsonValue);
}

export function sealRecallCaptureFrame(value: RecallCaptureFrameDraft): RecallCaptureFrame {
  const normalized = normalizeCaptureFrame(value, false) as RecallCaptureFrameDraft;
  const id = captureFrameId(normalized);
  const withId = { ...normalized, frame: { ...normalized.frame, id } };
  return { ...withId, frame: { ...withId.frame, digest: sha256(captureFrameIdentity(normalized)) } };
}

export function parseRecallCaptureFrame(value: unknown): RecallCaptureFrame {
  const normalized = normalizeCaptureFrame(value, true) as RecallCaptureFrame;
  if (normalized.frame.id !== captureFrameId(normalized)) fail("FRAME_ID_MISMATCH", "capture frame id does not match its turns.");
  if (normalized.frame.digest !== sha256(captureFrameIdentity(normalized))) fail("FRAME_DIGEST_MISMATCH", "capture frame digest does not match its payload.");
  return normalized;
}

function normalizeCaptureFrame(value: unknown, requireIdentity: boolean): RecallCaptureFrame | RecallCaptureFrameDraft {
  const root = asRecord(value);
  if (!root) fail("INVALID_FRAME", "capture frame must be an object.");
  assertKeys(root, ["schema", "frame", "scope", "approval", "turns"], "capture frame");
  if (root.schema !== RECALL_CAPTURE_FRAME_SCHEMA) fail("UNSUPPORTED_SCHEMA", "capture frame schema is unsupported.");
  const identity = asRecord(root.frame);
  if (!identity) fail("INVALID_FRAME", "capture frame identity is required.");
  assertKeys(identity, requireIdentity ? ["id", "digest", "sealedAt"] : ["sealedAt"], "capture frame identity");
  const approval = asRecord(root.approval);
  if (!approval) fail("INVALID_APPROVAL", "capture frame approval is required.");
  assertKeys(approval, ["source", "verifierRef", "digest"], "capture frame approval");
  if (approval.source !== "human" && approval.source !== "deterministic-check") fail("INVALID_APPROVAL", "capture frame approval source is invalid.");
  if (!Array.isArray(root.turns) || root.turns.length < 30 || root.turns.length > 50) {
    fail("CAPTURE_FRAME_SIZE", "capture frame must contain 30-50 consecutive source turns.");
  }
  const turns = root.turns.map((entry, index) => {
    const turn = asRecord(entry);
    if (!turn) fail("INVALID_TURN", `turns[${index}] must be an object.`);
    assertKeys(turn, ["sourceTurnId", "sourceCompletedAt"], `turns[${index}]`);
    const sourceTurnId = token(turn.sourceTurnId, `turns[${index}].sourceTurnId`);
    if (!SOURCE_TURN_RE.test(sourceTurnId)) fail("INVALID_TURN", `turns[${index}].sourceTurnId is invalid.`);
    return { sourceTurnId, sourceCompletedAt: instant(turn.sourceCompletedAt, `turns[${index}].sourceCompletedAt`) };
  });
  if (new Set(turns.map((turn) => turn.sourceTurnId)).size !== turns.length) fail("DUPLICATE_TURN", "capture frame source turns must be unique.");
  for (let index = 1; index < turns.length; index++) {
    if (Date.parse(turns[index]!.sourceCompletedAt) <= Date.parse(turns[index - 1]!.sourceCompletedAt)) {
      fail("TURN_ORDER", "capture frame turns must be strictly chronological.");
    }
  }
  const sealedAt = instant(identity.sealedAt, "frame.sealedAt");
  if (Date.parse(sealedAt) < Date.parse(turns.at(-1)!.sourceCompletedAt)) fail("FRAME_SEALED_EARLY", "capture frame cannot be sealed before its last turn.");
  const parsed = {
    schema: RECALL_CAPTURE_FRAME_SCHEMA,
    frame: {
      ...(requireIdentity ? { id: digest(identity.id, "frame.id"), digest: digest(identity.digest, "frame.digest") } : {}),
      sealedAt,
    },
    scope: scope(root.scope),
    approval: {
      source: approval.source,
      verifierRef: token(approval.verifierRef, "approval.verifierRef"),
      digest: digest(approval.digest, "approval.digest"),
    },
    turns,
  };
  return parsed as RecallCaptureFrame | RecallCaptureFrameDraft;
}

function listJson(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".json")).sort() : [];
}

function validateEnvelope(value: unknown, expected: {
  traceId: Digest;
  sourceTurnId: string;
  sourceCompletedAt: string;
  sourceDigest: Digest;
  scope: RecallExactScope;
}): ObservationJobV1 {
  const envelope = value as ObservationJobV1;
  if (!envelope || envelope.schema !== "engram.memory-observation-job.v1"
    || envelope.traceId !== expected.traceId
    || envelope.sourceTurnId !== expected.sourceTurnId
    || envelope.sourceCompletedAt !== expected.sourceCompletedAt
    || envelope.sourceDigest !== expected.sourceDigest
    || !same(envelope.scope, expected.scope)
    || !DIGEST_RE.test(envelope.policyDigest)
    || !Number.isFinite(Date.parse(envelope.admittedAt))) {
    fail("ENVELOPE_INVALID", "capture frame envelope is invalid or does not match its source turn.");
  }
  return envelope;
}

function validateQueue(value: unknown, traceId: Digest): LedgerQueueRecordV1 & { status: "terminal"; reasonCode: string } {
  const queue = value as LedgerQueueRecordV1;
  if (!queue || queue.schema !== "engram.memory-observation-ledger-queue.v1" || queue.traceId !== traceId || queue.queueClass !== "evaluator") {
    fail("QUEUE_INVALID", "capture frame evaluator queue record is invalid.");
  }
  if (queue.status !== "terminal") fail("CAPTURE_FRAME_OPEN", "capture frame contains a nonterminal evaluator record.");
  if (!queue.reasonCode || !Number.isFinite(Date.parse(queue.terminalAt ?? ""))) {
    fail("QUEUE_INVALID", "terminal evaluator record has no valid reason or terminal time.");
  }
  return queue as LedgerQueueRecordV1 & { status: "terminal"; reasonCode: string };
}

function traceEvents(root: string, traceId: Digest): Array<TraceEventV1 | Record<string, unknown>> {
  const directory = join(root, "traces", digestKey(traceId));
  return listJson(directory).map((name) => readJson(join(directory, name), "trace event") as TraceEventV1 | Record<string, unknown>);
}

function validateTraceEvent(value: unknown, expected: {
  traceId: Digest;
  stage: TraceEventV1["stage"];
  scope: RecallExactScope;
  policyDigest: Digest;
  stageRef: TraceEventV1["stageRef"];
  producer: ProducerRef;
  reasonCode: string;
}): TraceEventV1 {
  const event = value as TraceEventV1;
  if (!event || event.schema !== "engram.memory-trace-event.v1"
    || event.traceId !== expected.traceId
    || event.stage !== expected.stage
    || event.eventId !== deriveTraceEventId(expected.traceId, expected.stage, expected.stageRef.digest)
    || !same(event.scope, expected.scope)
    || !same(event.stageRef, expected.stageRef)
    || !same(event.producer, expected.producer)
    || event.policyDigest !== expected.policyDigest
    || event.reasonCode !== expected.reasonCode
    || !Number.isFinite(Date.parse(event.recordedAt))
    || event.verification !== null) {
    fail("TRACE_INVALID", `${expected.stage} trace is invalid.`);
  }
  return event;
}

function oneTraceStage(
  traces: Array<TraceEventV1 | Record<string, unknown>>,
  stage: TraceEventV1["stage"],
): TraceEventV1 | Record<string, unknown> {
  const matches = traces.filter((event) => (event as TraceEventV1).stage === stage);
  if (matches.length !== 1) fail("TRACE_CARDINALITY", `${stage} trace must exist exactly once.`);
  return matches[0]!;
}

type RecallObservation = EpisodicObservationV1 | BatchObservationV1;

function findTypedObservation(root: string, traceId: Digest): EpisodicObservationV1 {
  const path = join(root, "observations", "typed", `${digestKey(traceId)}.json`);
  if (!existsSync(path)) fail("OBSERVATION_MISSING", "semantic write has no typed observation.");
  const observation = readJson(path, "typed observation") as EpisodicObservationV1;
  try { validateDailyNoteObservation(observation); } catch { fail("OBSERVATION_INVALID", "typed observation is invalid."); }
  return observation;
}

function findReceiptObservation(root: string, receipt: MemoryApplyReceiptV1): RecallObservation {
  const typedPath = join(root, "observations", "typed", `${digestKey(receipt.traceId)}.json`);
  const batchPath = join(root, "observations", "batch", `${digestKey(receipt.sourceObservationRef)}.json`);
  if (!existsSync(typedPath) && !existsSync(batchPath)) fail("OBSERVATION_MISSING", "apply receipt has no source observation.");
  const observation = readJson(existsSync(batchPath) ? batchPath : typedPath, "source observation") as RecallObservation;
  try { validateDailyNoteObservation(observation); } catch { fail("OBSERVATION_INVALID", "source observation is invalid."); }
  return observation;
}

function observationTraceIds(value: RecallObservation): Digest[] {
  return value.schema === "engram.memory-batch-observation.v1" ? value.sourceRefs.map((source) => source.traceId) : [value.traceId];
}

function observationEvidenceRefs(value: RecallObservation): EpisodicObservationV1["evidenceRefs"] {
  return value.schema === "engram.memory-batch-observation.v1" ? value.citations.map((citation) => citation.evidenceRef).slice(0, 8) : value.evidenceRefs;
}

function dateInTimezone(value: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
  } catch {
    fail("TIMEZONE_INVALID", "projection daily-note timezone is invalid.");
  }
}

function validateReceipt(options: {
  workspace: string;
  root: string;
  receipt: unknown;
  exactScope: RecallExactScope;
  effectiveAfter: string;
  timezone: string;
}): { receipt: MemoryApplyReceiptV1; observation: RecallObservation } {
  const receipt = options.receipt as MemoryApplyReceiptV1;
  if (!receipt || receipt.schema !== "engram.memory-apply-receipt.v1" || receipt.status !== "applied"
    || receipt.canonicalMutation !== true || receipt.consumer !== "daily-note"
    || !same(receipt.scope, options.exactScope)
    || !same(receipt.producer, DAILY_NOTE_APPLICATOR)
    || !DIGEST_RE.test(receipt.receiptId) || !DIGEST_RE.test(receipt.operationId)
    || !DIGEST_RE.test(receipt.destinationEntryId) || !DIGEST_RE.test(receipt.readBackDigest)
    || !DIGEST_RE.test(receipt.policyDigest)
    || !DIGEST_RE.test(receipt.traceId)
    || !Number.isFinite(Date.parse(receipt.sourceCompletedAt))
    || Date.parse(receipt.sourceCompletedAt) < Date.parse(options.effectiveAfter)
    || !Number.isFinite(Date.parse(receipt.completedAt))
    || Date.parse(receipt.completedAt) < Date.parse(receipt.sourceCompletedAt)) {
    fail("RECEIPT_INVALID", "apply receipt is invalid or outside the exact authority window.");
  }
  const observation = findReceiptObservation(options.root, receipt);
  const primaryTraceId = observation.schema === "engram.memory-batch-observation.v1" ? observation.sourceRefs[0]!.traceId : observation.traceId;
  const primarySourceTurnId = observation.schema === "engram.memory-batch-observation.v1" ? observation.sourceRefs[0]!.sourceTurnId : observation.sourceTurnId;
  if (primaryTraceId !== receipt.traceId || observation.observationId !== receipt.sourceObservationRef || observation.sourceCompletedAt !== receipt.sourceCompletedAt
    || !same(observation.scope, receipt.scope)
    || receipt.sourceProvenance.sourceTurnId !== primarySourceTurnId
    || receipt.sourceProvenance.observationClass !== observation.observationClass
    || receipt.sourceProvenance.observationDigest !== observation.observationDigest
    || !same(receipt.sourceProvenance.producer, observation.producer)
    || !same(receipt.sourceProvenance.evidenceRefs, observationEvidenceRefs(observation))
    || (observation.schema === "engram.memory-batch-observation.v1"
      && (!same(receipt.sourceProvenance.batchSourceRefs, observation.sourceRefs)
        || !same(receipt.sourceProvenance.batchCitations, observation.citations)
        || receipt.sourceProvenance.batchEvaluationPolicyDigest !== observation.evaluationPolicyDigest))
    || (observation.schema === "engram.memory-observation.v1"
      && (receipt.sourceProvenance.batchSourceRefs !== undefined
        || receipt.sourceProvenance.batchCitations !== undefined
        || receipt.sourceProvenance.batchEvaluationPolicyDigest !== undefined))) {
    fail("RECEIPT_PROVENANCE_INVALID", "apply receipt provenance does not match its typed observation.");
  }
  const destinationEntryId = sha256(`engram.daily-note-entry.v1\0${observation.observationId}`);
  const operationId = sha256(`engram.memory-apply.v1\0daily-note\0${observation.observationId}\0${destinationEntryId}`);
  const receiptId = sha256(`engram.memory-apply-receipt.v1\0${operationId}`);
  const split = splitCanonicalSessionKey(observation.scope.runtimeSessionKey);
  if (!split) fail("SESSION_INVALID", "receipt scope cannot map to a canonical daily-note session.");
  const destinationDate = dateInTimezone(observation.sourceCompletedAt, options.timezone);
  const destinationPath = join(options.workspace, "memory", `agent-${split.agentId}`, split.sessionKey, `${destinationDate}.md`);
  const destinationRef = `${relative(options.workspace, destinationPath)}#engram-entry:${destinationEntryId}`;
  const rendered = renderDailyNoteEntry(observation, destinationEntryId);
  if (receipt.destinationEntryId !== destinationEntryId || receipt.operationId !== operationId || receipt.receiptId !== receiptId
    || receipt.destinationDate !== destinationDate || receipt.destinationRef !== destinationRef
    || receipt.readBackDigest !== sha256(rendered)
    || !existsSync(destinationPath)) {
    fail("RECEIPT_IDENTITY_INVALID", "apply receipt identity or destination is invalid.");
  }
  const readBack = readFileSync(destinationPath, "utf8");
  const anchor = `<!-- engram-entry:${destinationEntryId} -->`;
  if (!readBack.includes(rendered) || readBack.split(anchor).length !== 2) fail("READ_BACK_FAILED", "apply receipt destination does not read back exactly once.");
  return { receipt, observation };
}

function manifestPayload(value: Omit<RecallAuthorityManifest, "manifest"> & { manifest: { id: Digest; compiledAt: string } }): JsonValue {
  return value as unknown as JsonValue;
}

export function compileRecallAuthorityManifest(options: {
  workspace: string;
  workspaceId: string;
  runtimeSessionKey: string;
  captureFrame: unknown;
  compiledAt: string;
}): RecallAuthorityManifest {
  const workspace = resolve(options.workspace);
  const compiledAt = instant(options.compiledAt, "compiledAt");
  const frame = parseRecallCaptureFrame(options.captureFrame);
  const projection = resolveMemoryObservationProjection({ workspace, workspaceId: options.workspaceId });
  if (projection.mode !== "canary" || !projection.captureOwnership || !projection.consumers?.dailyNote?.qmdBinding) {
    fail("PROJECTION_NOT_READY", "memory observation projection is not an exact canary with a QMD binding.");
  }
  const binding = memoryObservationBinding(projection, options.runtimeSessionKey);
  if (!binding) fail("SCOPE_NOT_BOUND", "runtime session is not bound by the active projection.");
  const exactScope: RecallExactScope = {
    workspaceId: projection.workspaceId,
    runtimeSessionKey: binding.runtimeSessionKey,
    scopeClass: binding.scopeClass,
    scopeId: binding.scopeId,
  };
  if (!same(frame.scope, exactScope)) fail("FRAME_SCOPE_MISMATCH", "capture frame does not match the exact projection scope.");
  const effectiveAfter = projection.captureOwnership.effectiveAfter;
  if (frame.turns.some((turn) => Date.parse(turn.sourceCompletedAt) < Date.parse(effectiveAfter))) {
    fail("FRAME_BEFORE_CUTOVER", "capture frame contains a source turn before effectiveAfter.");
  }
  if (Date.parse(compiledAt) < Date.parse(frame.frame.sealedAt)) fail("COMPILED_EARLY", "manifest cannot be compiled before the capture frame is sealed.");

  const root = join(workspace, "memory-state", "memory-observation", "v1");
  const batchByTrace = new Map<Digest, BatchObservationV1[]>();
  for (const name of listJson(join(root, "observations", "batch"))) {
    const observation = readJson(join(root, "observations", "batch", name), "batch observation") as BatchObservationV1;
    try { validateDailyNoteObservation(observation); } catch { fail("OBSERVATION_INVALID", "batch observation directory contains an invalid artifact."); }
    if (!same(observation.scope, exactScope) || Date.parse(observation.completedAt) > Date.parse(compiledAt)) continue;
    for (const traceId of observationTraceIds(observation)) batchByTrace.set(traceId, [...(batchByTrace.get(traceId) ?? []), observation]);
  }
  for (const values of batchByTrace.values()) values.sort((left, right) => left.groupId.localeCompare(right.groupId) || left.assertionIndex - right.assertionIndex || left.observationId.localeCompare(right.observationId));
  const receiptByObservation = new Map<Digest, MemoryApplyReceiptV1>();
  const receiptsBySourceTrace = new Map<Digest, MemoryApplyReceiptV1[]>();
  const approvedEpisodes: RecallApprovedEpisode[] = [];
  for (const name of listJson(join(root, "receipts", "by-operation"))) {
    const value = readJson(join(root, "receipts", "by-operation", name), "apply receipt") as MemoryApplyReceiptV1;
    if (!value || value.schema !== "engram.memory-apply-receipt.v1") fail("RECEIPT_INVALID", "receipt directory contains an unsupported artifact.");
    if (Date.parse(value.sourceCompletedAt) < Date.parse(effectiveAfter)) continue;
    if (Date.parse(value.sourceCompletedAt) > Date.parse(compiledAt) || Date.parse(value.completedAt) > Date.parse(compiledAt)) continue;
    if (!same(value.scope, exactScope)) fail("CROSS_SCOPE_RECEIPT", "post-cutover receipt exists outside the exact projection scope.");
    const { receipt, observation } = validateReceipt({
      workspace,
      root,
      receipt: value,
      exactScope,
      effectiveAfter,
      timezone: projection.consumers.dailyNote.timezone,
    });
    if (receiptByObservation.has(receipt.sourceObservationRef)) fail("DUPLICATE_RECEIPT", "multiple post-cutover receipts share one source observation.");
    receiptByObservation.set(receipt.sourceObservationRef, receipt);
    for (const traceId of observationTraceIds(observation)) receiptsBySourceTrace.set(traceId, [...(receiptsBySourceTrace.get(traceId) ?? []), receipt]);
    approvedEpisodes.push({
      receiptId: receipt.receiptId,
      traceId: receipt.traceId,
      sourceCompletedAt: receipt.sourceCompletedAt,
      completedAt: receipt.completedAt,
      canonicalRef: receipt.destinationRef,
      canonicalDigest: receipt.readBackDigest,
      policyDigest: receipt.policyDigest,
      scope: exactScope,
    });
  }
  approvedEpisodes.sort((left, right) => left.sourceCompletedAt.localeCompare(right.sourceCompletedAt) || left.traceId.localeCompare(right.traceId));
  const receiptPolicyDigests = new Set<Digest>(approvedEpisodes.map((episode) => episode.policyDigest as Digest));
  if (receiptPolicyDigests.size > 1) fail("MIXED_RECEIPT_POLICY", "post-cutover receipts contain mixed policy snapshots.");

  const captureTurns: RecallAuthorityCaptureTurn[] = [];
  for (const turn of frame.turns) {
    const traceId = deriveTraceId(exactScope.workspaceId, exactScope.runtimeSessionKey, turn.sourceTurnId);
    const sourceDigest = deriveSourceDigest(turn.sourceTurnId, exactScope as ObservationScope, turn.sourceCompletedAt);
    const envelopePath = join(root, "envelopes", `${digestKey(traceId)}.json`);
    if (!existsSync(envelopePath)) {
      if ((receiptsBySourceTrace.get(traceId)?.length ?? 0) > 0) fail("RECEIPT_WITHOUT_ADMISSION", "non-admitted capture turn has an apply receipt.");
      captureTurns.push({ ...turn, traceId, sourceDigest, outcome: "not-admitted", reasonCode: "source_not_admitted", envelopePolicyDigest: null, observationRef: null, observationDigest: null, receiptId: null, observationRefs: [], observationDigests: [], receiptIds: [] });
      continue;
    }
    const envelope = validateEnvelope(readJson(envelopePath, "observation envelope"), { traceId, sourceTurnId: turn.sourceTurnId, sourceCompletedAt: turn.sourceCompletedAt, sourceDigest, scope: exactScope });
    const queuePath = join(root, "queues", "evaluator", `${digestKey(traceId)}.json`);
    if (!existsSync(queuePath)) fail("QUEUE_MISSING", "admitted capture turn has no evaluator queue record.");
    const queue = validateQueue(readJson(queuePath, "evaluator queue record"), traceId);
    const traces = traceEvents(root, traceId);
    validateTraceEvent(oneTraceStage(traces, "source_completed"), {
      traceId,
      stage: "source_completed",
      scope: exactScope,
      policyDigest: envelope.policyDigest,
      stageRef: { kind: "source-turn", ref: turn.sourceTurnId, digest: sourceDigest },
      producer: envelope.authority,
      reasonCode: "trusted_source_completed",
    });
    let outcome: RecallCaptureOutcome = "failed";
    let observationRef: Digest | null = null;
    let observationDigest: Digest | null = null;
    let observationRefs: Digest[] = [];
    let observationDigests: Digest[] = [];
    let receiptIds: Digest[] = [];
    if (queue.reasonCode === "semantic_write") {
      outcome = "write";
      const observation = findTypedObservation(root, traceId);
      if (observation.sourceTurnId !== turn.sourceTurnId || observation.sourceCompletedAt !== turn.sourceCompletedAt || !same(observation.scope, exactScope)) {
        fail("OBSERVATION_SOURCE_MISMATCH", "typed observation does not match its capture turn.");
      }
      validateTraceEvent(oneTraceStage(traces, "observation_admitted"), {
        traceId,
        stage: "observation_admitted",
        scope: exactScope,
        policyDigest: envelope.policyDigest,
        stageRef: { kind: "observation", ref: observation.observationId, digest: observation.observationDigest },
        producer: observation.producer,
        reasonCode: "episodic_candidate_admitted",
      });
      observationRef = observation.observationId;
      observationDigest = observation.observationDigest;
      observationRefs = [observation.observationId];
      observationDigests = [observation.observationDigest];
      receiptIds = (receiptsBySourceTrace.get(traceId) ?? []).map((receipt) => receipt.receiptId).sort();
    } else if (queue.reasonCode.startsWith("semantic_skip_")) {
      outcome = "skip";
      const reason = queue.reasonCode.slice("semantic_skip_".length);
      const skipDigest = sha256({ traceId, decision: { decision: "skip", reason } } as unknown as JsonValue);
      validateTraceEvent(oneTraceStage(traces, "observation_skipped"), {
        traceId,
        stage: "observation_skipped",
        scope: exactScope,
        policyDigest: envelope.policyDigest,
        stageRef: { kind: "observation", ref: traceId, digest: skipDigest },
        producer: POST_TURN_OBSERVER,
        reasonCode: `episodic_skip_${reason}`,
      });
    } else if (["semantic_batch_write", "semantic_batch_skip", "semantic_batch_grouped_no_assertion"].includes(queue.reasonCode)) {
      const observations = batchByTrace.get(traceId) ?? [];
      const terminal = oneTraceStage(traces, "batch_evaluation_terminal") as TraceEventV1;
      if (terminal.schema !== "engram.memory-trace-event.v1" || terminal.traceId !== traceId
        || terminal.stage !== "batch_evaluation_terminal" || !DIGEST_RE.test(terminal.eventId)
        || !same(terminal.scope, exactScope) || terminal.policyDigest !== envelope.policyDigest
        || terminal.reasonCode !== queue.reasonCode || !same(terminal.producer, BATCH_EVALUATOR_AUTHORITY)
        || terminal.stageRef?.kind !== "batch-result" || !DIGEST_RE.test(terminal.stageRef.digest)
        || !DIGEST_RE.test(terminal.stageRef.ref) || !Number.isFinite(Date.parse(terminal.recordedAt)) || terminal.verification !== null
        || terminal.eventId !== deriveTraceEventId(traceId, "batch_evaluation_terminal", terminal.stageRef.digest)) {
        fail("TRACE_INVALID", "batch_evaluation_terminal trace is invalid.");
      }
      for (const observation of observations) {
        const source = observation.sourceRefs.find((entry) => entry.traceId === traceId);
        if (!source || source.sourceTurnId !== turn.sourceTurnId || source.sourceDigest !== sourceDigest || source.sourceCompletedAt !== turn.sourceCompletedAt) {
          fail("OBSERVATION_SOURCE_MISMATCH", "batch observation does not match its capture turn.");
        }
      }
      if (queue.reasonCode === "semantic_batch_write") {
        if (observations.length === 0) fail("OBSERVATION_MISSING", "batch semantic write has no batch observation.");
        outcome = "write";
        observationRefs = observations.map((value) => value.observationId);
        observationDigests = observations.map((value) => value.observationDigest);
        receiptIds = observations.map((value) => receiptByObservation.get(value.observationId)?.receiptId).filter((value): value is Digest => Boolean(value)).sort();
        observationRef = observationRefs[0] ?? null;
        observationDigest = observationDigests[0] ?? null;
      } else {
        if (observations.length !== 0) fail("RECEIPT_OUTCOME_MISMATCH", "batch skip has a source observation.");
        outcome = "skip";
      }
    }
    if (outcome !== "write" && (receiptsBySourceTrace.get(traceId)?.length ?? 0) > 0) {
      fail("RECEIPT_OUTCOME_MISMATCH", "non-write capture turn has an apply receipt.");
    }
    captureTurns.push({
      ...turn,
      traceId,
      sourceDigest,
      outcome,
      reasonCode: queue.reasonCode,
      envelopePolicyDigest: envelope.policyDigest,
      observationRef,
      observationDigest,
      receiptId: receiptIds[0] ?? null,
      observationRefs,
      observationDigests,
      receiptIds,
    });
  }

  const counts: Record<RecallCaptureOutcome, number> = { "not-admitted": 0, write: 0, skip: 0, failed: 0 };
  for (const turn of captureTurns) counts[turn.outcome]++;
  const projectionDigest = sha256(projection as unknown as JsonValue);
  const id = sha256({ schema: RECALL_AUTHORITY_MANIFEST_SCHEMA, projectionDigest, frameDigest: frame.frame.digest } as unknown as JsonValue);
  const base = {
    schema: RECALL_AUTHORITY_MANIFEST_SCHEMA,
    manifest: { id, compiledAt },
    scope: exactScope,
    projection: {
      digest: projectionDigest,
      effectiveAfter,
      approvedBy: projection.approvedBy,
      approvedAt: projection.approvedAt,
      qmdCollection: projection.consumers.dailyNote.qmdBinding.collection,
    },
    captureFrame: { id: frame.frame.id, digest: frame.frame.digest, counts, turns: captureTurns },
    receiptPolicyDigest: receiptPolicyDigests.size === 1 ? [...receiptPolicyDigests][0]! : null,
    approvedEpisodes,
  };
  return { ...base, manifest: { ...base.manifest, digest: sha256(manifestPayload(base)) } };
}

export function loadRecallCaptureFrame(path: string): RecallCaptureFrame {
  try { return parseRecallCaptureFrame(JSON.parse(readFileSync(path, "utf8"))); }
  catch (error) {
    if (error instanceof RecallAuthorityError) throw error;
    throw contextError("Recall capture frame is not valid JSON.");
  }
}
