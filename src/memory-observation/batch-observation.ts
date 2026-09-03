import type { BatchSourceRefV1 } from "./batch-compiler.ts";
import type { BatchScopedCitationV1 } from "./batch-shadow-runner.ts";
import {
  sha256,
  type Digest,
  type EpisodicActorRef,
  type EpisodicOutcomeStatus,
  type EpisodicSection,
  type JsonValue,
  type ObservationScope,
  type ProducerRef,
} from "./ledger.ts";

export const BATCH_OBSERVATION_SCHEMA = "engram.memory-batch-observation.v1" as const;

export const BATCH_EVALUATOR_AUTHORITY: ProducerRef = {
  id: "batch-post-turn-observer",
  version: "v1",
  digest: "sha256:69bf6adb1ebcf5b258102f13871ca7ab29af55df47f0709a489616d76c1d1f74",
};

export type BatchObservationV1 = {
  schema: typeof BATCH_OBSERVATION_SCHEMA;
  observationId: Digest;
  bundleId: Digest;
  groupId: string;
  assertionIndex: number;
  scope: ObservationScope;
  sourceRefs: BatchSourceRefV1[];
  producer: ProducerRef;
  observationClass: "episodic.event" | "episodic.decision";
  targetConsumer: "daily-note";
  payload: {
    section: EpisodicSection;
    text: string;
    actorRef: EpisodicActorRef;
    outcomeStatus: EpisodicOutcomeStatus;
  };
  citations: BatchScopedCitationV1[];
  sourceCompletedAt: string;
  confidence: number;
  reasonCodes: string[];
  evaluationPolicyDigest: Digest;
  observationDigest: Digest;
  completedAt: string;
};

export class BatchObservationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BatchObservationError";
  }
}

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,299}$/;
const SOURCE_TURN_RE = /^channel-user:v1:[a-f0-9]{64}$/;
const SESSION_RE = /^agent:[^\s]{1,2042}$/;
const SCOPE_CLASSES = new Set(["self", "managers", "company", "project"]);
const EVIDENCE_KINDS = new Set(["source-turn", "message", "approved-tool-outcome"]);
const ACTOR_REFS = new Set(["user", "assistant", "system"]);
const OUTCOME_STATUSES = new Set(["completed", "in-progress", "decided", "corrected", "failed", "unknown"]);
const OBSERVATION_KEYS = new Set([
  "schema", "observationId", "bundleId", "groupId", "assertionIndex", "scope", "sourceRefs", "producer",
  "observationClass", "targetConsumer", "payload", "citations", "sourceCompletedAt", "confidence", "reasonCodes",
  "evaluationPolicyDigest", "observationDigest", "completedAt",
]);
const SCOPE_KEYS = new Set(["workspaceId", "runtimeSessionKey", "scopeClass", "scopeId"]);
const SOURCE_REF_KEYS = new Set(["traceId", "sourceTurnId", "sourceDigest", "evidenceDigest", "sourceCompletedAt"]);
const PRODUCER_KEYS = new Set(["id", "version", "digest"]);
const PAYLOAD_KEYS = new Set(["section", "text", "actorRef", "outcomeStatus"]);
const CITATION_KEYS = new Set(["traceId", "evidenceRef"]);
const EVIDENCE_REF_KEYS = new Set(["kind", "ref", "digest"]);
type Row = Record<string, unknown>;

function row(value: unknown): Row | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
function exactKeys(value: Row, expected: Set<string>): boolean { const keys = Object.keys(value); return keys.length === expected.size && keys.every((key) => expected.has(key)); }
function validInstant(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}
function validDigest(value: unknown): value is Digest { return typeof value === "string" && DIGEST_RE.test(value); }
function validToken(value: unknown): value is string { return typeof value === "string" && TOKEN_RE.test(value); }
function validScope(value: unknown): boolean {
  const scope = row(value);
  return !!scope && exactKeys(scope, SCOPE_KEYS) && validToken(scope.workspaceId)
    && typeof scope.runtimeSessionKey === "string" && SESSION_RE.test(scope.runtimeSessionKey)
    && typeof scope.scopeClass === "string" && SCOPE_CLASSES.has(scope.scopeClass) && validToken(scope.scopeId);
}
function validProducer(value: unknown): boolean {
  const producer = row(value);
  return !!producer && exactKeys(producer, PRODUCER_KEYS) && validToken(producer.id) && validToken(producer.version) && validDigest(producer.digest);
}
function validSourceRef(value: unknown): value is BatchSourceRefV1 {
  const source = row(value);
  return !!source && exactKeys(source, SOURCE_REF_KEYS) && validDigest(source.traceId)
    && typeof source.sourceTurnId === "string" && SOURCE_TURN_RE.test(source.sourceTurnId)
    && validDigest(source.sourceDigest) && validDigest(source.evidenceDigest) && validInstant(source.sourceCompletedAt);
}
function validEvidenceRef(value: unknown): boolean {
  const evidence = row(value);
  return !!evidence && exactKeys(evidence, EVIDENCE_REF_KEYS)
    && typeof evidence.kind === "string" && EVIDENCE_KINDS.has(evidence.kind)
    && typeof evidence.ref === "string" && evidence.ref.length >= 1 && evidence.ref.length <= 500 && validDigest(evidence.digest);
}
function validCitation(value: unknown): value is BatchScopedCitationV1 {
  const citation = row(value);
  return !!citation && exactKeys(citation, CITATION_KEYS) && validDigest(citation.traceId) && validEvidenceRef(citation.evidenceRef);
}

export function deriveBatchObservationId(value: Pick<BatchObservationV1, "bundleId" | "groupId" | "assertionIndex" | "observationClass" | "evaluationPolicyDigest">): Digest {
  return sha256({
    schema: BATCH_OBSERVATION_SCHEMA,
    bundleId: value.bundleId,
    groupId: value.groupId,
    assertionIndex: value.assertionIndex,
    observationClass: value.observationClass,
    evaluationPolicyDigest: value.evaluationPolicyDigest,
  } as unknown as JsonValue);
}

export function validateBatchObservation(value: BatchObservationV1): BatchObservationV1 {
  const observation = row(value);
  const producer = row(observation?.producer);
  const payload = row(observation?.payload);
  const sourceRefs = observation?.sourceRefs;
  const citations = observation?.citations;
  const reasonCodes = observation?.reasonCodes;
  if (!observation || !exactKeys(observation, OBSERVATION_KEYS) || observation.schema !== BATCH_OBSERVATION_SCHEMA
    || !validDigest(observation.observationId) || !validDigest(observation.bundleId) || !validToken(observation.groupId)
    || !Number.isInteger(observation.assertionIndex) || Number(observation.assertionIndex) < 0 || Number(observation.assertionIndex) > 7
    || !validScope(observation.scope) || !producer || !validProducer(producer)
    || !Array.isArray(sourceRefs) || sourceRefs.length < 1 || sourceRefs.length > 100 || sourceRefs.some((source) => !validSourceRef(source))
    || producer.id !== BATCH_EVALUATOR_AUTHORITY.id || producer.version !== BATCH_EVALUATOR_AUTHORITY.version || producer.digest !== BATCH_EVALUATOR_AUTHORITY.digest
    || (observation.observationClass !== "episodic.event" && observation.observationClass !== "episodic.decision") || observation.targetConsumer !== "daily-note"
    || !payload || !exactKeys(payload, PAYLOAD_KEYS) || (payload.section !== "events" && payload.section !== "decisions")
    || typeof payload.text !== "string" || payload.text.length < 1 || payload.text.length > 1_000
    || typeof payload.actorRef !== "string" || !ACTOR_REFS.has(payload.actorRef)
    || typeof payload.outcomeStatus !== "string" || !OUTCOME_STATUSES.has(payload.outcomeStatus)
    || !Array.isArray(citations) || citations.length < 1 || citations.length > 16 || citations.some((citation) => !validCitation(citation))
    || !validInstant(observation.sourceCompletedAt) || typeof observation.confidence !== "number" || !Number.isFinite(observation.confidence)
    || observation.confidence < 0 || observation.confidence > 1
    || !Array.isArray(reasonCodes) || reasonCodes.length < 1 || reasonCodes.length > 8
    || reasonCodes.some((reason) => !validToken(reason)) || new Set(reasonCodes).size !== reasonCodes.length
    || !validDigest(observation.evaluationPolicyDigest) || !validDigest(observation.observationDigest) || !validInstant(observation.completedAt)) {
    throw new BatchObservationError("OBSERVATION_DENIED", "batch observation violates the canonical schema");
  }
  const typed = value as BatchObservationV1;
  const { observationDigest, ...base } = value;
  if (typed.observationDigest !== sha256(base as unknown as JsonValue) || typed.observationId !== deriveBatchObservationId(typed)
    || (typed.observationClass === "episodic.event" ? typed.payload.section !== "events" : typed.payload.section !== "decisions")
    || Date.parse(typed.sourceCompletedAt) !== Math.max(...typed.sourceRefs.map((source) => Date.parse(source.sourceCompletedAt)))
    || Date.parse(typed.completedAt) < Date.parse(typed.sourceCompletedAt)) {
    throw new BatchObservationError("OBSERVATION_DENIED", "batch observation is invalid");
  }
  const sourceTraceIds = typed.sourceRefs.map((source) => source.traceId);
  const admitted = new Set(sourceTraceIds);
  const citationKeys = typed.citations.map((citation) => JSON.stringify(citation));
  if (admitted.size !== sourceTraceIds.length || new Set(citationKeys).size !== citationKeys.length
    || typed.citations.some((citation) => !admitted.has(citation.traceId))) {
    throw new BatchObservationError("OBSERVATION_DENIED", "batch observation citation is outside its exact source refs");
  }
  return typed;
}
