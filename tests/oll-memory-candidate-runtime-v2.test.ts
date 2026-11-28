import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadActorRegistry, type TrustedActorContext } from "../src/oll/authorization";
import { computeActionIdV3, computeHandoffDigestV3, type RethinkActionV3, type RethinkHandoffV3 } from "../src/oll/handoff-v3";
import { sha256Digest, type Digest } from "../src/oll/handoff-v2";
import {
  acknowledgeRuleActivationNotification,
  listPendingRuleActivationNotifications,
  prepareRuleActivationDeliveries,
  suspendRulesFromNotification,
} from "../src/oll/adaptation-store";
import { compileMemoryCandidateReportV2 } from "../src/oll/memory-candidate-compiler-v2";
import {
  MEMORY_CANDIDATE_POLICY_V2_SCHEMA,
  MEMORY_CANDIDATE_RANKING_POLICY_V1_SCHEMA,
  MEMORY_CANDIDATE_REVIEW_OUTCOME_V1_SCHEMA,
  MEMORY_CANDIDATE_SCOPE_REGISTRY_V1_SCHEMA,
  candidateReviewOutcomeId,
  candidateScopeRegistryDigestV1,
  type CandidateReviewOutcomeV1,
  type CandidateScopeRegistryV1,
  type CandidateSourcePolicyV2,
} from "../src/oll/memory-candidate-contracts-v2";
import {
  dispositionCandidateV1,
  materializeCandidateReportV2,
  readCandidateProjectionV1,
  reserveCandidateV1,
} from "../src/oll/memory-candidate-store-v2";
import {
  CandidateApplySimulatedCrash,
  CandidateReviewSimulatedCrash,
  applyCandidateHandoffV3,
  buildCandidateContextV2,
  candidateRuntimePathsV1,
  containCandidatePlansForRollbackV1,
  inspectCandidateRollbackPlansV1,
  reconcileCandidateReviewOutcomeV1,
} from "../src/oll/memory-candidate-runtime-v2";

const roots: string[] = [];
const NOW = "2026-08-14T15:00:00.000Z";
const EVALUATION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function writeJson(path: string, value: unknown): void { write(path, `${JSON.stringify(value, null, 2)}\n`); }

function policy(): CandidateSourcePolicyV2 {
  return {
    schema: MEMORY_CANDIDATE_POLICY_V2_SCHEMA,
    mode: "materialize",
    forwardOnlySince: "2026-08-14T00:00:00Z",
    workspaceTimezone: "UTC",
    legacyTimestampParser: null,
    daily: [{ session: "main", sections: ["decisions"], scopeCeiling: { level: "workspace", subject: "main" } }],
    domains: [],
    kg: [],
    limits: {
      maxCandidatesPerRun: 20,
      maxContextBytes: 65_536,
      maxOccurrencesPerCluster: 20,
      sourceQuotas: {
        "daily-decision": 20, "daily-learning": 0, "retrieval-card": 0,
        "domain-decision": 0, "domain-proposal": 0, "kg-assertion": 0,
      },
    },
    decayPolicy: {
      schema: "oll.memory-candidate-decay-policy.v1", hotDays: 7, warmDays: 30, accessCountCap: 10,
      warmScorePenalty: 12, coldKgContribution: "provenance-only", trustedAccessEventSchema: "engram.kg-v3-access-event.v1",
    },
    rankingPolicy: {
      schema: MEMORY_CANDIDATE_RANKING_POLICY_V1_SCHEMA,
      eligibilityThreshold: 55,
      baseScores: { decision: 70, learning: 55, preference: 78, constraint: 74, proposal: 68 },
      recencyBoostMax: 10, recencyBoostPerDay: 2, distinctRootBoostPerRoot: 3, distinctRootBoostMax: 12,
    },
    sensitiveTextPolicyVersion: "privacy-v1",
  };
}

function registry(): CandidateScopeRegistryV1 {
  const base: Omit<CandidateScopeRegistryV1, "digest"> = {
    schema: MEMORY_CANDIDATE_SCOPE_REGISTRY_V1_SCHEMA,
    workspaceId: "main",
    revision: 1,
    selfToDomain: {},
    domainToWorkspace: {},
    sourceAuthorities: { daily: { main: { level: "workspace", subject: "main" } }, domains: {}, kgScopes: {} },
  };
  return { ...base, digest: candidateScopeRegistryDigestV1(base) };
}

function fixture(statementCount = 2) {
  const root = mkdtempSync(join(tmpdir(), "engram-candidate-runtime-v2-"));
  roots.push(root);
  writeJson(join(root, "engram.json"), { workspace: { id: "main" } });
  writeJson(join(root, "life", "v3", "registry.json"), { revision: 1 });
  mkdirSync(join(root, "life", "v3", "assertions"), { recursive: true });
  const statements = Array.from({ length: statementCount }, (_, index) => [
    `### 2026-08-14T10:0${index}:00Z — decision`, "", `- Candidate rule evidence ${index + 1} stays stable.`, "",
  ].join("\n"));
  write(join(root, "memory", "agent-main", "main", "2026-08-14.md"), ["# 2026-08-14", "", "## Decisions", "", ...statements].join("\n"));
  const sourcePolicy = policy();
  const scopeRegistry = registry();
  const report = compileMemoryCandidateReportV2({
    workspace: root, workspaceId: "main", policy: sourcePolicy, scopeRegistry,
    snapshotAt: "2026-08-14T12:00:00.000Z", batchId: "batch:phase4", executionMode: "materialize",
  });
  materializeCandidateReportV2({ workspace: root, workspaceId: "main", report, policy: sourcePolicy, scopeRegistry });
  const context = buildCandidateContextV2({
    workspace: root, workspaceId: "main", batchId: "nightly-2026-08-14", snapshotAt: NOW,
    candidateIds: report.candidates.map((candidate) => candidate.candidateId),
  });
  return { root, sourcePolicy, scopeRegistry, report, context };
}

function handoff(input: ReturnType<typeof fixture>): RethinkHandoffV3 {
  const sourceCandidates = Object.keys(input.context.candidateRevisions).sort() as Digest[];
  const actionBase: Omit<RethinkActionV3, "actionId"> = {
    type: "propose_rule",
    payload: {
      ruleId: null,
      rule: "Always preserve append-only candidate evidence before applying review effects.",
      sourceSignals: [],
      sourceCandidates,
      scope: { level: "workspace", subject: "main" },
      risk: "medium",
      rationale: "Repeated evidence supports a reversible rule proposal.",
      expectedImprovement: "Recovery remains deterministic.",
      costOfInaction: "A partial plan could strand candidate lifecycle.",
      rollbackRef: "Remove the still-proposed rule after review.",
      expectedRuleRevision: null,
      authorizationResult: {
        status: "review_required", principalId: null, grantId: null, registryRevision: 1,
        registryDigest: sha256Digest("model-registry-snapshot"), reason: "candidate evidence requires review",
      },
      policyVersion: 1,
      reviewDisposition: "review_required",
    },
  };
  const action = { ...actionBase, actionId: computeActionIdV3(EVALUATION_ID, 0, actionBase as RethinkActionV3) } as RethinkActionV3;
  const base: Omit<RethinkHandoffV3, "handoffDigest"> = {
    schema: "oll.rethink-handoff.v3",
    batchId: "nightly-2026-08-14",
    workspaceId: "main",
    evaluationId: EVALUATION_ID,
    runId: RUN_ID,
    phase: "hb-rethink",
    attempt: 1,
    policyVersion: 1,
    contextDigest: input.context.contextDigest,
    createdAt: NOW,
    actions: [action],
    candidateDispositions: sourceCandidates.map((candidateId) => ({
      candidateId, expectedRevision: input.context.candidateRevisions[candidateId], disposition: "consumed", rationale: "used by proposal",
    })),
  };
  return { ...base, handoffDigest: computeHandoffDigestV3(base as RethinkHandoffV3) };
}

function separateRules(input: ReturnType<typeof fixture>): RethinkHandoffV3 {
  const value = handoff(input);
  const template = value.actions[0];
  value.actions = template.payload.sourceCandidates.map((id, index) => {
    const action = { ...template, payload: { ...template.payload, sourceCandidates: [id], rule: `Keep evidence for rule ${index + 1}.` } };
    return { ...action, actionId: computeActionIdV3(value.evaluationId, index, action) };
  });
  value.handoffDigest = computeHandoffDigestV3(value);
  return value;
}

function splitDispositionHandoff(input: ReturnType<typeof fixture>): RethinkHandoffV3 {
  const original = handoff(input);
  const candidateIds = Object.keys(input.context.candidateRevisions).sort() as Digest[];
  const actionBase = { ...original.actions[0], payload: { ...original.actions[0].payload, sourceCandidates: [candidateIds[0]] } };
  const action = { ...actionBase, actionId: computeActionIdV3(EVALUATION_ID, 0, actionBase) };
  const { handoffDigest: _ignored, ...withoutDigest } = original;
  const base = {
    ...withoutDigest,
    actions: [action],
    candidateDispositions: [
      { candidateId: candidateIds[0], expectedRevision: input.context.candidateRevisions[candidateIds[0]], disposition: "consumed" as const, rationale: "used by proposal" },
      { candidateId: candidateIds[1], expectedRevision: input.context.candidateRevisions[candidateIds[1]], disposition: "deferred" as const, rationale: "needs more evidence" },
    ],
  };
  return { ...base, handoffDigest: computeHandoffDigestV3(base as RethinkHandoffV3) };
}

function actorRegistry(root: string) {
  const path = join(root, "actor-registry.json");
  writeJson(path, {
    schema: "oll.actor-registry.v1",
    revision: 7,
    principals: [{
      principalId: "sergey",
      transportBindings: [{ channel: "telegram", accountId: "default", actorId: "actor-1" }],
      grants: [{ grantId: "approve-main", workspaceId: "main", scope: "workspace", actions: ["rule:approve"], maxRisk: "high" }],
    }],
  });
  return { path, loaded: loadActorRegistry(path) };
}

const ACTOR: TrustedActorContext = {
  trusted: true, channel: "telegram", accountId: "default", actorId: "actor-1", contextKind: "direct",
};
const LIVE_REVALIDATE = () => {};

test("disposition-only replay resumes partial dismissal by the same handoff without double-writing", () => {
  const env = fixture();
  const value = handoff(env);
  value.actions = [];
  for (const item of value.candidateDispositions) item.disposition = "ignored";
  value.handoffDigest = computeHandoffDigestV3(value);
  const options = { workspace: env.root, workspaceId: "main", handoff: value, scopeRegistry: env.scopeRegistry, now: NOW, liveRevalidate: LIVE_REVALIDATE };
  const first = value.candidateDispositions[0];
  dispositionCandidateV1({ ...options, candidateId: first.candidateId, expectedRevision: first.expectedRevision,
    disposition: "ignored", correlationId: value.handoffDigest });
  expect(applyCandidateHandoffV3(options)).toBeNull();
  expect(applyCandidateHandoffV3(options)).toBeNull();
  for (const item of value.candidateDispositions) {
    expect(readCandidateProjectionV1({ ...options, candidateId: item.candidateId })?.highestContiguousRevision).toBe(item.expectedRevision + 1);
  }
  const changed = { ...value, createdAt: "2026-08-15T00:00:00Z" };
  changed.handoffDigest = computeHandoffDigestV3(changed);
  expect(() => applyCandidateHandoffV3({ ...options, handoff: changed })).toThrow("exact pending disposition revisions");
});

function pendingReview(root: string): any {
  const runtime = candidateRuntimePathsV1(root).root;
  const reviewDirectory = join(runtime, "reviews", readdirSync(join(runtime, "reviews"))[0]);
  return JSON.parse(readFileSync(join(reviewDirectory, "00000001.json"), "utf8"));
}

function outcome(input: { review: any; disposition: "approved" | "rejected" | "expired"; reasonCode: CandidateReviewOutcomeV1["reasonCode"]; registryRevision: number; registryDigest: Digest }): CandidateReviewOutcomeV1 {
  const base: Omit<CandidateReviewOutcomeV1, "outcomeId"> = {
    schema: MEMORY_CANDIDATE_REVIEW_OUTCOME_V1_SCHEMA,
    operationId: input.review.operationId,
    actionId: input.review.actionId,
    reviewId: input.review.reviewId,
    expectedReviewRevision: 1,
    actualActorId: "actor-1",
    grantDigest: sha256Digest("approve-main"),
    registryRevision: input.registryRevision,
    registryDigest: input.registryDigest,
    candidateRevisions: input.review.candidateRevisions,
    effectiveScope: input.review.effectiveScope,
    disposition: input.disposition,
    reasonCode: input.reasonCode,
    observedAt: "2026-08-14T16:00:00.000Z",
  };
  return { ...base, outcomeId: candidateReviewOutcomeId(base as CandidateReviewOutcomeV1) };
}

describe("OLL memory candidate Phase 4 runtime", () => {
  test("optimistically activates a candidate rule, queues its numbered notification, and suspends it by reply item", () => {
    const input = fixture(1);
    const stateRoot = join(input.root, "state-root");
    mkdirSync(stateRoot, { recursive: true });
    writeJson(join(input.root, "engram.json"), {
      workspace: { id: "main" },
      oll: { adaptation: { mode: "active" } },
    });
    const value = handoff(input);
    const plan = applyCandidateHandoffV3({
      workspace: input.root,
      workspaceId: "main",
      handoff: value,
      scopeRegistry: input.scopeRegistry,
      now: NOW,
      liveRevalidate: LIVE_REVALIDATE,
      optimisticApply: true,
      stateRoot,
      notificationSession: "telegram-direct-42",
    })!;
    expect(plan.status).toBe("terminal");
    expect(plan.reasonCode).toBe("optimistic_apply");
    expect(plan.effects).toHaveLength(1);
    expect(plan.effects[0].type).toBe("rule_proposal");
    expect(plan.effects[0].type === "rule_proposal" && plan.effects[0].payload.reviewRequired).toBe(false);
    expect(input.report.candidates.every((candidate) => readCandidateProjectionV1({
      workspace: input.root,
      workspaceId: "main",
      candidateId: candidate.candidateId,
    })!.cluster.lifecycle.status === "evaluated")).toBe(true);

    const rulesDirectory = join(input.root, "memory-state", "oll", "rules");
    const rulePath = join(rulesDirectory, readdirSync(rulesDirectory)[0]);
    expect(JSON.parse(readFileSync(rulePath, "utf8"))).toEqual(expect.objectContaining({ status: "active", revision: 1 }));
    expect(readdirSync(join(candidateRuntimePathsV1(input.root).root, "reviews"))).toHaveLength(0);
    const [pending] = listPendingRuleActivationNotifications({ workspace: input.root });
    expect(pending.messageText).toMatch(/^⭐ /);
    expect(pending.messageText).not.toContain("Я самоулучшаюсь");
    expect(pending.messageText).toContain("Если хотите отменить");
    const delivered = acknowledgeRuleActivationNotification({ workspace: input.root, notificationId: pending.notificationId, messageId: "telegram-message-42", now: NOW });
    expect(delivered.status).toBe("delivered");
    const reverted = suspendRulesFromNotification({
      workspace: input.root,
      stateRoot,
      replyMessageId: "telegram-message-42",
      itemNumbers: [1],
      now: "2026-08-14T15:05:00.000Z",
    });
    expect(reverted.notification.status).toBe("reverted");
    expect(JSON.parse(readFileSync(rulePath, "utf8"))).toEqual(expect.objectContaining({ status: "suspended", revision: 2 }));

    const replay = applyCandidateHandoffV3({
      workspace: input.root,
      workspaceId: "main",
      handoff: value,
      scopeRegistry: input.scopeRegistry,
      now: "2026-08-14T15:06:00.000Z",
      liveRevalidate: LIVE_REVALIDATE,
      optimisticApply: true,
      stateRoot,
      notificationSession: "telegram-direct-42",
    })!;
    expect(replay.planId).toBe(plan.planId);
    expect(readdirSync(rulesDirectory)).toHaveLength(1);
  });

  for (const crashPoint of ["after_rule_activation", "after_candidate_finalization"] as const) {
    test(`recovers both independent rules exactly once after ${crashPoint}`, () => {
      const input = fixture(2);
      const value = separateRules(input);
      const run = {
        workspace: input.root, workspaceId: "main", handoff: value, scopeRegistry: input.scopeRegistry,
        optimisticApply: true, stateRoot: join(input.root, "state-root"), now: NOW,
        resolveNotificationSession: () => "telegram-direct-42", liveRevalidate: LIVE_REVALIDATE,
      };
      mkdirSync(run.stateRoot, { recursive: true });
      writeJson(join(input.root, "engram.json"), { workspace: { id: "main" }, oll: { adaptation: { mode: "active" } } });
      expect(() => applyCandidateHandoffV3({
        ...run, faultInjector(point) { if (point === crashPoint) throw new CandidateApplySimulatedCrash("crash"); },
      })).toThrow(CandidateApplySimulatedCrash);
      expect(listPendingRuleActivationNotifications(run)).toHaveLength(1);

      const plan = applyCandidateHandoffV3({ ...run, now: "2026-08-14T15:05:00Z" });
      expect(plan?.status).toBe("terminal");
      expect(applyCandidateHandoffV3(run)?.planId).toBe(plan?.planId);
      const notices = listPendingRuleActivationNotifications(run);
      expect(notices).toHaveLength(2);
      const ruleRoot = join(input.root, "memory-state", "oll", "rules");
      expect(readdirSync(ruleRoot)).toHaveLength(2);
      for (const notice of notices) {
        const rule = JSON.parse(readFileSync(join(ruleRoot, `${notice.items[0].ruleId}.json`), "utf8"));
        expect(rule.revision).toBe(1);
        expect(rule.sourceCandidates).toEqual(value.actions.find(a => a.actionId === rule.decision.actionId)?.payload.sourceCandidates);
        const projection = readCandidateProjectionV1({ ...run, candidateId: rule.sourceCandidates[0] });
        expect(projection?.cluster.lifecycle.status).toBe("evaluated");
        expect(projection?.highestContiguousRevision).toBe(input.context.candidateRevisions[rule.sourceCandidates[0]] + 2);
      }
    });
  }

  test("recovers separate review assignments without claiming a sibling action's evidence", () => {
    const input = fixture(2);
    const value = separateRules(input);
    const run = {
      workspace: input.root, workspaceId: "main", handoff: value, scopeRegistry: input.scopeRegistry,
      now: NOW, liveRevalidate: LIVE_REVALIDATE,
    };
    expect(() => applyCandidateHandoffV3({
      ...run, faultInjector(point) { if (point === "after_review_pending") throw new CandidateApplySimulatedCrash("crash"); },
    })).toThrow(CandidateApplySimulatedCrash);
    const plan = applyCandidateHandoffV3(run)!;
    expect(plan.status).toBe("terminal");
    expect(plan.effects).toHaveLength(4);
    for (const effect of plan.effects) {
      if (effect.type !== "mandatory_review") continue;
      const [id] = value.actions.find(a => a.actionId === effect.actionId)!.payload.sourceCandidates;
      expect(Object.keys(effect.candidateRevisions)).toEqual([id]);
      expect(readCandidateProjectionV1({ ...run, candidateId: id })?.cluster.lifecycle.correlationId).toBe(effect.payload.reviewId);
    }
  });

  test("reverting one item in a grouped notification leaves its sibling active and independently addressable", () => {
    const input = fixture(2);
    const run = {
      workspace: input.root, workspaceId: "main", handoff: separateRules(input), scopeRegistry: input.scopeRegistry,
      stateRoot: join(input.root, "state-root"), now: NOW, optimisticApply: true,
      resolveNotificationSession: () => "telegram-group--100123-topic-7", liveRevalidate: LIVE_REVALIDATE,
    };
    mkdirSync(run.stateRoot, { recursive: true });
    writeJson(join(input.root, "engram.json"), { workspace: { id: "main" }, oll: { adaptation: { mode: "active" } } });
    applyCandidateHandoffV3(run);
    const [delivery, ...remaining] = prepareRuleActivationDeliveries(run);
    expect(remaining).toHaveLength(0);
    expect(delivery.items.map(item => item.number)).toEqual([1, 2]);
    expect(prepareRuleActivationDeliveries(run)).toEqual([delivery]);
    acknowledgeRuleActivationNotification({ workspace: input.root, notificationId: delivery.notificationId, messageId: "201", now: NOW });
    expect(prepareRuleActivationDeliveries(run)).toHaveLength(0);
    const firstRollback = suspendRulesFromNotification({ ...run, replyMessageId: "201", itemNumbers: [2] });
    expect(firstRollback.suspendedRuleIds).toEqual([delivery.items[1].ruleId]);
    expect(firstRollback.notification.status).toBe("partially_reverted");
    const states = delivery.items.map(item => JSON.parse(readFileSync(join(input.root, "memory-state", "oll", "rules", `${item.ruleId}.json`), "utf8")).status);
    expect(states).toEqual(["active", "suspended"]);
    expect(inspectCandidateRollbackPlansV1(run)[0]).toMatchObject({ phase: "terminal", heldReservations: 0, pendingReviews: 0 });
    expect(suspendRulesFromNotification({ ...run, replyMessageId: "201", itemNumbers: [1] }).notification.status).toBe("reverted");
  });

  test("rollback inventory keeps the second review pending after resolving the first of two independent reviews", () => {
    const input = fixture(2);
    const run = {
      workspace: input.root, workspaceId: "main", handoff: separateRules(input), scopeRegistry: input.scopeRegistry,
      now: NOW, liveRevalidate: LIVE_REVALIDATE,
    };
    applyCandidateHandoffV3(run);
    const dir = join(candidateRuntimePathsV1(input.root).root, "reviews");
    const reviews = readdirSync(dir).map(name => JSON.parse(readFileSync(join(dir, name, "00000001.json"), "utf8")));
    expect(reviews).toHaveLength(2);
    const actor = actorRegistry(input.root);
    const resolveReview = (review: any) => reconcileCandidateReviewOutcomeV1({
      ...run, actorRegistryPath: actor.path, actorContext: ACTOR,
      outcome: outcome({ review, disposition: "approved", reasonCode: "review_approved", registryRevision: actor.loaded.registry.revision, registryDigest: actor.loaded.digest }),
    });
    expect(inspectCandidateRollbackPlansV1(run)[0]).toMatchObject({ phase: "review_pending", pendingReviews: 2 });
    resolveReview(reviews[0]);
    expect(inspectCandidateRollbackPlansV1(run)[0]).toMatchObject({ phase: "review_pending", pendingReviews: 1 });
    const other = Object.keys(reviews[1].candidateRevisions)[0] as Digest;
    expect(readCandidateProjectionV1({ ...run, candidateId: other })?.cluster.lifecycle.correlationId).toBe(reviews[1].reviewId);
    expect(containCandidatePlansForRollbackV1(run)[0]).toMatchObject({ phase: "review_pending", pendingReviews: 1 });
    resolveReview(reviews[1]);
    expect(inspectCandidateRollbackPlansV1(run)[0]).toMatchObject({ phase: "terminal", pendingReviews: 0 });
  });

  test("rejects overlapping evidence or missing per-rule routes before reserving any candidates", () => {
    const input = fixture(2);
    const value = separateRules(input);
    const run = {
      workspace: input.root, workspaceId: "main", handoff: value, scopeRegistry: input.scopeRegistry,
      now: NOW, optimisticApply: true, stateRoot: join(input.root, "state-root"), liveRevalidate: LIVE_REVALIDATE,
    };
    expect(() => applyCandidateHandoffV3({ ...run, notificationSession: "telegram-direct-42" })).toThrow("per proposal");
    const second = value.actions[1];
    second.payload.sourceCandidates.push(value.actions[0].payload.sourceCandidates[0]);
    second.actionId = computeActionIdV3(value.evaluationId, 1, second);
    value.handoffDigest = computeHandoffDigestV3(value);
    expect(() => applyCandidateHandoffV3(run)).toThrow("partition");
    expect(readdirSync(join(candidateRuntimePathsV1(input.root).root, "plans"))).toHaveLength(0);
    for (const candidate of input.context.candidates) {
      expect(readCandidateProjectionV1({ ...run, candidateId: candidate.candidateId })?.highestContiguousRevision).toBe(candidate.revision);
    }
  });

  test("reserves the whole candidate set before publishing an effect and resumes the same WAL plan", () => {
    const input = fixture(2);
    const value = handoff(input);
    let liveChecks = 0;
    expect(() => applyCandidateHandoffV3({
      workspace: input.root, workspaceId: "main", handoff: value, scopeRegistry: input.scopeRegistry, now: NOW,
      liveRevalidate: LIVE_REVALIDATE,
      faultInjector(point) { if (point === "after_first_reservation") throw new CandidateApplySimulatedCrash("crash"); },
    })).toThrow(CandidateApplySimulatedCrash);
    const runtime = candidateRuntimePathsV1(input.root).root;
    expect(readdirSync(join(runtime, "rule-proposals"))).toHaveLength(0);
    const states = input.report.candidates.map((candidate) => readCandidateProjectionV1({ workspace: input.root, workspaceId: "main", candidateId: candidate.candidateId })!.cluster.lifecycle.status).sort();
    expect(states).toEqual(["pending", "reserved"]);

    const plan = applyCandidateHandoffV3({
      workspace: input.root, workspaceId: "main", handoff: value, scopeRegistry: input.scopeRegistry, now: "2026-08-14T15:01:00.000Z",
      liveRevalidate() {
        liveChecks += 1;
        expect(input.report.candidates.every((candidate) => readCandidateProjectionV1({ workspace: input.root, workspaceId: "main", candidateId: candidate.candidateId })!.cluster.lifecycle.status === "reserved")).toBe(true);
        expect(readdirSync(join(candidateRuntimePathsV1(input.root).root, "rule-proposals"))).toHaveLength(0);
      },
    })!;
    expect(plan.status).toBe("terminal");
    expect(liveChecks).toBe(1);
    expect(readdirSync(join(runtime, "rule-proposals"))).toHaveLength(1);
    expect(readdirSync(join(runtime, "reviews"))).toHaveLength(1);
    expect(input.report.candidates.every((candidate) => readCandidateProjectionV1({ workspace: input.root, workspaceId: "main", candidateId: candidate.candidateId })!.cluster.lifecycle.status === "review_pending")).toBe(true);
  });

  test("releases its reservations when a whole-plan conflict occurs before any effect", () => {
    const input = fixture(2);
    const value = handoff(input);
    expect(() => applyCandidateHandoffV3({
      workspace: input.root, workspaceId: "main", handoff: value, scopeRegistry: input.scopeRegistry, now: NOW,
      liveRevalidate: LIVE_REVALIDATE,
      faultInjector(point) { if (point === "after_first_reservation") throw new CandidateApplySimulatedCrash("crash"); },
    })).toThrow();
    const second = input.report.candidates.find((candidate) => readCandidateProjectionV1({ workspace: input.root, workspaceId: "main", candidateId: candidate.candidateId })!.cluster.lifecycle.status === "pending")!;
    reserveCandidateV1({
      workspace: input.root, workspaceId: "main", planId: sha256Digest("competing-plan"), candidateId: second.candidateId,
      expectedRevision: 1, evidenceSetDigest: second.evidenceSetDigest, now: NOW,
    });
    expect(() => applyCandidateHandoffV3({ workspace: input.root, workspaceId: "main", handoff: value, scopeRegistry: input.scopeRegistry, now: NOW, liveRevalidate: LIVE_REVALIDATE })).toThrow();
    const first = input.report.candidates.find((candidate) => candidate.candidateId !== second.candidateId)!;
    expect(readCandidateProjectionV1({ workspace: input.root, workspaceId: "main", candidateId: first.candidateId })!.cluster.lifecycle.status).toBe("pending");
    expect(readdirSync(join(candidateRuntimePathsV1(input.root).root, "rule-proposals"))).toHaveLength(0);
  });

  test("holds ownership and quarantines when live drift is detected after a published effect", () => {
    const input = fixture(1);
    const value = handoff(input);
    expect(() => applyCandidateHandoffV3({
      workspace: input.root, workspaceId: "main", handoff: value, scopeRegistry: input.scopeRegistry, now: NOW,
      liveRevalidate: LIVE_REVALIDATE,
      faultInjector(point) { if (point === "after_effect_publication") throw new CandidateApplySimulatedCrash("crash"); },
    })).toThrow(CandidateApplySimulatedCrash);
    expect(() => applyCandidateHandoffV3({
      workspace: input.root, workspaceId: "main", handoff: value, scopeRegistry: input.scopeRegistry, now: NOW,
      liveRevalidate() { throw new Error("live source drift"); },
    })).toThrow("live source drift");
    const runtime = candidateRuntimePathsV1(input.root).root;
    const planDirectory = join(runtime, "plans", readdirSync(join(runtime, "plans"))[0]);
    const latest = JSON.parse(readFileSync(join(planDirectory, readdirSync(planDirectory).sort().at(-1)!), "utf8"));
    expect(latest.plan.status).toBe("quarantined");
    expect(readCandidateProjectionV1({ workspace: input.root, workspaceId: "main", candidateId: input.report.candidates[0].candidateId })!.cluster.lifecycle.status).toBe("reserved");
  });

  test("records non-consumed dispositions before making the apply plan terminal", () => {
    const input = fixture(2);
    const value = splitDispositionHandoff(input);
    const plan = applyCandidateHandoffV3({ workspace: input.root, workspaceId: "main", handoff: value, scopeRegistry: input.scopeRegistry, now: NOW, liveRevalidate: LIVE_REVALIDATE })!;
    expect(plan.status).toBe("terminal");
    const byId = Object.fromEntries(input.report.candidates.map((candidate) => [candidate.candidateId, readCandidateProjectionV1({ workspace: input.root, workspaceId: "main", candidateId: candidate.candidateId })!.cluster.lifecycle.status]));
    expect(byId[value.candidateDispositions[0].candidateId]).toBe("review_pending");
    expect(byId[value.candidateDispositions[1].candidateId]).toBe("deferred");
  });

  test("preflights stale deferred revisions before plan intent or reservation", () => {
    const input = fixture(2);
    const value = splitDispositionHandoff(input);
    const deferredId = value.candidateDispositions[1].candidateId;
    const deferred = input.report.candidates.find((candidate) => candidate.candidateId === deferredId)!;
    reserveCandidateV1({
      workspace: input.root, workspaceId: "main", planId: sha256Digest("competing-deferred-plan"),
      candidateId: deferredId, expectedRevision: 1, evidenceSetDigest: deferred.evidenceSetDigest, now: NOW,
    });
    expect(() => applyCandidateHandoffV3({ workspace: input.root, workspaceId: "main", handoff: value, scopeRegistry: input.scopeRegistry, now: NOW, liveRevalidate: LIVE_REVALIDATE })).toThrow("exact pending disposition");
    const consumedId = value.candidateDispositions[0].candidateId;
    expect(readCandidateProjectionV1({ workspace: input.root, workspaceId: "main", candidateId: consumedId })!.cluster.lifecycle.status).toBe("pending");
    const runtime = candidateRuntimePathsV1(input.root).root;
    expect(readdirSync(join(runtime, "plans"))).toHaveLength(0);
    expect(readdirSync(join(runtime, "rule-proposals"))).toHaveLength(0);
  });

  test("finishes the persisted plan after a crash following review-pending transitions", () => {
    const input = fixture(1);
    const value = handoff(input);
    expect(() => applyCandidateHandoffV3({
      workspace: input.root, workspaceId: "main", handoff: value, scopeRegistry: input.scopeRegistry, now: NOW,
      liveRevalidate: LIVE_REVALIDATE,
      faultInjector(point) { if (point === "after_review_pending") throw new CandidateApplySimulatedCrash("crash"); },
    })).toThrow(CandidateApplySimulatedCrash);
    const plan = applyCandidateHandoffV3({
      workspace: input.root, workspaceId: "main", handoff: value, scopeRegistry: input.scopeRegistry, now: "2026-08-14T15:02:00.000Z",
      liveRevalidate() { throw new Error("must not revalidate after all effects committed"); },
    })!;
    expect(plan.status).toBe("terminal");
    expect(readCandidateProjectionV1({ workspace: input.root, workspaceId: "main", candidateId: input.report.candidates[0].candidateId })!.cluster.lifecycle.status).toBe("review_pending");
  });

  test("continues approved, rejected, and expired reviews without activating the proposal", () => {
    const cases = [
      { disposition: "approved", reasonCode: "review_approved", status: "evaluated" },
      { disposition: "rejected", reasonCode: "review_rejected_retryable", status: "deferred" },
      { disposition: "expired", reasonCode: "review_expired_terminal", status: "dismissed" },
    ] as const;
    for (const item of cases) {
      const input = fixture(1);
      applyCandidateHandoffV3({ workspace: input.root, workspaceId: "main", handoff: handoff(input), scopeRegistry: input.scopeRegistry, now: NOW, liveRevalidate: LIVE_REVALIDATE });
      const review = pendingReview(input.root);
      const actor = actorRegistry(input.root);
      const value = outcome({ review, disposition: item.disposition, reasonCode: item.reasonCode, registryRevision: actor.loaded.registry.revision, registryDigest: actor.loaded.digest });
      const first = reconcileCandidateReviewOutcomeV1({ workspace: input.root, workspaceId: "main", outcome: value, actorRegistryPath: actor.path, actorContext: ACTOR });
      const replay = reconcileCandidateReviewOutcomeV1({ workspace: input.root, workspaceId: "main", outcome: value, actorRegistryPath: actor.path, actorContext: ACTOR });
      expect(first).toEqual(replay);
      expect(first.status).toBe(item.disposition);
      expect(readCandidateProjectionV1({ workspace: input.root, workspaceId: "main", candidateId: input.report.candidates[0].candidateId })!.cluster.lifecycle.status).toBe(item.status);
      const proposalPath = join(candidateRuntimePathsV1(input.root).root, "rule-proposals", readdirSync(join(candidateRuntimePathsV1(input.root).root, "rule-proposals"))[0]);
      expect(JSON.parse(readFileSync(proposalPath, "utf8")).status).toBe("proposed");
    }
  });

  test("resumes one authorized outcome after a crash between multi-candidate transitions", () => {
    const input = fixture(2);
    applyCandidateHandoffV3({ workspace: input.root, workspaceId: "main", handoff: handoff(input), scopeRegistry: input.scopeRegistry, now: NOW, liveRevalidate: LIVE_REVALIDATE });
    const review = pendingReview(input.root);
    const actor = actorRegistry(input.root);
    const value = outcome({ review, disposition: "approved", reasonCode: "review_approved", registryRevision: actor.loaded.registry.revision, registryDigest: actor.loaded.digest });
    expect(() => reconcileCandidateReviewOutcomeV1({
      workspace: input.root, workspaceId: "main", outcome: value, actorRegistryPath: actor.path, actorContext: ACTOR,
      faultInjector(point, candidateIndex) { if (point === "after_candidate_transition" && candidateIndex === 0) throw new CandidateReviewSimulatedCrash("crash"); },
    })).toThrow(CandidateReviewSimulatedCrash);
    expect(input.report.candidates.map((candidate) => readCandidateProjectionV1({ workspace: input.root, workspaceId: "main", candidateId: candidate.candidateId })!.cluster.lifecycle.status).sort()).toEqual(["evaluated", "review_pending"]);
    const terminal = reconcileCandidateReviewOutcomeV1({ workspace: input.root, workspaceId: "main", outcome: value, actorRegistryPath: actor.path, actorContext: ACTOR });
    expect(terminal.status).toBe("approved");
    expect(input.report.candidates.every((candidate) => readCandidateProjectionV1({ workspace: input.root, workspaceId: "main", candidateId: candidate.candidateId })!.cluster.lifecycle.status === "evaluated")).toBe(true);
  });

  test("quarantines a stale authority snapshot before changing review lifecycle", () => {
    const input = fixture(1);
    applyCandidateHandoffV3({ workspace: input.root, workspaceId: "main", handoff: handoff(input), scopeRegistry: input.scopeRegistry, now: NOW, liveRevalidate: LIVE_REVALIDATE });
    const review = pendingReview(input.root);
    const actor = actorRegistry(input.root);
    const stale = outcome({ review, disposition: "approved", reasonCode: "review_approved", registryRevision: actor.loaded.registry.revision, registryDigest: sha256Digest("stale") });
    expect(() => reconcileCandidateReviewOutcomeV1({ workspace: input.root, workspaceId: "main", outcome: stale, actorRegistryPath: actor.path, actorContext: ACTOR })).toThrow("stale");
    const runtime = candidateRuntimePathsV1(input.root).root;
    expect(readdirSync(join(runtime, "quarantine"))).toHaveLength(1);
    expect(readCandidateProjectionV1({ workspace: input.root, workspaceId: "main", candidateId: input.report.candidates[0].candidateId })!.cluster.lifecycle.status).toBe("review_pending");
  });

  test("Phase 5 rollback containment releases pre-effect reservations and quarantines partial effects", () => {
    const beforeEffect = fixture(2);
    expect(() => applyCandidateHandoffV3({
      workspace: beforeEffect.root, workspaceId: "main", handoff: handoff(beforeEffect), scopeRegistry: beforeEffect.scopeRegistry, now: NOW,
      liveRevalidate: LIVE_REVALIDATE,
      faultInjector(point) { if (point === "after_first_reservation") throw new CandidateApplySimulatedCrash("crash"); },
    })).toThrow(CandidateApplySimulatedCrash);
    expect(inspectCandidateRollbackPlansV1({ workspace: beforeEffect.root, workspaceId: "main", scopeRegistry: beforeEffect.scopeRegistry })).toEqual([
      expect.objectContaining({ phase: "pre_effect", heldReservations: 1, publishedEffects: 0 }),
    ]);
    expect(containCandidatePlansForRollbackV1({ workspace: beforeEffect.root, workspaceId: "main", scopeRegistry: beforeEffect.scopeRegistry, now: "2026-08-14T15:10:00.000Z" })).toEqual([
      expect.objectContaining({ phase: "terminal", status: "cancelled", heldReservations: 0 }),
    ]);
    expect(beforeEffect.report.candidates.every((candidate) => readCandidateProjectionV1({ workspace: beforeEffect.root, workspaceId: "main", candidateId: candidate.candidateId })!.cluster.lifecycle.status === "pending")).toBe(true);

    const partial = fixture(1);
    expect(() => applyCandidateHandoffV3({
      workspace: partial.root, workspaceId: "main", handoff: handoff(partial), scopeRegistry: partial.scopeRegistry, now: NOW,
      liveRevalidate: LIVE_REVALIDATE,
      faultInjector(point) { if (point === "after_effect_publication") throw new CandidateApplySimulatedCrash("crash"); },
    })).toThrow(CandidateApplySimulatedCrash);
    expect(containCandidatePlansForRollbackV1({ workspace: partial.root, workspaceId: "main", scopeRegistry: partial.scopeRegistry, now: "2026-08-14T15:10:00.000Z" })).toEqual([
      expect.objectContaining({ phase: "quarantined", status: "quarantined", heldReservations: 1, publishedEffects: 1 }),
    ]);
    expect(readCandidateProjectionV1({ workspace: partial.root, workspaceId: "main", candidateId: partial.report.candidates[0].candidateId })!.cluster.lifecycle.status).toBe("reserved");
  });

  test("Phase 5 rollback inventory retains pending reviews under the exact terminal plan", () => {
    const input = fixture(1);
    applyCandidateHandoffV3({ workspace: input.root, workspaceId: "main", handoff: handoff(input), scopeRegistry: input.scopeRegistry, now: NOW, liveRevalidate: LIVE_REVALIDATE });
    const before = inspectCandidateRollbackPlansV1({ workspace: input.root, workspaceId: "main", scopeRegistry: input.scopeRegistry });
    expect(before).toEqual([expect.objectContaining({ phase: "review_pending", status: "terminal", pendingReviews: 1 })]);
    expect(containCandidatePlansForRollbackV1({ workspace: input.root, workspaceId: "main", scopeRegistry: input.scopeRegistry, now: "2026-08-14T15:10:00.000Z" })).toEqual(before);
  });
});
