import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeJcs, sha256Digest, type Digest } from "../src/oll/handoff-v2";
import {
  CANDIDATE_BLOCKER_TRACEABILITY,
  CANDIDATE_DECAY_MATRIX,
  CANDIDATE_LIFECYCLE_TRANSITIONS,
  CANDIDATE_REASON_REGISTRY,
  CANDIDATE_SCOPE_RELATION_MATRIX,
  CANDIDATE_SUPPORTED_VERSIONS_V1,
  candidateIdV1,
  candidateContextBytesV1,
  candidateApplyPlanId,
  candidateEffectId,
  candidateEffectPayloadDigest,
  candidateOperationId,
  candidateOperationIntentDigest,
  candidatePolicyDigestV2,
  candidateProjectionDigest,
  candidateReportDigest,
  candidateReservationId,
  candidateReviewOutcomeId,
  candidateScopeRegistryDigestV1,
  computeCandidateRankingV1,
  evidenceSetDigestV1,
  intersectCandidateScopes,
  MEMORY_CANDIDATE_APPLY_PLAN_V1_SCHEMA,
  MEMORY_CANDIDATE_ASSESSMENT_V1_SCHEMA,
  MEMORY_CANDIDATE_CLUSTER_V1_SCHEMA,
  MEMORY_CANDIDATE_CONTRACT_JSON_SCHEMAS,
  MEMORY_CANDIDATE_OPERATION_V2_SCHEMA,
  MEMORY_CANDIDATE_POLICY_V2_SCHEMA,
  MEMORY_CANDIDATE_PROJECTION_V1_SCHEMA,
  MEMORY_CANDIDATE_REPORT_V2_SCHEMA,
  MEMORY_CANDIDATE_RESERVATION_V1_SCHEMA,
  MEMORY_CANDIDATE_REVIEW_OUTCOME_V1_SCHEMA,
  MEMORY_CANDIDATE_EFFECT_V1_SCHEMA,
  MEMORY_CANDIDATE_RANKING_POLICY_V1_SCHEMA,
  MEMORY_CANDIDATE_SCOPE_REGISTRY_V1_SCHEMA,
  MEMORY_EVIDENCE_OCCURRENCE_V1_SCHEMA,
  normalizeCandidateStatement,
  occurrenceIdV1,
  scopeContains,
  selectionAssessmentId,
  semanticKeyV1,
  validateCandidateApplyPlanV1,
  validateCandidateClusterV1,
  validateCandidateOperationV2,
  validateCandidatePolicyV2,
  validateCandidateProjectionV1,
  validateCandidateReportV2,
  validateCandidateReservationV1,
  validateCandidateReviewOutcomeV1,
  validateCandidateScopeRegistryV1,
  validateCandidateSelectionAssessmentV1,
  validateEvidenceOccurrenceV1,
  validateLifecycleTransition,
  type CandidateApplyPlanV1,
  type CandidateClusterV1,
  type CandidateOperationV2,
  type CandidatePlannedEffectV1,
  type CandidateProjectionV1,
  type CandidateReportV2,
  type CandidateReservationV1,
  type CandidateReviewOutcomeV1,
  type CandidateSelectionAssessmentV1,
  type CandidateSourcePolicyV2,
  type CandidateScopeRegistryV1,
  type EvidenceOccurrenceV1,
} from "../src/oll/memory-candidate-contracts-v2";

const FIXTURES = join(import.meta.dir, "fixtures", "oll-memory-candidates");
const REPO = join(import.meta.dir, "..");
const NOW = "2026-08-14T07:15:00.000Z";

function digest(value: string): Digest {
  return sha256Digest(value);
}

function policy(): CandidateSourcePolicyV2 {
  return {
    schema: MEMORY_CANDIDATE_POLICY_V2_SCHEMA,
    mode: "shadow",
    forwardOnlySince: "2026-08-14T00:00:00+03:00",
    workspaceTimezone: "Europe/Moscow",
    legacyTimestampParser: { version: "legacy-local-v1", daylightSavingAmbiguity: "reject" },
    daily: [{ session: "main", sections: ["decisions", "learnings", "retrieval-cards"], scopeCeiling: { level: "workspace", subject: "main" } }],
    domains: [{ domainId: "engram", formats: ["canonical-decisions-v1", "canonical-proposals-v1"], scopeCeiling: { level: "domain", subject: "engram" } }],
    kg: [{
      entityPrefix: "projects/",
      kinds: ["decision", "preference", "constraint"],
      admittedScopes: ["project:engram"],
      scopeMapping: { "project:engram": { level: "domain", subject: "engram" } },
    }],
    limits: {
      maxCandidatesPerRun: 20,
      maxContextBytes: 65_536,
      maxOccurrencesPerCluster: 8,
      sourceQuotas: {
        "daily-decision": 8,
        "daily-learning": 8,
        "retrieval-card": 8,
        "domain-decision": 8,
        "domain-proposal": 4,
        "kg-assertion": 8,
      },
    },
    decayPolicy: {
      schema: "oll.memory-candidate-decay-policy.v1",
      hotDays: 7,
      warmDays: 30,
      accessCountCap: 10,
      warmScorePenalty: 12,
      coldKgContribution: "provenance-only",
      trustedAccessEventSchema: "engram.kg-v3-access-event.v1",
    },
    rankingPolicy: {
      schema: MEMORY_CANDIDATE_RANKING_POLICY_V1_SCHEMA,
      eligibilityThreshold: 55,
      baseScores: { decision: 70, learning: 55, preference: 78, constraint: 74, proposal: 68 },
      recencyBoostMax: 10,
      recencyBoostPerDay: 2,
      distinctRootBoostPerRoot: 3,
      distinctRootBoostMax: 12,
    },
    sensitiveTextPolicyVersion: "privacy-v1",
  };
}

function scopeRegistry(): CandidateScopeRegistryV1 {
  const base: Omit<CandidateScopeRegistryV1, "digest"> = {
    schema: MEMORY_CANDIDATE_SCOPE_REGISTRY_V1_SCHEMA,
    workspaceId: "main",
    revision: 4,
    selfToDomain: { "telegram:100000001": "engram" },
    domainToWorkspace: { engram: "main" },
    sourceAuthorities: {
      daily: { main: { level: "workspace", subject: "main" } },
      domains: { engram: { level: "domain", subject: "engram" } },
      kgScopes: { "project:engram": { level: "domain", subject: "engram" } },
    },
  };
  return { ...base, digest: candidateScopeRegistryDigestV1(base) };
}

function reportContext(policyValue: CandidateSourcePolicyV2, registry = scopeRegistry()) {
  return { policy: policyValue, scopeRegistry: registry, versions: CANDIDATE_SUPPORTED_VERSIONS_V1 };
}

function occurrenceContext(policyValue: CandidateSourcePolicyV2, registry = scopeRegistry()) {
  return { ...reportContext(policyValue, registry), reportWorkspaceId: registry.workspaceId };
}

function applyPlanContext(cluster: CandidateClusterV1, registry = scopeRegistry()) {
  return { scopeRegistry: registry, candidateScopes: { [cluster.candidateId]: cluster.effectiveScope } };
}

function pairedEffects(cluster: CandidateClusterV1, operationId: Digest = digest("operation-1")): [CandidatePlannedEffectV1, CandidatePlannedEffectV1] {
  const common = {
    schema: MEMORY_CANDIDATE_EFFECT_V1_SCHEMA,
    effectId: digest("effect-placeholder"),
    actionId: digest("action-1"),
    candidateRevisions: { [cluster.candidateId]: 1 },
    effectiveScope: cluster.effectiveScope,
  };
  const proposalDraft: CandidatePlannedEffectV1 = {
    ...common,
    type: "rule_proposal",
    payload: {
      ruleId: "rule-candidate-1",
      ruleText: "Require verified reports for recovery.",
      ruleTextDigest: digest("Require verified reports for recovery."),
      reviewRequired: true,
    },
  };
  const reviewDraft: CandidatePlannedEffectV1 = {
    ...common,
    type: "mandatory_review",
    payload: {
      reviewId: digest("review-1"),
      operationId,
      ruleId: "rule-candidate-1",
      expectedReviewRevision: 1,
      requiredAction: "review_rule_proposal",
      requiredGrant: "engram.rule.review",
      registryRevision: 9,
      registryDigest: digest("registry-r9"),
      assignedReviewer: null,
    },
  };
  return [
    { ...proposalDraft, effectId: candidateEffectId(proposalDraft) },
    { ...reviewDraft, effectId: candidateEffectId(reviewDraft) },
  ];
}

function goldenObjects() {
  const statement = "Проверять digest перед восстановлением.";
  const semanticKey = semanticKeyV1(statement);
  const provenanceRootId = digest("decision-root-1");
  const occurrenceBase: Omit<EvidenceOccurrenceV1, "occurrenceId"> = {
    schema: MEMORY_EVIDENCE_OCCURRENCE_V1_SCHEMA,
    workspaceId: "main",
    sourceClass: "daily-decision",
    evidenceKind: "decision",
    sourceRef: "memory/agent-main/main/2026-08-14.md#decisions:1",
    sourceVersionDigest: digest("source-v1"),
    contentDigest: digest(statement),
    provenanceRootId,
    semanticKey,
    authoritativeScope: { level: "workspace", subject: "main" },
    effectiveScope: { level: "workspace", subject: "main" },
    observedAt: NOW,
    originalTimestamp: "2026-08-14T10:15:00+03:00",
    timezone: "Europe/Moscow",
    parserVersion: "daily-note-v2",
    kgDecay: null,
    canonicalStatement: statement,
  };
  const occurrence: EvidenceOccurrenceV1 = { ...occurrenceBase, occurrenceId: occurrenceIdV1(occurrenceBase) };
  const candidateId = candidateIdV1({ workspaceId: "main", normalizerVersion: "semantic-v1", semanticKey, effectiveScope: occurrence.effectiveScope });
  const evidenceSetDigest = evidenceSetDigestV1([occurrence.occurrenceId]);
  const selectedPolicy: CandidateSourcePolicyV2 = { ...policy(), mode: "materialize" };
  const policyDigest = candidatePolicyDigestV2(selectedPolicy);
  const cluster: CandidateClusterV1 = {
    schema: MEMORY_CANDIDATE_CLUSTER_V1_SCHEMA,
    candidateId,
    workspaceId: "main",
    normalizerVersion: "semantic-v1",
    evaluationEpoch: 1,
    semanticKey,
    effectiveScope: occurrence.effectiveScope,
    canonicalStatement: statement,
    occurrenceIds: [occurrence.occurrenceId],
    distinctProvenanceRootIds: [provenanceRootId],
    evidenceSetDigest,
    ranking: computeCandidateRankingV1({ occurrences: [occurrence], policy: selectedPolicy, snapshotAt: NOW }),
    lifecycle: {
      status: "pending",
      revision: 1,
      evaluationEpoch: 1,
      reasonCode: "admitted",
      reservationOwner: null,
      correlationId: digest("materialize-op-1"),
      updatedAt: NOW,
    },
  };
  const reportBase: Omit<CandidateReportV2, "reportDigest"> = {
    schema: MEMORY_CANDIDATE_REPORT_V2_SCHEMA,
    compilationAttemptId: digest("attempt-1"),
    batchId: "nightly-2026-08-14T00:40:00Z",
    workspaceId: "main",
    executionMode: "materialize",
    snapshotAt: NOW,
    policyDigest,
    scopeRegistryRevision: scopeRegistry().revision,
    scopeRegistryDigest: scopeRegistry().digest,
    compilerVersion: "compiler-v2",
    normalizerVersion: "semantic-v1",
    parserVersions: ["daily-note-v2"],
    kgAssertionRevision: 9,
    kgAssertionDigest: digest("kg-assertions-r9"),
    accessStateRevision: 7,
    accessStateDigest: digest("kg-access-r7"),
    considered: 1,
    eligible: 1,
    selected: 1,
    rejected: 0,
    selectedBytes: candidateContextBytesV1([cluster]),
    projectedModelSpawns: 1,
    projectedReviews: 1,
    sourceCounts: {
      "daily-decision": 1,
      "daily-learning": 0,
      "retrieval-card": 0,
      "domain-decision": 0,
      "domain-proposal": 0,
      "kg-assertion": 0,
    },
    rejectionCounts: {},
    occurrences: [occurrence],
    candidates: [cluster],
  };
  const report: CandidateReportV2 = { ...reportBase, reportDigest: candidateReportDigest(reportBase) };
  return { statement, occurrence, cluster, report, policyDigest, selectedPolicy, registry: scopeRegistry() };
}

function goldenRecoveryDigests() {
  const { cluster, report } = goldenObjects();
  const operationIntent: CandidateOperationV2["intent"] = {
    occurrenceIds: [...cluster.occurrenceIds].sort(),
    candidateCoreDigest: digest(canonicalizeJcs({ workspaceId: cluster.workspaceId, normalizerVersion: cluster.normalizerVersion, semanticKey: cluster.semanticKey, effectiveScope: cluster.effectiveScope, candidateId: cluster.candidateId })),
    candidatePayloadDigest: digest(canonicalizeJcs(cluster)),
    targetRootVersion: "oll-memory-candidates-v1",
  };
  const operationBase = {
    schema: MEMORY_CANDIDATE_OPERATION_V2_SCHEMA,
    reportDigest: report.reportDigest,
    workspaceId: "main",
    candidateId: cluster.candidateId,
    evidenceSetDigest: cluster.evidenceSetDigest,
    intent: operationIntent,
    immutableIntentDigest: candidateOperationIntentDigest(operationIntent),
    status: "intent_recorded" as const,
    reasonCode: "admitted" as const,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const operation: CandidateOperationV2 = { ...operationBase, operationId: candidateOperationId(operationBase) };
  const effects = pairedEffects(cluster, operation.operationId);
  const planDraft: CandidateApplyPlanV1 = {
    schema: MEMORY_CANDIDATE_APPLY_PLAN_V1_SCHEMA,
    planId: digest("plan-placeholder"),
    operationId: operation.operationId,
    batchId: report.batchId,
    workspaceId: "main",
    contextDigest: digest("context-v2"),
    handoffDigest: digest("handoff-v3"),
    candidateRevisions: { [cluster.candidateId]: 1 },
    reservations: [],
    effects,
    effectCommits: Object.fromEntries(effects.map((effect) => [effect.effectId, { payloadDigest: candidateEffectPayloadDigest(effect), status: "pending", committedAt: null }])),
    status: "reserving",
    reasonCode: "reservation_acquired",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const planId = candidateApplyPlanId(planDraft);
  const reservationDraft: CandidateReservationV1 = {
    schema: MEMORY_CANDIDATE_RESERVATION_V1_SCHEMA,
    reservationId: digest("reservation-placeholder"),
    planId,
    candidateId: cluster.candidateId,
    expectedRevision: 1,
    evidenceSetDigest: cluster.evidenceSetDigest,
    status: "held",
    reasonCode: "reservation_acquired",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const reservation = { ...reservationDraft, reservationId: candidateReservationId(reservationDraft) };
  const outcomeDraft: CandidateReviewOutcomeV1 = {
    schema: MEMORY_CANDIDATE_REVIEW_OUTCOME_V1_SCHEMA,
    outcomeId: digest("outcome-placeholder"),
    operationId: operation.operationId,
    actionId: digest("action-1"),
    reviewId: digest("review-1"),
    expectedReviewRevision: 1,
    actualActorId: "telegram:100000001",
    grantDigest: digest("grant-1"),
    registryRevision: 9,
    registryDigest: digest("registry-r9"),
    candidateRevisions: { [cluster.candidateId]: 2 },
    effectiveScope: cluster.effectiveScope,
    disposition: "approved",
    reasonCode: "review_approved",
    observedAt: NOW,
  };
  const outcome = { ...outcomeDraft, outcomeId: candidateReviewOutcomeId(outcomeDraft) };
  const projectionDraft: CandidateProjectionV1 = {
    schema: MEMORY_CANDIDATE_PROJECTION_V1_SCHEMA,
    workspaceId: "main",
    candidateId: cluster.candidateId,
    highestContiguousRevision: 1,
    journalDigest: digest("journal-r1"),
    projectionDigest: digest("projection-placeholder"),
    cluster,
    reservation: null,
    rebuiltAt: NOW,
  };
  const projection = { ...projectionDraft, projectionDigest: candidateProjectionDigest(projectionDraft) };
  return {
    reportDigest: report.reportDigest,
    operationId: operation.operationId,
    effectId: effects[0].effectId,
    effectPayloadDigest: candidateEffectPayloadDigest(effects[0]),
    reviewEffectId: effects[1].effectId,
    reviewEffectPayloadDigest: candidateEffectPayloadDigest(effects[1]),
    planId,
    reservationId: reservation.reservationId,
    outcomeId: outcome.outcomeId,
    projectionDigest: projection.projectionDigest,
  };
}

describe("OLL memory candidate Phase 0B contracts", () => {
  test("ships strict JSON schemas for every named Phase 0B artifact", () => {
    const expected = [
      MEMORY_CANDIDATE_POLICY_V2_SCHEMA,
      MEMORY_EVIDENCE_OCCURRENCE_V1_SCHEMA,
      MEMORY_CANDIDATE_CLUSTER_V1_SCHEMA,
      MEMORY_CANDIDATE_REPORT_V2_SCHEMA,
      MEMORY_CANDIDATE_ASSESSMENT_V1_SCHEMA,
      MEMORY_CANDIDATE_OPERATION_V2_SCHEMA,
      MEMORY_CANDIDATE_APPLY_PLAN_V1_SCHEMA,
      MEMORY_CANDIDATE_RESERVATION_V1_SCHEMA,
      MEMORY_CANDIDATE_REVIEW_OUTCOME_V1_SCHEMA,
      MEMORY_CANDIDATE_PROJECTION_V1_SCHEMA,
      MEMORY_CANDIDATE_SCOPE_REGISTRY_V1_SCHEMA,
      MEMORY_CANDIDATE_EFFECT_V1_SCHEMA,
    ];
    const schemas = Object.values(MEMORY_CANDIDATE_CONTRACT_JSON_SCHEMAS);
    for (const id of expected) {
      const schema = schemas.find((entry) => entry.$id === id);
      expect(schema).toBeDefined();
      expect(schema?.additionalProperties).toBe(false);
      expect(schema && "required" in schema ? schema.required.length : 0).toBeGreaterThan(0);
      expect(schema && "properties" in schema ? Object.keys(schema.properties).length : 0).toBeGreaterThan(0);
      if (schema && "required" in schema && "properties" in schema) {
        expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
      }
    }
  });

  test("executes JSON Schemas and enforces discriminator/source parity", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    for (const schema of Object.values(MEMORY_CANDIDATE_CONTRACT_JSON_SCHEMAS)) ajv.addSchema(schema as object);
    const { occurrence, report, selectedPolicy, cluster } = goldenObjects();
    for (const [schemaName, value] of [
      [MEMORY_CANDIDATE_POLICY_V2_SCHEMA, selectedPolicy],
      [MEMORY_EVIDENCE_OCCURRENCE_V1_SCHEMA, occurrence],
      [MEMORY_CANDIDATE_REPORT_V2_SCHEMA, report],
    ] as const) {
      const validate = ajv.getSchema(schemaName)!;
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    }
    const validateOccurrence = ajv.getSchema(MEMORY_EVIDENCE_OCCURRENCE_V1_SCHEMA)!;
    expect(validateOccurrence({ ...occurrence, sourceClass: "domain-proposal" })).toBe(false);
    expect(validateOccurrence({ ...occurrence, sourceClass: "kg-assertion" })).toBe(false);
    expect(validateOccurrence({ ...occurrence, observedAt: "2026-02-30T10:15:00Z" })).toBe(false);
    const [proposal, review] = pairedEffects(cluster);
    const validateEffect = ajv.getSchema(MEMORY_CANDIDATE_EFFECT_V1_SCHEMA)!;
    expect(validateEffect(proposal), JSON.stringify(validateEffect.errors)).toBe(true);
    expect(validateEffect(review), JSON.stringify(validateEffect.errors)).toBe(true);
    expect(validateEffect({ ...proposal, type: "mandatory_review" })).toBe(false);
  });

  test("policy validation is exact, timestamp-aware, and fail-closed", () => {
    expect(validateCandidatePolicyV2(policy())).toEqual(policy());
    expect(() => validateCandidatePolicyV2({ ...policy(), forwardOnlySince: "2026-08-14" })).toThrow("explicit RFC3339 offset");
    expect(() => validateCandidatePolicyV2({ ...policy(), forwardOnlySince: "2026-02-30T10:00:00Z" })).toThrow("day is invalid");
    expect(() => validateCandidatePolicyV2({ ...policy(), workspaceTimezone: "Not/A_Timezone" })).toThrow("workspaceTimezone is invalid");
    expect(() => validateCandidatePolicyV2({ ...policy(), undocumented: true })).toThrow("unknown field");
    const missingMapping = policy();
    missingMapping.kg[0].scopeMapping = {};
    expect(() => validateCandidatePolicyV2(missingMapping)).toThrow("exactly cover admittedScopes");
    const broadPrefix = policy();
    broadPrefix.kg[0].entityPrefix = "projects";
    expect(() => validateCandidatePolicyV2(broadPrefix)).toThrow("anchored namespace");
  });

  test("production template copies remain byte-identical and canonical source fixtures expose every grammar", () => {
    for (const [fixture, production] of [
      ["domain-decisions-template.md", "templates/domain/decisions.md"],
      ["topic-decisions-template.md", "templates/domain/topic-thread/decisions.md"],
      ["daily-note-template.md", "assets/templates/daily-note.md"],
    ]) {
      expect(readFileSync(join(FIXTURES, fixture), "utf8")).toBe(readFileSync(join(REPO, production), "utf8"));
    }
    const canonical = readFileSync(join(FIXTURES, "canonical-sources.md"), "utf8");
    for (const marker of ["retrieval event card", "**Условие**:", "**Действие**:", "**Решение**:", "— PROPOSAL", "**Proposal**:"]) {
      expect(canonical).toContain(marker);
    }
    const expectedRecords = JSON.parse(readFileSync(join(FIXTURES, "canonical-source-records.v1.json"), "utf8"));
    for (const record of expectedRecords) {
      expect(canonical).toContain(record.timestamp);
      expect(canonical).toContain(record.statement);
      expect(CANDIDATE_SUPPORTED_VERSIONS_V1.parserVersions[record.sourceClass as keyof typeof CANDIDATE_SUPPORTED_VERSIONS_V1.parserVersions]).toContain(record.parserVersion);
    }
  });

  test("scope comparisons require concrete trusted containment edges", () => {
    const registry = scopeRegistry();
    expect(validateCandidateScopeRegistryV1(registry)).toEqual(registry);
    const self = { level: "self" as const, subject: "telegram:100000001" };
    const domain = { level: "domain" as const, subject: "engram" };
    const workspace = { level: "workspace" as const, subject: "main" };
    expect(scopeContains(registry, workspace, self)).toBe(true);
    expect(scopeContains(registry, domain, self)).toBe(true);
    expect(scopeContains(registry, self, domain)).toBe(false);
    expect(intersectCandidateScopes(registry, workspace, self)).toEqual(self);
    expect(intersectCandidateScopes(registry, domain, { level: "domain", subject: "other" })).toBeNull();
    expect(CANDIDATE_SCOPE_RELATION_MATRIX.domain.domain).toBe("same-subject-only");
    const foreignBase: Omit<CandidateScopeRegistryV1, "digest"> = { ...registry, domainToWorkspace: { engram: "other" } };
    const { digest: _ignored, ...foreignWithoutDigest } = foreignBase as CandidateScopeRegistryV1;
    const foreign = { ...foreignWithoutDigest, digest: candidateScopeRegistryDigestV1(foreignWithoutDigest) };
    expect(() => validateCandidateScopeRegistryV1(foreign)).toThrow("domain escapes workspace");
  });

  test("report binds every occurrence to authority, exact policy entry, workspace, and supported versions", () => {
    const { occurrence, report, selectedPolicy, registry } = goldenObjects();
    const narrowAuthorityBase: Omit<CandidateScopeRegistryV1, "digest"> = {
      ...registry,
      sourceAuthorities: { ...registry.sourceAuthorities, daily: { main: { level: "domain", subject: "engram" } } },
    };
    const { digest: _narrowDigest, ...narrowAuthorityPayload } = narrowAuthorityBase as CandidateScopeRegistryV1;
    const narrowAuthorityRegistry = { ...narrowAuthorityPayload, digest: candidateScopeRegistryDigestV1(narrowAuthorityPayload) };
    expect(() => validateEvidenceOccurrenceV1(occurrence, occurrenceContext(selectedPolicy, narrowAuthorityRegistry))).toThrow("does not match trusted source registry");
    const forgedScopeBase = { ...occurrence, occurrenceId: undefined, effectiveScope: { level: "workspace" as const, subject: "other" } };
    const { occurrenceId: _scopeId, ...forgedScopePayload } = forgedScopeBase;
    const forgedScope = { ...forgedScopePayload, occurrenceId: occurrenceIdV1(forgedScopePayload) };
    const forgedScopeReportBase = { ...report, occurrences: [forgedScope] };
    const forgedScopeReport = { ...forgedScopeReportBase, reportDigest: candidateReportDigest(forgedScopeReportBase) };
    expect(() => validateCandidateReportV2(forgedScopeReport, reportContext(selectedPolicy, registry))).toThrow("effectiveScope exceeds authoritativeScope");

    const wrongSourcePayload = { ...occurrence, occurrenceId: undefined, sourceRef: "memory/agent-main/unauthorized/2026-08-14.md#decisions:1" };
    const { occurrenceId: _sourceId, ...wrongSourceBase } = wrongSourcePayload;
    const wrongSource = { ...wrongSourceBase, occurrenceId: occurrenceIdV1(wrongSourceBase) };
    const wrongSourceReportBase = { ...report, occurrences: [wrongSource] };
    const wrongSourceReport = { ...wrongSourceReportBase, reportDigest: candidateReportDigest(wrongSourceReportBase) };
    expect(() => validateCandidateReportV2(wrongSourceReport, reportContext(selectedPolicy, registry))).toThrow("exactly one source policy entry");

    expect(() => validateCandidateReportV2({ ...report, compilerVersion: "compiler-v999" }, reportContext(selectedPolicy, registry))).toThrow("compilerVersion is unsupported");
    expect(() => validateCandidateReportV2({ ...report, parserVersions: ["daily-note-v999"] }, reportContext(selectedPolicy, registry))).toThrow("parserVersions do not exactly match");
  });

  test("report scope uses greatest safe intersection and canonical text uses narrowest then newest occurrence", () => {
    const { occurrence: broad, report, selectedPolicy, registry } = goldenObjects();
    const narrowBase: Omit<EvidenceOccurrenceV1, "occurrenceId"> = {
      ...broad,
      sourceClass: "domain-decision",
      sourceRef: "memory/domains/engram/decisions.md#decisions:2",
      contentDigest: digest("Проверять digest перед восстановлением!"),
      authoritativeScope: { level: "domain", subject: "engram" },
      effectiveScope: { level: "domain", subject: "engram" },
      observedAt: "2026-08-14T06:00:00.000Z",
      originalTimestamp: "2026-08-14T09:00:00+03:00",
      parserVersion: "canonical-decisions-v1",
      canonicalStatement: "Проверять digest перед восстановлением!",
    };
    const narrow = { ...narrowBase, occurrenceId: occurrenceIdV1(narrowBase) };
    const occurrences = [narrow, broad].sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.occurrenceId.localeCompare(right.occurrenceId));
    const effectiveScope = { level: "domain" as const, subject: "engram" };
    const cluster: CandidateClusterV1 = {
      ...report.candidates[0],
      candidateId: candidateIdV1({ workspaceId: "main", normalizerVersion: "semantic-v1", semanticKey: broad.semanticKey, effectiveScope }),
      effectiveScope,
      canonicalStatement: narrow.canonicalStatement,
      occurrenceIds: occurrences.map((entry) => entry.occurrenceId),
      distinctProvenanceRootIds: [broad.provenanceRootId!],
      evidenceSetDigest: evidenceSetDigestV1(occurrences.map((entry) => entry.occurrenceId)),
      ranking: computeCandidateRankingV1({ occurrences, policy: selectedPolicy, snapshotAt: NOW }),
    };
    const base: Omit<CandidateReportV2, "reportDigest"> = {
      ...report,
      considered: 2,
      eligible: 2,
      sourceCounts: { ...report.sourceCounts, "domain-decision": 1 },
      parserVersions: ["canonical-decisions-v1", "daily-note-v2"],
      occurrences,
      candidates: [cluster],
      selectedBytes: candidateContextBytesV1([cluster]),
    };
    const narrowedReport: CandidateReportV2 = { ...base, reportDigest: candidateReportDigest(base) };
    expect(validateCandidateReportV2(narrowedReport, reportContext(selectedPolicy, registry))).toEqual(narrowedReport);
    const forgedCluster = { ...cluster, canonicalStatement: broad.canonicalStatement };
    const forgedBase = { ...base, candidates: [forgedCluster], selectedBytes: candidateContextBytesV1([forgedCluster]) };
    const forged = { ...forgedBase, reportDigest: candidateReportDigest(forgedBase) };
    expect(() => validateCandidateReportV2(forged, reportContext(selectedPolicy, registry))).toThrow("canonical statement mismatch");
  });

  test("decay matrix makes cold decision/preference evidence provenance-only without weakening KG constraints", () => {
    expect(CANDIDATE_DECAY_MATRIX.decision.cold).toEqual({ eligible: false, scorePenalty: "not-applicable", contribution: "provenance-only" });
    expect(CANDIDATE_DECAY_MATRIX.preference.warm).toEqual({ eligible: true, scorePenalty: "warmScorePenalty", contribution: "full" });
    expect(CANDIDATE_DECAY_MATRIX.constraint.cold.eligible).toBe(true);
    const { occurrence, selectedPolicy } = goldenObjects();
    const constraintPayload: Omit<EvidenceOccurrenceV1, "occurrenceId"> = {
      ...occurrence,
      sourceClass: "kg-assertion",
      evidenceKind: "constraint",
      sourceRef: "kg:projects/engram-retention",
      parserVersion: "kg-assertion-v3",
      kgDecay: { tier: "warm", accessCount: 2 },
      provenanceRootId: digest("constraint-root"),
    };
    const constraint = { ...constraintPayload, occurrenceId: occurrenceIdV1(constraintPayload) };
    const ranking = computeCandidateRankingV1({ occurrences: [occurrence, constraint], policy: selectedPolicy, snapshotAt: NOW });
    const golden = JSON.parse(readFileSync(join(FIXTURES, "golden-digests.v1.json"), "utf8")).rankingBaseFirst;
    expect({ baseScore: ranking.baseScore, decayPenalty: ranking.decayPenalty, score: ranking.score }).toEqual({
      baseScore: golden.expectedBaseScore,
      decayPenalty: golden.expectedDecayPenalty,
      score: golden.expectedScore,
    });
  });

  test("lifecycle table has one owner and closes review rejection/expiry paths", () => {
    expect(validateLifecycleTransition("pending", "deferred", "source_unstable").correlationIds).toEqual(["candidateId", "assessmentId"]);
    expect(validateLifecycleTransition("deferred", "pending", "selected").correlationIds).toEqual(["candidateId", "assessmentId"]);
    expect(validateLifecycleTransition("pending", "reserved", "reservation_acquired").requiresReservationOwner).toBe(true);
    expect(validateLifecycleTransition("reserved", "pending", "plan_cancelled_before_effect").releasesReservation).toBe(true);
    expect(validateLifecycleTransition("review_pending", "deferred", "review_rejected_retryable").releasesReservation).toBe(true);
    expect(validateLifecycleTransition("review_pending", "dismissed", "review_expired_terminal").terminal).toBe(true);
    expect(validateLifecycleTransition("reserved", "deferred", "review_policy_rejected_retryable").releasesReservation).toBe(true);
    expect(() => validateLifecycleTransition("evaluated", "pending", "selected")).toThrow("unsupported candidate lifecycle transition");
    expect(CANDIDATE_LIFECYCLE_TRANSITIONS.filter((entry) => ["evaluated", "dismissed", "invalidated"].includes(entry.from))).toHaveLength(0);
    expect(CANDIDATE_LIFECYCLE_TRANSITIONS.every((entry) => entry.expectedRevision === "required" && entry.replay === "byte-equivalent-noop")).toBe(true);
    expect(CANDIDATE_LIFECYCLE_TRANSITIONS.filter((entry) => entry.from === "review_pending").every((entry) => entry.owner === "candidate-review-reconciler")).toBe(true);
  });

  test("reason registry is content-free and covers every transition", () => {
    expect(Object.values(CANDIDATE_REASON_REGISTRY).every((entry) => entry.contentFree)).toBe(true);
    for (const transition of CANDIDATE_LIFECYCLE_TRANSITIONS) {
      for (const reason of transition.reasonCodes) expect(CANDIDATE_REASON_REGISTRY[reason]).toBeDefined();
    }
  });

  test("canonicalization and identity digests match checked-in golden values", () => {
    const golden = JSON.parse(readFileSync(join(FIXTURES, "golden-digests.v1.json"), "utf8"));
    const { occurrence, cluster, selectedPolicy, registry } = goldenObjects();
    const recovery = goldenRecoveryDigests();
    const actual = {
      semanticKey: cluster.semanticKey,
      occurrenceId: occurrence.occurrenceId,
      candidateId: cluster.candidateId,
      evidenceSetDigest: cluster.evidenceSetDigest,
      assessmentId: selectionAssessmentId({
        batchId: "nightly-2026-08-14T00:40:00Z",
        candidateId: cluster.candidateId,
        expectedCandidateRevision: 1,
        lifecycleInputsDigest: digest("lifecycle-v1"),
        accessStateRevision: 7,
        decayPolicyDigest: digest("decay-v1"),
      }),
      ...recovery,
    };
    expect(actual).toEqual(golden.digests);
    for (const entry of golden.normalizationCases) expect(normalizeCandidateStatement(entry.input)).toBe(entry.normalized);
    for (const group of golden.semanticEquivalenceGroups) {
      expect(new Set(group.map((statement: string) => semanticKeyV1(statement))).size).toBe(1);
    }
    for (const [left, right] of golden.semanticDistinctPairs) expect(semanticKeyV1(left)).not.toBe(semanticKeyV1(right));

    const maxStatement = "x".repeat(golden.boundaries.maxStatementLength);
    const maxPayload: Omit<EvidenceOccurrenceV1, "occurrenceId"> = {
      ...occurrence,
      canonicalStatement: maxStatement,
      contentDigest: digest(maxStatement),
      semanticKey: semanticKeyV1(maxStatement),
    };
    expect(validateEvidenceOccurrenceV1({ ...maxPayload, occurrenceId: occurrenceIdV1(maxPayload) }, occurrenceContext(selectedPolicy, registry)).canonicalStatement.length).toBe(golden.boundaries.maxStatementLength);
    const overLimit = "x".repeat(golden.boundaries.overLimitLength);
    const overPayload = { ...maxPayload, canonicalStatement: overLimit, contentDigest: digest(overLimit), semanticKey: semanticKeyV1(overLimit) };
    expect(() => validateEvidenceOccurrenceV1({ ...overPayload, occurrenceId: occurrenceIdV1(overPayload) }, occurrenceContext(selectedPolicy, registry))).toThrow("canonicalStatement is invalid");

    const oldPayload: Omit<EvidenceOccurrenceV1, "occurrenceId"> = { ...occurrence, observedAt: golden.ordering.oldestObservedAt, sourceRef: "memory/agent-main/main/2026-08-14.md#decisions:old" };
    const newPayload: Omit<EvidenceOccurrenceV1, "occurrenceId"> = { ...occurrence, observedAt: golden.ordering.newestObservedAt, sourceRef: "memory/agent-main/main/2026-08-14.md#decisions:new" };
    const oldOccurrence = { ...oldPayload, occurrenceId: occurrenceIdV1(oldPayload) };
    const newOccurrence = { ...newPayload, occurrenceId: occurrenceIdV1(newPayload) };
    const ordered = [newOccurrence, oldOccurrence].sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.occurrenceId.localeCompare(right.occurrenceId));
    expect(ordered.map((entry) => entry.sourceRef)).toEqual([oldOccurrence.sourceRef, newOccurrence.sourceRef]);
  });

  test("occurrence, cluster, report, and assessment validators bind frozen payloads", () => {
    const { occurrence, cluster, report, selectedPolicy, registry } = goldenObjects();
    expect(validateEvidenceOccurrenceV1(occurrence, occurrenceContext(selectedPolicy, registry))).toEqual(occurrence);
    expect(validateCandidateClusterV1(cluster)).toEqual(cluster);
    expect(validateCandidateReportV2(report, reportContext(selectedPolicy, registry))).toEqual(report);
    expect(() => validateCandidateReportV2({ ...report, selectedBytes: report.selectedBytes + 1 }, reportContext(selectedPolicy, registry))).toThrow("selectedBytes mismatch");
    expect(() => validateCandidateReportV2({ ...report, reportDigest: digest("forged-report") }, reportContext(selectedPolicy, registry))).toThrow("reportDigest mismatch");
    expect(() => validateEvidenceOccurrenceV1({ ...occurrence, sourceRef: "/opt/openclaw/private.md" }, occurrenceContext(selectedPolicy, registry))).toThrow("workspace-relative");
    expect(() => validateEvidenceOccurrenceV1({ ...occurrence, sourceRef: "../private.md" }, occurrenceContext(selectedPolicy, registry))).toThrow("workspace-relative");
    expect(() => validateEvidenceOccurrenceV1({ ...occurrence, canonicalStatement: "Forged statement" }, occurrenceContext(selectedPolicy, registry))).toThrow("contentDigest mismatch");
    const forgedLifecycleCluster = { ...cluster, lifecycle: { ...cluster.lifecycle, revision: 2 } };
    const forgedLifecycleBase = { ...report, candidates: [forgedLifecycleCluster], selectedBytes: candidateContextBytesV1([forgedLifecycleCluster]) };
    const forgedLifecycleReport = { ...forgedLifecycleBase, reportDigest: candidateReportDigest(forgedLifecycleBase) };
    expect(() => validateCandidateReportV2(forgedLifecycleReport, reportContext(selectedPolicy, registry))).toThrow("lifecycle must initialize pending");
    const forgedRankingCluster = { ...cluster, ranking: { ...cluster.ranking, score: cluster.ranking.score - 1 } };
    const forgedRankingBase = { ...report, candidates: [forgedRankingCluster], selectedBytes: candidateContextBytesV1([forgedRankingCluster]) };
    const forgedRankingReport = { ...forgedRankingBase, reportDigest: candidateReportDigest(forgedRankingBase) };
    expect(() => validateCandidateReportV2(forgedRankingReport, reportContext(selectedPolicy, registry))).toThrow("ranking mismatch");
    const uncitedPayload: Omit<EvidenceOccurrenceV1, "occurrenceId"> = { ...occurrence, sourceRef: "memory/agent-main/main/2026-08-14.md#decisions:uncited", observedAt: "2026-08-14T07:14:00.000Z" };
    const uncitedOccurrence = { ...uncitedPayload, occurrenceId: occurrenceIdV1(uncitedPayload) };
    const duplicateClusterBase = { ...report, considered: 2, eligible: 2, selected: 2, projectedReviews: 2, sourceCounts: { ...report.sourceCounts, "daily-decision": 2 }, occurrences: [uncitedOccurrence, occurrence], candidates: [cluster, cluster], selectedBytes: candidateContextBytesV1([cluster, cluster]) };
    const duplicateClusterReport = { ...duplicateClusterBase, reportDigest: candidateReportDigest(duplicateClusterBase) };
    expect(() => validateCandidateReportV2(duplicateClusterReport, reportContext(selectedPolicy, registry))).toThrow("at most one selected cluster");
    const zeroQuotaPolicy = { ...selectedPolicy, limits: { ...selectedPolicy.limits, sourceQuotas: { ...selectedPolicy.limits.sourceQuotas, "daily-decision": 0 } } };
    const zeroQuotaDigest = candidatePolicyDigestV2(zeroQuotaPolicy);
    const zeroQuotaCluster = { ...cluster, ranking: computeCandidateRankingV1({ occurrences: [occurrence], policy: zeroQuotaPolicy, snapshotAt: NOW }) };
    const zeroQuotaBase = { ...report, policyDigest: zeroQuotaDigest, candidates: [zeroQuotaCluster], selectedBytes: candidateContextBytesV1([zeroQuotaCluster]) };
    const zeroQuotaReport = { ...zeroQuotaBase, reportDigest: candidateReportDigest(zeroQuotaBase) };
    expect(() => validateCandidateReportV2(zeroQuotaReport, reportContext(zeroQuotaPolicy, registry))).toThrow("exceeds source quota");
    const assessmentBase = {
      schema: MEMORY_CANDIDATE_ASSESSMENT_V1_SCHEMA,
      batchId: report.batchId,
      candidateId: cluster.candidateId,
      expectedCandidateRevision: 1,
      lifecycleInputsDigest: digest("lifecycle-v1"),
      accessStateRevision: 7,
      decayPolicyDigest: digest("decay-v1"),
      outcome: "selected" as const,
      reasonCode: "selected" as const,
      assessedAt: NOW,
    };
    const assessment: CandidateSelectionAssessmentV1 = { ...assessmentBase, assessmentId: selectionAssessmentId(assessmentBase) };
    expect(validateCandidateSelectionAssessmentV1(assessment)).toEqual(assessment);
    expect(() => validateCandidateSelectionAssessmentV1({ ...assessment, accessStateRevision: 8 })).toThrow("assessmentId mismatch");
  });

  test("operation, reservation, plan, review outcome, and projection validators close correlations", () => {
    const { cluster, report } = goldenObjects();
    const operationIntent: CandidateOperationV2["intent"] = {
      occurrenceIds: [...cluster.occurrenceIds].sort(),
      candidateCoreDigest: digest(canonicalizeJcs({ workspaceId: cluster.workspaceId, normalizerVersion: cluster.normalizerVersion, semanticKey: cluster.semanticKey, effectiveScope: cluster.effectiveScope, candidateId: cluster.candidateId })),
      candidatePayloadDigest: digest(canonicalizeJcs(cluster)),
      targetRootVersion: "oll-memory-candidates-v1",
    };
    const operationBase = {
      schema: MEMORY_CANDIDATE_OPERATION_V2_SCHEMA,
      reportDigest: report.reportDigest,
      workspaceId: "main",
      candidateId: cluster.candidateId,
      evidenceSetDigest: cluster.evidenceSetDigest,
      intent: operationIntent,
      immutableIntentDigest: candidateOperationIntentDigest(operationIntent),
      status: "intent_recorded" as const,
      reasonCode: "admitted" as const,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const operation: CandidateOperationV2 = { ...operationBase, operationId: candidateOperationId(operationBase) };
    expect(validateCandidateOperationV2(operation)).toEqual(operation);
    expect(() => validateCandidateOperationV2({ ...operation, intent: { ...operation.intent, candidatePayloadDigest: digest("forged-candidate") } })).toThrow("immutableIntentDigest mismatch");
    const effects = pairedEffects(cluster, operation.operationId);
    const planDraft: CandidateApplyPlanV1 = {
      schema: MEMORY_CANDIDATE_APPLY_PLAN_V1_SCHEMA,
      planId: digest("plan-placeholder"),
      operationId: operation.operationId,
      batchId: report.batchId,
      workspaceId: "main",
      contextDigest: digest("context-v2"),
      handoffDigest: digest("handoff-v3"),
      candidateRevisions: { [cluster.candidateId]: 1 },
      reservations: [],
      effects,
      effectCommits: Object.fromEntries(effects.map((effect) => [effect.effectId, { payloadDigest: candidateEffectPayloadDigest(effect), status: "pending", committedAt: null }])),
      status: "reserving",
      reasonCode: "reservation_acquired",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const planId = candidateApplyPlanId(planDraft);
    const reservationDraft: CandidateReservationV1 = {
      schema: MEMORY_CANDIDATE_RESERVATION_V1_SCHEMA,
      reservationId: digest("reservation-placeholder"),
      planId,
      candidateId: cluster.candidateId,
      expectedRevision: 1,
      evidenceSetDigest: cluster.evidenceSetDigest,
      status: "held",
      reasonCode: "reservation_acquired",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const reservation: CandidateReservationV1 = { ...reservationDraft, reservationId: candidateReservationId(reservationDraft) };
    expect(validateCandidateReservationV1(reservation)).toEqual(reservation);
    const plan: CandidateApplyPlanV1 = {
      ...planDraft,
      planId,
      reservations: [reservation],
    };
    expect(validateCandidateApplyPlanV1(plan, applyPlanContext(cluster))).toEqual(plan);
    expect(() => validateCandidateApplyPlanV1({ ...plan, candidateRevisions: {} }, applyPlanContext(cluster))).toThrow("exactly cover");
    expect(() => validateCandidateApplyPlanV1({ ...plan, handoffDigest: digest("different-handoff") }, applyPlanContext(cluster))).toThrow("planId mismatch");
    expect(() => validateCandidateApplyPlanV1({ ...plan, effects: [effects[0]], effectCommits: { [effects[0].effectId]: plan.effectCommits[effects[0].effectId] } }, applyPlanContext(cluster))).toThrow("mandatory review");
    const broadenedReview = { ...effects[1], effectiveScope: { level: "workspace" as const, subject: "main" } };
    const narrowCluster = { ...cluster, effectiveScope: { level: "domain" as const, subject: "engram" } };
    const broadenedEffects = [effects[0], { ...broadenedReview, effectId: candidateEffectId(broadenedReview) }];
    const broadenedBase = { ...plan, effects: broadenedEffects, effectCommits: Object.fromEntries(broadenedEffects.map((effect) => [effect.effectId, { payloadDigest: candidateEffectPayloadDigest(effect), status: "pending", committedAt: null }])) };
    const broadenedPlan = { ...broadenedBase, planId: candidateApplyPlanId(broadenedBase) };
    expect(() => validateCandidateApplyPlanV1(broadenedPlan, applyPlanContext(narrowCluster))).toThrow("actionScope exceeds");
    const outcomeDraft: CandidateReviewOutcomeV1 = {
      schema: MEMORY_CANDIDATE_REVIEW_OUTCOME_V1_SCHEMA,
      outcomeId: digest("outcome-placeholder"),
      operationId: operation.operationId,
      actionId: digest("action-1"),
      reviewId: digest("review-1"),
      expectedReviewRevision: 1,
      actualActorId: "telegram:100000001",
      grantDigest: digest("grant-1"),
      registryRevision: 9,
      registryDigest: digest("registry-r9"),
      candidateRevisions: { [cluster.candidateId]: 2 },
      effectiveScope: cluster.effectiveScope,
      disposition: "approved",
      reasonCode: "review_approved",
      observedAt: NOW,
    };
    const outcome: CandidateReviewOutcomeV1 = { ...outcomeDraft, outcomeId: candidateReviewOutcomeId(outcomeDraft) };
    expect(validateCandidateReviewOutcomeV1(outcome)).toEqual(outcome);
    expect(() => validateCandidateReviewOutcomeV1({ ...outcome, disposition: "expired" })).toThrow("expiry reason");
    const projectionDraft: CandidateProjectionV1 = {
      schema: MEMORY_CANDIDATE_PROJECTION_V1_SCHEMA,
      workspaceId: "main",
      candidateId: cluster.candidateId,
      highestContiguousRevision: 1,
      journalDigest: digest("journal-r1"),
      projectionDigest: digest("projection-placeholder"),
      cluster,
      reservation: null,
      rebuiltAt: NOW,
    };
    const projection: CandidateProjectionV1 = { ...projectionDraft, projectionDigest: candidateProjectionDigest(projectionDraft) };
    expect(validateCandidateProjectionV1(projection)).toEqual(projection);
    expect(() => validateCandidateProjectionV1({ ...projection, highestContiguousRevision: 2 })).toThrow("revision mismatch");
    expect(() => validateCandidateProjectionV1({ ...projection, projectionDigest: digest("forged-projection") })).toThrow("projectionDigest mismatch");
  });

  test("every reviewed blocker has a unique normative clause and target test", () => {
    expect(CANDIDATE_BLOCKER_TRACEABILITY).toHaveLength(21);
    expect(new Set(CANDIDATE_BLOCKER_TRACEABILITY.map((entry) => entry.blocker)).size).toBe(CANDIDATE_BLOCKER_TRACEABILITY.length);
    expect(new Set(CANDIDATE_BLOCKER_TRACEABILITY.map((entry) => entry.targetTest)).size).toBe(CANDIDATE_BLOCKER_TRACEABILITY.length);
    expect(CANDIDATE_BLOCKER_TRACEABILITY.every((entry) => entry.clause.length > 0 && entry.targetTest.length > 0)).toBe(true);
    const redSuite = readFileSync(join(REPO, "target-contracts", "oll-memory-candidates.runtime-target.ts"), "utf8");
    for (const entry of CANDIDATE_BLOCKER_TRACEABILITY) expect(redSuite).toContain(`"${entry.targetTest}"`);
    expect(redSuite).toContain("throw new Error(`RED target contract");
  });
});
