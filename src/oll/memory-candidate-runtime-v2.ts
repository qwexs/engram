import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import {
  authorizeAdaptationAction,
  loadActorRegistry,
  type AdaptationRisk,
  type TrustedActorContext,
} from "./authorization";
import { activateCandidateRuleOptimistically } from "./adaptation-store";
import {
  MEMORY_CANDIDATE_APPLY_PLAN_V1_SCHEMA,
  MEMORY_CANDIDATE_EFFECT_V1_SCHEMA,
  MEMORY_CANDIDATE_RESERVATION_V1_SCHEMA,
  candidateApplyPlanId,
  candidateEffectId,
  candidateEffectPayloadDigest,
  candidateReservationId,
  candidateReviewOutcomeId,
  scopeContains,
  validateCandidateApplyPlanV1,
  validateCandidateReviewOutcomeV1,
  type CandidateApplyPlanV1,
  type CandidatePlannedEffectV1,
  type CandidateReservationV1,
  type CandidateReviewOutcomeV1,
  type CandidateScope,
  type CandidateScopeRegistryV1,
} from "./memory-candidate-contracts-v2";
import {
  applyCandidateReviewOutcomeV1,
  dispositionCandidateV1,
  markCandidateReviewPendingV1,
  markCandidateOptimisticAppliedV1,
  memoryCandidateStoreRootV1,
  readCandidateProjectionV1,
  releaseCandidateReservationV1,
  reserveCandidateV1,
} from "./memory-candidate-store-v2";
import { canonicalizeJcs, sha256Digest, type Digest } from "./handoff-v2";
import { computeActionIdV3, computeHandoffDigestV3, type RethinkActionV3, type RethinkHandoffV3 } from "./handoff-v3";

const PLAN_WAL_SCHEMA = "oll.memory-candidate-plan-wal.v1" as const;
const RULE_PROPOSAL_SCHEMA = "oll.memory-candidate-rule-proposal.v1" as const;
const REVIEW_SCHEMA = "oll.memory-candidate-review.v1" as const;
const CONTEXT_SCHEMA = "oll.memory-candidate-context.v2" as const;
const REVISION_RE = /^(\d{8})\.json$/;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function inside(parent: string, child: string): boolean {
  const relative = child.slice(parent.length);
  return child === parent || (child.startsWith(`${parent}${sep}`) && !relative.includes(`..${sep}`));
}

function ensureDirectory(path: string): void {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    invariant(stat.isDirectory() && !stat.isSymbolicLink(), `runtime path is not a plain directory: ${current}`);
  }
}

function runtimeRoot(workspace: string): string {
  const workspaceRoot = realpathSync(resolve(workspace));
  const root = join(memoryCandidateStoreRootV1(workspaceRoot), "runtime-v1");
  invariant(inside(workspaceRoot, root), "candidate runtime root escapes workspace");
  for (const child of ["plans", "rule-proposals", "reviews", "review-outcomes", "quarantine"]) ensureDirectory(join(root, child));
  return root;
}

function readJson<T>(path: string): T {
  const stat = lstatSync(path);
  invariant(stat.isFile() && !stat.isSymbolicLink(), `runtime artifact is not a plain file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeNoReplace(path: string, value: unknown): void {
  ensureDirectory(dirname(path));
  const bytes = `${canonicalizeJcs(value)}\n`;
  if (existsSync(path)) {
    invariant(readFileSync(path, "utf8") === bytes, `runtime artifact payload conflict: ${path}`);
    return;
  }
  const temporary = join(dirname(path), `.${path.split(sep).at(-1)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, bytes, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (existsSync(path) && readFileSync(path, "utf8") === bytes) return;
      throw error;
    }
    fsyncDirectory(dirname(path));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function digestName(value: Digest): string { return value.slice("sha256:".length); }

interface PlanWalEntryV1 {
  schema: typeof PLAN_WAL_SCHEMA;
  planId: Digest;
  revision: number;
  previousEntryDigest: Digest | null;
  plan: CandidateApplyPlanV1;
  entryDigest: Digest;
}

function walEntryDigest(entry: Omit<PlanWalEntryV1, "entryDigest"> | PlanWalEntryV1): Digest {
  const { entryDigest: _ignored, ...base } = entry as PlanWalEntryV1;
  return sha256Digest(canonicalizeJcs(base));
}

function planDirectory(root: string, planId: Digest): string { return join(root, "plans", digestName(planId)); }

function readPlanWal(root: string, planId: Digest, context: PlanValidationContext): PlanWalEntryV1[] {
  const directory = planDirectory(root, planId);
  if (!existsSync(directory)) return [];
  const names = readdirSync(directory).filter((name) => REVISION_RE.test(name)).sort();
  const entries: PlanWalEntryV1[] = [];
  for (const [index, name] of names.entries()) {
    invariant(Number(REVISION_RE.exec(name)![1]) === index + 1, "candidate plan WAL has a revision gap");
    const entry = readJson<PlanWalEntryV1>(join(directory, name));
    invariant(entry.schema === PLAN_WAL_SCHEMA && entry.planId === planId && entry.revision === index + 1, "candidate plan WAL correlation mismatch");
    invariant(entry.previousEntryDigest === (entries.at(-1)?.entryDigest || null), "candidate plan WAL hash chain mismatch");
    invariant(entry.entryDigest === walEntryDigest(entry), "candidate plan WAL digest mismatch");
    validateCandidateApplyPlanV1(entry.plan, context);
    entries.push(entry);
  }
  return entries;
}

interface PlanValidationContext {
  scopeRegistry: CandidateScopeRegistryV1;
  candidateScopes: Record<string, CandidateScope>;
}

function appendPlan(root: string, plan: CandidateApplyPlanV1, context: PlanValidationContext): CandidateApplyPlanV1 {
  validateCandidateApplyPlanV1(plan, context);
  const entries = readPlanWal(root, plan.planId, context);
  const latest = entries.at(-1);
  if (latest && canonicalizeJcs(latest.plan) === canonicalizeJcs(plan)) return latest.plan;
  const base: Omit<PlanWalEntryV1, "entryDigest"> = {
    schema: PLAN_WAL_SCHEMA,
    planId: plan.planId,
    revision: entries.length + 1,
    previousEntryDigest: latest?.entryDigest || null,
    plan,
  };
  const entry = { ...base, entryDigest: walEntryDigest(base) };
  writeNoReplace(join(planDirectory(root, plan.planId), `${String(entry.revision).padStart(8, "0")}.json`), entry);
  return plan;
}

export interface CandidateContextV2 {
  schema: typeof CONTEXT_SCHEMA;
  batchId: string;
  workspaceId: string;
  snapshotAt: string;
  candidateRevisions: Record<string, number>;
  candidates: Array<{
    candidateId: Digest;
    revision: number;
    evidenceSetDigest: Digest;
    effectiveScope: CandidateScope;
    canonicalStatement: string;
  }>;
  contextDigest: Digest;
}

export function buildCandidateContextV2(options: {
  workspace: string;
  workspaceId: string;
  batchId: string;
  snapshotAt: string;
  candidateIds: Digest[];
}): CandidateContextV2 {
  const candidates = [...new Set(options.candidateIds)].sort().map((candidateId) => {
    const projection = readCandidateProjectionV1({ workspace: options.workspace, workspaceId: options.workspaceId, candidateId });
    invariant(projection && projection.cluster.lifecycle.status === "pending" && projection.reservation === null, "candidate context requires an unreserved pending projection");
    return {
      candidateId,
      revision: projection.highestContiguousRevision,
      evidenceSetDigest: projection.cluster.evidenceSetDigest,
      effectiveScope: projection.cluster.effectiveScope,
      canonicalStatement: projection.cluster.canonicalStatement,
    };
  });
  const candidateRevisions = Object.fromEntries(candidates.map((candidate) => [candidate.candidateId, candidate.revision]));
  const base = { schema: CONTEXT_SCHEMA, batchId: options.batchId, workspaceId: options.workspaceId, snapshotAt: options.snapshotAt, candidateRevisions, candidates };
  return { ...base, contextDigest: sha256Digest(canonicalizeJcs(base)) };
}

function candidateScope(action: RethinkActionV3): CandidateScope {
  const scope = action.payload.scope;
  if (scope.level === "person") return { level: "self", subject: scope.subject };
  if (scope.level === "domain") return { level: "domain", subject: scope.subject };
  if (scope.level === "workspace") return { level: "workspace", subject: scope.subject };
  throw new Error("company-scoped candidate actions are outside the workspace candidate contract");
}

function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return canonicalizeJcs([...left].sort()) === canonicalizeJcs([...right].sort());
}

function buildEffects(operationId: Digest, action: RethinkActionV3, revisions: Record<string, number>, optimisticApply: boolean): CandidatePlannedEffectV1[] {
  invariant(action.type === "propose_rule" && action.payload.rule, "candidate evidence may only produce a rule proposal");
  const effectiveScope = candidateScope(action);
  const ruleId = `candidate-${action.actionId.slice("sha256:".length, "sha256:".length + 32)}`;
  const reviewId = sha256Digest(canonicalizeJcs({ schema: REVIEW_SCHEMA, operationId, actionId: action.actionId, ruleId }));
  const proposalBase: Omit<Extract<CandidatePlannedEffectV1, { type: "rule_proposal" }>, "effectId"> = {
    schema: MEMORY_CANDIDATE_EFFECT_V1_SCHEMA,
    actionId: action.actionId,
    candidateRevisions: revisions,
    effectiveScope,
    type: "rule_proposal",
    payload: { ruleId, ruleText: action.payload.rule, ruleTextDigest: sha256Digest(action.payload.rule), reviewRequired: !optimisticApply },
  };
  const proposal = { ...proposalBase, effectId: candidateEffectId(proposalBase as CandidatePlannedEffectV1) } as CandidatePlannedEffectV1;
  if (optimisticApply) return [proposal];
  const reviewBase: Omit<Extract<CandidatePlannedEffectV1, { type: "mandatory_review" }>, "effectId"> = {
    schema: MEMORY_CANDIDATE_EFFECT_V1_SCHEMA,
    actionId: action.actionId,
    candidateRevisions: revisions,
    effectiveScope,
    type: "mandatory_review",
    payload: {
      reviewId,
      operationId,
      ruleId,
      expectedReviewRevision: 1,
      requiredAction: "rule:approve",
      requiredGrant: "rule:approve",
      registryRevision: action.payload.authorizationResult.registryRevision,
      registryDigest: action.payload.authorizationResult.registryDigest,
      assignedReviewer: null,
    },
  };
  const review = { ...reviewBase, effectId: candidateEffectId(reviewBase as CandidatePlannedEffectV1) } as CandidatePlannedEffectV1;
  return [proposal, review];
}

function buildPlan(options: {
  workspace: string;
  workspaceId: string;
  handoff: RethinkHandoffV3;
  scopeRegistry: CandidateScopeRegistryV1;
  now: string;
  optimisticApply?: boolean;
}): { plan: CandidateApplyPlanV1; context: PlanValidationContext } | null {
  invariant(options.handoff.workspaceId === options.workspaceId, "candidate handoff workspace mismatch");
  invariant(options.handoff.handoffDigest === computeHandoffDigestV3(options.handoff), "candidate handoff digest mismatch");
  invariant(options.handoff.actions.every((action, ordinal) => action.actionId === computeActionIdV3(options.handoff.evaluationId, ordinal, action)), "candidate handoff action identity mismatch");
  invariant(new Set(options.handoff.candidateDispositions.map((entry) => entry.candidateId)).size === options.handoff.candidateDispositions.length, "candidate dispositions must be unique");
  const consumed = options.handoff.candidateDispositions.filter((entry) => entry.disposition === "consumed");
  if (!consumed.length) return null;
  const consumedIds = consumed.map((entry) => entry.candidateId).sort();
  const actions = options.handoff.actions.filter((action) => action.payload.sourceCandidates.length > 0);
  invariant(actions.length === 1 && actions.every((action) => equalIds(action.payload.sourceCandidates, consumedIds)), "Phase 4 candidate applicator requires one candidate-derived action citing the exact consumed set");
  invariant(options.handoff.actions.every((action) => action.payload.sourceCandidates.length > 0), "isolated candidate applicator rejects mixed legacy actions");
  const candidateRevisions = Object.fromEntries(consumed.sort((a, b) => a.candidateId.localeCompare(b.candidateId)).map((entry) => [entry.candidateId, entry.expectedRevision]));
  const candidateScopes: Record<string, CandidateScope> = {};
  const evidenceDigests: Record<string, Digest> = {};
  for (const [candidateId, expectedRevision] of Object.entries(candidateRevisions)) {
    const projection = readCandidateProjectionV1({ workspace: options.workspace, workspaceId: options.workspaceId, candidateId: candidateId as Digest });
    invariant(projection && projection.highestContiguousRevision >= expectedRevision, "candidate apply plan revision is unavailable");
    candidateScopes[candidateId] = projection.cluster.effectiveScope;
    evidenceDigests[candidateId] = projection.cluster.evidenceSetDigest;
  }
  const operationId = sha256Digest(canonicalizeJcs({ schema: "oll.memory-candidate-apply-operation.v1", handoffDigest: options.handoff.handoffDigest, candidateRevisions }));
  const effects = actions.flatMap((action) => buildEffects(operationId, action, candidateRevisions, options.optimisticApply === true));
  const prePlan = {
    schema: MEMORY_CANDIDATE_APPLY_PLAN_V1_SCHEMA,
    planId: sha256Digest("candidate-plan-placeholder"),
    operationId,
    batchId: options.handoff.batchId,
    workspaceId: options.workspaceId,
    contextDigest: options.handoff.contextDigest,
    handoffDigest: options.handoff.handoffDigest,
    candidateRevisions,
    reservations: [],
    effects,
    effectCommits: Object.fromEntries(effects.map((effect) => [effect.effectId, { payloadDigest: candidateEffectPayloadDigest(effect), status: "pending" as const, committedAt: null }])),
    status: "intent_recorded" as const,
    reasonCode: "admitted" as const,
    createdAt: options.now,
    updatedAt: options.now,
  };
  const planId = candidateApplyPlanId(prePlan as CandidateApplyPlanV1);
  const reservations = Object.entries(candidateRevisions).map(([candidateId, expectedRevision]) => {
    const base = { planId, candidateId: candidateId as Digest, expectedRevision, evidenceSetDigest: evidenceDigests[candidateId] };
    return {
      schema: MEMORY_CANDIDATE_RESERVATION_V1_SCHEMA,
      reservationId: candidateReservationId(base),
      ...base,
      status: "held" as const,
      reasonCode: "reservation_acquired" as const,
      createdAt: options.now,
      updatedAt: options.now,
    };
  });
  const plan = { ...prePlan, planId, reservations } as CandidateApplyPlanV1;
  const context = { scopeRegistry: options.scopeRegistry, candidateScopes };
  validateCandidateApplyPlanV1(plan, context);
  for (const effect of effects) for (const candidateId of Object.keys(candidateRevisions)) {
    invariant(scopeContains(options.scopeRegistry, candidateScopes[candidateId], effect.effectiveScope), "candidate action scope exceeds candidate scope");
  }
  return { plan, context };
}

export class CandidateApplySimulatedCrash extends Error {}
export class CandidateReviewSimulatedCrash extends Error {}

export type CandidateApplyFaultPoint =
  | "after_plan_intent"
  | "after_first_reservation"
  | "after_all_reservations"
  | "after_effect_publication"
  | "after_effect_commit"
  | "after_review_pending";

interface RuleProposalRecordV1 {
  schema: typeof RULE_PROPOSAL_SCHEMA;
  operationId: Digest;
  actionId: Digest;
  ruleId: string;
  ruleText: string;
  ruleTextDigest: Digest;
  candidateRevisions: Record<string, number>;
  effectiveScope: CandidateScope;
  risk: AdaptationRisk;
  status: "proposed";
  reviewRequired: boolean;
  createdAt: string;
}

interface CandidateReviewRecordV1 {
  schema: typeof REVIEW_SCHEMA;
  reviewId: Digest;
  revision: number;
  planId: Digest;
  operationId: Digest;
  actionId: Digest;
  ruleId: string;
  candidateRevisions: Record<string, number>;
  effectiveScope: CandidateScope;
  risk: AdaptationRisk;
  requiredAction: "rule:approve";
  requiredGrant: "rule:approve";
  registryRevision: number;
  registryDigest: Digest;
  assignedReviewer: null;
  status: "pending" | "approved" | "rejected" | "expired";
  outcomeId: Digest | null;
  updatedAt: string;
}

function proposalPath(root: string, effect: Extract<CandidatePlannedEffectV1, { type: "rule_proposal" }>): string {
  return join(root, "rule-proposals", `${effect.payload.ruleId}.json`);
}

function reviewPath(root: string, reviewId: Digest, revision: number): string {
  return join(root, "reviews", digestName(reviewId), `${String(revision).padStart(8, "0")}.json`);
}

function effectArtifactExists(root: string, effect: CandidatePlannedEffectV1): boolean {
  return effect.type === "rule_proposal"
    ? existsSync(proposalPath(root, effect))
    : existsSync(reviewPath(root, effect.payload.reviewId, effect.payload.expectedReviewRevision));
}

function publishEffect(root: string, plan: CandidateApplyPlanV1, effect: CandidatePlannedEffectV1, handoff: RethinkHandoffV3, now: string): void {
  const action = handoff.actions.find((entry) => entry.actionId === effect.actionId)!;
  invariant(action, "planned effect action is missing from handoff");
  if (effect.type === "rule_proposal") {
    const record: RuleProposalRecordV1 = {
      schema: RULE_PROPOSAL_SCHEMA,
      operationId: plan.operationId,
      actionId: effect.actionId,
      ruleId: effect.payload.ruleId,
      ruleText: effect.payload.ruleText,
      ruleTextDigest: effect.payload.ruleTextDigest,
      candidateRevisions: effect.candidateRevisions,
      effectiveScope: effect.effectiveScope,
      risk: action.payload.risk,
      status: "proposed",
      reviewRequired: effect.payload.reviewRequired,
      createdAt: plan.createdAt,
    };
    writeNoReplace(proposalPath(root, effect), record);
  } else {
    const record: CandidateReviewRecordV1 = {
      schema: REVIEW_SCHEMA,
      reviewId: effect.payload.reviewId,
      revision: 1,
      planId: plan.planId,
      operationId: plan.operationId,
      actionId: effect.actionId,
      ruleId: effect.payload.ruleId,
      candidateRevisions: Object.fromEntries(Object.entries(effect.candidateRevisions).map(([id, revision]) => [id, revision + 2])),
      effectiveScope: effect.effectiveScope,
      risk: action.payload.risk,
      requiredAction: "rule:approve",
      requiredGrant: "rule:approve",
      registryRevision: effect.payload.registryRevision,
      registryDigest: effect.payload.registryDigest,
      assignedReviewer: null,
      status: "pending",
      outcomeId: null,
      updatedAt: plan.createdAt,
    };
    writeNoReplace(reviewPath(root, effect.payload.reviewId, 1), record);
  }
}

function updatePlan(plan: CandidateApplyPlanV1, patch: Partial<CandidateApplyPlanV1>, now: string): CandidateApplyPlanV1 {
  return { ...plan, ...patch, planId: plan.planId, updatedAt: now };
}

export function applyCandidateHandoffV3(options: {
  workspace: string;
  workspaceId: string;
  handoff: RethinkHandoffV3;
  scopeRegistry: CandidateScopeRegistryV1;
  now: string;
  optimisticApply?: boolean;
  stateRoot?: string;
  notificationSession?: string;
  liveRevalidate: (input: { plan: CandidateApplyPlanV1; candidateScopes: Readonly<Record<string, CandidateScope>> }) => void;
  faultInjector?: (point: CandidateApplyFaultPoint) => void;
}): CandidateApplyPlanV1 | null {
  const built = buildPlan(options);
  const root = runtimeRoot(options.workspace);
  if (!built) {
    for (const disposition of options.handoff.candidateDispositions) {
      const projection = readCandidateProjectionV1({ workspace: options.workspace, workspaceId: options.workspaceId, candidateId: disposition.candidateId });
      invariant(projection?.highestContiguousRevision === disposition.expectedRevision
        && projection.cluster.lifecycle.status === "pending"
        && projection.reservation === null, "new candidate handoff requires exact pending disposition revisions");
    }
    for (const disposition of options.handoff.candidateDispositions) dispositionCandidateV1({
      workspace: options.workspace, workspaceId: options.workspaceId, candidateId: disposition.candidateId,
      expectedRevision: disposition.expectedRevision, disposition: disposition.disposition === "ignored" ? "ignored" : "deferred",
      correlationId: options.handoff.handoffDigest, now: options.now,
    });
    return null;
  }
  const { context } = built;
  const existing = readPlanWal(root, built.plan.planId, context).at(-1)?.plan;
  if (!existing) for (const disposition of options.handoff.candidateDispositions) {
    const projection = readCandidateProjectionV1({ workspace: options.workspace, workspaceId: options.workspaceId, candidateId: disposition.candidateId });
    invariant(projection?.highestContiguousRevision === disposition.expectedRevision
      && projection.cluster.lifecycle.status === "pending"
      && projection.reservation === null, "new candidate apply plan requires exact pending disposition revisions");
  }
  let plan = existing || appendPlan(root, built.plan, context);
  if (plan.status === "terminal") return plan;
  invariant(!["quarantined", "cancelled"].includes(plan.status), `candidate apply plan is ${plan.status}`);
  options.faultInjector?.("after_plan_intent");
  if (plan.status === "intent_recorded") plan = appendPlan(root, updatePlan(plan, { status: "reserving", reasonCode: "reservation_acquired" }, options.now), context);
  let anyEffect = Object.values(plan.effectCommits).some((commit) => commit.status === "committed") || plan.effects.some((effect) => effectArtifactExists(root, effect));
  try {
    for (const [index, reservation] of plan.reservations.entries()) {
      const projection = readCandidateProjectionV1({ workspace: options.workspace, workspaceId: options.workspaceId, candidateId: reservation.candidateId });
      if (!(projection?.cluster.lifecycle.status === "review_pending" && projection.cluster.lifecycle.reservationOwner === plan.planId)) {
        reserveCandidateV1({
          workspace: options.workspace,
          workspaceId: options.workspaceId,
          planId: plan.planId,
          candidateId: reservation.candidateId,
          expectedRevision: reservation.expectedRevision,
          evidenceSetDigest: reservation.evidenceSetDigest,
          now: reservation.createdAt,
        });
      }
      if (index === 0) options.faultInjector?.("after_first_reservation");
    }
    options.faultInjector?.("after_all_reservations");
    const effectsAlreadyCommitted = Object.values(plan.effectCommits).every((commit) => commit.status === "committed");
    if (!effectsAlreadyCommitted) {
      invariant(typeof options.liveRevalidate === "function", "candidate pre-effect live revalidation is required");
      options.liveRevalidate({ plan, candidateScopes: context.candidateScopes });
    }
    for (const reservation of plan.reservations) {
      const projection = readCandidateProjectionV1({ workspace: options.workspace, workspaceId: options.workspaceId, candidateId: reservation.candidateId });
      const allowedStatus = effectsAlreadyCommitted ? ["reserved", "review_pending"] : ["reserved"];
      invariant(projection && allowedStatus.includes(projection.cluster.lifecycle.status)
        && projection.cluster.lifecycle.reservationOwner === plan.planId
        && projection.reservation?.evidenceSetDigest === reservation.evidenceSetDigest, "candidate drifted after pre-effect revalidation");
    }
    if (plan.status === "reserving") plan = appendPlan(root, updatePlan(plan, { status: "applying", reasonCode: "reservation_acquired" }, options.now), context);
    for (const effect of plan.effects) {
      if (plan.effectCommits[effect.effectId].status === "committed") continue;
      publishEffect(root, plan, effect, options.handoff, options.now);
      anyEffect = true;
      options.faultInjector?.("after_effect_publication");
      plan = appendPlan(root, updatePlan(plan, {
        status: "applying",
        reasonCode: effect.type === "mandatory_review" ? "review_created" : "reservation_acquired",
        effectCommits: { ...plan.effectCommits, [effect.effectId]: { ...plan.effectCommits[effect.effectId], status: "committed", committedAt: options.now } },
      }, options.now), context);
      options.faultInjector?.("after_effect_commit");
    }
    const review = plan.effects.find((effect): effect is Extract<CandidatePlannedEffectV1, { type: "mandatory_review" }> => effect.type === "mandatory_review");
    if (options.optimisticApply === true) {
      invariant(!review && options.stateRoot && options.notificationSession, "optimistic candidate apply requires stateRoot and notificationSession");
      const proposal = plan.effects.find((effect): effect is Extract<CandidatePlannedEffectV1, { type: "rule_proposal" }> => effect.type === "rule_proposal");
      invariant(proposal && proposal.payload.reviewRequired === false, "optimistic candidate apply requires a no-review proposal");
      const action = options.handoff.actions.find((entry) => entry.actionId === proposal.actionId)!;
      const scope = proposal.effectiveScope.level === "self"
        ? { level: "person" as const, subject: proposal.effectiveScope.subject }
        : { level: proposal.effectiveScope.level, subject: proposal.effectiveScope.subject };
      activateCandidateRuleOptimistically({
        workspace: options.workspace,
        stateRoot: options.stateRoot,
        scope,
        rule: proposal.payload.ruleText,
        sourceCandidates: Object.keys(proposal.candidateRevisions),
        expectedImprovement: action.payload.expectedImprovement || "Применять подтверждённый памятью рабочий паттерн последовательно.",
        costOfInaction: action.payload.costOfInaction || "Повторение ранее выявленной ошибки или непоследовательности.",
        rollbackRef: `candidate-plan:${plan.planId}`,
        runId: options.handoff.runId,
        actionId: proposal.actionId,
        operationId: plan.operationId,
        planId: plan.planId,
        batchId: plan.batchId,
        notificationSession: options.notificationSession,
        now: options.now,
      });
      for (const reservation of plan.reservations) markCandidateOptimisticAppliedV1({
        workspace: options.workspace,
        workspaceId: options.workspaceId,
        planId: plan.planId,
        candidateId: reservation.candidateId,
        expectedRevision: reservation.expectedRevision + 1,
        operationId: plan.operationId,
        now: options.now,
      });
    } else {
      invariant(review, "candidate apply plan lacks mandatory review");
      for (const reservation of plan.reservations) markCandidateReviewPendingV1({
        workspace: options.workspace,
        workspaceId: options.workspaceId,
        planId: plan.planId,
        candidateId: reservation.candidateId,
        expectedRevision: reservation.expectedRevision + 1,
        reviewId: review.payload.reviewId,
        now: options.now,
      });
      options.faultInjector?.("after_review_pending");
    }
    for (const disposition of options.handoff.candidateDispositions.filter((entry) => entry.disposition !== "consumed")) dispositionCandidateV1({
      workspace: options.workspace, workspaceId: options.workspaceId, candidateId: disposition.candidateId,
      expectedRevision: disposition.expectedRevision, disposition: disposition.disposition === "ignored" ? "ignored" : "deferred",
      correlationId: options.handoff.handoffDigest, now: options.now,
    });
    plan = appendPlan(root, updatePlan(plan, {
      status: "terminal",
      reasonCode: options.optimisticApply === true ? "optimistic_apply" : "review_created",
      reservations: plan.reservations.map((reservation) => options.optimisticApply === true
        ? { ...reservation, status: "released", reasonCode: "optimistic_apply", updatedAt: options.now }
        : { ...reservation, status: "review_pending", reasonCode: "review_created", updatedAt: options.now }),
    }, options.now), context);
    return plan;
  } catch (error) {
    if (error instanceof CandidateApplySimulatedCrash) throw error;
    if (anyEffect) {
      appendPlan(root, updatePlan(plan, { status: "quarantined", reasonCode: "operator_quarantine" }, options.now), context);
    } else {
      for (const reservation of plan.reservations) {
        const projection = readCandidateProjectionV1({ workspace: options.workspace, workspaceId: options.workspaceId, candidateId: reservation.candidateId });
        if (projection?.cluster.lifecycle.status === "reserved" && projection.cluster.lifecycle.reservationOwner === plan.planId) {
          releaseCandidateReservationV1({
            workspace: options.workspace, workspaceId: options.workspaceId, planId: plan.planId,
            candidateId: reservation.candidateId, expectedRevision: reservation.expectedRevision + 1,
            to: "pending", reasonCode: "plan_cancelled_before_effect", now: options.now,
          });
        }
      }
      appendPlan(root, updatePlan(plan, {
        status: "cancelled",
        reasonCode: "plan_cancelled_before_effect",
        reservations: plan.reservations.map((reservation) => ({ ...reservation, status: "released", reasonCode: "plan_cancelled_before_effect", updatedAt: options.now })),
      }, options.now), context);
    }
    throw error;
  }
}

function readReview(root: string, reviewId: Digest): CandidateReviewRecordV1 {
  const directory = join(root, "reviews", digestName(reviewId));
  invariant(existsSync(directory), "candidate review is unavailable");
  const names = readdirSync(directory).filter((name) => REVISION_RE.test(name)).sort();
  invariant(names.length > 0 && names.every((name, index) => Number(REVISION_RE.exec(name)![1]) === index + 1), "candidate review revision gap");
  const review = readJson<CandidateReviewRecordV1>(join(directory, names.at(-1)!));
  invariant(review.schema === REVIEW_SCHEMA && review.reviewId === reviewId && review.revision === names.length, "candidate review correlation mismatch");
  return review;
}

function quarantineOutcome(root: string, outcome: CandidateReviewOutcomeV1, error: unknown): void {
  const fallbackId = sha256Digest(canonicalizeJcs(outcome));
  const outcomeId = typeof outcome?.outcomeId === "string" && /^sha256:[0-9a-f]{64}$/.test(outcome.outcomeId) ? outcome.outcomeId : fallbackId;
  const record = {
    schema: "oll.memory-candidate-review-quarantine.v1",
    outcomeId,
    payloadDigest: sha256Digest(canonicalizeJcs(outcome)),
    reasonDigest: sha256Digest(error instanceof Error ? error.message : "unknown review reconciliation error"),
    observedAt: typeof outcome?.observedAt === "string" ? outcome.observedAt : new Date(0).toISOString(),
  };
  writeNoReplace(join(root, "quarantine", `${digestName(outcomeId)}.json`), record);
}

export function reconcileCandidateReviewOutcomeV1(options: {
  workspace: string;
  workspaceId: string;
  outcome: CandidateReviewOutcomeV1;
  actorRegistryPath: string;
  actorContext: TrustedActorContext;
  faultInjector?: (point: "after_outcome_publication" | "after_candidate_transition", candidateIndex?: number) => void;
}): CandidateReviewRecordV1 {
  const root = runtimeRoot(options.workspace);
  try {
    const outcome = validateCandidateReviewOutcomeV1(options.outcome);
    invariant(outcome.outcomeId === candidateReviewOutcomeId(outcome), "candidate review outcome digest mismatch");
    invariant(String(options.actorContext.actorId) === outcome.actualActorId, "review actor/context mismatch");
    const review = readReview(root, outcome.reviewId);
    if (review.revision > outcome.expectedReviewRevision) {
      invariant(review.outcomeId === outcome.outcomeId && review.status === outcome.disposition, "conflicting replayed review outcome");
      return review;
    }
    invariant(review.status === "pending" && review.revision === outcome.expectedReviewRevision, "stale review outcome revision");
    invariant(review.operationId === outcome.operationId && review.actionId === outcome.actionId, "review outcome operation/action mismatch");
    invariant(canonicalizeJcs(review.candidateRevisions) === canonicalizeJcs(outcome.candidateRevisions), "review outcome candidate revisions mismatch");
    invariant(canonicalizeJcs(review.effectiveScope) === canonicalizeJcs(outcome.effectiveScope), "review outcome scope mismatch");
    const proposal = readJson<RuleProposalRecordV1>(join(root, "rule-proposals", `${review.ruleId}.json`));
    invariant(proposal.schema === RULE_PROPOSAL_SCHEMA
      && proposal.operationId === review.operationId
      && proposal.actionId === review.actionId
      && proposal.ruleId === review.ruleId
      && proposal.status === "proposed"
      && proposal.reviewRequired === true, "review outcome proposal correlation mismatch");
    const registry = loadActorRegistry(options.actorRegistryPath);
    const scope = outcome.effectiveScope.level === "self"
      ? { level: "person" as const, subject: outcome.effectiveScope.subject }
      : { level: outcome.effectiveScope.level, subject: outcome.effectiveScope.subject };
    const decision = authorizeAdaptationAction({
      registry,
      actorContext: options.actorContext,
      workspaceId: options.workspaceId,
      scope,
      action: "rule:approve",
      risk: review.risk,
      sourceType: "message",
    });
    invariant(decision.status === "authorized" && decision.grantId, "review actor is not currently authorized");
    invariant(decision.registryRevision === outcome.registryRevision && decision.registryDigest === outcome.registryDigest, "review outcome registry snapshot is stale");
    invariant(sha256Digest(decision.grantId) === outcome.grantDigest, "review outcome grant mismatch");
    const target = outcome.disposition === "approved" ? "evaluated" : outcome.reasonCode.endsWith("_retryable") ? "deferred" : "dismissed";
    for (const [candidateId, expectedRevision] of Object.entries(outcome.candidateRevisions)) {
      const projection = readCandidateProjectionV1({ workspace: options.workspace, workspaceId: options.workspaceId, candidateId: candidateId as Digest });
      const pending = projection?.highestContiguousRevision === expectedRevision
        && projection.cluster.lifecycle.status === "review_pending"
        && projection.cluster.lifecycle.reservationOwner === review.planId;
      const replayed = projection && projection.highestContiguousRevision > expectedRevision
        && projection.cluster.lifecycle.status === target
        && projection.cluster.lifecycle.correlationId === outcome.outcomeId;
      invariant(pending || replayed, "review outcome candidate preflight conflict");
    }
    writeNoReplace(join(root, "review-outcomes", `${digestName(outcome.outcomeId)}.json`), outcome);
    options.faultInjector?.("after_outcome_publication");
    for (const [index, [candidateId, expectedRevision]] of Object.entries(outcome.candidateRevisions).sort(([a], [b]) => a.localeCompare(b)).entries()) {
      applyCandidateReviewOutcomeV1({
        workspace: options.workspace,
        workspaceId: options.workspaceId,
        planId: review.planId,
        candidateId: candidateId as Digest,
        expectedRevision,
        outcomeId: outcome.outcomeId,
        to: target,
        reasonCode: outcome.reasonCode as Parameters<typeof applyCandidateReviewOutcomeV1>[0]["reasonCode"],
        now: outcome.observedAt,
      });
      options.faultInjector?.("after_candidate_transition", index);
    }
    const terminal: CandidateReviewRecordV1 = { ...review, revision: review.revision + 1, status: outcome.disposition, outcomeId: outcome.outcomeId, updatedAt: outcome.observedAt };
    writeNoReplace(reviewPath(root, review.reviewId, terminal.revision), terminal);
    return terminal;
  } catch (error) {
    if (error instanceof CandidateReviewSimulatedCrash) throw error;
    quarantineOutcome(root, options.outcome, error);
    throw error;
  }
}

export function candidateRuntimePathsV1(workspace: string): { root: string } {
  return { root: runtimeRoot(workspace) };
}

export type CandidateRollbackPlanPhaseV1 =
  | "pre_effect"
  | "partial_effect"
  | "review_pending"
  | "terminal"
  | "quarantined"
  | "invalid";

export interface CandidateRollbackPlanInventoryV1 {
  planId: Digest;
  phase: CandidateRollbackPlanPhaseV1;
  status: CandidateApplyPlanV1["status"] | "invalid";
  committedEffects: number;
  publishedEffects: number;
  heldReservations: number;
  pendingReviews: number;
  reasonDigest: Digest | null;
}

function planValidationContextFromLatest(options: {
  workspace: string;
  workspaceId: string;
  scopeRegistry: CandidateScopeRegistryV1;
  latest: PlanWalEntryV1;
}): PlanValidationContext {
  const candidateScopes: Record<string, CandidateScope> = {};
  for (const candidateId of Object.keys(options.latest.plan.candidateRevisions)) {
    const projection = readCandidateProjectionV1({
      workspace: options.workspace,
      workspaceId: options.workspaceId,
      candidateId: candidateId as Digest,
    });
    invariant(projection, `candidate projection is unavailable for rollback inventory: ${candidateId}`);
    candidateScopes[candidateId] = projection.cluster.effectiveScope;
  }
  return { scopeRegistry: options.scopeRegistry, candidateScopes };
}

function classifyRollbackPlan(root: string, plan: CandidateApplyPlanV1, options: {
  workspace: string;
  workspaceId: string;
}): Omit<CandidateRollbackPlanInventoryV1, "reasonDigest"> {
  const committedEffects = Object.values(plan.effectCommits).filter((entry) => entry.status === "committed").length;
  const publishedEffects = plan.effects.filter((effect) => effectArtifactExists(root, effect)).length;
  let heldReservations = 0;
  let pendingReviews = 0;
  for (const reservation of plan.reservations) {
    const projection = readCandidateProjectionV1({
      workspace: options.workspace,
      workspaceId: options.workspaceId,
      candidateId: reservation.candidateId,
    });
    if (projection?.cluster.lifecycle.reservationOwner === plan.planId && projection.cluster.lifecycle.status === "reserved") heldReservations += 1;
    if (projection?.cluster.lifecycle.reservationOwner === plan.planId && projection.cluster.lifecycle.status === "review_pending") pendingReviews += 1;
  }
  const phase: CandidateRollbackPlanPhaseV1 = plan.status === "quarantined"
    ? "quarantined"
    : pendingReviews > 0
      ? "review_pending"
      : ["cancelled", "terminal"].includes(plan.status)
        ? "terminal"
        : committedEffects > 0 || publishedEffects > 0
          ? "partial_effect"
          : "pre_effect";
  return { planId: plan.planId, phase, status: plan.status, committedEffects, publishedEffects, heldReservations, pendingReviews };
}

/**
 * Read-only inventory used by the Phase 5 rollback barrier. Invalid WALs stay
 * visible as digest-only findings; the inventory never repairs or deletes
 * candidate artifacts.
 */
export function inspectCandidateRollbackPlansV1(options: {
  workspace: string;
  workspaceId: string;
  scopeRegistry: CandidateScopeRegistryV1;
}): CandidateRollbackPlanInventoryV1[] {
  const root = join(memoryCandidateStoreRootV1(options.workspace), "runtime-v1");
  const plansRoot = join(root, "plans");
  if (!existsSync(plansRoot)) return [];
  return readdirSync(plansRoot).filter((name) => /^[0-9a-f]{64}$/.test(name)).sort().map((name) => {
    const planId = `sha256:${name}` as Digest;
    try {
      const directory = planDirectory(root, planId);
      const names = readdirSync(directory).filter((entry) => REVISION_RE.test(entry)).sort();
      invariant(names.length > 0, "candidate plan WAL is empty");
      const latest = readJson<PlanWalEntryV1>(join(directory, names.at(-1)!));
      const context = planValidationContextFromLatest({ ...options, latest });
      const plan = readPlanWal(root, planId, context).at(-1)!.plan;
      return { ...classifyRollbackPlan(root, plan, options), reasonDigest: null };
    } catch (error) {
      return {
        planId,
        phase: "invalid" as const,
        status: "invalid" as const,
        committedEffects: 0,
        publishedEffects: 0,
        heldReservations: 0,
        pendingReviews: 0,
        reasonDigest: sha256Digest(error instanceof Error ? error.message : "invalid candidate plan"),
      };
    }
  });
}

/**
 * Contains every non-terminal plan before a candidate-compiler mode rollback.
 * Plans with no published effect release only their own reservations and are
 * cancelled. Plans with any published/committed effect retain ownership and
 * become quarantined for exact-plan reconciliation.
 */
export function containCandidatePlansForRollbackV1(options: {
  workspace: string;
  workspaceId: string;
  scopeRegistry: CandidateScopeRegistryV1;
  now: string;
}): CandidateRollbackPlanInventoryV1[] {
  const before = inspectCandidateRollbackPlansV1(options);
  const root = join(memoryCandidateStoreRootV1(options.workspace), "runtime-v1");
  for (const item of before) {
    if (["invalid", "quarantined", "review_pending", "terminal"].includes(item.phase)) continue;
    const directory = planDirectory(root, item.planId);
    const names = readdirSync(directory).filter((entry) => REVISION_RE.test(entry)).sort();
    const latest = readJson<PlanWalEntryV1>(join(directory, names.at(-1)!));
    const context = planValidationContextFromLatest({ ...options, latest });
    const plan = readPlanWal(root, item.planId, context).at(-1)!.plan;
    if (item.phase === "partial_effect") {
      appendPlan(root, updatePlan(plan, { status: "quarantined", reasonCode: "operator_quarantine" }, options.now), context);
      continue;
    }
    for (const reservation of plan.reservations) {
      const projection = readCandidateProjectionV1({
        workspace: options.workspace,
        workspaceId: options.workspaceId,
        candidateId: reservation.candidateId,
      });
      if (projection?.cluster.lifecycle.status === "reserved" && projection.cluster.lifecycle.reservationOwner === plan.planId) {
        releaseCandidateReservationV1({
          workspace: options.workspace,
          workspaceId: options.workspaceId,
          planId: plan.planId,
          candidateId: reservation.candidateId,
          expectedRevision: projection.highestContiguousRevision,
          to: "pending",
          reasonCode: "plan_cancelled_before_effect",
          now: options.now,
        });
      }
    }
    appendPlan(root, updatePlan(plan, {
      status: "cancelled",
      reasonCode: "plan_cancelled_before_effect",
      reservations: plan.reservations.map((reservation) => ({
        ...reservation,
        status: "released",
        reasonCode: "plan_cancelled_before_effect",
        updatedAt: options.now,
      })),
    }, options.now), context);
  }
  return inspectCandidateRollbackPlansV1(options);
}
