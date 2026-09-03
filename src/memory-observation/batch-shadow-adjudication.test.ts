import { describe, expect, test } from "bun:test";
import {
  BATCH_ADJUDICATION_SCHEMA,
  BatchShadowAdjudicationError,
  createBatchAdjudicationTemplate,
  evaluateBatchAdjudication,
  type BatchShadowAdjudicationV1,
} from "./batch-shadow-adjudication.ts";
import {
  BATCH_CAMPAIGN_MANIFEST_SCHEMA,
  type BatchShadowCampaignManifestV1,
} from "./batch-shadow-campaign.ts";
import { sha256 } from "./ledger.ts";

const first = sha256("first");
const second = sha256("second");
const campaignId = sha256("campaign");
const manifest = {
  schema: BATCH_CAMPAIGN_MANIFEST_SCHEMA,
  campaignId,
  target: { requiredTurns: 50, observedTurns: 2, complete: false },
  historical: {
    decisions: [
      { traceId: first, sourceCompletedAt: "2026-08-31T20:01:00.000Z", decision: "write", reasonCode: "semantic_write", observationId: sha256("o1") },
      { traceId: second, sourceCompletedAt: "2026-08-31T20:02:00.000Z", decision: "skip", reasonCode: "semantic_skip_noise", observationId: null },
    ],
  },
  shadow: { usageReadback: "unavailable", monetaryCost: "unknown" },
  diagnostics: { callReductionGate: "met" },
} as unknown as BatchShadowCampaignManifestV1;

describe("batch shadow adjudication", () => {
  test("keeps snapshot completion separate from labeling completion and evidence sufficiency", () => {
    const template = createBatchAdjudicationTemplate(manifest);
    expect(template.unassignedSources).toEqual([first, second]);
    const empty = evaluateBatchAdjudication(manifest, template);
    expect(empty.completion).toEqual({
      snapshotTargetComplete: false,
      labelingComplete: false,
      caseCount: 0,
      caseTargetComplete: false,
    });
    expect(empty.gates.verdict).toBe("not_evaluated");

    const annotation: BatchShadowAdjudicationV1 = {
      schema: BATCH_ADJUDICATION_SCHEMA,
      campaignId,
      annotator: "human-reviewer",
      adjudicatedAt: "2026-08-31T21:00:00.000Z",
      labelAxes: { decision: "write|skip|defer", evidenceQuality: "sufficient|insufficient" },
      unassignedSources: [],
      cases: [
        {
          caseId: "case-1",
          sourceRefs: [first],
          decision: "write",
          evidenceQuality: "sufficient",
          mustCapture: true,
          explicitDecision: true,
          batchAssessment: "correct_write",
          boundaryAssessment: "correct",
          actorCompletionCorrect: true,
          sourceAttributionCorrect: true,
          rationale: "The visible evidence supports the retained decision.",
        },
        {
          caseId: "case-2",
          sourceRefs: [second],
          decision: "skip",
          evidenceQuality: "insufficient",
          mustCapture: false,
          explicitDecision: false,
          batchAssessment: "correct_skip",
          boundaryAssessment: "correct",
          actorCompletionCorrect: true,
          sourceAttributionCorrect: true,
          rationale: "The target remains a skip, but the visible evidence is insufficient for a retained fact.",
        },
      ],
    };
    const report = evaluateBatchAdjudication(manifest, annotation);
    expect(report.integrity).toMatchObject({ allSourcesAssigned: true, declaredUnassignedMatches: true });
    expect(report.completion.labelingComplete).toBe(true);
    expect(report.evidenceQuality).toEqual({ sufficient: 1, insufficient: 1 });
    expect(report.metrics).toMatchObject({ mustCaptureRecall: 1, explicitDecisionRecall: 1, precision: 1 });
    expect(report.gates).toMatchObject({ corpus: "not_met", cases: "not_met", economics: "not_evaluated", verdict: "not_evaluated" });
  });

  test("rejects duplicate or reordered source attribution", () => {
    const template = createBatchAdjudicationTemplate(manifest);
    const invalid = {
      ...template,
      annotator: "reviewer",
      adjudicatedAt: "2026-08-31T21:00:00.000Z",
      unassignedSources: [],
      cases: [{
        caseId: "case-1",
        sourceRefs: [second, first],
        decision: "write",
        evidenceQuality: "sufficient",
        mustCapture: true,
        explicitDecision: false,
        batchAssessment: "correct_write",
        boundaryAssessment: "correct",
        actorCompletionCorrect: true,
        sourceAttributionCorrect: true,
        rationale: "Reordered refs must fail.",
      }],
    };
    expect(() => evaluateBatchAdjudication(manifest, invalid)).toThrow(BatchShadowAdjudicationError);
  });

  test("does not accept measured tokens or call reduction as measured monetary economics", () => {
    const measuredTokensOnly = {
      ...manifest,
      shadow: { ...manifest.shadow, usageReadback: "measured", monetaryCost: "unknown" },
    } as BatchShadowCampaignManifestV1;
    const report = evaluateBatchAdjudication(measuredTokensOnly, createBatchAdjudicationTemplate(measuredTokensOnly));
    expect(report.gates.economics).toBe("not_evaluated");
    expect(report.gates.verdict).toBe("not_evaluated");
  });
});
