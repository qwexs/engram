import { BATCH_EVALUATOR_AUTHORITY, deriveBatchObservationId, validateBatchObservation, type BatchObservationV1 } from "./batch-observation.ts";
import { sha256, type JsonValue, type Digest } from "./ledger.ts";
import type { CompiledBatchBundleV1 } from "./batch-compiler.ts";
import { groupAssertionAttribution } from "./group-attribution.ts";
import { buildContextualObservation, renderContextualObservation, type ContextAssertion, type ContextualObservationV2 } from "./contextual-observation.ts";
export const CONTEXTUAL_BATCH_SCHEMA = "engram.memory-batch-observation.v2" as const;
export const CONTEXTUAL_EVALUATOR_AUTHORITY = { id: "batch-post-turn-observer", version: "v2", digest: sha256("engram.memory-batch-observation.v2/quote-interpretation-status-spans") };
export type ContextualBatchObservationV2 = Omit<BatchObservationV1, "schema" | "producer"> & {
    schema: typeof CONTEXTUAL_BATCH_SCHEMA;
    producer: typeof CONTEXTUAL_EVALUATOR_AUTHORITY;
    context: Pick<ContextAssertion, "subject" | "resolution" | "status" | "spans"> & {
        chronology: ContextualObservationV2["chronology"];
    };
};
export type ReadableBatchObservation = BatchObservationV1 | ContextualBatchObservationV2;
function id(value: Pick<BatchObservationV1, "bundleId" | "groupId" | "assertionIndex" | "observationClass" | "evaluationPolicyDigest">): Digest {
    return sha256({ schema: CONTEXTUAL_BATCH_SCHEMA, bundleId: value.bundleId, groupId: value.groupId, assertionIndex: value.assertionIndex,
        observationClass: value.observationClass, evaluationPolicyDigest: value.evaluationPolicyDigest } as JsonValue);
}
/** Canonical v2 assertions still use the existing daily/domain writer. v1 is
 * never relaxed or rewritten. A policy must explicitly admit v2 before apply. */
export function contextualBatchObservations(raw: unknown, bundle: CompiledBatchBundleV1, policyDigest: Digest, now = new Date()): ContextualBatchObservationV2[] {
    const evaluated = buildContextualObservation(raw, bundle, policyDigest, now);
    return evaluated.assertions.map(a => {
        const traces = new Set(a.spans.map(s => s.traceId));
        const sourceRefs = bundle.sourceRefs.filter(s => traces.has(s.traceId));
        const citations = sourceRefs.map(s => ({ traceId: s.traceId, evidenceRef: bundle.inputs.find(i => i.traceId === s.traceId)!.evidenceRefs[0]! }));
        for (const span of a.spans.filter(s => (s.replyContextRef??s.episodeContextRef) !== undefined)) {
            const input = bundle.inputs.find(i => i.traceId === span.traceId)!;
            const evidenceRef = input.evidenceRefs.find(r => r.kind === "message" && r.ref === `${bundle.partition.runtimeSessionKey}#${span.replyContextRef??span.episodeContextRef}`)!;
            if (!citations.some(c => c.traceId === span.traceId && c.evidenceRef.ref === evidenceRef.ref))
                citations.push({ traceId: span.traceId, evidenceRef });
        }
        const primary = new Set(a.spans.filter(s => s.role === a.actorRef && s.purpose !== "context").map(s => s.traceId));
        const attributedText = groupAssertionAttribution(bundle, a.actorRef, citations.filter(c => primary.has(c.traceId))) + a.text;
        const identity = { bundleId: bundle.bundleId, groupId: a.id, assertionIndex: 0, observationClass: (a.section === "events" ? "episodic.event" : "episodic.decision") as BatchObservationV1["observationClass"], evaluationPolicyDigest: policyDigest };
        const { workspaceId, runtimeSessionKey, scopeClass, scopeId } = bundle.partition;
        const outcome: BatchObservationV1["payload"]["outcomeStatus"] = a.status === "reported_done" ? "completed" : a.status === "decided" || a.status === "accepted" ? "decided" : a.status === "failed" ? "failed" : "unknown";
        const base = { schema: CONTEXTUAL_BATCH_SCHEMA, ...identity, observationId: id(identity), scope: { workspaceId, runtimeSessionKey, scopeClass, scopeId },
            sourceRefs, producer: CONTEXTUAL_EVALUATOR_AUTHORITY, targetConsumer: "daily-note" as const,
            payload: { section: a.section, text: attributedText, actorRef: a.actorRef, outcomeStatus: outcome }, citations,
            sourceCompletedAt: sourceRefs.map(s => s.sourceCompletedAt).sort().at(-1)!, confidence: 0, reasonCodes: ["contextual_source_backed"], completedAt: now.toISOString(),
            context: { subject: a.subject, resolution: a.resolution, status: a.status, spans: a.spans, chronology: evaluated.chronology.filter(t => traces.has(t.traceId)) } };
        // Confidence remains a compatibility field; it is never a quality gate.
        return { ...base, observationDigest: sha256(base as unknown as JsonValue) };
    });
}
export function validateReadableBatchObservation(value: ReadableBatchObservation): ReadableBatchObservation {
    if (value.schema !== CONTEXTUAL_BATCH_SCHEMA)
        return validateBatchObservation(value);
    const { schema, context, observationDigest, producer, ...rest } = value;
    if (!context || Object.keys(context).sort().join(",") !== "chronology,resolution,spans,status,subject"
        || sha256({ ...rest, schema, context, producer } as unknown as JsonValue) !== observationDigest || value.observationId !== id(value)
        || sha256(producer as JsonValue) !== sha256(CONTEXTUAL_EVALUATOR_AUTHORITY as JsonValue)
        || !Array.isArray(context.spans) || !context.spans.length || context.spans.length > 16
        || !["explicit", "resolved", "ambiguous"].includes(context.resolution)
        || !["proposed", "requested", "decided", "reported_done", "accepted", "failed", "unknown"].includes(context.status)
        || !["user", "assistant"].includes(value.payload.actorRef)
        || (["requested", "decided", "accepted"].includes(context.status) && value.payload.actorRef !== "user")
        || (context.status === "reported_done" && value.payload.actorRef !== "assistant")
        || (context.resolution === "ambiguous" && context.status !== "unknown")
        || (context.resolution === "resolved" && context.spans.length < 2)
        || /<!--|-->/.test(value.payload.text)
        || (context.resolution === "ambiguous" ? context.subject !== null : typeof context.subject !== "string" || !context.subject.trim())
        || (typeof context.subject === "string" && (context.subject.length > 200 || /<!--|-->|\u0000/.test(context.subject)))
        || !context.spans.some(s => s.role === value.payload.actorRef && s.purpose !== "context")
        || value.payload.outcomeStatus !== (context.status === "reported_done" ? "completed" : ["decided", "accepted"].includes(context.status) ? "decided" : context.status === "failed" ? "failed" : "unknown")
        || !value.sourceRefs.every(r => context.spans.some(s => s.traceId === r.traceId))
        || !Array.isArray(context.chronology) || context.chronology.length !== value.sourceRefs.length)
        throw Error("CONTEXTUAL_OBSERVATION_DENIED");
    // Reuse the STRICT unchanged v1 validation for all common envelope fields,
    // with an ephemeral v1-shaped identity; nothing is written in that shape.
    const base = { ...rest, schema: "engram.memory-batch-observation.v1" as const, producer: BATCH_EVALUATOR_AUTHORITY, observationId: deriveBatchObservationId(value) };
    validateBatchObservation({ ...base, observationDigest: sha256(base as unknown as JsonValue) });
    const distinctSpans=new Set(context.spans.map(s=>JSON.stringify([s.traceId,s.role,s.start,s.end,s.replyContextRef??s.episodeContextRef??null])));
    if(distinctSpans.size!==context.spans.length)throw Error("CONTEXTUAL_OBSERVATION_DENIED");
    for (const span of context.spans) {
        const keys = Object.keys(span).sort().join(",");
        if (!["end,quote,role,start,traceId", "end,purpose,quote,role,start,traceId", "end,purpose,quote,replyContextRef,role,start,traceId", "end,episodeContextRef,purpose,quote,role,start,traceId"].includes(keys)
            || (span.purpose !== undefined && !['assertion', 'context'].includes(span.purpose))
            || ((span.replyContextRef??span.episodeContextRef) !== undefined && (typeof (span.replyContextRef??span.episodeContextRef) !== "string" || span.purpose !== "context"
                || !value.citations.some(c => c.traceId === span.traceId && c.evidenceRef.kind === "message" && c.evidenceRef.ref === `${value.scope.runtimeSessionKey}#${span.replyContextRef??span.episodeContextRef}`)))
            || !value.sourceRefs.some(s => s.traceId === span.traceId) || typeof span.quote !== "string" || !span.quote.trim() || span.quote.length > 700
            || !["user", "assistant", "external"].includes(span.role) || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
            || span.start < 0 || span.end - span.start !== span.quote.length || /<!--|-->/.test(span.quote))
            throw Error("CONTEXTUAL_OBSERVATION_DENIED");
    }
    for (const [index, time] of context.chronology.entries()) {
        const source = value.sourceRefs[index]!;
        if (Object.keys(time).sort().join(",") !== "sourceAt,sourceCompletedAt,traceId" || time.traceId !== source.traceId || time.sourceCompletedAt !== source.sourceCompletedAt
            || (time.sourceAt !== null && (!Number.isFinite(Date.parse(time.sourceAt)) || Date.parse(time.sourceAt) > Date.parse(time.sourceCompletedAt))))
            throw Error("CONTEXTUAL_OBSERVATION_DENIED");
    }
    return value;
}
export function renderContextualBatch(value: ContextualBatchObservationV2): string {
    validateReadableBatchObservation(value);
    const a: ContextAssertion = { id: value.groupId, section: value.payload.section, text: value.payload.text, actorRef: value.payload.actorRef as "user" | "assistant", ...value.context };
    const base = { schema: "engram.memory-contextual-observation.v2" as const, observationId: value.observationId, bundleId: value.bundleId,
        scope: { ...value.scope, producerEpoch: "v2", policyDigest: value.evaluationPolicyDigest }, evaluationPolicyDigest: value.evaluationPolicyDigest,
        sourceRefs: value.sourceRefs, assertions: [a], dispositions: [], chronology: value.context.chronology, recordedAt: value.completedAt };
    return renderContextualObservation({ ...base, observationDigest: sha256(base as unknown as JsonValue) });
}
