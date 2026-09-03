import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { contextError } from "../cli/errors.ts";

export const RECALL_EVAL_CASE_SCHEMA = "engram.recall-eval-case.v1" as const;
export const RECALL_EVAL_CASE_RESULT_SCHEMA = "engram.recall-eval-case-result.v1" as const;
export const RECALL_EVAL_REPORT_SCHEMA = "engram.recall-eval-report.v1" as const;

export type RecallExactScope = {
  workspaceId: string;
  runtimeSessionKey: string;
  scopeClass: "self" | "managers" | "company" | "project";
  scopeId: string;
};

export type RecallGoldEvidenceRef = {
  kind: "canonical-record" | "observation" | "trace";
  ref: string;
  digest: string;
};

export type RecallAdjudication = {
  source: "human" | "deterministic-check";
  verifierRef: string;
  digest: string;
};

export type RecallFailureStage = "capture" | "admission" | "index" | "retrieval" | "utilization" | "currentness" | "abstention";
export type RecallDisposition = "correct" | "incorrect" | "abstained" | "unresolved" | "invalidated";
export type RecallVerificationSource = "human" | "deterministic-check";
export type RecallMetricKey = "captureRecall" | "capturePrecision" | "retrievalRecallAt5" | "utilizationAccuracy" | "currentStateAccuracy" | "abstentionAccuracy";

export type RecallMetricContribution = {
  numerator: number;
  denominator: number;
  value: number | null;
};

export type RecallEvalCase = {
  schema: typeof RECALL_EVAL_CASE_SCHEMA;
  caseId: string;
  datasetId: string;
  scope: RecallExactScope;
  questionClass: string;
  question: string;
  sourceTraceIds: string[];
  goldEvidenceRefs: RecallGoldEvidenceRef[];
  expectedClaims: string[];
  forbiddenClaims: string[];
  mustAbstain: boolean;
  critical: boolean;
  tags: string[];
  adjudication: RecallAdjudication;
};

export type RecallEvalCaseResult = {
  schema: typeof RECALL_EVAL_CASE_RESULT_SCHEMA;
  resultId: string;
  runId: string;
  caseId: string;
  datasetId: string;
  scope: RecallExactScope;
  terminalDisposition: RecallDisposition;
  failureStage: RecallFailureStage | null;
  verification: { source: RecallVerificationSource };
  metricContributions: Record<RecallMetricKey, RecallMetricContribution>;
  bottleneck: { stage: RecallFailureStage | null; count: number; reasonCodes: string[] };
  safety: { crossScopeResults: number; rawEvidenceIndexed: number; unauthorizedMutations: number };
  createdAt: string;
};

export type RecallEvalReport = {
  schema: typeof RECALL_EVAL_REPORT_SCHEMA;
  runId: string;
  dataset: { id: string; version: number; digest: string };
  scope: RecallExactScope;
  snapshot: {
    evaluatorDigest: string;
    policyDigest: string;
    indexGeneration: string;
    retrievalConfigDigest: string;
    promptDigest: string;
    modelRef: string;
  };
  counts: { total: number; valid: number; invalidated: number; unresolved: number };
  metrics: Record<RecallMetricKey, RecallMetricContribution>;
  bottlenecks: Array<{ stage: RecallFailureStage; count: number; caseIds: string[]; reasonCodes: string[] }>;
  safety: { crossScopeResults: number; rawEvidenceIndexed: number; unauthorizedMutations: number };
  verdict: "baseline" | "pass" | "fail" | "invalidated";
  createdAt: string;
};

const SCOPE_CLASSES = ["self", "managers", "company", "project"] as const;
const EVIDENCE_KINDS = ["canonical-record", "observation", "trace"] as const;
const VERIFICATION_SOURCES = ["human", "deterministic-check"] as const;
const FAILURE_STAGES = ["capture", "admission", "index", "retrieval", "utilization", "currentness", "abstention"] as const;
const DISPOSITIONS = ["correct", "incorrect", "abstained", "unresolved", "invalidated"] as const;
const METRIC_KEYS: RecallMetricKey[] = [
  "captureRecall",
  "capturePrecision",
  "retrievalRecallAt5",
  "utilizationAccuracy",
  "currentStateAccuracy",
  "abstentionAccuracy",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function fail(message: string): never {
  throw contextError(message);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function assertKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(label + " contains unknown field " + key + ".");
  }
}

function parseCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(field + " must be a finite non-negative safe integer.");
  }
  return value;
}

function parseDigest(value: unknown, field: string): string {
  if (!isToken(value) || !/^sha256:[a-f0-9]{64}$/.test(value.trim())) {
    fail(field + " must be a sha256 digest.");
  }
  return value.trim();
}

function parseUuid(value: unknown, field: string): string {
  if (!isToken(value) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())) {
    fail(field + " must be an RFC 4122 UUID.");
  }
  return value.trim().toLowerCase();
}

function parseTimestamp(value: unknown, field: string): string {
  const text = isToken(value) ? value.trim() : "";
  const match = text
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(text)
    : null;
  if (!match) {
    fail(field + " must be a valid RFC3339 timestamp.");
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const date = new Date(Date.UTC(year, month - 1, day));
  const invalidCalendar = date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day;
  const invalidClock = hour > 23 || minute > 59 || second > 59;
  const invalidOffset = offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59);
  if (invalidCalendar || invalidClock || invalidOffset || !Number.isFinite(Date.parse(text))) {
    fail(field + " must be a valid RFC3339 timestamp.");
  }
  return text;
}

function parseStrings(value: unknown, field: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => !isToken(item))) {
    fail(field + " must be " + (allowEmpty ? "an array" : "a non-empty array") + " of non-empty strings.");
  }
  return value.map((item) => item.trim());
}

function parseExactScope(value: unknown): RecallExactScope {
  const scope = asRecord(value);
  if (!scope) fail("scope must be an object.");
  assertKeys(scope, ["workspaceId", "runtimeSessionKey", "scopeClass", "scopeId"], "scope");
  if (!isToken(scope.workspaceId) || !isToken(scope.runtimeSessionKey) || !isToken(scope.scopeId)) fail("scope fields are required.");
  if (!SCOPE_CLASSES.includes(scope.scopeClass as never)) fail("scopeClass is invalid.");
  if (!/^agent:[^\s]{1,2042}$/.test(scope.runtimeSessionKey.trim())) fail("runtimeSessionKey is invalid.");
  return {
    workspaceId: scope.workspaceId.trim(),
    runtimeSessionKey: scope.runtimeSessionKey.trim(),
    scopeClass: scope.scopeClass as RecallExactScope["scopeClass"],
    scopeId: scope.scopeId.trim(),
  };
}

function parseEvidenceRefs(value: unknown, allowEmpty: boolean): RecallGoldEvidenceRef[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(allowEmpty ? "goldEvidenceRefs must be an array." : "goldEvidenceRefs must not be empty.");
  }
  return value.map((entry) => {
    const ref = asRecord(entry);
    if (!ref) fail("goldEvidenceRefs entries must be objects.");
    assertKeys(ref, ["kind", "ref", "digest"], "goldEvidenceRef");
    if (!EVIDENCE_KINDS.includes(ref.kind as never)) fail("goldEvidenceRefs.kind is invalid.");
    if (!isToken(ref.ref)) fail("goldEvidenceRefs.ref is required.");
    return {
      kind: ref.kind as RecallGoldEvidenceRef["kind"],
      ref: ref.ref.trim(),
      digest: parseDigest(ref.digest, "goldEvidenceRefs.digest"),
    };
  });
}

function parseAdjudication(value: unknown): RecallAdjudication {
  const adjudication = asRecord(value);
  if (!adjudication) fail("adjudication is required.");
  assertKeys(adjudication, ["source", "verifierRef", "digest"], "adjudication");
  if (!VERIFICATION_SOURCES.includes(adjudication.source as never)) fail("adjudication.source is invalid.");
  if (!isToken(adjudication.verifierRef)) fail("adjudication.verifierRef is required.");
  return {
    source: adjudication.source as RecallAdjudication["source"],
    verifierRef: adjudication.verifierRef.trim(),
    digest: parseDigest(adjudication.digest, "adjudication.digest"),
  };
}

function parseMetric(value: unknown, field: string): RecallMetricContribution {
  const metric = asRecord(value);
  if (!metric) fail(field + " must be an object.");
  assertKeys(metric, ["numerator", "denominator", "value"], field);
  const numerator = parseCount(metric.numerator, field + ".numerator");
  const denominator = parseCount(metric.denominator, field + ".denominator");
  if (numerator > denominator) fail(field + ".numerator cannot exceed denominator.");
  if (denominator === 0) {
    if (numerator !== 0 || metric.value !== null) fail(field + " must be 0/0/null when denominator is zero.");
    return { numerator, denominator, value: null };
  }
  const expected = numerator / denominator;
  if (typeof metric.value !== "number" || !Number.isFinite(metric.value) || metric.value < 0 || metric.value > 1 || metric.value !== expected) {
    fail(field + ".value is inconsistent with numerator/denominator.");
  }
  return { numerator, denominator, value: metric.value };
}

function parseMetricRecord(value: unknown, field: string): Record<RecallMetricKey, RecallMetricContribution> {
  const metrics = asRecord(value);
  if (!metrics) fail(field + " must be an object.");
  assertKeys(metrics, METRIC_KEYS, field);
  const parsed = {} as Record<RecallMetricKey, RecallMetricContribution>;
  for (const key of METRIC_KEYS) parsed[key] = parseMetric(metrics[key], field + "." + key);
  return parsed;
}

function parseFailureStage(value: unknown, field: string): RecallFailureStage | null {
  if (value === null || value === undefined) return null;
  if (!FAILURE_STAGES.includes(value as never)) fail(field + " is invalid.");
  return value as RecallFailureStage;
}

function parseSafety(value: unknown): RecallEvalCaseResult["safety"] {
  const safety = asRecord(value);
  if (!safety) fail("safety must be an object.");
  assertKeys(safety, ["crossScopeResults", "rawEvidenceIndexed", "unauthorizedMutations"], "safety");
  return {
    crossScopeResults: parseCount(safety.crossScopeResults, "safety.crossScopeResults"),
    rawEvidenceIndexed: parseCount(safety.rawEvidenceIndexed, "safety.rawEvidenceIndexed"),
    unauthorizedMutations: parseCount(safety.unauthorizedMutations, "safety.unauthorizedMutations"),
  };
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stable(record[key])).join(",") + "}";
}

function digest(value: unknown): string {
  return "sha256:" + createHash("sha256").update(stable(value)).digest("hex");
}

function exactScopeKey(scope: RecallExactScope): string {
  return stable(scope);
}

function zeroMetrics(): Record<RecallMetricKey, RecallMetricContribution> {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, { numerator: 0, denominator: 0, value: null }])) as Record<RecallMetricKey, RecallMetricContribution>;
}

export function parseRecallEvalCase(value: unknown): RecallEvalCase {
  const root = asRecord(value);
  if (!root) fail("case must be an object.");
  assertKeys(root, [
    "schema", "caseId", "datasetId", "scope", "questionClass", "question", "sourceTraceIds", "goldEvidenceRefs",
    "expectedClaims", "forbiddenClaims", "mustAbstain", "critical", "tags", "adjudication",
  ], "case");
  if (root.schema !== RECALL_EVAL_CASE_SCHEMA) fail("unknown schema.");
  if (!isToken(root.questionClass) || !isToken(root.question)) fail("questionClass and question are required.");
  if (typeof root.mustAbstain !== "boolean" || typeof root.critical !== "boolean") fail("mustAbstain and critical are required booleans.");
  const goldEvidenceRefs = parseEvidenceRefs(root.goldEvidenceRefs, root.mustAbstain);
  if (root.mustAbstain && goldEvidenceRefs.length !== 0) fail("mustAbstain cases cannot contain goldEvidenceRefs.");
  return {
    schema: RECALL_EVAL_CASE_SCHEMA,
    caseId: parseDigest(root.caseId, "caseId"),
    datasetId: parseDigest(root.datasetId, "datasetId"),
    scope: parseExactScope(root.scope),
    questionClass: root.questionClass.trim(),
    question: root.question.trim(),
    sourceTraceIds: parseStrings(root.sourceTraceIds, "sourceTraceIds", false).map((item) => parseDigest(item, "sourceTraceId")),
    goldEvidenceRefs,
    expectedClaims: parseStrings(root.expectedClaims, "expectedClaims", true),
    forbiddenClaims: parseStrings(root.forbiddenClaims, "forbiddenClaims", true),
    mustAbstain: root.mustAbstain,
    critical: root.critical,
    tags: parseStrings(root.tags, "tags", true),
    adjudication: parseAdjudication(root.adjudication),
  };
}

export function validateRecallEvalCase(value: unknown): value is RecallEvalCase {
  try { parseRecallEvalCase(value); return true; } catch { return false; }
}

export function parseRecallEvalCaseResult(value: unknown): RecallEvalCaseResult {
  const root = asRecord(value);
  if (!root) fail("result must be an object.");
  assertKeys(root, [
    "schema", "resultId", "runId", "caseId", "datasetId", "scope", "terminalDisposition", "failureStage",
    "verification", "metricContributions", "bottleneck", "safety", "createdAt",
  ], "result");
  if (root.schema !== RECALL_EVAL_CASE_RESULT_SCHEMA) fail("unknown schema.");
  if (!DISPOSITIONS.includes(root.terminalDisposition as never)) fail("terminalDisposition is invalid.");
  const runId = parseUuid(root.runId, "runId");
  const caseId = parseDigest(root.caseId, "caseId");
  const resultId = parseDigest(root.resultId, "resultId");
  if (resultId !== digest({ runId, caseId })) fail("resultId does not match runId/caseId.");
  const verification = asRecord(root.verification);
  if (!verification) fail("verification must be an object.");
  assertKeys(verification, ["source"], "verification");
  if (!VERIFICATION_SOURCES.includes(verification.source as never)) fail("verification.source is invalid.");
  const failureStage = parseFailureStage(root.failureStage, "failureStage");
  const bottleneck = asRecord(root.bottleneck);
  if (!bottleneck) fail("bottleneck must be an object.");
  assertKeys(bottleneck, ["stage", "count", "reasonCodes"], "bottleneck");
  const bottleneckStage = parseFailureStage(bottleneck.stage, "bottleneck.stage");
  const bottleneckCount = parseCount(bottleneck.count, "bottleneck.count");
  if (bottleneckStage !== failureStage) fail("bottleneck.stage must equal failureStage.");
  if ((bottleneckStage === null && bottleneckCount !== 0) || (bottleneckStage !== null && bottleneckCount < 1)) {
    fail("bottleneck.count is inconsistent with bottleneck.stage.");
  }
  const metricContributions = parseMetricRecord(root.metricContributions, "metricContributions");
  if (root.terminalDisposition === "invalidated" && METRIC_KEYS.some((key) => metricContributions[key].denominator !== 0)) {
    fail("invalidated results cannot contribute to quality metrics.");
  }
  return {
    schema: RECALL_EVAL_CASE_RESULT_SCHEMA,
    resultId,
    runId,
    caseId,
    datasetId: parseDigest(root.datasetId, "datasetId"),
    scope: parseExactScope(root.scope),
    terminalDisposition: root.terminalDisposition as RecallDisposition,
    failureStage,
    verification: { source: verification.source as RecallVerificationSource },
    metricContributions,
    bottleneck: {
      stage: bottleneckStage,
      count: bottleneckCount,
      reasonCodes: parseStrings(bottleneck.reasonCodes, "bottleneck.reasonCodes", true).sort(),
    },
    safety: parseSafety(root.safety),
    createdAt: parseTimestamp(root.createdAt, "createdAt"),
  };
}

export function validateRecallEvalCaseResult(value: unknown): value is RecallEvalCaseResult {
  try { parseRecallEvalCaseResult(value); return true; } catch { return false; }
}

export function constructRecallEvalCaseResult(input: {
  case: RecallEvalCase;
  runId: string;
  createdAt: string;
  terminalDisposition: RecallDisposition;
  failureStage?: RecallFailureStage | null;
  verificationSource: RecallVerificationSource;
  metricContributions: Record<RecallMetricKey, RecallMetricContribution>;
  bottleneck?: { count?: number; reasonCodes?: string[] };
  safety?: RecallEvalCaseResult["safety"];
}): RecallEvalCaseResult {
  const evalCase = parseRecallEvalCase(input.case);
  const runId = parseUuid(input.runId, "runId");
  const failureStage = parseFailureStage(input.failureStage, "failureStage");
  const candidate: RecallEvalCaseResult = {
    schema: RECALL_EVAL_CASE_RESULT_SCHEMA,
    resultId: digest({ runId, caseId: evalCase.caseId }),
    runId,
    caseId: evalCase.caseId,
    datasetId: evalCase.datasetId,
    scope: evalCase.scope,
    terminalDisposition: input.terminalDisposition,
    failureStage,
    verification: { source: input.verificationSource },
    metricContributions: input.metricContributions,
    bottleneck: {
      stage: failureStage,
      count: input.bottleneck?.count ?? (failureStage === null ? 0 : 1),
      reasonCodes: input.bottleneck?.reasonCodes ?? [],
    },
    safety: input.safety ?? { crossScopeResults: 0, rawEvidenceIndexed: 0, unauthorizedMutations: 0 },
    createdAt: input.createdAt,
  };
  return parseRecallEvalCaseResult(candidate);
}

function sumMetrics(results: RecallEvalCaseResult[]): Record<RecallMetricKey, RecallMetricContribution> {
  const totals = zeroMetrics();
  for (const key of METRIC_KEYS) {
    const numerator = results.reduce((sum, result) => sum + result.metricContributions[key].numerator, 0);
    const denominator = results.reduce((sum, result) => sum + result.metricContributions[key].denominator, 0);
    totals[key] = { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
  }
  return totals;
}

export function constructRecallEvalReport(params: {
  runId: string;
  createdAt: string;
  datasetId: string;
  datasetVersion: number;
  datasetDigest: string;
  scope: RecallExactScope;
  evaluatorDigest: string;
  policyDigest: string;
  indexGeneration: string;
  retrievalConfigDigest: string;
  promptDigest: string;
  modelRef: string;
  results: RecallEvalCaseResult[];
}): RecallEvalReport {
  const runId = parseUuid(params.runId, "runId");
  const datasetId = parseDigest(params.datasetId, "datasetId");
  const scope = parseExactScope(params.scope);
  const results = params.results.map(parseRecallEvalCaseResult);
  if (new Set(results.map((result) => result.caseId)).size !== results.length) fail("results contain duplicate caseId values.");
  if (results.some((result) => result.runId !== runId)) fail("results must share the report runId.");
  if (results.some((result) => result.datasetId !== datasetId)) fail("results must share the report datasetId.");
  if (results.some((result) => exactScopeKey(result.scope) !== exactScopeKey(scope))) fail("results must share the exact scope.");
  const validResults = results.filter((result) => result.terminalDisposition !== "invalidated");
  const invalidated = results.length - validResults.length;
  const safety = results.reduce((total, result) => ({
    crossScopeResults: total.crossScopeResults + result.safety.crossScopeResults,
    rawEvidenceIndexed: total.rawEvidenceIndexed + result.safety.rawEvidenceIndexed,
    unauthorizedMutations: total.unauthorizedMutations + result.safety.unauthorizedMutations,
  }), { crossScopeResults: 0, rawEvidenceIndexed: 0, unauthorizedMutations: 0 });
  const groups = new Map<RecallFailureStage, { caseIds: string[]; reasonCodes: Set<string> }>();
  for (const result of validResults) {
    if (!result.failureStage) continue;
    const group = groups.get(result.failureStage) ?? { caseIds: [], reasonCodes: new Set<string>() };
    group.caseIds.push(result.caseId);
    for (const code of result.bottleneck.reasonCodes) group.reasonCodes.add(code);
    groups.set(result.failureStage, group);
  }
  const report: RecallEvalReport = {
    schema: RECALL_EVAL_REPORT_SCHEMA,
    runId,
    dataset: { id: datasetId, version: params.datasetVersion, digest: params.datasetDigest },
    scope,
    snapshot: {
      evaluatorDigest: params.evaluatorDigest,
      policyDigest: params.policyDigest,
      indexGeneration: params.indexGeneration,
      retrievalConfigDigest: params.retrievalConfigDigest,
      promptDigest: params.promptDigest,
      modelRef: params.modelRef,
    },
    counts: {
      total: results.length,
      valid: validResults.length,
      invalidated,
      unresolved: validResults.filter((result) => result.terminalDisposition === "unresolved").length,
    },
    metrics: sumMetrics(validResults),
    bottlenecks: [...groups.entries()].map(([stage, group]) => ({
      stage,
      count: group.caseIds.length,
      caseIds: [...group.caseIds].sort(),
      reasonCodes: [...group.reasonCodes].sort(),
    })).sort((left, right) => left.stage.localeCompare(right.stage)),
    safety,
    verdict: invalidated > 0 ? "invalidated" : Object.values(safety).some((count) => count > 0) ? "fail" : "baseline",
    createdAt: params.createdAt,
  };
  return parseRecallEvalReport(report);
}

export function parseRecallEvalReport(value: unknown): RecallEvalReport {
  const root = asRecord(value);
  if (!root) fail("report must be an object.");
  assertKeys(root, ["schema", "runId", "dataset", "scope", "snapshot", "counts", "metrics", "bottlenecks", "safety", "verdict", "createdAt"], "report");
  if (root.schema !== RECALL_EVAL_REPORT_SCHEMA) fail("unknown schema.");
  const dataset = asRecord(root.dataset);
  if (!dataset) fail("dataset must be an object.");
  assertKeys(dataset, ["id", "version", "digest"], "dataset");
  const version = parseCount(dataset.version, "dataset.version");
  if (version < 1) fail("dataset.version must be >= 1.");
  const snapshot = asRecord(root.snapshot);
  if (!snapshot) fail("snapshot must be an object.");
  assertKeys(snapshot, ["evaluatorDigest", "policyDigest", "indexGeneration", "retrievalConfigDigest", "promptDigest", "modelRef"], "snapshot");
  if (!isToken(snapshot.modelRef)) fail("snapshot.modelRef is required.");
  const counts = asRecord(root.counts);
  if (!counts) fail("counts must be an object.");
  assertKeys(counts, ["total", "valid", "invalidated", "unresolved"], "counts");
  const parsedCounts = {
    total: parseCount(counts.total, "counts.total"),
    valid: parseCount(counts.valid, "counts.valid"),
    invalidated: parseCount(counts.invalidated, "counts.invalidated"),
    unresolved: parseCount(counts.unresolved, "counts.unresolved"),
  };
  if (parsedCounts.total !== parsedCounts.valid + parsedCounts.invalidated || parsedCounts.unresolved > parsedCounts.valid) {
    fail("report counts are inconsistent.");
  }
  const bottlenecksValue = root.bottlenecks;
  if (!Array.isArray(bottlenecksValue)) fail("bottlenecks must be an array.");
  const bottlenecks = bottlenecksValue.map((entry) => {
    const bottleneck = asRecord(entry);
    if (!bottleneck) fail("bottleneck must be an object.");
    assertKeys(bottleneck, ["stage", "count", "caseIds", "reasonCodes"], "bottleneck");
    const stage = parseFailureStage(bottleneck.stage, "bottleneck.stage");
    if (!stage) fail("bottleneck.stage is required.");
    const caseIds = parseStrings(bottleneck.caseIds, "bottleneck.caseIds", false).map((caseId) => parseDigest(caseId, "bottleneck.caseId")).sort();
    const count = parseCount(bottleneck.count, "bottleneck.count");
    if (count !== caseIds.length) fail("bottleneck.count must equal caseIds length.");
    return { stage, count, caseIds, reasonCodes: parseStrings(bottleneck.reasonCodes, "bottleneck.reasonCodes", true).sort() };
  }).sort((left, right) => left.stage.localeCompare(right.stage));
  if (new Set(bottlenecks.map((entry) => entry.stage)).size !== bottlenecks.length) fail("bottleneck stages must be unique.");
  const safety = parseSafety(root.safety);
  const verdict = root.verdict;
  if (verdict !== "baseline" && verdict !== "pass" && verdict !== "fail" && verdict !== "invalidated") fail("verdict is invalid.");
  if (parsedCounts.invalidated > 0 && verdict !== "invalidated") fail("invalidated reports require verdict invalidated.");
  if (parsedCounts.invalidated === 0 && Object.values(safety).some((count) => count > 0) && verdict !== "fail") fail("safety blockers require verdict fail.");
  return {
    schema: RECALL_EVAL_REPORT_SCHEMA,
    runId: parseUuid(root.runId, "runId"),
    dataset: { id: parseDigest(dataset.id, "dataset.id"), version, digest: parseDigest(dataset.digest, "dataset.digest") },
    scope: parseExactScope(root.scope),
    snapshot: {
      evaluatorDigest: parseDigest(snapshot.evaluatorDigest, "snapshot.evaluatorDigest"),
      policyDigest: parseDigest(snapshot.policyDigest, "snapshot.policyDigest"),
      indexGeneration: parseDigest(snapshot.indexGeneration, "snapshot.indexGeneration"),
      retrievalConfigDigest: parseDigest(snapshot.retrievalConfigDigest, "snapshot.retrievalConfigDigest"),
      promptDigest: parseDigest(snapshot.promptDigest, "snapshot.promptDigest"),
      modelRef: snapshot.modelRef.trim(),
    },
    counts: parsedCounts,
    metrics: parseMetricRecord(root.metrics, "metrics"),
    bottlenecks,
    safety,
    verdict,
    createdAt: parseTimestamp(root.createdAt, "createdAt"),
  };
}

export function validateRecallEvalReport(value: unknown): value is RecallEvalReport {
  try { parseRecallEvalReport(value); return true; } catch { return false; }
}

export function loadRecallEvalCases(path: string): RecallEvalCase[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw contextError("Recall eval cases are not valid JSON.", { path, cause: error instanceof Error ? error.message : String(error) });
  }
  if (!Array.isArray(parsed)) fail("Recall eval cases must be an array.");
  return parsed.map(parseRecallEvalCase);
}
