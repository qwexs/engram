import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { contextError } from "../cli/errors.ts";
import {
  parseRecallEvalCase,
  type RecallEvalCase,
  type RecallExactScope,
} from "./recall-evaluator-contracts.ts";

export const RECALL_EVAL_DATASET_SCHEMA = "engram.recall-eval-dataset.v1" as const;
export const RECALL_EVAL_PREFLIGHT_SCHEMA = "engram.recall-eval-preflight.v1" as const;
export const RECALL_REQUIRED_QUESTION_CLASSES = [
  "factual-event",
  "explicit-decision",
  "state-correction",
  "temporal-relation",
  "no-evidence",
] as const;

export type RecallRequiredQuestionClass = typeof RECALL_REQUIRED_QUESTION_CLASSES[number];

export type RecallApprovedEpisode = {
  receiptId: string;
  traceId: string;
  sourceCompletedAt: string;
  completedAt: string;
  canonicalRef: string;
  canonicalDigest: string;
  policyDigest: string;
  scope: RecallExactScope;
};

export type RecallEvalDataset = {
  schema: typeof RECALL_EVAL_DATASET_SCHEMA;
  dataset: {
    id: string;
    version: number;
    digest: string;
    sealedAt: string;
  };
  scope: RecallExactScope;
  collections: string[];
  topK: [1, 3, 5, 10];
  approval: {
    approvedBy: string;
    approvedAt: string;
    effectiveAfter: string;
  };
  approvedEpisodes: RecallApprovedEpisode[];
  cases: RecallEvalCase[];
};

export type RecallEvalDatasetDraft = Omit<RecallEvalDataset, "dataset"> & {
  dataset: Omit<RecallEvalDataset["dataset"], "digest">;
};

export type RecallEvalPreflight = {
  schema: typeof RECALL_EVAL_PREFLIGHT_SCHEMA;
  status: "structure-valid";
  runAllowed: false;
  authorityVerified: false;
  datasetId: string;
  datasetVersion: number;
  datasetDigest: string;
  policyDigest: string;
  exactScope: RecallExactScope;
  collections: string[];
  topK: [1, 3, 5, 10];
  counts: {
    cases: number;
    approvedEpisodes: number;
    traceableGoldCases: number;
    abstentionCases: number;
    byQuestionClass: Record<RecallRequiredQuestionClass, number>;
  };
};

const CANONICAL_DAILY_REF_RE = /^memory\/[a-zA-Z0-9._/-]+\.md#engram-entry:sha256:[a-f0-9]{64}$/;
const PRIVATE_PATH_RE = /(?:^|\s)(?:~\/|\/(?:home|root|opt\/openclaw\/\.openclaw|etc|var\/lib\/private)\/)[^\s]*/i;
const SENSITIVE_TEXT_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:api[-_ ]?key|password|passwd|private[-_ ]?key|secret|token)\s*[:=]\s*\S+/i,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:^|\D)\+?\d[\d ()-]{9,}\d(?:\D|$)/,
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function fail(message: string): never {
  throw contextError(message);
}

function assertKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(`${label} contains unknown field ${key}.`);
  }
}

function parseToken(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${field} is required.`);
  return value.trim();
}

function parseDigest(value: unknown, field: string): string {
  const token = parseToken(value, field);
  if (!/^sha256:[a-f0-9]{64}$/.test(token)) fail(`${field} must be a sha256 digest.`);
  return token;
}

function parseInstant(value: unknown, field: string): string {
  const token = parseToken(value, field);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(token);
  if (!match) fail(`${field} must be a valid RFC3339 timestamp.`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  const invalidCalendar = date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day;
  const invalidClock = Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59;
  const invalidOffset = offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59);
  if (invalidCalendar || invalidClock || invalidOffset || !Number.isFinite(Date.parse(token))) {
    fail(`${field} must be a valid RFC3339 timestamp.`);
  }
  return token;
}

function parseScope(value: unknown, field = "scope"): RecallExactScope {
  const scope = asRecord(value);
  if (!scope) fail(`${field} must be an object.`);
  assertKeys(scope, ["workspaceId", "runtimeSessionKey", "scopeClass", "scopeId"], field);
  const scopeClass = parseToken(scope.scopeClass, `${field}.scopeClass`);
  if (!["self", "managers", "company", "project"].includes(scopeClass)) fail(`${field}.scopeClass is invalid.`);
  const runtimeSessionKey = parseToken(scope.runtimeSessionKey, `${field}.runtimeSessionKey`);
  if (!/^agent:[^\s]{1,2042}$/.test(runtimeSessionKey)) fail(`${field}.runtimeSessionKey is invalid.`);
  return {
    workspaceId: parseToken(scope.workspaceId, `${field}.workspaceId`),
    runtimeSessionKey,
    scopeClass: scopeClass as RecallExactScope["scopeClass"],
    scopeId: parseToken(scope.scopeId, `${field}.scopeId`),
  };
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${field} must be a non-empty array.`);
  const parsed = value.map((entry, index) => parseToken(entry, `${field}[${index}]`));
  if (new Set(parsed).size !== parsed.length) fail(`${field} must not contain duplicates.`);
  return parsed.sort();
}

function containsSensitiveText(value: string): boolean {
  return value.length > 2_000 || PRIVATE_PATH_RE.test(value) || SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

function assertCasePrivacy(evalCase: RecallEvalCase): void {
  const textFields = [evalCase.question, ...evalCase.expectedClaims, ...evalCase.forbiddenClaims];
  if (textFields.some(containsSensitiveText)) fail("eval case contains text forbidden by privacy-v1.");
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
}

function scopeKey(scope: RecallExactScope): string {
  return stable(scope);
}

function digestPayload(dataset: RecallEvalDataset | RecallEvalDatasetDraft): unknown {
  return {
    schema: dataset.schema,
    dataset: {
      id: dataset.dataset.id,
      version: dataset.dataset.version,
      sealedAt: dataset.dataset.sealedAt,
    },
    scope: dataset.scope,
    collections: dataset.collections,
    topK: dataset.topK,
    approval: dataset.approval,
    approvedEpisodes: dataset.approvedEpisodes,
    cases: dataset.cases,
  };
}

export function computeRecallEvalDatasetDigest(dataset: RecallEvalDataset | RecallEvalDatasetDraft): string {
  return sha256(digestPayload(dataset));
}

function parseEpisode(value: unknown, index: number): RecallApprovedEpisode {
  const episode = asRecord(value);
  const label = `approvedEpisodes[${index}]`;
  if (!episode) fail(`${label} must be an object.`);
  assertKeys(episode, [
    "receiptId", "traceId", "sourceCompletedAt", "completedAt", "canonicalRef", "canonicalDigest", "policyDigest", "scope",
  ], label);
  return {
    receiptId: parseDigest(episode.receiptId, `${label}.receiptId`),
    traceId: parseDigest(episode.traceId, `${label}.traceId`),
    sourceCompletedAt: parseInstant(episode.sourceCompletedAt, `${label}.sourceCompletedAt`),
    completedAt: parseInstant(episode.completedAt, `${label}.completedAt`),
    canonicalRef: (() => {
      const ref = parseToken(episode.canonicalRef, `${label}.canonicalRef`);
      if (!CANONICAL_DAILY_REF_RE.test(ref)) fail(`${label}.canonicalRef must be a canonical daily-note entry reference.`);
      return ref;
    })(),
    canonicalDigest: parseDigest(episode.canonicalDigest, `${label}.canonicalDigest`),
    policyDigest: parseDigest(episode.policyDigest, `${label}.policyDigest`),
    scope: parseScope(episode.scope, `${label}.scope`),
  };
}

function normalizeDataset(value: unknown, requireDigest: boolean): RecallEvalDataset | RecallEvalDatasetDraft {
  const root = asRecord(value);
  if (!root) fail("recall eval dataset must be an object.");
  assertKeys(root, ["schema", "dataset", "scope", "collections", "topK", "approval", "approvedEpisodes", "cases"], "dataset root");
  if (root.schema !== RECALL_EVAL_DATASET_SCHEMA) fail("recall eval dataset schema is unsupported.");

  const identity = asRecord(root.dataset);
  if (!identity) fail("dataset identity must be an object.");
  assertKeys(identity, requireDigest ? ["id", "version", "digest", "sealedAt"] : ["id", "version", "sealedAt"], "dataset");
  if (!Number.isSafeInteger(identity.version) || Number(identity.version) < 1) fail("dataset.version must be a positive safe integer.");

  const approval = asRecord(root.approval);
  if (!approval) fail("approval must be an object.");
  assertKeys(approval, ["approvedBy", "approvedAt", "effectiveAfter"], "approval");

  if (!Array.isArray(root.topK) || stable(root.topK) !== stable([1, 3, 5, 10])) fail("topK must equal [1,3,5,10].");
  if (!Array.isArray(root.approvedEpisodes)) fail("approvedEpisodes must be an array.");
  if (!Array.isArray(root.cases)) fail("cases must be an array.");

  const normalized = {
    schema: RECALL_EVAL_DATASET_SCHEMA,
    dataset: {
      id: parseDigest(identity.id, "dataset.id"),
      version: Number(identity.version),
      ...(requireDigest ? { digest: parseDigest(identity.digest, "dataset.digest") } : {}),
      sealedAt: parseInstant(identity.sealedAt, "dataset.sealedAt"),
    },
    scope: parseScope(root.scope),
    collections: parseStringArray(root.collections, "collections"),
    topK: [1, 3, 5, 10] as [1, 3, 5, 10],
    approval: {
      approvedBy: parseToken(approval.approvedBy, "approval.approvedBy"),
      approvedAt: parseInstant(approval.approvedAt, "approval.approvedAt"),
      effectiveAfter: parseInstant(approval.effectiveAfter, "approval.effectiveAfter"),
    },
    approvedEpisodes: root.approvedEpisodes.map(parseEpisode).sort((left, right) => left.traceId.localeCompare(right.traceId)),
    cases: root.cases.map(parseRecallEvalCase).sort((left, right) => left.caseId.localeCompare(right.caseId)),
  };
  return normalized as RecallEvalDataset | RecallEvalDatasetDraft;
}

export function sealRecallEvalDataset(value: RecallEvalDatasetDraft): RecallEvalDataset {
  const normalized = normalizeDataset(value, false) as RecallEvalDatasetDraft;
  return {
    ...normalized,
    dataset: {
      ...normalized.dataset,
      digest: computeRecallEvalDatasetDigest(normalized),
    },
  };
}

export function parseRecallEvalDataset(value: unknown): RecallEvalDataset {
  const normalized = normalizeDataset(value, true) as RecallEvalDataset;
  const expectedDigest = computeRecallEvalDatasetDigest(normalized);
  if (normalized.dataset.digest !== expectedDigest) fail("dataset.digest does not match the sealed dataset payload.");
  return normalized;
}

export function loadRecallEvalDataset(path: string): RecallEvalDataset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw contextError("Recall eval dataset is not valid JSON.", {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return parseRecallEvalDataset(parsed);
}

export function preflightRecallEvalDataset(value: unknown): RecallEvalPreflight {
  const dataset = parseRecallEvalDataset(value);
  const exactScope = scopeKey(dataset.scope);
  const effectiveAfter = Date.parse(dataset.approval.effectiveAfter);
  if (Date.parse(dataset.approval.approvedAt) > effectiveAfter) fail("approval.approvedAt cannot be after effectiveAfter.");
  if (Date.parse(dataset.dataset.sealedAt) < effectiveAfter) fail("dataset.sealedAt cannot be before effectiveAfter.");
  if (dataset.approvedEpisodes.length < 20 || dataset.approvedEpisodes.length > 30) {
    fail("R2 requires 20-30 approved canonical episodes.");
  }
  if (dataset.cases.length < 25) fail("R2 requires at least 25 eval cases.");

  const receiptIds = new Set<string>();
  const canonicalRefs = new Set<string>();
  const policyDigests = new Set<string>();
  for (const episode of dataset.approvedEpisodes) {
    if (scopeKey(episode.scope) !== exactScope) fail("approved episodes must share the exact dataset scope.");
    if (Date.parse(episode.completedAt) < effectiveAfter || Date.parse(episode.sourceCompletedAt) < effectiveAfter) {
      fail("approved episodes must not predate approval.effectiveAfter.");
    }
    if (Date.parse(episode.completedAt) < Date.parse(episode.sourceCompletedAt)) fail("approved episode completedAt cannot predate sourceCompletedAt.");
    if (Date.parse(dataset.dataset.sealedAt) < Date.parse(episode.completedAt)) fail("dataset.sealedAt cannot predate an approved episode.");
    if (receiptIds.has(episode.receiptId)) fail("approved episode receiptIds must be unique.");
    if (canonicalRefs.has(episode.canonicalRef)) fail("approved episode canonicalRefs must be unique.");
    receiptIds.add(episode.receiptId);
    canonicalRefs.add(episode.canonicalRef);
    policyDigests.add(episode.policyDigest);
  }
  if (policyDigests.size !== 1) fail("approved episodes must share one policyDigest; mixed policy snapshots are forbidden.");

  const caseIds = new Set<string>();
  const byQuestionClass = Object.fromEntries(RECALL_REQUIRED_QUESTION_CLASSES.map((key) => [key, 0])) as Record<RecallRequiredQuestionClass, number>;
  let traceableGoldCases = 0;
  let abstentionCases = 0;
  for (const evalCase of dataset.cases) {
    assertCasePrivacy(evalCase);
    if (caseIds.has(evalCase.caseId)) fail("eval caseIds must be unique.");
    caseIds.add(evalCase.caseId);
    if (evalCase.datasetId !== dataset.dataset.id) fail("eval cases must share dataset.id.");
    if (scopeKey(evalCase.scope) !== exactScope) fail("eval cases must share the exact dataset scope.");
    if (!RECALL_REQUIRED_QUESTION_CLASSES.includes(evalCase.questionClass as RecallRequiredQuestionClass)) {
      fail(`questionClass ${evalCase.questionClass} is not part of the required R2 set.`);
    }
    const questionClass = evalCase.questionClass as RecallRequiredQuestionClass;
    byQuestionClass[questionClass] += 1;

    if (questionClass === "no-evidence") {
      if (!evalCase.mustAbstain || evalCase.goldEvidenceRefs.length !== 0) fail("no-evidence cases must require abstention and contain no gold evidence.");
      abstentionCases += 1;
      continue;
    }
    if (evalCase.mustAbstain) fail("positive recall cases cannot require abstention.");
    const sourceTraceIds = new Set(evalCase.sourceTraceIds);
    const canonicalGold = evalCase.goldEvidenceRefs.filter((ref) => ref.kind === "canonical-record");
    if (canonicalGold.length === 0) fail("positive recall cases require canonical gold evidence.");
    const traceable = canonicalGold.every((gold) => dataset.approvedEpisodes.some((episode) => (
      sourceTraceIds.has(episode.traceId)
      && episode.canonicalRef === gold.ref
      && episode.canonicalDigest === gold.digest
    )));
    if (!traceable) fail("every positive gold reference must resolve through an approved episode and source trace.");
    traceableGoldCases += 1;
  }

  for (const questionClass of RECALL_REQUIRED_QUESTION_CLASSES) {
    if (byQuestionClass[questionClass] < 5) fail(`R2 requires at least five ${questionClass} cases.`);
  }

  return {
    schema: RECALL_EVAL_PREFLIGHT_SCHEMA,
    status: "structure-valid",
    runAllowed: false,
    authorityVerified: false,
    datasetId: dataset.dataset.id,
    datasetVersion: dataset.dataset.version,
    datasetDigest: dataset.dataset.digest,
    policyDigest: [...policyDigests][0]!,
    exactScope: dataset.scope,
    collections: dataset.collections,
    topK: dataset.topK,
    counts: {
      cases: dataset.cases.length,
      approvedEpisodes: dataset.approvedEpisodes.length,
      traceableGoldCases,
      abstentionCases,
      byQuestionClass,
    },
  };
}
