import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { AdaptationRisk, AdaptationScope } from "./authorization";

export const RETHINK_HANDOFF_SCHEMA = "oll.rethink-handoff.v2" as const;
export const RETHINK_POLICY_VERSION = 1 as const;
export const RETHINK_HANDOFF_MAX_BYTES = 262_144;
export const RETHINK_HANDOFF_MAX_ACTIONS = 50;
export const RETHINK_ACTION_TYPES = Object.freeze([
  "propose_rule",
  "activate_rule",
  "supersede_rule",
  "suspend_rule",
  "reject_rule",
] as const);

export type RethinkActionType = typeof RETHINK_ACTION_TYPES[number];
export type ReviewDisposition = "auto_apply" | "review_required" | "reject";
export type Digest = `sha256:${string}`;

export interface HandoffAuthorizationResultV1 {
  status: "authorized" | "review_required" | "denied";
  principalId: string | null;
  grantId: string | null;
  registryRevision: number;
  registryDigest: Digest;
  reason: string;
}

export interface RethinkActionPayloadV2 {
  ruleId?: string | null;
  rule?: string | null;
  sourceSignals: string[];
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

export interface RethinkActionV2 {
  type: RethinkActionType;
  actionId: Digest;
  payload: RethinkActionPayloadV2;
}

export interface RethinkHandoffV2 {
  schema: typeof RETHINK_HANDOFF_SCHEMA;
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
  actions: RethinkActionV2[];
}

export interface ExpectedHandoffV2 {
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
}

export class HandoffValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HandoffValidationError";
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const WORKSPACE_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function fail(message: string): never {
  throw new HandoffValidationError("schema_invalid", message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!(key in value)) fail(`missing required field: ${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`unknown field: ${key}`);
}

function stringField(value: unknown, field: string, max: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(`${field} is invalid`);
  if (pattern && !pattern.test(value)) fail(`${field} is invalid`);
  return value;
}

function integerField(value: unknown, field: string, minimum = 1): number {
  if (!Number.isInteger(value) || Number(value) < minimum) fail(`${field} is invalid`);
  return Number(value);
}

function validateUnicode(value: unknown): void {
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail("lone high surrogate is not valid JCS input");
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        fail("lone low surrogate is not valid JCS input");
      }
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) validateUnicode(entry);
  } else if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      validateUnicode(key);
      validateUnicode(entry);
    }
  }
}

/** RFC 8785 JSON canonicalization for JSON-compatible ECMAScript values. */
export function canonicalizeJcs(value: unknown): string {
  validateUnicode(value);
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("non-finite numbers are not valid JCS input");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalizeJcs(entry)).join(",")}]`;
  if (isObject(value)) {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeJcs(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return fail("value is not JSON-compatible");
}

export function sha256Digest(value: string | Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function computeHandoffDigest(handoff: Omit<RethinkHandoffV2, "handoffDigest"> | RethinkHandoffV2): Digest {
  const { handoffDigest: _omitted, ...canonical } = handoff as RethinkHandoffV2;
  return sha256Digest(canonicalizeJcs(canonical));
}

export function computeActionId(evaluationId: string, ordinal: number, action: Omit<RethinkActionV2, "actionId"> | RethinkActionV2): Digest {
  const { actionId: _omitted, ...canonical } = action as RethinkActionV2;
  return sha256Digest(`${evaluationId}${ordinal}${canonicalizeJcs(canonical)}`);
}

export function computeOperationId(workspaceId: string, runId: string, actionId: string): Digest {
  return sha256Digest(`${workspaceId}${runId}${actionId}`);
}

function parseScope(value: unknown): RethinkActionPayloadV2["scope"] {
  if (!isObject(value)) fail("payload.scope must be an object");
  exactKeys(value, ["level", "subject"]);
  if (!["person", "domain", "workspace", "company"].includes(String(value.level))) fail("payload.scope.level is invalid");
  return {
    level: value.level as AdaptationScope["level"],
    subject: stringField(value.subject, "payload.scope.subject", 300),
  };
}

function parseAuthorization(value: unknown): HandoffAuthorizationResultV1 {
  if (!isObject(value)) fail("payload.authorizationResult must be an object");
  exactKeys(value, ["status", "principalId", "grantId", "registryRevision", "registryDigest", "reason"]);
  if (!["authorized", "review_required", "denied"].includes(String(value.status))) fail("authorization status is invalid");
  if (value.principalId !== null) stringField(value.principalId, "authorization principalId", 300);
  if (value.grantId !== null) stringField(value.grantId, "authorization grantId", 300);
  return {
    status: value.status as HandoffAuthorizationResultV1["status"],
    principalId: value.principalId as string | null,
    grantId: value.grantId as string | null,
    registryRevision: integerField(value.registryRevision, "authorization registryRevision"),
    registryDigest: stringField(value.registryDigest, "authorization registryDigest", 71, DIGEST_RE) as Digest,
    reason: stringField(value.reason, "authorization reason", 1000),
  };
}

function parsePayload(value: unknown, actionType: RethinkActionType): RethinkActionPayloadV2 {
  if (!isObject(value)) fail("action payload must be an object");
  exactKeys(value, [
    "sourceSignals", "scope", "risk", "rationale", "expectedImprovement", "costOfInaction",
    "rollbackRef", "expectedRuleRevision", "authorizationResult", "policyVersion", "reviewDisposition",
  ], ["ruleId", "rule"]);
  if (!Array.isArray(value.sourceSignals) || value.sourceSignals.length < 1 || value.sourceSignals.length > 50) fail("sourceSignals is invalid");
  const sourceSignals = value.sourceSignals.map((id) => stringField(id, "sourceSignal", 36, UUID_RE));
  if (new Set(sourceSignals).size !== sourceSignals.length) fail("sourceSignals must be unique");
  const scope = parseScope(value.scope);
  if (!["low", "medium", "high"].includes(String(value.risk))) fail("payload.risk is invalid");
  if (value.policyVersion !== 1) fail("payload.policyVersion must equal 1");
  if (!["auto_apply", "review_required", "reject"].includes(String(value.reviewDisposition))) fail("reviewDisposition is invalid");
  const ruleId = value.ruleId == null ? null : stringField(value.ruleId, "payload.ruleId", 36, UUID_RE);
  const rule = value.rule == null ? null : stringField(value.rule, "payload.rule", 4000);
  const expectedRuleRevision = value.expectedRuleRevision == null
    ? null
    : integerField(value.expectedRuleRevision, "expectedRuleRevision");
  if (actionType === "propose_rule" && (!rule || ruleId || expectedRuleRevision !== null)) fail("propose_rule requires rule and null ruleId/revision");
  if (actionType !== "propose_rule" && (!ruleId || expectedRuleRevision === null)) fail(`${actionType} requires ruleId and expectedRuleRevision`);
  if (actionType === "supersede_rule" && !rule) fail("supersede_rule requires replacement rule text");
  return {
    ruleId,
    rule,
    sourceSignals,
    scope,
    risk: value.risk as AdaptationRisk,
    rationale: stringField(value.rationale, "payload.rationale", 2000),
    expectedImprovement: stringField(value.expectedImprovement, "payload.expectedImprovement", 2000),
    costOfInaction: stringField(value.costOfInaction, "payload.costOfInaction", 2000),
    rollbackRef: stringField(value.rollbackRef, "payload.rollbackRef", 500),
    expectedRuleRevision,
    authorizationResult: parseAuthorization(value.authorizationResult),
    policyVersion: 1,
    reviewDisposition: value.reviewDisposition as ReviewDisposition,
  };
}

function parseAction(value: unknown, evaluationId: string, ordinal: number): RethinkActionV2 {
  if (!isObject(value)) fail("action must be an object");
  exactKeys(value, ["type", "actionId", "payload"]);
  if (!RETHINK_ACTION_TYPES.includes(value.type as RethinkActionType)) fail("action type is unsupported");
  const action: RethinkActionV2 = {
    type: value.type as RethinkActionType,
    actionId: stringField(value.actionId, "actionId", 71, DIGEST_RE) as Digest,
    payload: parsePayload(value.payload, value.type as RethinkActionType),
  };
  if (action.actionId !== computeActionId(evaluationId, ordinal, action)) fail(`actionId mismatch at ordinal ${ordinal}`);
  return action;
}

export function parseRethinkHandoffV2(raw: string | Uint8Array, expected: ExpectedHandoffV2, observedPath: string): RethinkHandoffV2 {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
  if (bytes > RETHINK_HANDOFF_MAX_BYTES) throw new HandoffValidationError("schema_invalid", "handoff exceeds 256 KiB");
  if (resolve(observedPath) !== resolve(expected.expectedHandoffPath)) throw new HandoffValidationError("correlation_mismatch", "handoff path mismatch");
  let value: unknown;
  try { value = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8")); }
  catch { throw new HandoffValidationError("schema_invalid", "handoff is not valid JSON"); }
  if (!isObject(value)) fail("handoff must be an object");
  exactKeys(value, [
    "schema", "batchId", "workspaceId", "evaluationId", "runId", "phase", "attempt",
    "policyVersion", "contextDigest", "handoffDigest", "createdAt", "actions",
  ]);
  const handoff: RethinkHandoffV2 = {
    schema: value.schema as typeof RETHINK_HANDOFF_SCHEMA,
    batchId: stringField(value.batchId, "batchId", 300, /^nightly-[A-Za-z0-9:._+-]+$/),
    workspaceId: stringField(value.workspaceId, "workspaceId", 64, WORKSPACE_RE),
    evaluationId: stringField(value.evaluationId, "evaluationId", 36, UUID_RE),
    runId: stringField(value.runId, "runId", 36, UUID_RE),
    phase: value.phase as "hb-rethink",
    attempt: integerField(value.attempt, "attempt"),
    policyVersion: value.policyVersion as 1,
    contextDigest: stringField(value.contextDigest, "contextDigest", 71, DIGEST_RE) as Digest,
    handoffDigest: stringField(value.handoffDigest, "handoffDigest", 71, DIGEST_RE) as Digest,
    createdAt: stringField(value.createdAt, "createdAt", 100),
    actions: [],
  };
  if (handoff.schema !== RETHINK_HANDOFF_SCHEMA) fail("handoff schema is unsupported");
  if (handoff.phase !== "hb-rethink") fail("phase must equal hb-rethink");
  if (handoff.policyVersion !== RETHINK_POLICY_VERSION) fail("policyVersion must equal 1");
  if (!Number.isFinite(Date.parse(handoff.createdAt))) fail("createdAt is invalid");
  if (!Array.isArray(value.actions) || value.actions.length > RETHINK_HANDOFF_MAX_ACTIONS) fail("actions is invalid");
  handoff.actions = value.actions.map((action, ordinal) => parseAction(action, handoff.evaluationId, ordinal));
  if (new Set(handoff.actions.map((action) => action.actionId)).size !== handoff.actions.length) fail("actionIds must be unique");
  if (handoff.handoffDigest !== computeHandoffDigest(handoff)) fail("handoffDigest mismatch");
  const correlations: Array<[keyof ExpectedHandoffV2, unknown, unknown]> = [
    ["batchId", handoff.batchId, expected.batchId],
    ["workspaceId", handoff.workspaceId, expected.workspaceId],
    ["evaluationId", handoff.evaluationId, expected.evaluationId],
    ["runId", handoff.runId, expected.runId],
    ["phase", handoff.phase, expected.phase],
    ["attempt", handoff.attempt, expected.attempt],
    ["policyVersion", handoff.policyVersion, expected.policyVersion],
    ["contextDigest", handoff.contextDigest, expected.contextDigest],
  ];
  const mismatch = correlations.find(([, actual, wanted]) => actual !== wanted);
  if (mismatch) throw new HandoffValidationError("correlation_mismatch", `${String(mismatch[0])} mismatch`);
  return handoff;
}

export function buildRethinkProposalPrompt(input: {
  contextSnapshot: unknown;
  expected: ExpectedHandoffV2;
  policyBoundaries?: readonly string[];
  emptyHandoffWriterPath?: string;
}): string {
  const target = resolve(input.expected.expectedHandoffPath);
  const snapshot = canonicalizeJcs(input.contextSnapshot);
  const boundaries = input.policyBoundaries || [
    "proposal-only: do not edit files except the exact handoff target; never activate rules, send messages, or perform external actions",
    "use only the frozen context snapshot and listed source signal IDs",
    "company, legal, safety, privacy, security, permission, and external-action changes require review",
    "never propose AGENTS.md, SOUL.md, skill, source-code, infrastructure, experiment, rethink2, or autoresearch changes",
  ];
  const emptyWriter = input.emptyHandoffWriterPath
    ? [
        "If the frozen context has no eligible authorized UUID source signal, actions MUST be empty.",
        "For an empty-actions response, execute this exact helper command; it is the only permitted file write:",
        [
          "bun", input.emptyHandoffWriterPath,
          "--target", target,
          "--workspace", resolve(target, "../../../../.."),
          "--batch-id", input.expected.batchId,
          "--workspace-id", input.expected.workspaceId,
          "--evaluation-id", input.expected.evaluationId,
          "--run-id", input.expected.runId,
          "--attempt", String(input.expected.attempt),
          "--context-digest", input.expected.contextDigest,
        ].map((value) => JSON.stringify(value)).join(" "),
      ]
    : [];
  return [
    "You are hb-rethink. Produce exactly one oll.rethink-handoff.v2 JSON object at the exact target and no prose.",
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
    })}`,
    `Allowed actions: ${RETHINK_ACTION_TYPES.join(", ")}`,
    "Policy boundaries:",
    ...boundaries.map((boundary) => `- ${boundary}`),
    "Every actionId and handoffDigest must follow the JCS/SHA-256 contract. Unknown fields are rejected.",
    ...emptyWriter,
    `Immutable context snapshot (JCS): ${snapshot}`,
  ].join("\n");
}
