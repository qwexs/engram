import { readFileSync } from "node:fs";
import { sha256, type Digest, type JsonValue } from "./ledger.ts";
import {
  BATCH_CAMPAIGN_MANIFEST_SCHEMA,
  type BatchShadowCampaignManifestV1,
} from "./batch-shadow-campaign.ts";

type Row = Record<string, unknown>;

export const BATCH_ADJUDICATION_SCHEMA = "engram.memory-batch-shadow-adjudication.v1" as const;
export const BATCH_ADJUDICATION_REPORT_SCHEMA = "engram.memory-batch-shadow-adjudication-report.v1" as const;

export type BatchGoldCaseV1 = {
  caseId: string;
  sourceRefs: Digest[];
  decision: "write" | "skip" | "defer";
  evidenceQuality: "sufficient" | "insufficient";
  mustCapture: boolean;
  explicitDecision: boolean;
  batchAssessment: "correct_write" | "missed_write" | "false_write" | "correct_skip" | "correct_defer" | "incorrect_defer";
  boundaryAssessment: "correct" | "erroneous_merge" | "erroneous_split";
  actorCompletionCorrect: boolean;
  sourceAttributionCorrect: boolean;
  rationale: string;
};

export type BatchShadowAdjudicationV1 = {
  schema: typeof BATCH_ADJUDICATION_SCHEMA;
  campaignId: Digest;
  annotator: string | null;
  adjudicatedAt: string | null;
  labelAxes: {
    decision: "write|skip|defer";
    evidenceQuality: "sufficient|insufficient";
  };
  unassignedSources: Digest[];
  cases: BatchGoldCaseV1[];
};

export type BatchShadowAdjudicationReportV1 = {
  schema: typeof BATCH_ADJUDICATION_REPORT_SCHEMA;
  campaignId: Digest;
  annotationDigest: Digest;
  integrity: {
    sourceCount: number;
    assignedSourceCount: number;
    uniqueSourceRefs: boolean;
    allSourceRefsResolve: boolean;
    allSourcesAssigned: boolean;
    declaredUnassignedMatches: boolean;
  };
  completion: {
    snapshotTargetComplete: boolean;
    labelingComplete: boolean;
    caseCount: number;
    caseTargetComplete: boolean;
  };
  classBalance: { write: number; skip: number; defer: number; writeShare: number | null };
  evidenceQuality: { sufficient: number; insufficient: number };
  metrics: null | {
    mustCaptureRecall: number | null;
    explicitDecisionRecall: number | null;
    precision: number | null;
    falseWriteRate: number;
    caseBoundaryAccuracy: number;
    erroneousMergeCount: number;
    actorCompletionSafety: number;
    sourceAttributionSafety: number;
  };
  gates: {
    corpus: "met" | "not_met";
    cases: "met" | "not_met";
    sourceCoverage: "met" | "not_met";
    quality: "met" | "not_met" | "not_evaluated";
    economics: "met" | "not_met" | "not_evaluated";
    verdict: "met" | "not_met" | "not_evaluated";
  };
};

export class BatchShadowAdjudicationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BatchShadowAdjudicationError";
  }
}

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,299}$/;

function row(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function fail(code: string, message: string): never {
  throw new BatchShadowAdjudicationError(code, message);
}

function validDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST_RE.test(value);
}

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : rounded(numerator / denominator);
}

function sourceIds(manifest: BatchShadowCampaignManifestV1): Digest[] {
  return manifest.historical.decisions.map((decision) => decision.traceId);
}

function validateManifest(value: unknown): BatchShadowCampaignManifestV1 {
  const manifest = row(value);
  if (!manifest || manifest.schema !== BATCH_CAMPAIGN_MANIFEST_SCHEMA || !validDigest(manifest.campaignId)
    || !row(manifest.target) || !Number.isSafeInteger((manifest.target as Row).observedTurns)
    || typeof (manifest.target as Row).complete !== "boolean" || !row(manifest.historical)
    || !Array.isArray((manifest.historical as Row).decisions) || !row(manifest.shadow)
    || !row(manifest.diagnostics)) fail("INVALID_MANIFEST", "campaign manifest is invalid");
  const typed = manifest as unknown as BatchShadowCampaignManifestV1;
  const ids = sourceIds(typed);
  if (ids.length !== typed.target.observedTurns || new Set(ids).size !== ids.length || ids.some((id) => !validDigest(id))) {
    fail("INVALID_MANIFEST", "campaign source identities are inconsistent");
  }
  return typed;
}

export function createBatchAdjudicationTemplate(manifestValue: unknown): BatchShadowAdjudicationV1 {
  const manifest = validateManifest(manifestValue);
  return {
    schema: BATCH_ADJUDICATION_SCHEMA,
    campaignId: manifest.campaignId,
    annotator: null,
    adjudicatedAt: null,
    labelAxes: { decision: "write|skip|defer", evidenceQuality: "sufficient|insufficient" },
    unassignedSources: sourceIds(manifest),
    cases: [],
  };
}

function validateCase(value: unknown): BatchGoldCaseV1 {
  const candidate = row(value);
  if (!candidate || Object.keys(candidate).length !== 11
    || typeof candidate.caseId !== "string" || !TOKEN_RE.test(candidate.caseId)
    || !Array.isArray(candidate.sourceRefs) || candidate.sourceRefs.length < 1 || candidate.sourceRefs.some((ref) => !validDigest(ref))
    || !["write", "skip", "defer"].includes(candidate.decision as string)
    || !["sufficient", "insufficient"].includes(candidate.evidenceQuality as string)
    || typeof candidate.mustCapture !== "boolean" || typeof candidate.explicitDecision !== "boolean"
    || !["correct_write", "missed_write", "false_write", "correct_skip", "correct_defer", "incorrect_defer"].includes(candidate.batchAssessment as string)
    || !["correct", "erroneous_merge", "erroneous_split"].includes(candidate.boundaryAssessment as string)
    || typeof candidate.actorCompletionCorrect !== "boolean" || typeof candidate.sourceAttributionCorrect !== "boolean"
    || typeof candidate.rationale !== "string" || candidate.rationale.trim() !== candidate.rationale
    || candidate.rationale.length < 1 || candidate.rationale.length > 1_000) {
    fail("INVALID_CASE", "gold case is incomplete or invalid");
  }
  return candidate as unknown as BatchGoldCaseV1;
}

export function evaluateBatchAdjudication(
  manifestValue: unknown,
  annotationValue: unknown,
): BatchShadowAdjudicationReportV1 {
  const manifest = validateManifest(manifestValue);
  const annotation = row(annotationValue);
  if (!annotation || annotation.schema !== BATCH_ADJUDICATION_SCHEMA || annotation.campaignId !== manifest.campaignId
    || !row(annotation.labelAxes) || (annotation.labelAxes as Row).decision !== "write|skip|defer"
    || (annotation.labelAxes as Row).evidenceQuality !== "sufficient|insufficient"
    || !Array.isArray(annotation.unassignedSources) || annotation.unassignedSources.some((ref) => !validDigest(ref))
    || !Array.isArray(annotation.cases)) fail("INVALID_ANNOTATION", "annotation header or axes are invalid");
  const cases = annotation.cases.map(validateCase);
  const expected = sourceIds(manifest);
  const expectedSet = new Set(expected);
  const assigned = cases.flatMap((entry) => entry.sourceRefs);
  const assignedSet = new Set(assigned);
  const uniqueSourceRefs = assigned.length === assignedSet.size;
  const allSourceRefsResolve = assigned.every((ref) => expectedSet.has(ref));
  const actualUnassigned = expected.filter((ref) => !assignedSet.has(ref));
  const declaredUnassigned = annotation.unassignedSources as Digest[];
  const declaredUnassignedMatches = declaredUnassigned.length === actualUnassigned.length
    && declaredUnassigned.every((ref, index) => ref === actualUnassigned[index]);
  const allSourcesAssigned = uniqueSourceRefs && allSourceRefsResolve && assigned.length === expected.length && actualUnassigned.length === 0;
  const caseIds = cases.map((entry) => entry.caseId);
  if (new Set(caseIds).size !== caseIds.length) fail("DUPLICATE_CASE", "case IDs must be unique");
  for (const entry of cases) {
    const positions = entry.sourceRefs.map((ref) => expected.indexOf(ref));
    if (new Set(entry.sourceRefs).size !== entry.sourceRefs.length
      || positions.some((position) => position < 0)
      || positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
      fail("SOURCE_ORDER", `case ${entry.caseId} has duplicate, unknown, or reordered source refs`);
    }
  }
  const labelingComplete = allSourcesAssigned && declaredUnassignedMatches && cases.length > 0
    && typeof annotation.annotator === "string" && annotation.annotator.trim().length > 0
    && typeof annotation.adjudicatedAt === "string" && Number.isFinite(Date.parse(annotation.adjudicatedAt));
  const writes = cases.filter((entry) => entry.decision === "write").length;
  const skips = cases.filter((entry) => entry.decision === "skip").length;
  const defers = cases.filter((entry) => entry.decision === "defer").length;
  let metrics: BatchShadowAdjudicationReportV1["metrics"] = null;
  if (labelingComplete) {
    const mustCapture = cases.filter((entry) => entry.mustCapture);
    const explicitDecisions = cases.filter((entry) => entry.explicitDecision);
    const trueWrites = cases.filter((entry) => entry.batchAssessment === "correct_write").length;
    const falseWrites = cases.filter((entry) => entry.batchAssessment === "false_write").length;
    metrics = {
      mustCaptureRecall: ratio(mustCapture.filter((entry) => entry.batchAssessment === "correct_write").length, mustCapture.length),
      explicitDecisionRecall: ratio(explicitDecisions.filter((entry) => entry.batchAssessment === "correct_write").length, explicitDecisions.length),
      precision: ratio(trueWrites, trueWrites + falseWrites),
      falseWriteRate: rounded(falseWrites / cases.length),
      caseBoundaryAccuracy: rounded(cases.filter((entry) => entry.boundaryAssessment === "correct").length / cases.length),
      erroneousMergeCount: cases.filter((entry) => entry.boundaryAssessment === "erroneous_merge").length,
      actorCompletionSafety: rounded(cases.filter((entry) => entry.actorCompletionCorrect).length / cases.length),
      sourceAttributionSafety: rounded(cases.filter((entry) => entry.sourceAttributionCorrect).length / cases.length),
    };
  }
  const sourceCoverage = allSourcesAssigned && declaredUnassignedMatches;
  const qualityMet = metrics !== null
    && (metrics.mustCaptureRecall ?? 0) >= 0.85
    && (metrics.explicitDecisionRecall ?? 0) >= 0.95
    && (metrics.precision ?? 0) >= 0.90
    && metrics.falseWriteRate <= 0.02
    && metrics.caseBoundaryAccuracy >= 0.90
    && metrics.erroneousMergeCount === 0
    && metrics.actorCompletionSafety === 1
    && metrics.sourceAttributionSafety === 1;
  const measuredCost = manifest.shadow.monetaryCost;
  const economicsEvaluable = manifest.shadow.usageReadback === "measured"
    && measuredCost !== "unknown"
    && measuredCost.provenance === "provider-measured"
    && Number.isFinite(measuredCost.historicalUsd)
    && Number.isFinite(measuredCost.shadowUsd)
    && Number.isFinite(measuredCost.reductionPercent);
  const economicsMet = economicsEvaluable
    && measuredCost.reductionPercent >= 30
    && manifest.diagnostics.callReductionGate === "met";
  const corpusMet = manifest.target.complete;
  const casesMet = cases.length >= 25;
  const ready = corpusMet && casesMet && sourceCoverage && labelingComplete && metrics !== null
    && economicsEvaluable;
  const verdict = !ready ? "not_evaluated" : qualityMet && economicsMet ? "met" : "not_met";
  return {
    schema: BATCH_ADJUDICATION_REPORT_SCHEMA,
    campaignId: manifest.campaignId,
    annotationDigest: sha256(annotationValue as JsonValue),
    integrity: {
      sourceCount: expected.length,
      assignedSourceCount: assignedSet.size,
      uniqueSourceRefs,
      allSourceRefsResolve,
      allSourcesAssigned,
      declaredUnassignedMatches,
    },
    completion: {
      snapshotTargetComplete: manifest.target.complete,
      labelingComplete,
      caseCount: cases.length,
      caseTargetComplete: casesMet,
    },
    classBalance: { write: writes, skip: skips, defer: defers, writeShare: ratio(writes, cases.length) },
    evidenceQuality: {
      sufficient: cases.filter((entry) => entry.evidenceQuality === "sufficient").length,
      insufficient: cases.filter((entry) => entry.evidenceQuality === "insufficient").length,
    },
    metrics,
    gates: {
      corpus: corpusMet ? "met" : "not_met",
      cases: casesMet ? "met" : "not_met",
      sourceCoverage: sourceCoverage ? "met" : "not_met",
      quality: metrics === null ? "not_evaluated" : qualityMet ? "met" : "not_met",
      economics: !economicsEvaluable ? "not_evaluated" : economicsMet ? "met" : "not_met",
      verdict,
    },
  };
}

if (import.meta.main) {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    if (!process.argv[index]?.startsWith("--") || !process.argv[index + 1]) fail("INVALID_CLI", "arguments must be --name value pairs");
    args.set(process.argv[index], process.argv[index + 1]);
  }
  const manifest = JSON.parse(readFileSync(args.get("--manifest") ?? fail("INVALID_CLI", "missing --manifest"), "utf8"));
  if (args.has("--template")) {
    process.stdout.write(`${JSON.stringify(createBatchAdjudicationTemplate(manifest), null, 2)}\n`);
  } else {
    const annotation = JSON.parse(readFileSync(args.get("--annotation") ?? fail("INVALID_CLI", "missing --annotation"), "utf8"));
    process.stdout.write(`${JSON.stringify(evaluateBatchAdjudication(manifest, annotation), null, 2)}\n`);
  }
}
