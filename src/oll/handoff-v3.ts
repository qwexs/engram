import { resolve } from "node:path";
import type { AdaptationRisk, AdaptationScope } from "./authorization";
import {
  canonicalizeJcs,
  type Digest,
  HandoffValidationError,
  RETHINK_ACTION_TYPES,
  RETHINK_HANDOFF_MAX_ACTIONS,
  RETHINK_HANDOFF_MAX_BYTES,
  sha256Digest,
  type HandoffAuthorizationResultV1,
  type RethinkActionType,
  type ReviewDisposition,
} from "./handoff-v2";

export const RETHINK_HANDOFF_V3_SCHEMA = "oll.rethink-handoff.v3" as const;

export interface RethinkActionPayloadV3 {
  ruleId?: string | null;
  rule?: string | null;
  sourceSignals: string[];
  sourceCandidates: Digest[];
  scope: { level: AdaptationScope["level"]; subject: string };
  risk: AdaptationRisk;
  rationale: string;
  expectedImprovement: string;
  costOfInaction: string;
  rollbackRef: string;
  expectedRuleRevision: number | null;
  authorizationResult: HandoffAuthorizationResultV1;
  policyVersion: 1;
  reviewDisposition: ReviewDisposition;
}

export interface RethinkActionV3 {
  type: RethinkActionType;
  actionId: Digest;
  payload: RethinkActionPayloadV3;
}

export interface CandidateDispositionV1 {
  candidateId: Digest;
  expectedRevision: number;
  disposition: "consumed" | "ignored" | "deferred";
  rationale: string;
}

export interface RethinkHandoffV3 {
  schema: typeof RETHINK_HANDOFF_V3_SCHEMA;
  batchId: string;
  workspaceId: string;
  evaluationId: string;
  runId: string;
  phase: "hb-rethink";
  attempt: number;
  policyVersion: 1;
  contextDigest: Digest;
  handoffDigest: Digest;
  createdAt: string;
  actions: RethinkActionV3[];
  candidateDispositions: CandidateDispositionV1[];
}

export interface ExpectedHandoffV3 {
  batchId: string;
  workspaceId: string;
  evaluationId: string;
  runId: string;
  phase: "hb-rethink";
  attempt: number;
  policyVersion: 1;
  contextDigest: Digest;
  expectedHandoffPath: string;
  signalRevisions: Readonly<Record<string, number>>;
  candidateRevisions: Readonly<Record<string, number>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const WORKSPACE_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function fail(message: string): never { throw new HandoffValidationError("schema_invalid", message); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!(key in value)) fail(`missing required field: ${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`unknown field: ${key}`);
}
function string(value: unknown, label: string, max: number, pattern?: RegExp): string {
  if (typeof value !== "string" || !value || value.length > max || (pattern && !pattern.test(value))) fail(`${label} is invalid`);
  return value;
}
function integer(value: unknown, label: string, minimum = 1): number {
  if (!Number.isInteger(value) || Number(value) < minimum) fail(`${label} is invalid`);
  return Number(value);
}
function uniqueStrings(value: unknown, label: string, pattern: RegExp): string[] {
  if (!Array.isArray(value) || value.length > 50) fail(`${label} is invalid`);
  const out = value.map((entry) => string(entry, label, 71, pattern));
  if (new Set(out).size !== out.length) fail(`${label} must be unique`);
  return out;
}
function authorization(value: unknown): HandoffAuthorizationResultV1 {
  const row = object(value, "authorizationResult");
  keys(row, ["status", "principalId", "grantId", "registryRevision", "registryDigest", "reason"]);
  if (!["authorized", "review_required", "denied"].includes(String(row.status))) fail("authorization status is invalid");
  if (row.principalId !== null) string(row.principalId, "principalId", 300);
  if (row.grantId !== null) string(row.grantId, "grantId", 300);
  return {
    status: row.status as HandoffAuthorizationResultV1["status"],
    principalId: row.principalId as string | null,
    grantId: row.grantId as string | null,
    registryRevision: integer(row.registryRevision, "registryRevision"),
    registryDigest: string(row.registryDigest, "registryDigest", 71, DIGEST_RE) as Digest,
    reason: string(row.reason, "authorization reason", 1000),
  };
}

export function computeHandoffDigestV3(handoff: Omit<RethinkHandoffV3, "handoffDigest"> | RethinkHandoffV3): Digest {
  const { handoffDigest: _ignored, ...base } = handoff as RethinkHandoffV3;
  return sha256Digest(canonicalizeJcs(base));
}

export function computeActionIdV3(evaluationId: string, ordinal: number, action: Omit<RethinkActionV3, "actionId"> | RethinkActionV3): Digest {
  const { actionId: _ignored, ...base } = action as RethinkActionV3;
  return sha256Digest(`${evaluationId}${ordinal}${canonicalizeJcs(base)}`);
}

function parseAction(value: unknown, evaluationId: string, ordinal: number, expected: ExpectedHandoffV3): RethinkActionV3 {
  const row = object(value, "action");
  keys(row, ["type", "actionId", "payload"]);
  if (!RETHINK_ACTION_TYPES.includes(row.type as RethinkActionType)) fail("action type is unsupported");
  const payload = object(row.payload, "action payload");
  keys(payload, [
    "sourceSignals", "sourceCandidates", "scope", "risk", "rationale", "expectedImprovement", "costOfInaction",
    "rollbackRef", "expectedRuleRevision", "authorizationResult", "policyVersion", "reviewDisposition",
  ], ["ruleId", "rule"]);
  const sourceSignals = uniqueStrings(payload.sourceSignals, "sourceSignals", UUID_RE);
  const sourceCandidates = uniqueStrings(payload.sourceCandidates, "sourceCandidates", DIGEST_RE) as Digest[];
  if (!sourceSignals.length && !sourceCandidates.length) fail("action requires at least one source");
  for (const id of sourceSignals) if (!Number.isInteger(expected.signalRevisions[id])) fail(`signal ${id} is outside the immutable context snapshot`);
  for (const id of sourceCandidates) if (!Number.isInteger(expected.candidateRevisions[id])) fail(`candidate ${id} is outside the immutable context snapshot`);
  const scopeRow = object(payload.scope, "scope");
  keys(scopeRow, ["level", "subject"]);
  if (!["person", "domain", "workspace", "company"].includes(String(scopeRow.level))) fail("scope level is invalid");
  const actionType = row.type as RethinkActionType;
  const ruleId = payload.ruleId == null ? null : string(payload.ruleId, "ruleId", 36, UUID_RE);
  const rule = payload.rule == null ? null : string(payload.rule, "rule", 4000);
  const expectedRuleRevision = payload.expectedRuleRevision == null ? null : integer(payload.expectedRuleRevision, "expectedRuleRevision");
  if (actionType === "propose_rule" && (!rule || ruleId || expectedRuleRevision !== null)) fail("propose_rule requires rule and null ruleId/revision");
  if (actionType !== "propose_rule" && (!ruleId || expectedRuleRevision === null)) fail(`${actionType} requires ruleId and expectedRuleRevision`);
  if (actionType === "supersede_rule" && !rule) fail("supersede_rule requires replacement rule text");
  if (!["low", "medium", "high"].includes(String(payload.risk))) fail("risk is invalid");
  if (payload.policyVersion !== 1) fail("policyVersion must equal 1");
  if (!["auto_apply", "review_required", "reject"].includes(String(payload.reviewDisposition))) fail("reviewDisposition is invalid");
  const auth = authorization(payload.authorizationResult);
  if (sourceCandidates.length && actionType !== "propose_rule") fail("memory candidate evidence may only produce a scoped rule proposal");
  const action: RethinkActionV3 = {
    type: actionType,
    actionId: string(row.actionId, "actionId", 71, DIGEST_RE) as Digest,
    payload: {
      ruleId, rule, sourceSignals, sourceCandidates,
      scope: { level: scopeRow.level as AdaptationScope["level"], subject: string(scopeRow.subject, "scope subject", 300) },
      risk: payload.risk as AdaptationRisk,
      rationale: string(payload.rationale, "rationale", 2000),
      expectedImprovement: string(payload.expectedImprovement, "expectedImprovement", 2000),
      costOfInaction: string(payload.costOfInaction, "costOfInaction", 2000),
      rollbackRef: string(payload.rollbackRef, "rollbackRef", 500),
      expectedRuleRevision,
      authorizationResult: auth,
      policyVersion: 1,
      reviewDisposition: payload.reviewDisposition as ReviewDisposition,
    },
  };
  if (action.actionId !== computeActionIdV3(evaluationId, ordinal, action)) fail(`actionId mismatch at ordinal ${ordinal}`);
  return action;
}

export function parseRethinkHandoffV3(raw: string | Uint8Array, expected: ExpectedHandoffV3, observedPath: string): RethinkHandoffV3 {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
  if (bytes > RETHINK_HANDOFF_MAX_BYTES) fail("handoff exceeds 256 KiB");
  if (resolve(observedPath) !== resolve(expected.expectedHandoffPath)) throw new HandoffValidationError("correlation_mismatch", "handoff path mismatch");
  let parsed: unknown;
  try { parsed = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8")); }
  catch { fail("handoff is not valid JSON"); }
  const row = object(parsed, "handoff");
  keys(row, [
    "schema", "batchId", "workspaceId", "evaluationId", "runId", "phase", "attempt", "policyVersion",
    "contextDigest", "handoffDigest", "createdAt", "actions", "candidateDispositions",
  ]);
  if (row.schema !== RETHINK_HANDOFF_V3_SCHEMA || row.phase !== "hb-rethink" || row.policyVersion !== 1) fail("handoff contract is unsupported");
  const evaluationId = string(row.evaluationId, "evaluationId", 36, UUID_RE);
  if (!Array.isArray(row.actions) || row.actions.length > RETHINK_HANDOFF_MAX_ACTIONS) fail("actions is invalid");
  if (!Array.isArray(row.candidateDispositions) || row.candidateDispositions.length > 50) fail("candidateDispositions is invalid");
  const dispositions: CandidateDispositionV1[] = row.candidateDispositions.map((value) => {
    const item = object(value, "candidate disposition");
    keys(item, ["candidateId", "expectedRevision", "disposition", "rationale"]);
    const candidateId = string(item.candidateId, "candidateId", 71, DIGEST_RE) as Digest;
    if (!["consumed", "ignored", "deferred"].includes(String(item.disposition))) fail("candidate disposition is invalid");
    const expectedRevision = integer(item.expectedRevision, "candidate expectedRevision");
    if (expected.candidateRevisions[candidateId] !== expectedRevision) fail(`candidate revision mismatch: ${candidateId}`);
    return { candidateId, expectedRevision, disposition: item.disposition as CandidateDispositionV1["disposition"], rationale: string(item.rationale, "candidate rationale", 1000) };
  });
  const expectedIds = Object.keys(expected.candidateRevisions).sort();
  const actualIds = dispositions.map((item) => item.candidateId).sort();
  if (new Set(actualIds).size !== actualIds.length || canonicalizeJcs(actualIds) !== canonicalizeJcs(expectedIds)) fail("candidate dispositions must cover the exact context candidate set");
  const handoff: RethinkHandoffV3 = {
    schema: RETHINK_HANDOFF_V3_SCHEMA,
    batchId: string(row.batchId, "batchId", 300, /^nightly-[A-Za-z0-9:._+-]+$/),
    workspaceId: string(row.workspaceId, "workspaceId", 64, WORKSPACE_RE),
    evaluationId,
    runId: string(row.runId, "runId", 36, UUID_RE),
    phase: "hb-rethink",
    attempt: integer(row.attempt, "attempt"),
    policyVersion: 1,
    contextDigest: string(row.contextDigest, "contextDigest", 71, DIGEST_RE) as Digest,
    handoffDigest: string(row.handoffDigest, "handoffDigest", 71, DIGEST_RE) as Digest,
    createdAt: string(row.createdAt, "createdAt", 100),
    actions: row.actions.map((value, ordinal) => parseAction(value, evaluationId, ordinal, expected)),
    candidateDispositions: dispositions,
  };
  const citedCandidates = new Set(handoff.actions.flatMap((action) => action.payload.sourceCandidates));
  for (const disposition of handoff.candidateDispositions) {
    if ((disposition.disposition === "consumed") !== citedCandidates.has(disposition.candidateId)) {
      fail("consumed candidate dispositions must exactly match candidates cited by actions");
    }
  }
  if (!Number.isFinite(Date.parse(handoff.createdAt))) fail("createdAt is invalid");
  if (new Set(handoff.actions.map((action) => action.actionId)).size !== handoff.actions.length) fail("actionIds must be unique");
  if (handoff.handoffDigest !== computeHandoffDigestV3(handoff)) fail("handoffDigest mismatch");
  for (const [field, actual, wanted] of [
    ["batchId", handoff.batchId, expected.batchId], ["workspaceId", handoff.workspaceId, expected.workspaceId],
    ["evaluationId", handoff.evaluationId, expected.evaluationId], ["runId", handoff.runId, expected.runId],
    ["attempt", handoff.attempt, expected.attempt], ["contextDigest", handoff.contextDigest, expected.contextDigest],
  ] as const) if (actual !== wanted) throw new HandoffValidationError("correlation_mismatch", `${field} mismatch`);
  return handoff;
}

export function buildRethinkProposalPromptV3(input: {
  contextSnapshot: unknown;
  expected: ExpectedHandoffV3;
  policyBoundaries?: readonly string[];
  emptyHandoffWriterPath?: string;
}): string {
  const target = resolve(input.expected.expectedHandoffPath);
  const noSources = !Object.keys(input.expected.signalRevisions).length && !Object.keys(input.expected.candidateRevisions).length;
  const helper = input.emptyHandoffWriterPath && noSources ? [
    "No eligible sources exist. actions and candidateDispositions MUST both be empty.",
    "Execute this exact helper command; it is the only permitted file write:",
    ["bun", input.emptyHandoffWriterPath, "--schema", "v3", "--target", target, "--workspace", resolve(target, "../../../../.."),
      "--batch-id", input.expected.batchId, "--workspace-id", input.expected.workspaceId, "--evaluation-id", input.expected.evaluationId,
      "--run-id", input.expected.runId, "--attempt", String(input.expected.attempt), "--context-digest", input.expected.contextDigest,
    ].map((value) => JSON.stringify(value)).join(" "),
  ] : [];
  return [
    "You are hb-rethink. Produce exactly one oll.rethink-handoff.v3 JSON object at the exact target and no prose.",
    `Exact absolute handoff target: ${target}`,
    `Correlation: ${canonicalizeJcs({
      batchId: input.expected.batchId,
      workspaceId: input.expected.workspaceId,
      evaluationId: input.expected.evaluationId,
      runId: input.expected.runId,
      phase: input.expected.phase,
      attempt: input.expected.attempt,
      policyVersion: input.expected.policyVersion,
      contextDigest: input.expected.contextDigest,
      signalRevisions: input.expected.signalRevisions,
      candidateRevisions: input.expected.candidateRevisions,
    })}`,
    `Allowed actions: ${RETHINK_ACTION_TYPES.join(", ")}`,
    "Behavioral sourceSignals retain their frozen authorization contract.",
    "Memory sourceCandidates are evidence only: any action citing one MUST be propose_rule. The deterministic applicator, not the model, decides immediate activation and notification from the frozen workspace mode.",
    "Every context candidate MUST receive exactly one consumed, ignored, or deferred disposition. consumed means cited by a proposal; ignored means not useful; deferred means genuinely awaiting more evidence.",
    "Never broaden a candidate scope ceiling. Candidate evidence never authorizes activation, KG writes, external actions, source-code changes, or infrastructure changes.",
    ...(input.policyBoundaries || [
      "proposal-only: do not edit files except the exact handoff target",
      "never propose AGENTS.md, SOUL.md, skill, source-code, infrastructure, experiment, rethink2, or autoresearch changes",
    ]).map((line) => `- ${line}`),
    "Every actionId and handoffDigest must follow the JCS/SHA-256 contract. Unknown fields are rejected.",
    ...helper,
    `Immutable context snapshot (JCS): ${canonicalizeJcs(input.contextSnapshot)}`,
  ].join("\n");
}
