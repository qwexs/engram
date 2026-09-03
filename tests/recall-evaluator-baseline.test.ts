import { describe, expect, test } from "bun:test";
import {
  parseRecallEvalDataset,
  preflightRecallEvalDataset,
  sealRecallEvalDataset,
  type RecallApprovedEpisode,
  type RecallEvalDataset,
  type RecallEvalDatasetDraft,
  type RecallRequiredQuestionClass,
} from "../src/qmd/recall-evaluator-baseline.ts";
import type { RecallEvalCase, RecallExactScope } from "../src/qmd/recall-evaluator-contracts.ts";

const digest = (value: number) => `sha256:${value.toString(16).padStart(64, "0")}`;
const scope: RecallExactScope = {
  workspaceId: "main",
  runtimeSessionKey: "agent:main:telegram:direct:100000001",
  scopeClass: "self",
  scopeId: "telegram:100000001",
};
const datasetId = digest(1);
const effectiveAfter = "2026-08-28T22:56:07.000Z";
const sealedAt = "2026-08-29T12:00:00.000Z";
const classes: RecallRequiredQuestionClass[] = [
  "factual-event",
  "explicit-decision",
  "state-correction",
  "temporal-relation",
  "no-evidence",
];

function episode(index: number): RecallApprovedEpisode {
  return {
    receiptId: digest(100 + index),
    traceId: digest(200 + index),
    sourceCompletedAt: `2026-08-29T10:${String(index).padStart(2, "0")}:00.000Z`,
    completedAt: `2026-08-29T10:${String(index).padStart(2, "0")}:10.000Z`,
    canonicalRef: `memory/example.md#engram-entry:${digest(300 + index)}`,
    canonicalDigest: digest(400 + index),
    policyDigest: digest(500),
    scope,
  };
}

function evalCase(index: number, questionClass: RecallRequiredQuestionClass, episodes: RecallApprovedEpisode[]): RecallEvalCase {
  const source = episodes[index % episodes.length]!;
  const mustAbstain = questionClass === "no-evidence";
  return {
    schema: "engram.recall-eval-case.v1",
    caseId: digest(1000 + index),
    datasetId,
    scope,
    questionClass,
    question: `Question ${index}`,
    sourceTraceIds: [source.traceId],
    goldEvidenceRefs: mustAbstain ? [] : [{ kind: "canonical-record", ref: source.canonicalRef, digest: source.canonicalDigest }],
    expectedClaims: mustAbstain ? ["abstain"] : [`claim ${index}`],
    forbiddenClaims: [`forbidden ${index}`],
    mustAbstain,
    critical: questionClass === "state-correction",
    tags: [questionClass],
    adjudication: {
      source: "human",
      verifierRef: "verifier://human/1",
      digest: digest(2000 + index),
    },
  };
}

function draft(): RecallEvalDatasetDraft {
  const approvedEpisodes = Array.from({ length: 20 }, (_, index) => episode(index));
  const cases = classes.flatMap((questionClass, classIndex) => (
    Array.from({ length: 5 }, (_, offset) => evalCase(classIndex * 5 + offset, questionClass, approvedEpisodes))
  ));
  return {
    schema: "engram.recall-eval-dataset.v1",
    dataset: { id: datasetId, version: 1, sealedAt },
    scope,
    collections: ["main-direct-memory"],
    topK: [1, 3, 5, 10],
    approval: { approvedBy: "operator", approvedAt: effectiveAfter, effectiveAfter },
    approvedEpisodes,
    cases,
  };
}

function sealed(): RecallEvalDataset {
  return sealRecallEvalDataset(draft());
}

describe("recall evaluator R2 structural dataset preflight", () => {
  test("seals and structurally validates a balanced offline dataset without authorizing a run", () => {
    const dataset = sealed();
    expect(parseRecallEvalDataset(dataset)).toEqual(dataset);
    expect(preflightRecallEvalDataset(dataset)).toMatchObject({
      schema: "engram.recall-eval-preflight.v1",
      status: "structure-valid",
      runAllowed: false,
      authorityVerified: false,
      datasetId,
      policyDigest: digest(500),
      counts: {
        cases: 25,
        approvedEpisodes: 20,
        traceableGoldCases: 20,
        abstentionCases: 5,
        byQuestionClass: {
          "factual-event": 5,
          "explicit-decision": 5,
          "state-correction": 5,
          "temporal-relation": 5,
          "no-evidence": 5,
        },
      },
    });
  });

  test("produces a stable digest and rejects sealed-payload tampering", () => {
    const first = sealed();
    const second = sealRecallEvalDataset({ ...draft(), approvedEpisodes: [...draft().approvedEpisodes].reverse() });
    expect(second.dataset.digest).toBe(first.dataset.digest);
    expect(() => parseRecallEvalDataset({ ...first, collections: ["other"] })).toThrow(/digest/);
  });

  test("allows distinct batch assertions to share one source trace", () => {
    const source = draft();
    const oldTrace = source.approvedEpisodes[1]!.traceId;
    const sharedTrace = source.approvedEpisodes[0]!.traceId;
    const approvedEpisodes = source.approvedEpisodes.map((value, index) => index === 1 ? { ...value, traceId: sharedTrace } : value);
    const cases = source.cases.map((value) => ({
      ...value,
      sourceTraceIds: value.sourceTraceIds.map((traceId) => traceId === oldTrace ? sharedTrace : traceId),
    }));
    expect(preflightRecallEvalDataset(sealRecallEvalDataset({ ...source, approvedEpisodes, cases })).counts.approvedEpisodes).toBe(20);
  });

  test("rejects incomplete corpus and unbalanced required classes", () => {
    const source = draft();
    expect(() => preflightRecallEvalDataset(sealRecallEvalDataset({ ...source, approvedEpisodes: source.approvedEpisodes.slice(0, 19) }))).toThrow(/20-30/);
    expect(() => preflightRecallEvalDataset(sealRecallEvalDataset({ ...source, cases: source.cases.slice(0, 24) }))).toThrow(/25/);
    const withoutAbstention = source.cases.filter((entry) => entry.questionClass !== "no-evidence");
    const extraPositive = withoutAbstention.slice(0, 5).map((entry, index) => ({ ...entry, caseId: digest(9000 + index) }));
    expect(() => preflightRecallEvalDataset(sealRecallEvalDataset({ ...source, cases: [...withoutAbstention, ...extraPositive] }))).toThrow(/no-evidence/);
  });

  test("rejects episodes outside approval and exact-scope boundaries", () => {
    const source = draft();
    const beforeApproval = { ...source.approvedEpisodes[0]!, sourceCompletedAt: "2026-08-28T22:00:00.000Z" };
    expect(() => preflightRecallEvalDataset(sealRecallEvalDataset({ ...source, approvedEpisodes: [beforeApproval, ...source.approvedEpisodes.slice(1)] }))).toThrow(/predate/);
    const crossScope = { ...source.approvedEpisodes[0]!, scope: { ...scope, scopeId: "telegram:other" } };
    expect(() => preflightRecallEvalDataset(sealRecallEvalDataset({ ...source, approvedEpisodes: [crossScope, ...source.approvedEpisodes.slice(1)] }))).toThrow(/exact dataset scope/);
  });

  test("rejects mixed policy snapshots", () => {
    const source = draft();
    const mixedPolicy = { ...source.approvedEpisodes[0]!, policyDigest: digest(501) };
    expect(() => preflightRecallEvalDataset(sealRecallEvalDataset({
      ...source,
      approvedEpisodes: [mixedPolicy, ...source.approvedEpisodes.slice(1)],
    }))).toThrow(/mixed policy snapshots/);
  });

  test("rejects untraceable gold and invalid abstention semantics", () => {
    const source = draft();
    const positive = source.cases.find((entry) => entry.questionClass === "factual-event")!;
    const brokenPositive = { ...positive, goldEvidenceRefs: [{ ...positive.goldEvidenceRefs[0]!, digest: digest(9999) }] };
    expect(() => preflightRecallEvalDataset(sealRecallEvalDataset({ ...source, cases: [brokenPositive, ...source.cases.filter((entry) => entry.caseId !== positive.caseId)] }))).toThrow(/resolve through/);
    const abstention = source.cases.find((entry) => entry.questionClass === "no-evidence")!;
    const invalidAbstention = { ...abstention, mustAbstain: false };
    expect(() => sealRecallEvalDataset({ ...source, cases: [invalidAbstention, ...source.cases.filter((entry) => entry.caseId !== abstention.caseId)] })).toThrow(/must not be empty/);
  });

  test("rejects non-canonical refs and privacy-v1 violations content-free", () => {
    const source = draft();
    const rawRef = { ...source.approvedEpisodes[0]!, canonicalRef: "memory-state/memory-observation/v1/evidence/raw.json" };
    expect(() => sealRecallEvalDataset({ ...source, approvedEpisodes: [rawRef, ...source.approvedEpisodes.slice(1)] })).toThrow(/canonical daily-note/);
    const target = source.cases[0]!;
    const sensitive = { ...target, question: "Use api_key=not-a-real-credential-value" };
    expect(() => preflightRecallEvalDataset(sealRecallEvalDataset({ ...source, cases: [sensitive, ...source.cases.slice(1)] }))).toThrow(/privacy-v1/);
  });
});
