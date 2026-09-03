import { describe, expect, test } from "bun:test";
import { BATCH_EVALUATOR_AUTHORITY, BATCH_OBSERVATION_SCHEMA, deriveBatchObservationId, validateBatchObservation, type BatchObservationV1 } from "./batch-observation.ts";
import { sha256, type JsonValue } from "./ledger.ts";

function fixture(): BatchObservationV1 {
  const identity = { bundleId: sha256("bundle"), groupId: "case-1", assertionIndex: 0, observationClass: "episodic.event" as const, evaluationPolicyDigest: sha256("evaluation-policy") };
  const base = {
    schema: BATCH_OBSERVATION_SCHEMA,
    observationId: deriveBatchObservationId(identity),
    ...identity,
    scope: { workspaceId: "main", runtimeSessionKey: "agent:main:telegram:direct:100000001", scopeClass: "self" as const, scopeId: "telegram:100000001" },
    sourceRefs: [{ traceId: sha256("trace"), sourceTurnId: `channel-user:v1:${"1".repeat(64)}`, sourceDigest: sha256("source"), evidenceDigest: sha256("evidence-envelope"), sourceCompletedAt: "2026-08-31T20:02:00.000Z" }],
    producer: BATCH_EVALUATOR_AUTHORITY,
    targetConsumer: "daily-note" as const,
    payload: { section: "events" as const, text: "Verified batch outcome.", actorRef: "assistant" as const, outcomeStatus: "completed" as const },
    citations: [{ traceId: sha256("trace"), evidenceRef: { kind: "source-turn" as const, ref: `channel-user:v1:${"1".repeat(64)}`, digest: sha256("evidence-ref") } }],
    sourceCompletedAt: "2026-08-31T20:02:00.000Z",
    confidence: 1,
    reasonCodes: ["verified_outcome"],
    completedAt: "2026-08-31T20:20:00.000Z",
  };
  return { ...base, observationDigest: sha256(base as unknown as JsonValue) };
}

function redigest(value: any): any {
  const { observationDigest: _old, ...base } = value;
  return { ...base, observationDigest: sha256(base as JsonValue) };
}

describe("canonical batch observation validation", () => {
  test("accepts the exact canonical shape and closed derivations", () => {
    const value = fixture();
    expect(validateBatchObservation(value)).toEqual(value);
  });

  test("denies malformed artifacts even when their outer digest is recomputed", () => {
    const mutations: Array<(value: any) => void> = [
      (value) => { value.extra = true; },
      (value) => { value.assertionIndex = 8; },
      (value) => { value.scope.extra = true; },
      (value) => { value.sourceRefs[0].sourceTurnId = "invented"; },
      (value) => { value.payload.text = ""; },
      (value) => { value.citations[0].evidenceRef.extra = true; },
      (value) => { value.sourceCompletedAt = "not-an-instant"; },
      (value) => { value.confidence = 2; },
      (value) => { value.reasonCodes = ["duplicate", "duplicate"]; },
      (value) => { value.observationId = sha256("invented-observation"); },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(fixture()) as any;
      mutate(value);
      expect(() => validateBatchObservation(redigest(value))).toThrow();
    }
  });

  test("denies citations outside exact source refs and non-causal completion times", () => {
    const inventedCitation = structuredClone(fixture()) as any;
    inventedCitation.citations[0].traceId = sha256("invented-trace");
    expect(() => validateBatchObservation(redigest(inventedCitation))).toThrow();
    const early = structuredClone(fixture()) as any;
    early.completedAt = "2026-08-31T20:01:00.000Z";
    expect(() => validateBatchObservation(redigest(early))).toThrow();
  });
});
