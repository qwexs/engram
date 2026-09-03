import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  constructRecallEvalCaseResult,
  constructRecallEvalReport,
  loadRecallEvalCases,
  parseRecallEvalCase,
  parseRecallEvalCaseResult,
  parseRecallEvalReport,
  validateRecallEvalCase,
  validateRecallEvalCaseResult,
  validateRecallEvalReport,
  type RecallMetricContribution,
  type RecallMetricKey,
} from "../src/qmd/recall-evaluator-contracts.ts";

const root = dirname(fileURLToPath(import.meta.url));
const fixtures = join(root, "fixtures", "recall-evaluator-contracts");
const validPath = join(fixtures, "valid.json");
const invalidPath = join(fixtures, "invalid.json");
const baseCase = loadRecallEvalCases(validPath)[0]!;
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_RUN_ID = "22222222-2222-4222-8222-222222222222";
const CREATED_AT = "2026-08-25T00:00:00.000Z";
const digest = (character: string) => "sha256:" + character.repeat(64).slice(0, 64);
const METRIC_KEYS: RecallMetricKey[] = [
  "captureRecall",
  "capturePrecision",
  "retrievalRecallAt5",
  "utilizationAccuracy",
  "currentStateAccuracy",
  "abstentionAccuracy",
];

function metrics(overrides: Partial<Record<RecallMetricKey, RecallMetricContribution>> = {}): Record<RecallMetricKey, RecallMetricContribution> {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, overrides[key] ?? { numerator: 0, denominator: 0, value: null }])) as Record<RecallMetricKey, RecallMetricContribution>;
}

function report(results: ReturnType<typeof constructRecallEvalCaseResult>[], runId = RUN_ID) {
  return constructRecallEvalReport({
    runId,
    createdAt: CREATED_AT,
    datasetId: baseCase.datasetId,
    datasetVersion: 1,
    datasetDigest: baseCase.datasetId,
    scope: baseCase.scope,
    evaluatorDigest: digest("a"),
    policyDigest: digest("b"),
    indexGeneration: digest("c"),
    retrievalConfigDigest: digest("d"),
    promptDigest: digest("e"),
    modelRef: "provider/model/version",
    results,
  });
}

describe("recall evaluator R1 contracts", () => {
  test("loads exact-scope cases and rejects unknown schema or missing provenance", () => {
    expect(loadRecallEvalCases(validPath)).toHaveLength(2);
    expect(parseRecallEvalCase(baseCase)).toMatchObject({ schema: "engram.recall-eval-case.v1", scope: { scopeClass: "self" } });
    expect(validateRecallEvalCase(baseCase)).toBe(true);
    expect(validateRecallEvalCase({ ...baseCase, schema: "engram.recall-eval-case.v2" })).toBe(false);
    expect(() => loadRecallEvalCases(invalidPath)).toThrow(/unknown schema/);
    expect(() => parseRecallEvalCase({ ...baseCase, sourceTraceIds: [] })).toThrow(/sourceTraceIds/);
    expect(() => parseRecallEvalCase({ ...baseCase, goldEvidenceRefs: [] })).toThrow(/goldEvidenceRefs/);
    expect(() => parseRecallEvalCase({ ...baseCase, goldEvidenceRefs: [{ ...baseCase.goldEvidenceRefs[0], kind: "raw-tool-output" }] })).toThrow(/kind is invalid/);
    expect(() => parseRecallEvalCase({ ...baseCase, adjudication: { ...baseCase.adjudication, source: "model" } })).toThrow(/source is invalid/);
    const abstentionCase = loadRecallEvalCases(validPath)[1]!;
    expect(abstentionCase).toMatchObject({ questionClass: "no-evidence", mustAbstain: true, goldEvidenceRefs: [] });
    expect(() => parseRecallEvalCase({ ...abstentionCase, goldEvidenceRefs: [baseCase.goldEvidenceRefs[0]] })).toThrow(/cannot contain/);
  });

  test("strict result parsing rejects model verdicts, unknown stages, bad metrics, and unsafe identities", () => {
    const valid = constructRecallEvalCaseResult({
      case: baseCase,
      runId: RUN_ID,
      createdAt: CREATED_AT,
      terminalDisposition: "incorrect",
      failureStage: "retrieval",
      verificationSource: "deterministic-check",
      metricContributions: metrics({ retrievalRecallAt5: { numerator: 0, denominator: 1, value: 0 } }),
      bottleneck: { reasonCodes: ["z", "a"] },
    });
    expect(validateRecallEvalCaseResult(valid)).toBe(true);
    const abstentionFailure = constructRecallEvalCaseResult({
      case: baseCase,
      runId: RUN_ID,
      createdAt: CREATED_AT,
      terminalDisposition: "incorrect",
      failureStage: "abstention",
      verificationSource: "human",
      metricContributions: metrics({ abstentionAccuracy: { numerator: 0, denominator: 1, value: 0 } }),
      bottleneck: { reasonCodes: ["unsupported-claim"] },
    });
    expect(report([abstentionFailure]).bottlenecks).toEqual([{
      stage: "abstention",
      count: 1,
      caseIds: [abstentionFailure.caseId],
      reasonCodes: ["unsupported-claim"],
    }]);
    expect(validateRecallEvalCaseResult({ ...valid, verification: { source: "model" } })).toBe(false);
    expect(() => parseRecallEvalCaseResult({ ...valid, bottleneck: { ...valid.bottleneck, stage: "abstention" } })).toThrow(/must equal failureStage/);
    expect(() => parseRecallEvalCaseResult({ ...valid, bottleneck: { ...valid.bottleneck, stage: "capture" } })).toThrow(/must equal failureStage/);
    expect(() => parseRecallEvalCaseResult({ ...valid, metricContributions: { ...valid.metricContributions, retrievalRecallAt5: { numerator: 2, denominator: 1, value: 2 } } })).toThrow(/cannot exceed/);
    expect(() => parseRecallEvalCaseResult({ ...valid, metricContributions: { ...valid.metricContributions, retrievalRecallAt5: { numerator: 0, denominator: 0, value: 0 } } })).toThrow(/0\/0\/null/);
    expect(() => parseRecallEvalCaseResult({ ...valid, safety: { ...valid.safety, crossScopeResults: -1 } })).toThrow(/safe integer/);
    expect(() => parseRecallEvalCaseResult({ ...valid, metricContributions: { ...valid.metricContributions, retrievalRecallAt5: { numerator: 0, denominator: Number.NaN, value: null } } })).toThrow(/safe integer/);
    expect(() => parseRecallEvalCaseResult({ ...valid, createdAt: "not-a-time" })).toThrow(/RFC3339/);
    expect(() => parseRecallEvalCaseResult({ ...valid, createdAt: "2026-02-30T00:00:00Z" })).toThrow(/RFC3339/);
    expect(() => parseRecallEvalCaseResult({ ...valid, resultId: digest("f") })).toThrow(/does not match/);
    expect(() => constructRecallEvalCaseResult({
      case: baseCase,
      runId: RUN_ID,
      createdAt: CREATED_AT,
      terminalDisposition: "invalidated",
      verificationSource: "human",
      metricContributions: metrics({ captureRecall: { numerator: 0, denominator: 1, value: 0 } }),
    })).toThrow(/invalidated results/);
  });

  test("result identity is stable within a run and changes across runs", () => {
    const input = {
      case: baseCase,
      createdAt: CREATED_AT,
      terminalDisposition: "correct" as const,
      verificationSource: "human" as const,
      metricContributions: metrics(),
    };
    const first = constructRecallEvalCaseResult({ ...input, runId: RUN_ID });
    const replay = constructRecallEvalCaseResult({ ...input, runId: RUN_ID });
    const otherRun = constructRecallEvalCaseResult({ ...input, runId: OTHER_RUN_ID });
    expect(first.resultId).toBe(replay.resultId);
    expect(otherRun.resultId).not.toBe(first.resultId);
  });

  test("report deterministically aggregates only valid quality records while retaining all safety evidence", () => {
    const correct = constructRecallEvalCaseResult({
      case: baseCase,
      runId: RUN_ID,
      createdAt: CREATED_AT,
      terminalDisposition: "correct",
      verificationSource: "human",
      metricContributions: metrics({ captureRecall: { numerator: 1, denominator: 1, value: 1 } }),
    });
    const unresolved = constructRecallEvalCaseResult({
      case: { ...baseCase, caseId: digest("6") },
      runId: RUN_ID,
      createdAt: CREATED_AT,
      terminalDisposition: "unresolved",
      failureStage: "retrieval",
      verificationSource: "human",
      metricContributions: metrics({ retrievalRecallAt5: { numerator: 0, denominator: 1, value: 0 } }),
      bottleneck: { reasonCodes: ["z", "a"] },
    });
    const invalidated = constructRecallEvalCaseResult({
      case: { ...baseCase, caseId: digest("7") },
      runId: RUN_ID,
      createdAt: CREATED_AT,
      terminalDisposition: "invalidated",
      verificationSource: "deterministic-check",
      metricContributions: metrics(),
      safety: { crossScopeResults: 1, rawEvidenceIndexed: 2, unauthorizedMutations: 3 },
    });
    const built = report([unresolved, invalidated, correct]);
    expect(built.counts).toEqual({ total: 3, valid: 2, invalidated: 1, unresolved: 1 });
    expect(built.metrics.captureRecall).toEqual({ numerator: 1, denominator: 1, value: 1 });
    expect(built.metrics.retrievalRecallAt5).toEqual({ numerator: 0, denominator: 1, value: 0 });
    expect(built.bottlenecks).toEqual([{ stage: "retrieval", count: 1, caseIds: [unresolved.caseId], reasonCodes: ["a", "z"] }]);
    expect(built.safety).toEqual({ crossScopeResults: 1, rawEvidenceIndexed: 2, unauthorizedMutations: 3 });
    expect(built.verdict).toBe("invalidated");
    const serialized = JSON.stringify(built);
    expect(serialized).not.toContain('"question":');
    expect(serialized).not.toContain('"answer":');
    expect(serialized).not.toContain('"evidence":');
    expect(serialized).not.toContain('"goldEvidenceRefs":');
    expect(serialized).toBe(JSON.stringify(report([unresolved, invalidated, correct])));
    expect(validateRecallEvalReport(built)).toBe(true);
  });

  test("report rejects mixed identity/scope, duplicate cases, extra metrics, and inconsistent counts", () => {
    const valid = constructRecallEvalCaseResult({
      case: baseCase,
      runId: RUN_ID,
      createdAt: CREATED_AT,
      terminalDisposition: "correct",
      verificationSource: "human",
      metricContributions: metrics(),
    });
    expect(() => report([{ ...valid, runId: OTHER_RUN_ID } as typeof valid])).toThrow(/resultId|runId/);
    expect(() => report([{ ...valid, datasetId: digest("f") } as typeof valid])).toThrow(/datasetId/);
    expect(() => report([{ ...valid, scope: { ...valid.scope, scopeId: "other" } } as typeof valid])).toThrow(/exact scope/);
    expect(() => report([valid, valid])).toThrow(/duplicate caseId/);
    const built = report([valid]);
    expect(validateRecallEvalReport({ ...built, metrics: { ...built.metrics, madeUp: { numerator: 0, denominator: 0, value: null } } })).toBe(false);
    expect(() => parseRecallEvalReport({ ...built, counts: { ...built.counts, total: 9 } })).toThrow(/inconsistent/);
    expect(() => parseRecallEvalReport({ ...built, dataset: { ...built.dataset, version: 0 } })).toThrow(/>= 1/);
    expect(() => parseRecallEvalReport({ ...built, runId: digest("f") })).toThrow(/UUID/);
  });
});
