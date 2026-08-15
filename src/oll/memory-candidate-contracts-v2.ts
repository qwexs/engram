import { canonicalizeJcs, type Digest, sha256Digest } from "./handoff-v2";

export const MEMORY_CANDIDATE_POLICY_V2_SCHEMA = "oll.memory-candidate-policy.v2" as const;
export const MEMORY_EVIDENCE_OCCURRENCE_V1_SCHEMA = "oll.memory-evidence-occurrence.v1" as const;
export const MEMORY_CANDIDATE_CLUSTER_V1_SCHEMA = "oll.memory-candidate-cluster.v1" as const;
export const MEMORY_CANDIDATE_REPORT_V2_SCHEMA = "oll.memory-candidate-report.v2" as const;
export const MEMORY_CANDIDATE_ASSESSMENT_V1_SCHEMA = "oll.memory-candidate-assessment.v1" as const;
export const MEMORY_CANDIDATE_OPERATION_V2_SCHEMA = "oll.memory-candidate-operation.v2" as const;
export const MEMORY_CANDIDATE_APPLY_PLAN_V1_SCHEMA = "oll.memory-candidate-apply-plan.v1" as const;
export const MEMORY_CANDIDATE_RESERVATION_V1_SCHEMA = "oll.memory-candidate-reservation.v1" as const;
export const MEMORY_CANDIDATE_REVIEW_OUTCOME_V1_SCHEMA = "oll.memory-candidate-review-outcome.v1" as const;
export const MEMORY_CANDIDATE_PROJECTION_V1_SCHEMA = "oll.memory-candidate-projection.v1" as const;
export const MEMORY_CANDIDATE_DECAY_POLICY_V1_SCHEMA = "oll.memory-candidate-decay-policy.v1" as const;
export const MEMORY_CANDIDATE_RANKING_POLICY_V1_SCHEMA = "oll.memory-candidate-ranking-policy.v1" as const;
export const MEMORY_CANDIDATE_SCOPE_REGISTRY_V1_SCHEMA = "oll.memory-candidate-scope-registry.v1" as const;
export const MEMORY_CANDIDATE_EFFECT_V1_SCHEMA = "oll.memory-candidate-effect.v1" as const;
export const KG_ACCESS_EVENT_V1_SCHEMA = "engram.kg-v3-access-event.v1" as const;

export type CandidateSourceClass =
  | "daily-decision"
  | "daily-learning"
  | "retrieval-card"
  | "domain-decision"
  | "domain-proposal"
  | "kg-assertion";

export type CandidateEvidenceKind = "decision" | "learning" | "preference" | "constraint" | "proposal";

export type CandidateScope =
  | { level: "self"; subject: string }
  | { level: "domain"; subject: string }
  | { level: "workspace"; subject: string };

export type CandidateLifecycleStatus =
  | "pending"
  | "deferred"
  | "reserved"
  | "review_pending"
  | "evaluated"
  | "dismissed"
  | "invalidated";

export type CandidateReasonCode = keyof typeof CANDIDATE_REASON_REGISTRY;

export interface CandidateLimitsV2 {
  maxCandidatesPerRun: number;
  maxContextBytes: number;
  maxOccurrencesPerCluster: number;
  sourceQuotas: Record<CandidateSourceClass, number>;
}

export interface CandidateDecayPolicyV1 {
  schema: typeof MEMORY_CANDIDATE_DECAY_POLICY_V1_SCHEMA;
  hotDays: 7;
  warmDays: 30;
  accessCountCap: 10;
  warmScorePenalty: number;
  coldKgContribution: "provenance-only";
  trustedAccessEventSchema: typeof KG_ACCESS_EVENT_V1_SCHEMA;
}

export interface CandidateRankingPolicyV1 {
  schema: typeof MEMORY_CANDIDATE_RANKING_POLICY_V1_SCHEMA;
  eligibilityThreshold: number;
  baseScores: Record<CandidateEvidenceKind, number>;
  recencyBoostMax: number;
  recencyBoostPerDay: number;
  distinctRootBoostPerRoot: number;
  distinctRootBoostMax: number;
}

export interface CandidateScopeRegistryV1 {
  schema: typeof MEMORY_CANDIDATE_SCOPE_REGISTRY_V1_SCHEMA;
  workspaceId: string;
  revision: number;
  digest: Digest;
  selfToDomain: Record<string, string>;
  domainToWorkspace: Record<string, string>;
  sourceAuthorities: {
    daily: Record<string, CandidateScope>;
    domains: Record<string, CandidateScope>;
    kgScopes: Record<string, CandidateScope>;
  };
}

export interface CandidateContractVersionRegistryV1 {
  compilerVersions: readonly string[];
  normalizerVersions: readonly string[];
  parserVersions: Readonly<Record<CandidateSourceClass, readonly string[]>>;
}

export const CANDIDATE_SUPPORTED_VERSIONS_V1: CandidateContractVersionRegistryV1 = {
  compilerVersions: ["compiler-v2"],
  normalizerVersions: ["semantic-v1"],
  parserVersions: {
    "daily-decision": ["daily-note-v2"],
    "daily-learning": ["daily-note-v2"],
    "retrieval-card": ["retrieval-card-v1"],
    "domain-decision": ["canonical-decisions-v1"],
    "domain-proposal": ["canonical-proposals-v1"],
    "kg-assertion": ["kg-assertion-v3"],
  },
};

export interface CandidateSourcePolicyV2 {
  schema: typeof MEMORY_CANDIDATE_POLICY_V2_SCHEMA;
  mode: "disabled" | "shadow" | "materialize";
  forwardOnlySince: string;
  workspaceTimezone: string;
  legacyTimestampParser: null | {
    version: "legacy-local-v1";
    daylightSavingAmbiguity: "reject" | "earlier" | "later";
  };
  daily: Array<{
    session: string;
    sections: Array<"decisions" | "learnings" | "retrieval-cards">;
    scopeCeiling: CandidateScope;
  }>;
  domains: Array<{
    domainId: string;
    formats: Array<"canonical-decisions-v1" | "canonical-proposals-v1">;
    scopeCeiling: { level: "domain"; subject: string };
  }>;
  kg: Array<{
    entityPrefix: string;
    kinds: Array<"decision" | "preference" | "constraint">;
    admittedScopes: string[];
    scopeMapping: Record<string, CandidateScope>;
  }>;
  limits: CandidateLimitsV2;
  decayPolicy: CandidateDecayPolicyV1;
  rankingPolicy: CandidateRankingPolicyV1;
  sensitiveTextPolicyVersion: string;
}

export interface RankingSnapshotV1 {
  schema: "oll.memory-candidate-ranking.v1";
  score: number;
  baseScore: number;
  recencyBoost: number;
  distinctRootBoost: number;
  decayPenalty: number;
  accessCount: number;
  decayTier: "hot" | "warm" | "cold" | null;
  reasons: CandidateReasonCode[];
  policyDigest: Digest;
}

export interface EvidenceOccurrenceV1 {
  schema: typeof MEMORY_EVIDENCE_OCCURRENCE_V1_SCHEMA;
  occurrenceId: Digest;
  workspaceId: string;
  sourceClass: CandidateSourceClass;
  evidenceKind: CandidateEvidenceKind;
  sourceRef: string;
  sourceVersionDigest: Digest;
  contentDigest: Digest;
  provenanceRootId: Digest | null;
  semanticKey: Digest;
  authoritativeScope: CandidateScope;
  effectiveScope: CandidateScope;
  observedAt: string;
  originalTimestamp: string;
  timezone: string;
  parserVersion: string;
  kgDecay: null | {
    tier: "hot" | "warm" | "cold";
    accessCount: number;
  };
  canonicalStatement: string;
}

export interface CandidateLifecycleV1 {
  status: CandidateLifecycleStatus;
  revision: number;
  evaluationEpoch: number;
  reasonCode: CandidateReasonCode;
  reservationOwner: Digest | null;
  correlationId: Digest;
  updatedAt: string;
}

export interface CandidateClusterV1 {
  schema: typeof MEMORY_CANDIDATE_CLUSTER_V1_SCHEMA;
  candidateId: Digest;
  workspaceId: string;
  normalizerVersion: string;
  evaluationEpoch: number;
  semanticKey: Digest;
  effectiveScope: CandidateScope;
  canonicalStatement: string;
  occurrenceIds: Digest[];
  distinctProvenanceRootIds: Digest[];
  evidenceSetDigest: Digest;
  ranking: RankingSnapshotV1;
  lifecycle: CandidateLifecycleV1;
}

export interface CandidateReportV2 {
  schema: typeof MEMORY_CANDIDATE_REPORT_V2_SCHEMA;
  compilationAttemptId: Digest;
  batchId: string;
  workspaceId: string;
  executionMode: "report-only" | "shadow" | "materialize";
  snapshotAt: string;
  policyDigest: Digest;
  scopeRegistryRevision: number;
  scopeRegistryDigest: Digest;
  compilerVersion: string;
  normalizerVersion: string;
  parserVersions: string[];
  kgAssertionRevision: number;
  kgAssertionDigest: Digest;
  accessStateRevision: number;
  accessStateDigest: Digest;
  considered: number;
  eligible: number;
  selected: number;
  rejected: number;
  selectedBytes: number;
  projectedModelSpawns: number;
  projectedReviews: number;
  sourceCounts: Record<CandidateSourceClass, number>;
  rejectionCounts: Partial<Record<CandidateReasonCode, number>>;
  occurrences: EvidenceOccurrenceV1[];
  candidates: CandidateClusterV1[];
  reportDigest: Digest;
}

export interface CandidateSelectionAssessmentV1 {
  schema: typeof MEMORY_CANDIDATE_ASSESSMENT_V1_SCHEMA;
  assessmentId: Digest;
  batchId: string;
  candidateId: Digest;
  expectedCandidateRevision: number;
  lifecycleInputsDigest: Digest;
  accessStateRevision: number;
  decayPolicyDigest: Digest;
  outcome: "selected" | "deferred" | "invalidated";
  reasonCode: CandidateReasonCode;
  assessedAt: string;
}

export interface CandidateOperationV2 {
  schema: typeof MEMORY_CANDIDATE_OPERATION_V2_SCHEMA;
  operationId: Digest;
  reportDigest: Digest;
  workspaceId: string;
  candidateId: Digest;
  evidenceSetDigest: Digest;
  intent: {
    occurrenceIds: Digest[];
    candidateCoreDigest: Digest;
    candidatePayloadDigest: Digest;
    targetRootVersion: "oll-memory-candidates-v1";
  };
  immutableIntentDigest: Digest;
  status: "intent_recorded" | "committed" | "quarantined";
  reasonCode: CandidateReasonCode;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateReservationV1 {
  schema: typeof MEMORY_CANDIDATE_RESERVATION_V1_SCHEMA;
  reservationId: Digest;
  planId: Digest;
  candidateId: Digest;
  expectedRevision: number;
  evidenceSetDigest: Digest;
  status: "held" | "released" | "review_pending" | "quarantined";
  reasonCode: CandidateReasonCode;
  createdAt: string;
  updatedAt: string;
}

export type CandidatePlannedEffectV1 = {
  schema: typeof MEMORY_CANDIDATE_EFFECT_V1_SCHEMA;
  effectId: Digest;
  actionId: Digest;
  candidateRevisions: Record<string, number>;
  effectiveScope: CandidateScope;
} & (
  | {
    type: "rule_proposal";
    payload: {
      ruleId: string;
      ruleText: string;
      ruleTextDigest: Digest;
      reviewRequired: boolean;
    };
  }
  | {
    type: "mandatory_review";
    payload: {
      reviewId: Digest;
      operationId: Digest;
      ruleId: string;
      expectedReviewRevision: number;
      requiredAction: string;
      requiredGrant: string;
      registryRevision: number;
      registryDigest: Digest;
      assignedReviewer: string | null;
    };
  }
);

export interface CandidateEffectCommitV1 {
  payloadDigest: Digest;
  status: "pending" | "committed";
  committedAt: string | null;
}

export interface CandidateApplyPlanV1 {
  schema: typeof MEMORY_CANDIDATE_APPLY_PLAN_V1_SCHEMA;
  planId: Digest;
  operationId: Digest;
  batchId: string;
  workspaceId: string;
  contextDigest: Digest;
  handoffDigest: Digest;
  candidateRevisions: Record<string, number>;
  reservations: CandidateReservationV1[];
  effects: CandidatePlannedEffectV1[];
  effectCommits: Record<string, CandidateEffectCommitV1>;
  status: "intent_recorded" | "reserving" | "applying" | "terminal" | "quarantined" | "cancelled";
  reasonCode: CandidateReasonCode;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateReviewOutcomeV1 {
  schema: typeof MEMORY_CANDIDATE_REVIEW_OUTCOME_V1_SCHEMA;
  outcomeId: Digest;
  operationId: Digest;
  actionId: Digest;
  reviewId: Digest;
  expectedReviewRevision: number;
  actualActorId: string;
  grantDigest: Digest;
  registryRevision: number;
  registryDigest: Digest;
  candidateRevisions: Record<string, number>;
  effectiveScope: CandidateScope;
  disposition: "approved" | "rejected" | "expired";
  reasonCode: CandidateReasonCode;
  observedAt: string;
}

export interface CandidateProjectionV1 {
  schema: typeof MEMORY_CANDIDATE_PROJECTION_V1_SCHEMA;
  workspaceId: string;
  candidateId: Digest;
  highestContiguousRevision: number;
  journalDigest: Digest;
  projectionDigest: Digest;
  cluster: CandidateClusterV1;
  reservation: CandidateReservationV1 | null;
  rebuiltAt: string;
}

type ReasonDefinition = {
  category: "admission" | "selection" | "lifecycle" | "recovery" | "review";
  terminal: boolean;
  retryable: boolean;
  contentFree: true;
};

export const CANDIDATE_REASON_REGISTRY = {
  admitted: { category: "admission", terminal: false, retryable: false, contentFree: true },
  selected: { category: "selection", terminal: false, retryable: false, contentFree: true },
  not_selected: { category: "selection", terminal: false, retryable: true, contentFree: true },
  source_quota: { category: "selection", terminal: false, retryable: true, contentFree: true },
  byte_budget: { category: "selection", terminal: false, retryable: true, contentFree: true },
  cold_provenance_only: { category: "selection", terminal: false, retryable: true, contentFree: true },
  warm_decay_penalty: { category: "selection", terminal: false, retryable: false, contentFree: true },
  invalid_schema: { category: "admission", terminal: true, retryable: false, contentFree: true },
  unknown_field: { category: "admission", terminal: true, retryable: false, contentFree: true },
  unsupported_source: { category: "admission", terminal: true, retryable: false, contentFree: true },
  unsupported_format: { category: "admission", terminal: true, retryable: false, contentFree: true },
  unsupported_kind: { category: "admission", terminal: true, retryable: false, contentFree: true },
  unsupported_scope: { category: "admission", terminal: true, retryable: false, contentFree: true },
  scope_incomparable: { category: "admission", terminal: true, retryable: false, contentFree: true },
  scope_revoked: { category: "lifecycle", terminal: true, retryable: false, contentFree: true },
  source_revoked: { category: "lifecycle", terminal: true, retryable: false, contentFree: true },
  source_superseded: { category: "lifecycle", terminal: true, retryable: false, contentFree: true },
  source_retracted: { category: "lifecycle", terminal: true, retryable: false, contentFree: true },
  source_unstable: { category: "admission", terminal: false, retryable: true, contentFree: true },
  path_escape: { category: "admission", terminal: true, retryable: false, contentFree: true },
  symlink_rejected: { category: "admission", terminal: true, retryable: false, contentFree: true },
  non_regular_file: { category: "admission", terminal: true, retryable: false, contentFree: true },
  sensitive_text: { category: "admission", terminal: true, retryable: false, contentFree: true },
  timestamp_out_of_window: { category: "admission", terminal: true, retryable: false, contentFree: true },
  timestamp_ambiguous: { category: "admission", terminal: true, retryable: false, contentFree: true },
  timestamp_invalid: { category: "admission", terminal: true, retryable: false, contentFree: true },
  report_verified: { category: "recovery", terminal: false, retryable: false, contentFree: true },
  report_digest_mismatch: { category: "recovery", terminal: true, retryable: false, contentFree: true },
  payload_conflict: { category: "recovery", terminal: true, retryable: false, contentFree: true },
  reservation_acquired: { category: "lifecycle", terminal: false, retryable: false, contentFree: true },
  plan_cancelled_before_effect: { category: "lifecycle", terminal: false, retryable: true, contentFree: true },
  review_created: { category: "review", terminal: false, retryable: false, contentFree: true },
  optimistic_apply: { category: "lifecycle", terminal: true, retryable: false, contentFree: true },
  review_approved: { category: "review", terminal: true, retryable: false, contentFree: true },
  review_rejected_retryable: { category: "review", terminal: false, retryable: true, contentFree: true },
  review_rejected_terminal: { category: "review", terminal: true, retryable: false, contentFree: true },
  review_policy_rejected_retryable: { category: "review", terminal: false, retryable: true, contentFree: true },
  review_policy_rejected_terminal: { category: "review", terminal: true, retryable: false, contentFree: true },
  review_expired_retryable: { category: "review", terminal: false, retryable: true, contentFree: true },
  review_expired_terminal: { category: "review", terminal: true, retryable: false, contentFree: true },
  explicit_ignore: { category: "lifecycle", terminal: true, retryable: false, contentFree: true },
  operator_quarantine: { category: "recovery", terminal: false, retryable: false, contentFree: true },
  replay_verified: { category: "recovery", terminal: false, retryable: false, contentFree: true },
} as const satisfies Record<string, ReasonDefinition>;

export interface CandidateLifecycleTransition {
  from: CandidateLifecycleStatus;
  to: CandidateLifecycleStatus;
  reasonCodes: readonly CandidateReasonCode[];
  terminal: boolean;
  requiresReservationOwner: boolean;
  releasesReservation: boolean;
  expectedRevision: "required";
  correlationIds: readonly ["candidateId", "assessmentId" | "operationId" | "eventId"];
  replay: "byte-equivalent-noop";
  owner: "candidate-store" | "candidate-review-reconciler";
}

const CANDIDATE_LIFECYCLE_TRANSITION_CORE = [
  { from: "pending", to: "deferred", reasonCodes: ["not_selected", "source_quota", "byte_budget", "cold_provenance_only", "source_unstable"], terminal: false, requiresReservationOwner: false, releasesReservation: false, correlationIds: ["candidateId", "assessmentId"] },
  { from: "pending", to: "reserved", reasonCodes: ["reservation_acquired"], terminal: false, requiresReservationOwner: true, releasesReservation: false, correlationIds: ["candidateId", "operationId"] },
  { from: "pending", to: "dismissed", reasonCodes: ["explicit_ignore"], terminal: true, requiresReservationOwner: false, releasesReservation: false, correlationIds: ["candidateId", "eventId"] },
  { from: "pending", to: "invalidated", reasonCodes: ["scope_revoked", "source_revoked", "source_superseded", "source_retracted"], terminal: true, requiresReservationOwner: false, releasesReservation: false, correlationIds: ["candidateId", "eventId"] },
  { from: "deferred", to: "pending", reasonCodes: ["selected"], terminal: false, requiresReservationOwner: false, releasesReservation: false, correlationIds: ["candidateId", "assessmentId"] },
  { from: "deferred", to: "invalidated", reasonCodes: ["scope_revoked", "source_revoked", "source_superseded", "source_retracted"], terminal: true, requiresReservationOwner: false, releasesReservation: false, correlationIds: ["candidateId", "eventId"] },
  { from: "reserved", to: "review_pending", reasonCodes: ["review_created"], terminal: false, requiresReservationOwner: true, releasesReservation: false, correlationIds: ["candidateId", "operationId"] },
  { from: "reserved", to: "evaluated", reasonCodes: ["optimistic_apply"], terminal: true, requiresReservationOwner: true, releasesReservation: true, correlationIds: ["candidateId", "operationId"] },
  { from: "reserved", to: "pending", reasonCodes: ["plan_cancelled_before_effect"], terminal: false, requiresReservationOwner: true, releasesReservation: true, correlationIds: ["candidateId", "operationId"] },
  { from: "reserved", to: "deferred", reasonCodes: ["review_policy_rejected_retryable"], terminal: false, requiresReservationOwner: true, releasesReservation: true, correlationIds: ["candidateId", "operationId"] },
  { from: "reserved", to: "dismissed", reasonCodes: ["review_policy_rejected_terminal"], terminal: true, requiresReservationOwner: true, releasesReservation: true, correlationIds: ["candidateId", "operationId"] },
  { from: "review_pending", to: "evaluated", reasonCodes: ["review_approved"], terminal: true, requiresReservationOwner: true, releasesReservation: true, correlationIds: ["candidateId", "operationId"] },
  { from: "review_pending", to: "deferred", reasonCodes: ["review_rejected_retryable", "review_expired_retryable"], terminal: false, requiresReservationOwner: true, releasesReservation: true, correlationIds: ["candidateId", "operationId"] },
  { from: "review_pending", to: "dismissed", reasonCodes: ["review_rejected_terminal", "review_expired_terminal"], terminal: true, requiresReservationOwner: true, releasesReservation: true, correlationIds: ["candidateId", "operationId"] },
] as const satisfies readonly Omit<CandidateLifecycleTransition, "expectedRevision" | "replay" | "owner">[];

export const CANDIDATE_LIFECYCLE_TRANSITIONS: readonly CandidateLifecycleTransition[] = CANDIDATE_LIFECYCLE_TRANSITION_CORE.map((transition) => ({
  ...transition,
  expectedRevision: "required",
  replay: "byte-equivalent-noop",
  owner: transition.from === "review_pending" ? "candidate-review-reconciler" : "candidate-store",
}));

export const CANDIDATE_SCOPE_RELATION_MATRIX = {
  self: { self: "same-subject-only", domain: "registry-edge-required", workspace: "registry-path-required" },
  domain: { self: "never-broader-than", domain: "same-subject-only", workspace: "registry-edge-required" },
  workspace: { self: "never-broader-than", domain: "never-broader-than", workspace: "same-subject-only" },
} as const;

export const CANDIDATE_DECAY_MATRIX = {
  constraint: {
    hot: { eligible: true, scorePenalty: "none", contribution: "full" },
    warm: { eligible: true, scorePenalty: "warmScorePenalty", contribution: "full" },
    cold: { eligible: true, scorePenalty: "warmScorePenalty", contribution: "full" },
  },
  decision: {
    hot: { eligible: true, scorePenalty: "none", contribution: "full" },
    warm: { eligible: true, scorePenalty: "warmScorePenalty", contribution: "full" },
    cold: { eligible: false, scorePenalty: "not-applicable", contribution: "provenance-only" },
  },
  preference: {
    hot: { eligible: true, scorePenalty: "none", contribution: "full" },
    warm: { eligible: true, scorePenalty: "warmScorePenalty", contribution: "full" },
    cold: { eligible: false, scorePenalty: "not-applicable", contribution: "provenance-only" },
  },
} as const;

export const CANDIDATE_BLOCKER_TRACEABILITY = [
  { blocker: "shadow-actionable-context", clause: "5", targetTest: "shadow-legacy-path-isolation" },
  { blocker: "canonical-domain-parsers", clause: "6.2", targetTest: "production-template-source-fixtures" },
  { blocker: "disabled-protocol-migration", clause: "5,14", targetTest: "disabled-byte-compatible-protocol" },
  { blocker: "compile-recovery-drift", clause: "9,13", targetTest: "report-recovery-frozen-inputs" },
  { blocker: "review-rejection-stranding", clause: "10.1,12", targetTest: "review-outcome-continuation" },
  { blocker: "acl-scope-symlink-privacy", clause: "6.1-6.4", targetTest: "source-admission-adversarial" },
  { blocker: "forged-report-operation", clause: "11", targetTest: "materialization-payload-verification" },
  { blocker: "day-only-forward-boundary", clause: "6.3,17", targetTest: "exact-rfc3339-forward-boundary" },
  { blocker: "cold-kg-not-deprioritized", clause: "8", targetTest: "kg-decay-matrix" },
  { blocker: "cross-layer-duplicate-inflation", clause: "7", targetTest: "provenance-root-deduplication" },
  { blocker: "stale-source-lifecycle", clause: "8,10", targetTest: "live-source-lifecycle-revalidation" },
  { blocker: "report-load-omission", clause: "9,15", targetTest: "projected-load-metrics" },
  { blocker: "duplicate-context-review", clause: "7", targetTest: "single-cluster-single-review" },
  { blocker: "effect-before-ownership", clause: "10,12", targetTest: "reservation-before-effect" },
  { blocker: "scope-config-broadening", clause: "6,12", targetTest: "authoritative-scope-lattice" },
  { blocker: "inflight-decay-drift", clause: "8,13", targetTest: "frozen-selection-assessment" },
  { blocker: "shadow-failure-blocks-legacy", clause: "5,16", targetTest: "shadow-fault-isolation" },
  { blocker: "rollback-strands-v3", clause: "14,18", targetTest: "per-phase-rollback-barrier" },
  { blocker: "scope-narrowing-mutates-identity", clause: "7,8", targetTest: "scope-narrowing-new-identity" },
  { blocker: "truncated-canonical-revision", clause: "4.2", targetTest: "atomic-no-replace-revision" },
  { blocker: "review-evidence-mutation", clause: "7,10", targetTest: "pending-evidence-inbox" },
] as const;

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const WORKSPACE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SUBJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,299}$/;
const RFC3339_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function exactKeys(value: unknown, required: readonly string[], label: string): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const row = value as Record<string, unknown>;
  const expected = new Set(required);
  for (const key of required) invariant(key in row, `${label} missing field: ${key}`);
  for (const key of Object.keys(row)) invariant(expected.has(key), `${label} unknown field: ${key}`);
  return row;
}

function digest(value: unknown, label: string): asserts value is Digest {
  invariant(typeof value === "string" && DIGEST_RE.test(value), `${label} must be a SHA-256 digest`);
}

function instant(value: unknown, label: string): asserts value is string {
  invariant(typeof value === "string", `${label} must be a string`);
  const match = RFC3339_INSTANT_RE.exec(value);
  invariant(match, `${label} must have an explicit RFC3339 offset`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offset, offsetHourText, offsetMinuteText] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  invariant(month >= 1 && month <= 12, `${label} month is invalid`);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  invariant(day >= 1 && day <= daysInMonth, `${label} day is invalid`);
  invariant(hour <= 23 && minute <= 59 && second <= 59, `${label} time is invalid`);
  if (offset !== "Z") invariant(Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59, `${label} offset is invalid`);
  invariant(Number.isFinite(Date.parse(value)), `${label} must be a valid RFC3339 instant`);
}

function ianaTimezone(value: unknown, label: string): asserts value is string {
  invariant(typeof value === "string" && value.length <= 100, `${label} is invalid`);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function safeSourceRef(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 500 || value.includes("\0") || value.includes("\\")) return false;
  const path = value.split("#", 1)[0];
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  if (path.includes(":")) return /^[A-Za-z][A-Za-z0-9._-]{0,31}:[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*$/.test(path);
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function anchoredNamespaceMatch(entityId: string, entityPrefix: string): boolean {
  const escaped = entityPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}[a-z0-9][a-z0-9-]*(?:/[a-z0-9][a-z0-9-]*)*$`).test(entityId);
}

function scope(value: unknown, label: string): asserts value is CandidateScope {
  const row = exactKeys(value, ["level", "subject"], label);
  invariant(["self", "domain", "workspace"].includes(String(row.level)), `${label}.level is invalid`);
  invariant(typeof row.subject === "string" && SUBJECT_RE.test(row.subject), `${label}.subject is invalid`);
}

function integer(value: unknown, label: string, minimum = 0): asserts value is number {
  invariant(Number.isInteger(value) && Number(value) >= minimum, `${label} must be an integer >= ${minimum}`);
}

function stringArray(value: unknown, label: string, allowed?: readonly string[]): asserts value is string[] {
  invariant(Array.isArray(value), `${label} must be an array`);
  invariant(value.every((item) => typeof item === "string" && (!allowed || allowed.includes(item))), `${label} contains an invalid value`);
  invariant(new Set(value).size === value.length, `${label} must be unique`);
}

function recordWithKeys(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  const row = exactKeys(value, keys, label);
  return row;
}

export function validateCandidatePolicyV2(value: unknown): CandidateSourcePolicyV2 {
  const row = exactKeys(value, [
    "schema", "mode", "forwardOnlySince", "workspaceTimezone", "legacyTimestampParser", "daily", "domains", "kg",
    "limits", "decayPolicy", "rankingPolicy", "sensitiveTextPolicyVersion",
  ], "candidate policy");
  invariant(row.schema === MEMORY_CANDIDATE_POLICY_V2_SCHEMA, "candidate policy schema is unsupported");
  invariant(["disabled", "shadow", "materialize"].includes(String(row.mode)), "candidate policy mode is invalid");
  instant(row.forwardOnlySince, "candidate policy forwardOnlySince");
  ianaTimezone(row.workspaceTimezone, "candidate policy workspaceTimezone");
  if (row.legacyTimestampParser !== null) {
    const legacy = exactKeys(row.legacyTimestampParser, ["version", "daylightSavingAmbiguity"], "legacy timestamp parser");
    invariant(legacy.version === "legacy-local-v1", "legacy timestamp parser version is unsupported");
    invariant(["reject", "earlier", "later"].includes(String(legacy.daylightSavingAmbiguity)), "legacy timestamp ambiguity rule is invalid");
  }
  invariant(Array.isArray(row.daily), "candidate policy daily must be an array");
  const dailySessions = new Set<string>();
  for (const [index, value] of row.daily.entries()) {
    const item = exactKeys(value, ["session", "sections", "scopeCeiling"], `daily source ${index}`);
    invariant(typeof item.session === "string" && SUBJECT_RE.test(item.session) && !dailySessions.has(item.session), `daily source ${index} session is invalid or duplicated`);
    dailySessions.add(item.session);
    stringArray(item.sections, `daily source ${index} sections`, ["decisions", "learnings", "retrieval-cards"]);
    invariant(item.sections.length > 0, `daily source ${index} sections must not be empty`);
    scope(item.scopeCeiling, `daily source ${index} scopeCeiling`);
  }
  invariant(Array.isArray(row.domains), "candidate policy domains must be an array");
  const domainIds = new Set<string>();
  for (const [index, value] of row.domains.entries()) {
    const item = exactKeys(value, ["domainId", "formats", "scopeCeiling"], `domain source ${index}`);
    invariant(typeof item.domainId === "string" && SUBJECT_RE.test(item.domainId) && !domainIds.has(item.domainId), `domain source ${index} ID is invalid or duplicated`);
    domainIds.add(item.domainId);
    stringArray(item.formats, `domain source ${index} formats`, ["canonical-decisions-v1", "canonical-proposals-v1"]);
    invariant(item.formats.length > 0, `domain source ${index} formats must not be empty`);
    scope(item.scopeCeiling, `domain source ${index} scopeCeiling`);
    invariant((item.scopeCeiling as CandidateScope).level === "domain" && (item.scopeCeiling as CandidateScope).subject === item.domainId, `domain source ${index} scopeCeiling must match domainId`);
  }
  invariant(Array.isArray(row.kg), "candidate policy kg must be an array");
  const kgPrefixes = new Set<string>();
  for (const [index, value] of row.kg.entries()) {
    const item = exactKeys(value, ["entityPrefix", "kinds", "admittedScopes", "scopeMapping"], `KG source ${index}`);
    invariant(typeof item.entityPrefix === "string" && /^[a-z][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\/$/.test(item.entityPrefix), `KG source ${index} entityPrefix must be an anchored namespace`);
    invariant(!kgPrefixes.has(item.entityPrefix as string), `KG source ${index} entityPrefix is duplicated`);
    invariant([...kgPrefixes].every((prefix) => !(item.entityPrefix as string).startsWith(prefix) && !prefix.startsWith(item.entityPrefix as string)), `KG source ${index} entityPrefix overlaps another namespace`);
    kgPrefixes.add(item.entityPrefix as string);
    stringArray(item.kinds, `KG source ${index} kinds`, ["decision", "preference", "constraint"]);
    stringArray(item.admittedScopes, `KG source ${index} admittedScopes`);
    invariant(item.kinds.length > 0 && item.admittedScopes.length > 0, `KG source ${index} allowlists must not be empty`);
    invariant(item.scopeMapping !== null && typeof item.scopeMapping === "object" && !Array.isArray(item.scopeMapping), `KG source ${index} scopeMapping must be an object`);
    const mappings = item.scopeMapping as Record<string, unknown>;
    invariant(Object.keys(mappings).sort().join("\0") === [...item.admittedScopes].sort().join("\0"), `KG source ${index} scopeMapping must exactly cover admittedScopes`);
    for (const [name, mappedScope] of Object.entries(mappings)) scope(mappedScope, `KG source ${index} scopeMapping.${name}`);
  }
  const limits = exactKeys(row.limits, ["maxCandidatesPerRun", "maxContextBytes", "maxOccurrencesPerCluster", "sourceQuotas"], "candidate limits");
  integer(limits.maxCandidatesPerRun, "maxCandidatesPerRun", 1);
  integer(limits.maxContextBytes, "maxContextBytes", 1024);
  integer(limits.maxOccurrencesPerCluster, "maxOccurrencesPerCluster", 1);
  invariant(Number(limits.maxCandidatesPerRun) <= 200, "maxCandidatesPerRun must be <= 200");
  invariant(Number(limits.maxContextBytes) <= 262_144, "maxContextBytes must be <= 262144");
  invariant(Number(limits.maxOccurrencesPerCluster) <= 100, "maxOccurrencesPerCluster must be <= 100");
  const sourceQuotaKeys: CandidateSourceClass[] = ["daily-decision", "daily-learning", "retrieval-card", "domain-decision", "domain-proposal", "kg-assertion"];
  const quotas = recordWithKeys(limits.sourceQuotas, "sourceQuotas", sourceQuotaKeys);
  for (const key of sourceQuotaKeys) {
    integer(quotas[key], `sourceQuotas.${key}`);
    invariant(Number(quotas[key]) <= 100, `sourceQuotas.${key} must be <= 100`);
  }
  const decay = exactKeys(row.decayPolicy, ["schema", "hotDays", "warmDays", "accessCountCap", "warmScorePenalty", "coldKgContribution", "trustedAccessEventSchema"], "decay policy");
  invariant(decay.schema === MEMORY_CANDIDATE_DECAY_POLICY_V1_SCHEMA, "decay policy schema is unsupported");
  invariant(decay.hotDays === 7 && decay.warmDays === 30 && decay.accessCountCap === 10, "decay policy native boundaries are invalid");
  integer(decay.warmScorePenalty, "warmScorePenalty");
  invariant(decay.coldKgContribution === "provenance-only", "cold KG contribution must be provenance-only");
  invariant(decay.trustedAccessEventSchema === KG_ACCESS_EVENT_V1_SCHEMA, "trusted access event schema is unsupported");
  const ranking = exactKeys(row.rankingPolicy, ["schema", "eligibilityThreshold", "baseScores", "recencyBoostMax", "recencyBoostPerDay", "distinctRootBoostPerRoot", "distinctRootBoostMax"], "ranking policy");
  invariant(ranking.schema === MEMORY_CANDIDATE_RANKING_POLICY_V1_SCHEMA, "ranking policy schema is unsupported");
  for (const key of ["eligibilityThreshold", "recencyBoostMax", "recencyBoostPerDay", "distinctRootBoostPerRoot", "distinctRootBoostMax"] as const) {
    integer(ranking[key], `ranking policy ${key}`);
    invariant(Number(ranking[key]) <= 100, `ranking policy ${key} must be <= 100`);
  }
  const baseScores = recordWithKeys(ranking.baseScores, "ranking policy baseScores", ["decision", "learning", "preference", "constraint", "proposal"]);
  for (const key of ["decision", "learning", "preference", "constraint", "proposal"] as const) {
    integer(baseScores[key], `ranking policy baseScores.${key}`);
    invariant(Number(baseScores[key]) <= 100, `ranking policy baseScores.${key} must be <= 100`);
  }
  invariant(typeof row.sensitiveTextPolicyVersion === "string" && /^privacy-[a-z0-9.-]+$/.test(row.sensitiveTextPolicyVersion), "sensitive text policy version is invalid");
  return value as CandidateSourcePolicyV2;
}

function validateEvidenceOccurrenceShapeV1(value: unknown): EvidenceOccurrenceV1 {
  const row = exactKeys(value, [
    "schema", "occurrenceId", "workspaceId", "sourceClass", "evidenceKind", "sourceRef", "sourceVersionDigest", "contentDigest", "provenanceRootId",
    "semanticKey", "authoritativeScope", "effectiveScope", "observedAt", "originalTimestamp", "timezone", "parserVersion", "kgDecay", "canonicalStatement",
  ], "evidence occurrence");
  invariant(row.schema === MEMORY_EVIDENCE_OCCURRENCE_V1_SCHEMA, "occurrence schema is unsupported");
  digest(row.occurrenceId, "occurrenceId");
  invariant(typeof row.workspaceId === "string" && WORKSPACE_RE.test(row.workspaceId), "occurrence workspaceId is invalid");
  invariant(["daily-decision", "daily-learning", "retrieval-card", "domain-decision", "domain-proposal", "kg-assertion"].includes(String(row.sourceClass)), "occurrence sourceClass is unsupported");
  invariant(["decision", "learning", "preference", "constraint", "proposal"].includes(String(row.evidenceKind)), "occurrence evidenceKind is unsupported");
  const expectedKinds: Record<CandidateSourceClass, readonly CandidateEvidenceKind[]> = {
    "daily-decision": ["decision"], "daily-learning": ["learning"], "retrieval-card": ["decision", "learning"],
    "domain-decision": ["decision"], "domain-proposal": ["proposal"], "kg-assertion": ["decision", "preference", "constraint"],
  };
  invariant(expectedKinds[row.sourceClass as CandidateSourceClass].includes(row.evidenceKind as CandidateEvidenceKind), "occurrence sourceClass/evidenceKind mismatch");
  invariant(safeSourceRef(row.sourceRef), "occurrence sourceRef must be opaque or workspace-relative");
  digest(row.sourceVersionDigest, "sourceVersionDigest");
  digest(row.contentDigest, "contentDigest");
  if (row.provenanceRootId !== null) digest(row.provenanceRootId, "provenanceRootId");
  digest(row.semanticKey, "semanticKey");
  scope(row.authoritativeScope, "authoritativeScope");
  scope(row.effectiveScope, "effectiveScope");
  instant(row.observedAt, "observedAt");
  invariant(typeof row.originalTimestamp === "string" && row.originalTimestamp.length <= 100, "originalTimestamp is invalid");
  ianaTimezone(row.timezone, "timezone");
  invariant(typeof row.parserVersion === "string" && row.parserVersion.length <= 100, "parserVersion is invalid");
  if (row.sourceClass === "kg-assertion") {
    const decay = exactKeys(row.kgDecay, ["tier", "accessCount"], "occurrence kgDecay");
    invariant(["hot", "warm", "cold"].includes(String(decay.tier)), "occurrence KG decay tier is invalid");
    integer(decay.accessCount, "occurrence KG accessCount");
    invariant(Number(decay.accessCount) <= 10, "occurrence KG accessCount exceeds policy cap");
  } else invariant(row.kgDecay === null, "non-KG occurrence must have null kgDecay");
  invariant(typeof row.canonicalStatement === "string" && row.canonicalStatement.trim() === row.canonicalStatement && row.canonicalStatement.length > 0 && row.canonicalStatement.length <= 2000, "canonicalStatement is invalid");
  invariant(row.contentDigest === sha256Digest(row.canonicalStatement), "occurrence contentDigest mismatch");
  invariant(row.semanticKey === semanticKeyV1(row.canonicalStatement), "occurrence semanticKey mismatch");
  invariant(row.occurrenceId === occurrenceIdV1(value as EvidenceOccurrenceV1), "occurrenceId mismatch");
  return value as EvidenceOccurrenceV1;
}

export interface CandidateOccurrenceValidationContext {
  policy: CandidateSourcePolicyV2;
  scopeRegistry: CandidateScopeRegistryV1;
  versions: CandidateContractVersionRegistryV1;
  reportWorkspaceId: string;
}

function exactOccurrenceSourceContract(occurrence: EvidenceOccurrenceV1, policy: CandidateSourcePolicyV2, registry: CandidateScopeRegistryV1): { policyScope: CandidateScope; authoritativeScope: CandidateScope } {
  const escapedWorkspace = occurrence.workspaceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (["daily-decision", "daily-learning", "retrieval-card"].includes(occurrence.sourceClass)) {
    const match = new RegExp(`^memory/agent-${escapedWorkspace}/([^/]+)/[^#]+#(decisions|learnings|retrieval-cards):[^#]+$`).exec(occurrence.sourceRef);
    invariant(match, "daily occurrence sourceRef does not identify an exact canonical session/section");
    const expectedSection = occurrence.sourceClass === "daily-decision" ? "decisions" : occurrence.sourceClass === "daily-learning" ? "learnings" : "retrieval-cards";
    invariant(match[2] === expectedSection, "daily occurrence sourceClass/section mismatch");
    const entries = policy.daily.filter((entry) => entry.session === match[1] && entry.sections.includes(expectedSection));
    invariant(entries.length === 1, "daily occurrence does not match exactly one source policy entry");
    const authoritativeScope = registry.sourceAuthorities.daily[match[1]];
    invariant(authoritativeScope, "daily occurrence lacks trusted source authority");
    return { policyScope: entries[0].scopeCeiling, authoritativeScope };
  }
  if (["domain-decision", "domain-proposal"].includes(occurrence.sourceClass)) {
    const match = /^memory\/domains\/([^/]+)\/[^#]+#(decisions|proposals):[^#]+$/.exec(occurrence.sourceRef);
    invariant(match, "domain occurrence sourceRef does not identify an exact canonical domain/format");
    const expectedFormat = occurrence.sourceClass === "domain-decision" ? "canonical-decisions-v1" : "canonical-proposals-v1";
    const expectedFragment = occurrence.sourceClass === "domain-decision" ? "decisions" : "proposals";
    invariant(match[2] === expectedFragment, "domain occurrence sourceClass/format mismatch");
    const entries = policy.domains.filter((entry) => entry.domainId === match[1] && entry.formats.includes(expectedFormat));
    invariant(entries.length === 1, "domain occurrence does not match exactly one source policy entry");
    const authoritativeScope = registry.sourceAuthorities.domains[match[1]];
    invariant(authoritativeScope, "domain occurrence lacks trusted source authority");
    return { policyScope: entries[0].scopeCeiling, authoritativeScope };
  }
  const kgMatch = /^kg:([a-z][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)$/.exec(occurrence.sourceRef);
  invariant(kgMatch, "KG occurrence sourceRef does not identify an exact entity namespace");
  const entries = policy.kg.flatMap((entry) => entry.kinds.includes(occurrence.evidenceKind as "decision" | "preference" | "constraint") && anchoredNamespaceMatch(kgMatch[1], entry.entityPrefix)
    ? entry.admittedScopes.map((admittedScope) => ({ entry, admittedScope, mappedScope: entry.scopeMapping[admittedScope] }))
    : []).filter(({ mappedScope }) => canonicalizeJcs(mappedScope) === canonicalizeJcs(occurrence.effectiveScope));
  invariant(entries.length === 1, "KG occurrence does not match exactly one entity/kind/scope policy entry");
  const authoritativeScope = registry.sourceAuthorities.kgScopes[entries[0].admittedScope];
  invariant(authoritativeScope, "KG occurrence lacks trusted source authority");
  return { policyScope: entries[0].mappedScope, authoritativeScope };
}

function validateEvidenceOccurrenceAuthority(occurrence: EvidenceOccurrenceV1, context: CandidateOccurrenceValidationContext): void {
  const registry = validateCandidateScopeRegistryV1(context.scopeRegistry);
  const policy = validateCandidatePolicyV2(context.policy);
  invariant(occurrence.workspaceId === context.reportWorkspaceId && occurrence.workspaceId === registry.workspaceId, "occurrence/report/registry workspace mismatch");
  const workspaceScope: CandidateScope = { level: "workspace", subject: context.reportWorkspaceId };
  invariant(scopeContains(registry, workspaceScope, occurrence.authoritativeScope), "occurrence authoritativeScope escapes report workspace");
  invariant(scopeContains(registry, occurrence.authoritativeScope, occurrence.effectiveScope), "occurrence effectiveScope exceeds authoritativeScope");
  const sourceContract = exactOccurrenceSourceContract(occurrence, policy, registry);
  invariant(canonicalizeJcs(occurrence.authoritativeScope) === canonicalizeJcs(sourceContract.authoritativeScope), "occurrence authoritativeScope does not match trusted source registry");
  const policyScope = sourceContract.policyScope;
  invariant(scopeContains(registry, workspaceScope, policyScope), "occurrence source policy scope escapes report workspace");
  const expectedEffective = intersectCandidateScopes(registry, occurrence.authoritativeScope, policyScope);
  invariant(expectedEffective && canonicalizeJcs(expectedEffective) === canonicalizeJcs(occurrence.effectiveScope), "occurrence effectiveScope does not equal authoritative/policy intersection");
  invariant(context.versions.parserVersions[occurrence.sourceClass]?.includes(occurrence.parserVersion), "occurrence parserVersion is unsupported for source class");
}

export function validateEvidenceOccurrenceV1(value: unknown, context: CandidateOccurrenceValidationContext): EvidenceOccurrenceV1 {
  const occurrence = validateEvidenceOccurrenceShapeV1(value);
  validateEvidenceOccurrenceAuthority(occurrence, context);
  return occurrence;
}

export function validateCandidateClusterV1(value: unknown): CandidateClusterV1 {
  const row = exactKeys(value, [
    "schema", "candidateId", "workspaceId", "normalizerVersion", "evaluationEpoch", "semanticKey", "effectiveScope", "canonicalStatement",
    "occurrenceIds", "distinctProvenanceRootIds", "evidenceSetDigest", "ranking", "lifecycle",
  ], "candidate cluster");
  invariant(row.schema === MEMORY_CANDIDATE_CLUSTER_V1_SCHEMA, "cluster schema is unsupported");
  digest(row.candidateId, "candidateId");
  invariant(typeof row.workspaceId === "string" && WORKSPACE_RE.test(row.workspaceId), "cluster workspaceId is invalid");
  invariant(typeof row.normalizerVersion === "string" && row.normalizerVersion.length <= 100, "normalizerVersion is invalid");
  integer(row.evaluationEpoch, "evaluationEpoch", 1);
  digest(row.semanticKey, "semanticKey");
  scope(row.effectiveScope, "effectiveScope");
  invariant(typeof row.canonicalStatement === "string" && row.canonicalStatement.length > 0 && row.canonicalStatement.length <= 2000, "cluster canonicalStatement is invalid");
  stringArray(row.occurrenceIds, "occurrenceIds");
  invariant(row.occurrenceIds.length > 0, "occurrenceIds must not be empty");
  for (const id of row.occurrenceIds) digest(id, "occurrenceId");
  stringArray(row.distinctProvenanceRootIds, "distinctProvenanceRootIds");
  for (const id of row.distinctProvenanceRootIds) digest(id, "provenanceRootId");
  invariant([...row.distinctProvenanceRootIds].sort().join("\0") === row.distinctProvenanceRootIds.join("\0"), "distinctProvenanceRootIds must be sorted");
  digest(row.evidenceSetDigest, "evidenceSetDigest");
  invariant(row.evidenceSetDigest === evidenceSetDigestV1(row.occurrenceIds as Digest[]), "evidenceSetDigest mismatch");
  invariant(row.candidateId === candidateIdV1({
    workspaceId: row.workspaceId as string,
    normalizerVersion: row.normalizerVersion as string,
    semanticKey: row.semanticKey as Digest,
    effectiveScope: row.effectiveScope as CandidateScope,
  }), "candidateId mismatch");
  validateRankingSnapshot(row.ranking);
  validateCandidateLifecycle(row.lifecycle);
  return value as CandidateClusterV1;
}

function validateRankingSnapshot(value: unknown): RankingSnapshotV1 {
  const row = exactKeys(value, ["schema", "score", "baseScore", "recencyBoost", "distinctRootBoost", "decayPenalty", "accessCount", "decayTier", "reasons", "policyDigest"], "ranking snapshot");
  invariant(row.schema === "oll.memory-candidate-ranking.v1", "ranking schema is unsupported");
  for (const key of ["score", "baseScore", "recencyBoost", "distinctRootBoost", "decayPenalty", "accessCount"] as const) integer(row[key], `ranking.${key}`);
  invariant(Number(row.score) <= 100, "ranking score must be <= 100");
  invariant(row.decayTier === null || ["hot", "warm", "cold"].includes(String(row.decayTier)), "ranking decayTier is invalid");
  stringArray(row.reasons, "ranking reasons", Object.keys(CANDIDATE_REASON_REGISTRY));
  digest(row.policyDigest, "ranking policyDigest");
  return value as RankingSnapshotV1;
}

function validateCandidateLifecycle(value: unknown): CandidateLifecycleV1 {
  const row = exactKeys(value, ["status", "revision", "evaluationEpoch", "reasonCode", "reservationOwner", "correlationId", "updatedAt"], "candidate lifecycle");
  invariant(["pending", "deferred", "reserved", "review_pending", "evaluated", "dismissed", "invalidated"].includes(String(row.status)), "candidate lifecycle status is invalid");
  integer(row.revision, "candidate lifecycle revision", 1);
  integer(row.evaluationEpoch, "candidate lifecycle evaluationEpoch", 1);
  invariant(typeof row.reasonCode === "string" && row.reasonCode in CANDIDATE_REASON_REGISTRY, "candidate lifecycle reasonCode is invalid");
  const lifecycleReasons: Record<CandidateLifecycleStatus, readonly CandidateReasonCode[]> = {
    pending: ["admitted", "selected", "plan_cancelled_before_effect"],
    deferred: ["not_selected", "source_quota", "byte_budget", "cold_provenance_only", "source_unstable", "review_rejected_retryable", "review_expired_retryable", "review_policy_rejected_retryable"],
    reserved: ["reservation_acquired"], review_pending: ["review_created"], evaluated: ["review_approved", "optimistic_apply"],
    dismissed: ["explicit_ignore", "review_rejected_terminal", "review_expired_terminal", "review_policy_rejected_terminal"],
    invalidated: ["scope_revoked", "source_revoked", "source_superseded", "source_retracted"],
  };
  invariant(lifecycleReasons[row.status as CandidateLifecycleStatus].includes(row.reasonCode as CandidateReasonCode), "candidate lifecycle status/reason mismatch");
  if (row.reservationOwner !== null) digest(row.reservationOwner, "candidate lifecycle reservationOwner");
  if (["reserved", "review_pending"].includes(String(row.status))) invariant(row.reservationOwner !== null, "reserved lifecycle states require reservationOwner");
  digest(row.correlationId, "candidate lifecycle correlationId");
  instant(row.updatedAt, "candidate lifecycle updatedAt");
  return value as CandidateLifecycleV1;
}

export function candidatePolicyDigestV2(policy: CandidateSourcePolicyV2): Digest {
  return sha256Digest(canonicalizeJcs(policy));
}

export function candidateScopeRegistryDigestV1(registry: Omit<CandidateScopeRegistryV1, "digest"> | CandidateScopeRegistryV1): Digest {
  const { digest: _ignored, ...base } = registry as CandidateScopeRegistryV1;
  return sha256Digest(canonicalizeJcs(base));
}

export function validateCandidateScopeRegistryV1(value: unknown): CandidateScopeRegistryV1 {
  const row = exactKeys(value, ["schema", "workspaceId", "revision", "digest", "selfToDomain", "domainToWorkspace", "sourceAuthorities"], "candidate scope registry");
  invariant(row.schema === MEMORY_CANDIDATE_SCOPE_REGISTRY_V1_SCHEMA, "scope registry schema is unsupported");
  invariant(typeof row.workspaceId === "string" && WORKSPACE_RE.test(row.workspaceId), "scope registry workspaceId is invalid");
  integer(row.revision, "scope registry revision", 1);
  digest(row.digest, "scope registry digest");
  for (const field of ["selfToDomain", "domainToWorkspace"] as const) {
    invariant(row[field] !== null && typeof row[field] === "object" && !Array.isArray(row[field]), `scope registry ${field} must be an object`);
    for (const [left, right] of Object.entries(row[field] as Record<string, unknown>)) {
      invariant(SUBJECT_RE.test(left) && typeof right === "string" && SUBJECT_RE.test(right), `scope registry ${field} contains an invalid edge`);
    }
  }
  const selfToDomain = row.selfToDomain as Record<string, string>;
  const domainToWorkspace = row.domainToWorkspace as Record<string, string>;
  invariant(Object.values(domainToWorkspace).every((workspaceId) => workspaceId === row.workspaceId), "scope registry domain escapes workspace");
  invariant(Object.values(selfToDomain).every((domainId) => domainToWorkspace[domainId] === row.workspaceId), "scope registry self edge lacks an in-workspace domain path");
  const sourceAuthorities = exactKeys(row.sourceAuthorities, ["daily", "domains", "kgScopes"], "scope registry sourceAuthorities");
  const workspaceScope: CandidateScope = { level: "workspace", subject: row.workspaceId as string };
  for (const field of ["daily", "domains", "kgScopes"] as const) {
    invariant(sourceAuthorities[field] !== null && typeof sourceAuthorities[field] === "object" && !Array.isArray(sourceAuthorities[field]), `scope registry sourceAuthorities.${field} must be an object`);
    for (const [sourceId, sourceScope] of Object.entries(sourceAuthorities[field] as Record<string, unknown>)) {
      invariant(SUBJECT_RE.test(sourceId), `scope registry sourceAuthorities.${field} contains an invalid source ID`);
      scope(sourceScope, `scope registry sourceAuthorities.${field}.${sourceId}`);
      invariant(scopeContains(value as CandidateScopeRegistryV1, workspaceScope, sourceScope), `scope registry sourceAuthorities.${field}.${sourceId} escapes workspace`);
      if (field === "domains") invariant((sourceScope as CandidateScope).level === "domain" && (sourceScope as CandidateScope).subject === sourceId, `scope registry domain authority must match domain ID`);
    }
  }
  invariant(row.digest === candidateScopeRegistryDigestV1(value as CandidateScopeRegistryV1), "scope registry digest mismatch");
  return value as CandidateScopeRegistryV1;
}

export function computeCandidateRankingV1(options: {
  occurrences: readonly EvidenceOccurrenceV1[];
  policy: CandidateSourcePolicyV2;
  snapshotAt: string;
}): RankingSnapshotV1 {
  instant(options.snapshotAt, "ranking snapshotAt");
  invariant(options.occurrences.length > 0, "ranking requires occurrences");
  const eligible = options.occurrences.flatMap((occurrence) => {
    const coldProvenanceOnly = occurrence.sourceClass === "kg-assertion"
      && occurrence.kgDecay?.tier === "cold"
      && ["decision", "preference"].includes(occurrence.evidenceKind);
    if (coldProvenanceOnly) return [];
    const decayPenalty = occurrence.sourceClass === "kg-assertion"
      && occurrence.kgDecay
      && ["warm", "cold"].includes(occurrence.kgDecay.tier)
      ? options.policy.decayPolicy.warmScorePenalty
      : 0;
    return [{
      occurrence,
      baseScore: options.policy.rankingPolicy.baseScores[occurrence.evidenceKind],
      decayPenalty,
      adjustedBase: Math.max(0, options.policy.rankingPolicy.baseScores[occurrence.evidenceKind] - decayPenalty),
    }];
  });
  invariant(eligible.length > 0, "ranking has no eligible occurrence");
  const base = [...eligible].sort((left, right) => right.baseScore - left.baseScore || right.occurrence.observedAt.localeCompare(left.occurrence.observedAt) || left.occurrence.occurrenceId.localeCompare(right.occurrence.occurrenceId))[0];
  const newest = [...eligible].sort((left, right) => right.occurrence.observedAt.localeCompare(left.occurrence.observedAt) || left.occurrence.occurrenceId.localeCompare(right.occurrence.occurrenceId))[0].occurrence;
  const recencyDays = Math.max(0, Math.floor((Date.parse(options.snapshotAt) - Date.parse(newest.observedAt)) / 86_400_000));
  const recencyBoost = Math.max(0, options.policy.rankingPolicy.recencyBoostMax - recencyDays * options.policy.rankingPolicy.recencyBoostPerDay);
  const roots = new Set(eligible.flatMap((entry) => entry.occurrence.provenanceRootId ? [entry.occurrence.provenanceRootId] : []));
  const distinctRootBoost = Math.min(options.policy.rankingPolicy.distinctRootBoostMax, Math.max(0, roots.size - 1) * options.policy.rankingPolicy.distinctRootBoostPerRoot);
  const score = Math.max(0, Math.min(100, base.adjustedBase + recencyBoost + distinctRootBoost));
  const reasons = new Set<CandidateReasonCode>(["admitted"]);
  if (base.decayPenalty) reasons.add("warm_decay_penalty");
  if (options.occurrences.some((occurrence) => occurrence.sourceClass === "kg-assertion" && occurrence.kgDecay?.tier === "cold" && ["decision", "preference"].includes(occurrence.evidenceKind))) reasons.add("cold_provenance_only");
  return {
    schema: "oll.memory-candidate-ranking.v1",
    score,
    baseScore: base.baseScore,
    recencyBoost,
    distinctRootBoost,
    decayPenalty: base.decayPenalty,
    accessCount: Math.min(options.policy.decayPolicy.accessCountCap, Math.max(0, ...options.occurrences.map((occurrence) => occurrence.kgDecay?.accessCount || 0))),
    decayTier: base.occurrence.kgDecay?.tier || null,
    reasons: [...reasons].sort(),
    policyDigest: candidatePolicyDigestV2(options.policy),
  };
}

function greatestSafeScopeIntersection(registry: CandidateScopeRegistryV1, scopes: readonly CandidateScope[]): CandidateScope {
  invariant(scopes.length > 0, "scope intersection requires at least one scope");
  let current = scopes[0];
  for (const candidate of scopes.slice(1)) {
    const intersection = intersectCandidateScopes(registry, current, candidate);
    invariant(intersection, "candidate occurrence scopes are incomparable");
    current = intersection;
  }
  return current;
}

function canonicalOccurrenceForCluster(registry: CandidateScopeRegistryV1, occurrences: readonly EvidenceOccurrenceV1[]): EvidenceOccurrenceV1 {
  const narrowest = greatestSafeScopeIntersection(registry, occurrences.map((occurrence) => occurrence.effectiveScope));
  const atNarrowest = occurrences.filter((occurrence) => canonicalizeJcs(occurrence.effectiveScope) === canonicalizeJcs(narrowest));
  invariant(atNarrowest.length > 0, "cluster has no occurrence at its effective scope");
  return [...atNarrowest].sort((left, right) => right.observedAt.localeCompare(left.observedAt) || left.occurrenceId.localeCompare(right.occurrenceId))[0];
}

export function validateCandidateReportV2(value: unknown, context: { policy: CandidateSourcePolicyV2; scopeRegistry: CandidateScopeRegistryV1; versions: CandidateContractVersionRegistryV1 }): CandidateReportV2 {
  const row = exactKeys(value, [
    "schema", "compilationAttemptId", "batchId", "workspaceId", "executionMode", "snapshotAt", "policyDigest", "scopeRegistryRevision", "scopeRegistryDigest", "compilerVersion", "normalizerVersion",
    "parserVersions", "kgAssertionRevision", "kgAssertionDigest", "accessStateRevision", "accessStateDigest", "considered", "eligible", "selected", "rejected",
    "selectedBytes", "projectedModelSpawns", "projectedReviews", "sourceCounts", "rejectionCounts", "occurrences", "candidates", "reportDigest",
  ], "candidate report");
  invariant(row.schema === MEMORY_CANDIDATE_REPORT_V2_SCHEMA, "report schema is unsupported");
  for (const key of ["compilationAttemptId", "policyDigest", "scopeRegistryDigest", "kgAssertionDigest", "accessStateDigest", "reportDigest"] as const) digest(row[key], `report ${key}`);
  invariant(typeof row.batchId === "string" && row.batchId.length <= 300, "report batchId is invalid");
  invariant(typeof row.workspaceId === "string" && WORKSPACE_RE.test(row.workspaceId), "report workspaceId is invalid");
  invariant(["report-only", "shadow", "materialize"].includes(String(row.executionMode)), "report executionMode is invalid");
  instant(row.snapshotAt, "report snapshotAt");
  const policy = validateCandidatePolicyV2(context.policy);
  const registry = validateCandidateScopeRegistryV1(context.scopeRegistry);
  invariant(policy.mode !== "disabled", "disabled policy cannot produce a candidate report");
  if (row.executionMode !== "report-only") invariant(row.executionMode === policy.mode, "report executionMode/policy mode mismatch");
  invariant(row.policyDigest === candidatePolicyDigestV2(policy), "report policy digest mismatch");
  integer(row.scopeRegistryRevision, "report scopeRegistryRevision", 1);
  invariant(row.scopeRegistryRevision === registry.revision && row.scopeRegistryDigest === registry.digest, "report scope registry correlation mismatch");
  invariant(row.workspaceId === registry.workspaceId, "report/scope registry workspace mismatch");
  invariant(typeof row.compilerVersion === "string" && context.versions.compilerVersions.includes(row.compilerVersion), "report compilerVersion is unsupported");
  invariant(typeof row.normalizerVersion === "string" && context.versions.normalizerVersions.includes(row.normalizerVersion), "report normalizerVersion is unsupported");
  stringArray(row.parserVersions, "report parserVersions");
  for (const key of ["kgAssertionRevision", "accessStateRevision", "considered", "eligible", "selected", "rejected", "selectedBytes", "projectedModelSpawns", "projectedReviews"] as const) integer(row[key], `report ${key}`);
  invariant(Number(row.considered) === Number(row.eligible) + Number(row.rejected), "report considered count mismatch");
  invariant(Number(row.selected) <= Number(row.eligible), "report selected cannot exceed eligible");
  const sourceClasses: CandidateSourceClass[] = ["daily-decision", "daily-learning", "retrieval-card", "domain-decision", "domain-proposal", "kg-assertion"];
  const sourceCounts = recordWithKeys(row.sourceCounts, "report sourceCounts", sourceClasses);
  for (const key of sourceClasses) integer(sourceCounts[key], `report sourceCounts.${key}`);
  invariant(row.rejectionCounts !== null && typeof row.rejectionCounts === "object" && !Array.isArray(row.rejectionCounts), "report rejectionCounts must be an object");
  for (const [reason, count] of Object.entries(row.rejectionCounts as Record<string, unknown>)) {
    invariant(reason in CANDIDATE_REASON_REGISTRY, `report rejectionCounts has unknown reason: ${reason}`);
    integer(count, `report rejectionCounts.${reason}`);
  }
  invariant(Array.isArray(row.occurrences), "report occurrences must be an array");
  const occurrences = row.occurrences.map((occurrence) => validateEvidenceOccurrenceV1(occurrence, {
    policy,
    scopeRegistry: registry,
    versions: context.versions,
    reportWorkspaceId: row.workspaceId as string,
  }));
  const exactParserVersions = [...new Set(occurrences.map((occurrence) => occurrence.parserVersion))].sort();
  invariant(canonicalizeJcs(exactParserVersions) === canonicalizeJcs([...(row.parserVersions as string[])].sort()), "report parserVersions do not exactly match occurrences");
  invariant(occurrences.every((occurrence) => occurrence.workspaceId === row.workspaceId), "report occurrence workspace mismatch");
  const occurrenceById = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  invariant(occurrenceById.size === occurrences.length, "report occurrence IDs must be unique");
  const actualSourceCounts = Object.fromEntries(sourceClasses.map((sourceClass) => [sourceClass, occurrences.filter((occurrence) => occurrence.sourceClass === sourceClass).length]));
  invariant(canonicalizeJcs(actualSourceCounts) === canonicalizeJcs(sourceCounts), "report sourceCounts mismatch");
  const rejectedCount = Object.values(row.rejectionCounts as Record<string, number>).reduce((sum, count) => sum + count, 0);
  invariant(Number(row.rejected) === rejectedCount, "report rejected count mismatch");
  invariant(Number(row.considered) === occurrences.length + rejectedCount, "report considered count mismatch");
  invariant(Number(row.eligible) === occurrences.length, "report eligible count mismatch");
  invariant(Array.isArray(row.candidates), "report candidates must be an array");
  const candidates = row.candidates.map((candidate) => validateCandidateClusterV1(candidate));
  invariant(Number(row.selected) === candidates.length, "report selected count mismatch");
  invariant(Number(row.selectedBytes) === candidateContextBytesV1(candidates), "report selectedBytes mismatch");
  invariant(Number(row.projectedModelSpawns) === (candidates.length === 0 ? 0 : 1), "report projectedModelSpawns mismatch");
  invariant(Number(row.projectedReviews) === candidates.length, "report projectedReviews mismatch");
  invariant(candidates.length <= policy.limits.maxCandidatesPerRun, "report exceeds candidate limit");
  invariant(Number(row.selectedBytes) <= policy.limits.maxContextBytes, "report exceeds context byte limit");
  const quotaUse = new Map<CandidateSourceClass, number>();
  const occurrenceClusterUse = new Map<Digest, Digest>();
  for (const candidate of candidates) {
    invariant(candidate.workspaceId === row.workspaceId, "report candidate workspace mismatch");
    const cited = candidate.occurrenceIds.map((id) => occurrenceById.get(id));
    invariant(cited.every(Boolean), "report candidate cites an unknown occurrence");
    const typedCited = cited as EvidenceOccurrenceV1[];
    for (const occurrence of typedCited) {
      invariant(!occurrenceClusterUse.has(occurrence.occurrenceId), "report occurrence may belong to at most one selected cluster");
      occurrenceClusterUse.set(occurrence.occurrenceId, candidate.candidateId);
    }
    invariant(typedCited.every((occurrence) => occurrence.semanticKey === candidate.semanticKey), "report candidate occurrence semantic key mismatch");
    invariant(typedCited.length <= policy.limits.maxOccurrencesPerCluster, "report candidate exceeds occurrence limit");
    const intersection = greatestSafeScopeIntersection(registry, typedCited.map((occurrence) => occurrence.effectiveScope));
    invariant(canonicalizeJcs(intersection) === canonicalizeJcs(candidate.effectiveScope), "report candidate scope intersection mismatch");
    const orderedIds = [...typedCited].sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.occurrenceId.localeCompare(right.occurrenceId)).map((occurrence) => occurrence.occurrenceId);
    invariant(canonicalizeJcs(orderedIds) === canonicalizeJcs(candidate.occurrenceIds), "report candidate occurrence order mismatch");
    const roots = [...new Set(typedCited.flatMap((occurrence) => occurrence.provenanceRootId ? [occurrence.provenanceRootId] : []))].sort();
    invariant(canonicalizeJcs(roots) === canonicalizeJcs(candidate.distinctProvenanceRootIds), "report candidate provenance roots mismatch");
    const canonicalOccurrence = canonicalOccurrenceForCluster(registry, typedCited);
    invariant(candidate.canonicalStatement === canonicalOccurrence.canonicalStatement, "report candidate canonical statement mismatch");
    const expectedRanking = computeCandidateRankingV1({ occurrences: typedCited, policy, snapshotAt: row.snapshotAt as string });
    invariant(canonicalizeJcs(candidate.ranking) === canonicalizeJcs(expectedRanking), "report candidate ranking mismatch");
    invariant(candidate.ranking.score >= policy.rankingPolicy.eligibilityThreshold, "report contains an ineligible candidate");
    invariant(candidate.lifecycle.status === "pending" && candidate.lifecycle.revision === 1 && candidate.lifecycle.evaluationEpoch === 1 && candidate.lifecycle.reasonCode === "admitted" && candidate.lifecycle.reservationOwner === null, "report candidate lifecycle must initialize pending at revision 1");
    const used = (quotaUse.get(canonicalOccurrence.sourceClass) || 0) + 1;
    quotaUse.set(canonicalOccurrence.sourceClass, used);
    invariant(used <= policy.limits.sourceQuotas[canonicalOccurrence.sourceClass], `report exceeds source quota: ${canonicalOccurrence.sourceClass}`);
  }
  const candidateIds = candidates.map((candidate) => candidate.candidateId);
  invariant(new Set(candidateIds).size === candidateIds.length, "report candidate IDs must be unique");
  invariant(row.reportDigest === candidateReportDigest(value as CandidateReportV2), "reportDigest mismatch");
  return value as CandidateReportV2;
}

export function validateCandidateSelectionAssessmentV1(value: unknown): CandidateSelectionAssessmentV1 {
  const row = exactKeys(value, ["schema", "assessmentId", "batchId", "candidateId", "expectedCandidateRevision", "lifecycleInputsDigest", "accessStateRevision", "decayPolicyDigest", "outcome", "reasonCode", "assessedAt"], "candidate assessment");
  invariant(row.schema === MEMORY_CANDIDATE_ASSESSMENT_V1_SCHEMA, "assessment schema is unsupported");
  for (const key of ["assessmentId", "candidateId", "lifecycleInputsDigest", "decayPolicyDigest"] as const) digest(row[key], `assessment ${key}`);
  invariant(typeof row.batchId === "string" && row.batchId.length <= 300, "assessment batchId is invalid");
  integer(row.expectedCandidateRevision, "assessment expectedCandidateRevision", 1);
  integer(row.accessStateRevision, "assessment accessStateRevision");
  invariant(["selected", "deferred", "invalidated"].includes(String(row.outcome)), "assessment outcome is invalid");
  invariant(typeof row.reasonCode === "string" && row.reasonCode in CANDIDATE_REASON_REGISTRY, "assessment reasonCode is invalid");
  const assessmentReasons: Record<CandidateSelectionAssessmentV1["outcome"], readonly CandidateReasonCode[]> = {
    selected: ["selected"],
    deferred: ["not_selected", "source_quota", "byte_budget", "cold_provenance_only", "source_unstable"],
    invalidated: ["scope_revoked", "source_revoked", "source_superseded", "source_retracted"],
  };
  invariant(assessmentReasons[row.outcome as CandidateSelectionAssessmentV1["outcome"]].includes(row.reasonCode as CandidateReasonCode), "assessment outcome/reason mismatch");
  instant(row.assessedAt, "assessment assessedAt");
  invariant(row.assessmentId === selectionAssessmentId(value as CandidateSelectionAssessmentV1), "assessmentId mismatch");
  return value as CandidateSelectionAssessmentV1;
}

function reasonCode(value: unknown, label: string): asserts value is CandidateReasonCode {
  invariant(typeof value === "string" && value in CANDIDATE_REASON_REGISTRY, `${label} is invalid`);
}

function revisionMap(value: unknown, label: string): asserts value is Record<string, number> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  for (const [key, revision] of Object.entries(value as Record<string, unknown>)) {
    digest(key, `${label} key`);
    integer(revision, `${label}.${key}`, 1);
  }
}

export function validateCandidateOperationV2(value: unknown): CandidateOperationV2 {
  const row = exactKeys(value, ["schema", "operationId", "reportDigest", "workspaceId", "candidateId", "evidenceSetDigest", "intent", "immutableIntentDigest", "status", "reasonCode", "createdAt", "updatedAt"], "candidate operation");
  invariant(row.schema === MEMORY_CANDIDATE_OPERATION_V2_SCHEMA, "operation schema is unsupported");
  for (const key of ["operationId", "reportDigest", "candidateId", "evidenceSetDigest", "immutableIntentDigest"] as const) digest(row[key], `operation ${key}`);
  invariant(typeof row.workspaceId === "string" && WORKSPACE_RE.test(row.workspaceId), "operation workspaceId is invalid");
  const intent = exactKeys(row.intent, ["occurrenceIds", "candidateCoreDigest", "candidatePayloadDigest", "targetRootVersion"], "operation intent");
  stringArray(intent.occurrenceIds, "operation intent occurrenceIds");
  invariant(intent.occurrenceIds.length > 0, "operation intent requires occurrenceIds");
  for (const id of intent.occurrenceIds) digest(id, "operation intent occurrenceId");
  invariant([...intent.occurrenceIds].sort().join("\0") === intent.occurrenceIds.join("\0"), "operation intent occurrenceIds must be sorted");
  digest(intent.candidateCoreDigest, "operation intent candidateCoreDigest");
  digest(intent.candidatePayloadDigest, "operation intent candidatePayloadDigest");
  invariant(intent.targetRootVersion === "oll-memory-candidates-v1", "operation intent targetRootVersion is unsupported");
  invariant(row.immutableIntentDigest === candidateOperationIntentDigest(row.intent as CandidateOperationV2["intent"]), "operation immutableIntentDigest mismatch");
  invariant(["intent_recorded", "committed", "quarantined"].includes(String(row.status)), "operation status is invalid");
  reasonCode(row.reasonCode, "operation reasonCode");
  const operationReasons: Record<CandidateOperationV2["status"], readonly CandidateReasonCode[]> = {
    intent_recorded: ["admitted"], committed: ["report_verified", "replay_verified"],
    quarantined: ["payload_conflict", "report_digest_mismatch", "operator_quarantine"],
  };
  invariant(operationReasons[row.status as CandidateOperationV2["status"]].includes(row.reasonCode as CandidateReasonCode), "operation status/reason mismatch");
  instant(row.createdAt, "operation createdAt");
  instant(row.updatedAt, "operation updatedAt");
  invariant(row.operationId === candidateOperationId(value as CandidateOperationV2), "operationId mismatch");
  return value as CandidateOperationV2;
}

export function validateCandidateReservationV1(value: unknown): CandidateReservationV1 {
  const row = exactKeys(value, ["schema", "reservationId", "planId", "candidateId", "expectedRevision", "evidenceSetDigest", "status", "reasonCode", "createdAt", "updatedAt"], "candidate reservation");
  invariant(row.schema === MEMORY_CANDIDATE_RESERVATION_V1_SCHEMA, "reservation schema is unsupported");
  for (const key of ["reservationId", "planId", "candidateId", "evidenceSetDigest"] as const) digest(row[key], `reservation ${key}`);
  integer(row.expectedRevision, "reservation expectedRevision", 1);
  invariant(["held", "released", "review_pending", "quarantined"].includes(String(row.status)), "reservation status is invalid");
  reasonCode(row.reasonCode, "reservation reasonCode");
  const reservationReasons: Record<CandidateReservationV1["status"], readonly CandidateReasonCode[]> = {
    held: ["reservation_acquired"], released: ["plan_cancelled_before_effect", "review_policy_rejected_retryable", "review_policy_rejected_terminal", "optimistic_apply"],
    review_pending: ["review_created"], quarantined: ["operator_quarantine", "payload_conflict"],
  };
  invariant(reservationReasons[row.status as CandidateReservationV1["status"]].includes(row.reasonCode as CandidateReasonCode), "reservation status/reason mismatch");
  instant(row.createdAt, "reservation createdAt");
  instant(row.updatedAt, "reservation updatedAt");
  invariant(row.reservationId === candidateReservationId(value as CandidateReservationV1), "reservationId mismatch");
  return value as CandidateReservationV1;
}

export function validateCandidatePlannedEffectV1(value: unknown): CandidatePlannedEffectV1 {
  const row = exactKeys(value, ["schema", "effectId", "actionId", "candidateRevisions", "effectiveScope", "type", "payload"], "candidate planned effect");
  invariant(row.schema === MEMORY_CANDIDATE_EFFECT_V1_SCHEMA, "effect schema is unsupported");
  digest(row.effectId, "effectId");
  digest(row.actionId, "effect actionId");
  revisionMap(row.candidateRevisions, "effect candidateRevisions");
  invariant(Object.keys(row.candidateRevisions as Record<string, number>).length > 0, "effect requires candidates");
  scope(row.effectiveScope, "effect effectiveScope");
  invariant(["rule_proposal", "mandatory_review"].includes(String(row.type)), "effect type is invalid");
  if (row.type === "rule_proposal") {
    const payload = exactKeys(row.payload, ["ruleId", "ruleText", "ruleTextDigest", "reviewRequired"], "rule proposal payload");
    invariant(typeof payload.ruleId === "string" && payload.ruleId.length <= 100, "rule proposal ruleId is invalid");
    invariant(typeof payload.ruleText === "string" && payload.ruleText.length > 0 && payload.ruleText.length <= 4000, "rule proposal ruleText is invalid");
    digest(payload.ruleTextDigest, "rule proposal ruleTextDigest");
    invariant(payload.ruleTextDigest === sha256Digest(payload.ruleText as string), "rule proposal ruleTextDigest mismatch");
    invariant(typeof payload.reviewRequired === "boolean", "candidate rule proposal reviewRequired must be boolean");
  } else {
    const payload = exactKeys(row.payload, ["reviewId", "operationId", "ruleId", "expectedReviewRevision", "requiredAction", "requiredGrant", "registryRevision", "registryDigest", "assignedReviewer"], "mandatory review payload");
    digest(payload.reviewId, "mandatory review reviewId");
    digest(payload.operationId, "mandatory review operationId");
    invariant(typeof payload.ruleId === "string" && payload.ruleId.length > 0 && payload.ruleId.length <= 100, "mandatory review ruleId is invalid");
    integer(payload.expectedReviewRevision, "mandatory review expectedReviewRevision", 1);
    invariant(typeof payload.requiredAction === "string" && payload.requiredAction.length <= 100, "mandatory review requiredAction is invalid");
    invariant(typeof payload.requiredGrant === "string" && payload.requiredGrant.length <= 100, "mandatory review requiredGrant is invalid");
    integer(payload.registryRevision, "mandatory review registryRevision", 1);
    digest(payload.registryDigest, "mandatory review registryDigest");
    invariant(payload.assignedReviewer === null || (typeof payload.assignedReviewer === "string" && SUBJECT_RE.test(payload.assignedReviewer)), "mandatory review assignedReviewer is invalid");
  }
  invariant(row.effectId === candidateEffectId(value as CandidatePlannedEffectV1), "effectId mismatch");
  return value as CandidatePlannedEffectV1;
}

export function validateCandidateApplyPlanV1(value: unknown, context: { scopeRegistry: CandidateScopeRegistryV1; candidateScopes: Record<string, CandidateScope> }): CandidateApplyPlanV1 {
  const row = exactKeys(value, ["schema", "planId", "operationId", "batchId", "workspaceId", "contextDigest", "handoffDigest", "candidateRevisions", "reservations", "effects", "effectCommits", "status", "reasonCode", "createdAt", "updatedAt"], "candidate apply plan");
  invariant(row.schema === MEMORY_CANDIDATE_APPLY_PLAN_V1_SCHEMA, "apply plan schema is unsupported");
  for (const key of ["planId", "operationId", "contextDigest", "handoffDigest"] as const) digest(row[key], `apply plan ${key}`);
  invariant(typeof row.batchId === "string" && row.batchId.length <= 300, "apply plan batchId is invalid");
  invariant(typeof row.workspaceId === "string" && WORKSPACE_RE.test(row.workspaceId), "apply plan workspaceId is invalid");
  revisionMap(row.candidateRevisions, "apply plan candidateRevisions");
  invariant(Array.isArray(row.reservations), "apply plan reservations must be an array");
  for (const reservation of row.reservations) validateCandidateReservationV1(reservation);
  invariant(Array.isArray(row.effects) && row.effects.length > 0, "apply plan effects must be a non-empty array");
  const effects = row.effects.map((effect) => validateCandidatePlannedEffectV1(effect));
  const effectIds = effects.map((effect) => effect.effectId);
  invariant(new Set(effectIds).size === effectIds.length, "apply plan effect IDs must be unique");
  const registry = validateCandidateScopeRegistryV1(context.scopeRegistry);
  invariant(registry.workspaceId === row.workspaceId, "apply plan/scope registry workspace mismatch");
  invariant(context.candidateScopes !== null && typeof context.candidateScopes === "object" && !Array.isArray(context.candidateScopes), "apply plan candidateScopes must be an object");
  for (const [candidateId, candidateScope] of Object.entries(context.candidateScopes)) {
    digest(candidateId, "apply plan candidateScopes key");
    scope(candidateScope, `apply plan candidateScopes.${candidateId}`);
  }
  const candidateScopeIds = Object.keys(context.candidateScopes).sort();
  invariant(canonicalizeJcs(candidateScopeIds) === canonicalizeJcs(Object.keys(row.candidateRevisions as Record<string, number>).sort()), "apply plan candidateScopes must exactly cover candidateRevisions");
  for (const effect of effects) {
    invariant(Object.keys(effect.candidateRevisions).every((candidateId) => scopeContains(registry, context.candidateScopes[candidateId], effect.effectiveScope)), "apply plan actionScope exceeds a cited candidate scope");
  }
  const proposals = effects.filter((effect): effect is Extract<CandidatePlannedEffectV1, { type: "rule_proposal" }> => effect.type === "rule_proposal");
  const reviews = effects.filter((effect): effect is Extract<CandidatePlannedEffectV1, { type: "mandatory_review" }> => effect.type === "mandatory_review");
  invariant(proposals.length > 0, "apply plan requires at least one rule proposal");
  invariant(reviews.length === proposals.filter((proposal) => proposal.payload.reviewRequired).length, "apply plan review count does not match review-required proposals");
  invariant(reviews.every((review) => review.payload.operationId === row.operationId), "mandatory review operationId must match apply plan");
  for (const proposal of proposals) {
    const matches = reviews.filter((review) => review.actionId === proposal.actionId
      && review.payload.ruleId === proposal.payload.ruleId
      && canonicalizeJcs(review.candidateRevisions) === canonicalizeJcs(proposal.candidateRevisions)
      && canonicalizeJcs(review.effectiveScope) === canonicalizeJcs(proposal.effectiveScope));
    invariant(matches.length === (proposal.payload.reviewRequired ? 1 : 0), "rule proposal review correlation does not match reviewRequired");
  }
  invariant(reviews.every((review) => proposals.some((proposal) => proposal.actionId === review.actionId && proposal.payload.ruleId === review.payload.ruleId)), "mandatory review must correlate to a rule proposal");
  invariant(row.effectCommits !== null && typeof row.effectCommits === "object" && !Array.isArray(row.effectCommits), "apply plan effectCommits must be an object");
  invariant(canonicalizeJcs(Object.keys(row.effectCommits as Record<string, unknown>).sort()) === canonicalizeJcs([...effectIds].sort()), "apply plan effectCommits must exactly cover effects");
  for (const [effectId, value] of Object.entries(row.effectCommits as Record<string, unknown>)) {
    const commit = exactKeys(value, ["payloadDigest", "status", "committedAt"], `effect commit ${effectId}`);
    digest(commit.payloadDigest, `effect commit ${effectId} payloadDigest`);
    invariant(commit.payloadDigest === candidateEffectPayloadDigest(effects.find((effect) => effect.effectId === effectId)!), `effect commit ${effectId} payloadDigest mismatch`);
    invariant(["pending", "committed"].includes(String(commit.status)), `effect commit ${effectId} status is invalid`);
    if (commit.status === "pending") invariant(commit.committedAt === null, `pending effect commit ${effectId} must not have committedAt`);
    else instant(commit.committedAt, `effect commit ${effectId} committedAt`);
  }
  invariant(["intent_recorded", "reserving", "applying", "terminal", "quarantined", "cancelled"].includes(String(row.status)), "apply plan status is invalid");
  reasonCode(row.reasonCode, "apply plan reasonCode");
  const planReasons: Record<CandidateApplyPlanV1["status"], readonly CandidateReasonCode[]> = {
    intent_recorded: ["admitted"], reserving: ["reservation_acquired"], applying: ["reservation_acquired", "review_created"],
    terminal: ["review_created", "optimistic_apply", "replay_verified"], quarantined: ["operator_quarantine", "payload_conflict"],
    cancelled: ["plan_cancelled_before_effect", "review_policy_rejected_retryable", "review_policy_rejected_terminal"],
  };
  invariant(planReasons[row.status as CandidateApplyPlanV1["status"]].includes(row.reasonCode as CandidateReasonCode), "apply plan status/reason mismatch");
  instant(row.createdAt, "apply plan createdAt");
  instant(row.updatedAt, "apply plan updatedAt");
  const revisionIds = Object.keys(row.candidateRevisions as Record<string, number>).sort();
  const reservationIds = (row.reservations as CandidateReservationV1[]).map((entry) => entry.candidateId).sort();
  invariant(canonicalizeJcs(revisionIds) === canonicalizeJcs(reservationIds), "apply plan reservations must exactly cover candidateRevisions");
  invariant(effects.every((effect) => canonicalizeJcs(Object.keys(effect.candidateRevisions).sort()) === canonicalizeJcs(revisionIds)), "apply plan effects must cite the exact candidate set");
  invariant((row.reservations as CandidateReservationV1[]).every((reservation) => reservation.planId === row.planId), "apply plan reservation owner mismatch");
  const committedCount = Object.values(row.effectCommits as Record<string, CandidateEffectCommitV1>).filter((commit) => commit.status === "committed").length;
  if (row.status === "terminal") invariant(committedCount === effects.length, "terminal apply plan requires every effect committed");
  if (["intent_recorded", "reserving"].includes(String(row.status))) invariant(committedCount === 0, "pre-apply plan cannot contain committed effects");
  invariant(row.planId === candidateApplyPlanId(value as CandidateApplyPlanV1), "planId mismatch");
  return value as CandidateApplyPlanV1;
}

export function validateCandidateReviewOutcomeV1(value: unknown): CandidateReviewOutcomeV1 {
  const row = exactKeys(value, ["schema", "outcomeId", "operationId", "actionId", "reviewId", "expectedReviewRevision", "actualActorId", "grantDigest", "registryRevision", "registryDigest", "candidateRevisions", "effectiveScope", "disposition", "reasonCode", "observedAt"], "candidate review outcome");
  invariant(row.schema === MEMORY_CANDIDATE_REVIEW_OUTCOME_V1_SCHEMA, "review outcome schema is unsupported");
  for (const key of ["outcomeId", "operationId", "actionId", "reviewId", "grantDigest", "registryDigest"] as const) digest(row[key], `review outcome ${key}`);
  integer(row.expectedReviewRevision, "review outcome expectedReviewRevision", 1);
  invariant(typeof row.actualActorId === "string" && SUBJECT_RE.test(row.actualActorId), "review outcome actualActorId is invalid");
  integer(row.registryRevision, "review outcome registryRevision", 1);
  revisionMap(row.candidateRevisions, "review outcome candidateRevisions");
  scope(row.effectiveScope, "review outcome effectiveScope");
  invariant(["approved", "rejected", "expired"].includes(String(row.disposition)), "review outcome disposition is invalid");
  reasonCode(row.reasonCode, "review outcome reasonCode");
  const reason = CANDIDATE_REASON_REGISTRY[row.reasonCode as CandidateReasonCode];
  if (row.disposition === "approved") invariant(row.reasonCode === "review_approved", "approved review requires review_approved reason");
  if (row.disposition === "rejected") invariant(reason.category === "review" && String(row.reasonCode).startsWith("review_rejected_"), "rejected review requires a rejection reason");
  if (row.disposition === "expired") invariant(reason.category === "review" && String(row.reasonCode).startsWith("review_expired_"), "expired review requires an expiry reason");
  instant(row.observedAt, "review outcome observedAt");
  invariant(row.outcomeId === candidateReviewOutcomeId(value as CandidateReviewOutcomeV1), "outcomeId mismatch");
  return value as CandidateReviewOutcomeV1;
}

export function validateCandidateProjectionV1(value: unknown): CandidateProjectionV1 {
  const row = exactKeys(value, ["schema", "workspaceId", "candidateId", "highestContiguousRevision", "journalDigest", "projectionDigest", "cluster", "reservation", "rebuiltAt"], "candidate projection");
  invariant(row.schema === MEMORY_CANDIDATE_PROJECTION_V1_SCHEMA, "projection schema is unsupported");
  invariant(typeof row.workspaceId === "string" && WORKSPACE_RE.test(row.workspaceId), "projection workspaceId is invalid");
  for (const key of ["candidateId", "journalDigest", "projectionDigest"] as const) digest(row[key], `projection ${key}`);
  integer(row.highestContiguousRevision, "projection highestContiguousRevision", 1);
  const cluster = validateCandidateClusterV1(row.cluster);
  invariant(cluster.workspaceId === row.workspaceId && cluster.candidateId === row.candidateId, "projection cluster correlation mismatch");
  invariant(cluster.lifecycle.revision === row.highestContiguousRevision, "projection revision mismatch");
  if (row.reservation !== null) {
    const reservation = validateCandidateReservationV1(row.reservation);
    invariant(reservation.candidateId === row.candidateId, "projection reservation correlation mismatch");
    invariant(["reserved", "review_pending"].includes(cluster.lifecycle.status), "projection reservation requires an owned lifecycle state");
    invariant(cluster.lifecycle.reservationOwner === reservation.planId, "projection lifecycle/reservation owner mismatch");
    invariant((cluster.lifecycle.status === "reserved" && reservation.status === "held") || (cluster.lifecycle.status === "review_pending" && reservation.status === "review_pending") || reservation.status === "quarantined", "projection lifecycle/reservation status mismatch");
  } else {
    invariant(!["reserved", "review_pending"].includes(cluster.lifecycle.status) && cluster.lifecycle.reservationOwner === null, "owned projection state requires a reservation");
  }
  instant(row.rebuiltAt, "projection rebuiltAt");
  invariant(row.projectionDigest === candidateProjectionDigest(value as CandidateProjectionV1), "projectionDigest mismatch");
  return value as CandidateProjectionV1;
}

export function validateLifecycleTransition(from: CandidateLifecycleStatus, to: CandidateLifecycleStatus, reasonCode: CandidateReasonCode): CandidateLifecycleTransition {
  const transition = CANDIDATE_LIFECYCLE_TRANSITIONS.find((entry) => entry.from === from && entry.to === to && entry.reasonCodes.includes(reasonCode));
  invariant(transition, `unsupported candidate lifecycle transition: ${from} -> ${to} (${reasonCode})`);
  return transition;
}

export function scopeContains(registry: CandidateScopeRegistryV1, broader: CandidateScope, narrower: CandidateScope): boolean {
  if (broader.level === narrower.level) return broader.subject === narrower.subject;
  if (broader.level === "domain" && narrower.level === "self") return registry.selfToDomain[narrower.subject] === broader.subject;
  if (broader.level === "workspace" && narrower.level === "domain") return registry.domainToWorkspace[narrower.subject] === broader.subject;
  if (broader.level === "workspace" && narrower.level === "self") {
    const domainId = registry.selfToDomain[narrower.subject];
    return Boolean(domainId && registry.domainToWorkspace[domainId] === broader.subject);
  }
  return false;
}

export function intersectCandidateScopes(registry: CandidateScopeRegistryV1, left: CandidateScope, right: CandidateScope): CandidateScope | null {
  if (scopeContains(registry, left, right)) return right;
  if (scopeContains(registry, right, left)) return left;
  return null;
}

export function normalizeCandidateStatement(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function semanticKeyV1(statement: string): Digest {
  const normalized = normalizeCandidateStatement(statement).toLocaleLowerCase("und").replace(/[\p{P}]+/gu, " ").replace(/\s+/g, " ").trim();
  return sha256Digest(`oll.memory-semantic-key.v1\0${normalized}`);
}

export function occurrenceIdV1(input: Omit<EvidenceOccurrenceV1, "occurrenceId"> | EvidenceOccurrenceV1): Digest {
  const { occurrenceId: _ignored, schema: _schema, ...base } = input as EvidenceOccurrenceV1;
  return sha256Digest(canonicalizeJcs({ schema: MEMORY_EVIDENCE_OCCURRENCE_V1_SCHEMA, ...base }));
}

export function candidateIdV1(input: { workspaceId: string; normalizerVersion: string; semanticKey: Digest; effectiveScope: CandidateScope }): Digest {
  return sha256Digest(canonicalizeJcs({ schema: MEMORY_CANDIDATE_CLUSTER_V1_SCHEMA, ...input }));
}

export function evidenceSetDigestV1(occurrenceIds: readonly Digest[]): Digest {
  const canonicalIds = [...new Set(occurrenceIds)].sort();
  return sha256Digest(canonicalizeJcs({ schema: "oll.memory-evidence-set.v1", occurrenceIds: canonicalIds }));
}

export function candidateContextBytesV1(candidates: readonly CandidateClusterV1[]): number {
  return Buffer.byteLength(canonicalizeJcs({ schema: "oll.memory-candidate-context.v1", candidates }), "utf8");
}

export function selectionAssessmentId(input: Omit<CandidateSelectionAssessmentV1, "assessmentId" | "schema" | "outcome" | "reasonCode" | "assessedAt"> | CandidateSelectionAssessmentV1): Digest {
  return sha256Digest(canonicalizeJcs({
    candidateId: input.candidateId,
    candidateRevision: input.expectedCandidateRevision,
    lifecycleInputsDigest: input.lifecycleInputsDigest,
    accessStateRevision: input.accessStateRevision,
    decayPolicyDigest: input.decayPolicyDigest,
    batchId: input.batchId,
  }));
}

export function candidateOperationId(input: { reportDigest: Digest; candidateId: Digest; evidenceSetDigest: Digest; workspaceId: string }): Digest {
  return sha256Digest(canonicalizeJcs({
    reportDigest: input.reportDigest,
    candidateId: input.candidateId,
    evidenceSetDigest: input.evidenceSetDigest,
    workspaceId: input.workspaceId,
  }));
}

export function candidateOperationIntentDigest(intent: CandidateOperationV2["intent"]): Digest {
  return sha256Digest(canonicalizeJcs(intent));
}

export function candidateReservationId(input: Pick<CandidateReservationV1, "planId" | "candidateId" | "expectedRevision" | "evidenceSetDigest">): Digest {
  return sha256Digest(canonicalizeJcs({
    schema: MEMORY_CANDIDATE_RESERVATION_V1_SCHEMA,
    planId: input.planId,
    candidateId: input.candidateId,
    expectedRevision: input.expectedRevision,
    evidenceSetDigest: input.evidenceSetDigest,
  }));
}

export function candidateEffectPayloadDigest(effect: CandidatePlannedEffectV1): Digest {
  const { effectId: _ignored, ...base } = effect;
  return sha256Digest(canonicalizeJcs(base));
}

export function candidateEffectId(effect: CandidatePlannedEffectV1): Digest {
  return candidateEffectPayloadDigest(effect);
}

export function candidateApplyPlanId(plan: CandidateApplyPlanV1): Digest {
  return sha256Digest(canonicalizeJcs({
    schema: MEMORY_CANDIDATE_APPLY_PLAN_V1_SCHEMA,
    operationId: plan.operationId,
    batchId: plan.batchId,
    workspaceId: plan.workspaceId,
    contextDigest: plan.contextDigest,
    handoffDigest: plan.handoffDigest,
    candidateRevisions: plan.candidateRevisions,
    effects: plan.effects,
  }));
}

export function candidateReviewOutcomeId(outcome: CandidateReviewOutcomeV1): Digest {
  const { outcomeId: _ignored, ...base } = outcome;
  return sha256Digest(canonicalizeJcs(base));
}

export function candidateProjectionDigest(projection: CandidateProjectionV1): Digest {
  const { projectionDigest: _ignored, rebuiltAt: _rebuiltAt, ...base } = projection;
  return sha256Digest(canonicalizeJcs(base));
}

export function candidateReportDigest(report: Omit<CandidateReportV2, "reportDigest"> | CandidateReportV2): Digest {
  const { reportDigest: _ignored, ...base } = report as CandidateReportV2;
  return sha256Digest(canonicalizeJcs(base));
}

const scopeJsonSchema = {
  type: "object", additionalProperties: false, required: ["level", "subject"],
  properties: { level: { enum: ["self", "domain", "workspace"] }, subject: { type: "string", minLength: 1, maxLength: 300 } },
} as const;

const digestJsonSchema = { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } as const;
const instantJsonSchema = { type: "string", format: "date-time", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$" } as const;

export const MEMORY_CANDIDATE_CONTRACT_JSON_SCHEMAS = {
  policy: {
    $id: MEMORY_CANDIDATE_POLICY_V2_SCHEMA, type: "object", additionalProperties: false,
    required: ["schema", "mode", "forwardOnlySince", "workspaceTimezone", "legacyTimestampParser", "daily", "domains", "kg", "limits", "decayPolicy", "rankingPolicy", "sensitiveTextPolicyVersion"],
    properties: {
      schema: { const: MEMORY_CANDIDATE_POLICY_V2_SCHEMA }, mode: { enum: ["disabled", "shadow", "materialize"] }, forwardOnlySince: instantJsonSchema,
      workspaceTimezone: { type: "string" }, legacyTimestampParser: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["version", "daylightSavingAmbiguity"], properties: { version: { const: "legacy-local-v1" }, daylightSavingAmbiguity: { enum: ["reject", "earlier", "later"] } } }] },
      daily: { type: "array", items: { type: "object", additionalProperties: false, required: ["session", "sections", "scopeCeiling"], properties: { session: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:@-]{0,299}$" }, sections: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["decisions", "learnings", "retrieval-cards"] } }, scopeCeiling: scopeJsonSchema } } },
      domains: { type: "array", items: { type: "object", additionalProperties: false, required: ["domainId", "formats", "scopeCeiling"], properties: { domainId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:@-]{0,299}$" }, formats: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["canonical-decisions-v1", "canonical-proposals-v1"] } }, scopeCeiling: scopeJsonSchema } } },
      kg: { type: "array", items: { type: "object", additionalProperties: false, required: ["entityPrefix", "kinds", "admittedScopes", "scopeMapping"], properties: { entityPrefix: { type: "string", pattern: "^[a-z][a-z0-9-]*(?:/[a-z0-9][a-z0-9-]*)*/$" }, kinds: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["decision", "preference", "constraint"] } }, admittedScopes: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } }, scopeMapping: { type: "object", minProperties: 1, additionalProperties: scopeJsonSchema } } } },
      limits: { type: "object", additionalProperties: false, required: ["maxCandidatesPerRun", "maxContextBytes", "maxOccurrencesPerCluster", "sourceQuotas"], properties: { maxCandidatesPerRun: { type: "integer", minimum: 1, maximum: 200 }, maxContextBytes: { type: "integer", minimum: 1024, maximum: 262144 }, maxOccurrencesPerCluster: { type: "integer", minimum: 1, maximum: 100 }, sourceQuotas: { type: "object", additionalProperties: false, required: ["daily-decision", "daily-learning", "retrieval-card", "domain-decision", "domain-proposal", "kg-assertion"], properties: Object.fromEntries(["daily-decision", "daily-learning", "retrieval-card", "domain-decision", "domain-proposal", "kg-assertion"].map((key) => [key, { type: "integer", minimum: 0, maximum: 100 }])) } } },
      decayPolicy: { type: "object", additionalProperties: false, required: ["schema", "hotDays", "warmDays", "accessCountCap", "warmScorePenalty", "coldKgContribution", "trustedAccessEventSchema"], properties: { schema: { const: MEMORY_CANDIDATE_DECAY_POLICY_V1_SCHEMA }, hotDays: { const: 7 }, warmDays: { const: 30 }, accessCountCap: { const: 10 }, warmScorePenalty: { type: "integer", minimum: 0 }, coldKgContribution: { const: "provenance-only" }, trustedAccessEventSchema: { const: KG_ACCESS_EVENT_V1_SCHEMA } } },
      rankingPolicy: { type: "object", additionalProperties: false, required: ["schema", "eligibilityThreshold", "baseScores", "recencyBoostMax", "recencyBoostPerDay", "distinctRootBoostPerRoot", "distinctRootBoostMax"], properties: { schema: { const: MEMORY_CANDIDATE_RANKING_POLICY_V1_SCHEMA }, eligibilityThreshold: { type: "integer", minimum: 0, maximum: 100 }, baseScores: { type: "object", additionalProperties: false, required: ["decision", "learning", "preference", "constraint", "proposal"], properties: Object.fromEntries(["decision", "learning", "preference", "constraint", "proposal"].map((key) => [key, { type: "integer", minimum: 0, maximum: 100 }])) }, recencyBoostMax: { type: "integer", minimum: 0, maximum: 100 }, recencyBoostPerDay: { type: "integer", minimum: 0, maximum: 100 }, distinctRootBoostPerRoot: { type: "integer", minimum: 0, maximum: 100 }, distinctRootBoostMax: { type: "integer", minimum: 0, maximum: 100 } } },
      sensitiveTextPolicyVersion: { type: "string", pattern: "^privacy-[a-z0-9.-]+$" },
    },
  },
  occurrence: {
    $id: MEMORY_EVIDENCE_OCCURRENCE_V1_SCHEMA, type: "object", additionalProperties: false,
    required: ["schema", "occurrenceId", "workspaceId", "sourceClass", "evidenceKind", "sourceRef", "sourceVersionDigest", "contentDigest", "provenanceRootId", "semanticKey", "authoritativeScope", "effectiveScope", "observedAt", "originalTimestamp", "timezone", "parserVersion", "kgDecay", "canonicalStatement"],
    properties: { schema: { const: MEMORY_EVIDENCE_OCCURRENCE_V1_SCHEMA }, occurrenceId: digestJsonSchema, workspaceId: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" }, sourceClass: { enum: ["daily-decision", "daily-learning", "retrieval-card", "domain-decision", "domain-proposal", "kg-assertion"] }, evidenceKind: { enum: ["decision", "learning", "preference", "constraint", "proposal"] }, sourceRef: { type: "string", minLength: 1, maxLength: 500 }, sourceVersionDigest: digestJsonSchema, contentDigest: digestJsonSchema, provenanceRootId: { anyOf: [{ type: "null" }, digestJsonSchema] }, semanticKey: digestJsonSchema, authoritativeScope: scopeJsonSchema, effectiveScope: scopeJsonSchema, observedAt: instantJsonSchema, originalTimestamp: { type: "string", minLength: 1, maxLength: 100 }, timezone: { type: "string", minLength: 1, maxLength: 100 }, parserVersion: { type: "string", minLength: 1, maxLength: 100 }, kgDecay: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["tier", "accessCount"], properties: { tier: { enum: ["hot", "warm", "cold"] }, accessCount: { type: "integer", minimum: 0, maximum: 10 } } }] }, canonicalStatement: { type: "string", minLength: 1, maxLength: 2000 } },
    allOf: [
      { if: { properties: { sourceClass: { const: "daily-decision" } } }, then: { properties: { evidenceKind: { const: "decision" }, parserVersion: { const: "daily-note-v2" }, kgDecay: { type: "null" } } } },
      { if: { properties: { sourceClass: { const: "daily-learning" } } }, then: { properties: { evidenceKind: { const: "learning" }, parserVersion: { const: "daily-note-v2" }, kgDecay: { type: "null" } } } },
      { if: { properties: { sourceClass: { const: "retrieval-card" } } }, then: { properties: { evidenceKind: { enum: ["decision", "learning"] }, parserVersion: { const: "retrieval-card-v1" }, kgDecay: { type: "null" } } } },
      { if: { properties: { sourceClass: { const: "domain-decision" } } }, then: { properties: { evidenceKind: { const: "decision" }, parserVersion: { const: "canonical-decisions-v1" }, kgDecay: { type: "null" } } } },
      { if: { properties: { sourceClass: { const: "domain-proposal" } } }, then: { properties: { evidenceKind: { const: "proposal" }, parserVersion: { const: "canonical-proposals-v1" }, kgDecay: { type: "null" } } } },
      { if: { properties: { sourceClass: { const: "kg-assertion" } } }, then: { properties: { evidenceKind: { enum: ["decision", "preference", "constraint"] }, parserVersion: { const: "kg-assertion-v3" }, kgDecay: { type: "object" } } } },
    ],
  },
  cluster: {
    $id: MEMORY_CANDIDATE_CLUSTER_V1_SCHEMA, type: "object", additionalProperties: false,
    required: ["schema", "candidateId", "workspaceId", "normalizerVersion", "evaluationEpoch", "semanticKey", "effectiveScope", "canonicalStatement", "occurrenceIds", "distinctProvenanceRootIds", "evidenceSetDigest", "ranking", "lifecycle"],
    properties: { schema: { const: MEMORY_CANDIDATE_CLUSTER_V1_SCHEMA }, candidateId: digestJsonSchema, workspaceId: { type: "string" }, normalizerVersion: { type: "string" }, evaluationEpoch: { type: "integer", minimum: 1 }, semanticKey: digestJsonSchema, effectiveScope: scopeJsonSchema, canonicalStatement: { type: "string", minLength: 1, maxLength: 2000 }, occurrenceIds: { type: "array", minItems: 1, uniqueItems: true, items: digestJsonSchema }, distinctProvenanceRootIds: { type: "array", uniqueItems: true, items: digestJsonSchema }, evidenceSetDigest: digestJsonSchema, ranking: { $ref: "oll.memory-candidate-ranking.v1" }, lifecycle: { $ref: "oll.memory-candidate-lifecycle.v1" } },
  },
  ranking: {
    $id: "oll.memory-candidate-ranking.v1", type: "object", additionalProperties: false,
    required: ["schema", "score", "baseScore", "recencyBoost", "distinctRootBoost", "decayPenalty", "accessCount", "decayTier", "reasons", "policyDigest"],
    properties: { schema: { const: "oll.memory-candidate-ranking.v1" }, score: { type: "integer", minimum: 0, maximum: 100 }, baseScore: { type: "integer", minimum: 0 }, recencyBoost: { type: "integer", minimum: 0 }, distinctRootBoost: { type: "integer", minimum: 0 }, decayPenalty: { type: "integer", minimum: 0 }, accessCount: { type: "integer", minimum: 0 }, decayTier: { enum: ["hot", "warm", "cold", null] }, reasons: { type: "array", uniqueItems: true, items: { enum: Object.keys(CANDIDATE_REASON_REGISTRY) } }, policyDigest: digestJsonSchema },
  },
  lifecycle: {
    $id: "oll.memory-candidate-lifecycle.v1", type: "object", additionalProperties: false,
    required: ["status", "revision", "evaluationEpoch", "reasonCode", "reservationOwner", "correlationId", "updatedAt"],
    properties: { status: { enum: ["pending", "deferred", "reserved", "review_pending", "evaluated", "dismissed", "invalidated"] }, revision: { type: "integer", minimum: 1 }, evaluationEpoch: { type: "integer", minimum: 1 }, reasonCode: { enum: Object.keys(CANDIDATE_REASON_REGISTRY) }, reservationOwner: { anyOf: [{ type: "null" }, digestJsonSchema] }, correlationId: digestJsonSchema, updatedAt: instantJsonSchema },
  },
  scopeRegistry: {
    $id: MEMORY_CANDIDATE_SCOPE_REGISTRY_V1_SCHEMA, type: "object", additionalProperties: false,
    required: ["schema", "workspaceId", "revision", "digest", "selfToDomain", "domainToWorkspace", "sourceAuthorities"],
    properties: { schema: { const: MEMORY_CANDIDATE_SCOPE_REGISTRY_V1_SCHEMA }, workspaceId: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" }, revision: { type: "integer", minimum: 1 }, digest: digestJsonSchema, selfToDomain: { type: "object", additionalProperties: { type: "string", minLength: 1, maxLength: 300 } }, domainToWorkspace: { type: "object", additionalProperties: { type: "string", minLength: 1, maxLength: 300 } }, sourceAuthorities: { type: "object", additionalProperties: false, required: ["daily", "domains", "kgScopes"], properties: { daily: { type: "object", additionalProperties: scopeJsonSchema }, domains: { type: "object", additionalProperties: scopeJsonSchema }, kgScopes: { type: "object", additionalProperties: scopeJsonSchema } } } },
  },
  report: {
    $id: MEMORY_CANDIDATE_REPORT_V2_SCHEMA, type: "object", additionalProperties: false,
    required: ["schema", "compilationAttemptId", "batchId", "workspaceId", "executionMode", "snapshotAt", "policyDigest", "scopeRegistryRevision", "scopeRegistryDigest", "compilerVersion", "normalizerVersion", "parserVersions", "kgAssertionRevision", "kgAssertionDigest", "accessStateRevision", "accessStateDigest", "considered", "eligible", "selected", "rejected", "selectedBytes", "projectedModelSpawns", "projectedReviews", "sourceCounts", "rejectionCounts", "occurrences", "candidates", "reportDigest"],
    properties: { schema: { const: MEMORY_CANDIDATE_REPORT_V2_SCHEMA }, compilationAttemptId: digestJsonSchema, batchId: { type: "string", minLength: 1, maxLength: 300 }, workspaceId: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" }, executionMode: { enum: ["report-only", "shadow", "materialize"] }, snapshotAt: instantJsonSchema, policyDigest: digestJsonSchema, scopeRegistryRevision: { type: "integer", minimum: 1 }, scopeRegistryDigest: digestJsonSchema, compilerVersion: { enum: CANDIDATE_SUPPORTED_VERSIONS_V1.compilerVersions }, normalizerVersion: { enum: CANDIDATE_SUPPORTED_VERSIONS_V1.normalizerVersions }, parserVersions: { type: "array", uniqueItems: true, items: { enum: [...new Set(Object.values(CANDIDATE_SUPPORTED_VERSIONS_V1.parserVersions).flat())] } }, kgAssertionRevision: { type: "integer", minimum: 0 }, kgAssertionDigest: digestJsonSchema, accessStateRevision: { type: "integer", minimum: 0 }, accessStateDigest: digestJsonSchema, considered: { type: "integer", minimum: 0 }, eligible: { type: "integer", minimum: 0 }, selected: { type: "integer", minimum: 0 }, rejected: { type: "integer", minimum: 0 }, selectedBytes: { type: "integer", minimum: 0 }, projectedModelSpawns: { type: "integer", minimum: 0 }, projectedReviews: { type: "integer", minimum: 0 }, sourceCounts: { type: "object", additionalProperties: false, required: ["daily-decision", "daily-learning", "retrieval-card", "domain-decision", "domain-proposal", "kg-assertion"], properties: Object.fromEntries(["daily-decision", "daily-learning", "retrieval-card", "domain-decision", "domain-proposal", "kg-assertion"].map((key) => [key, { type: "integer", minimum: 0 }])) }, rejectionCounts: { type: "object", additionalProperties: { type: "integer", minimum: 0 }, propertyNames: { enum: Object.keys(CANDIDATE_REASON_REGISTRY) } }, occurrences: { type: "array", items: { $ref: MEMORY_EVIDENCE_OCCURRENCE_V1_SCHEMA } }, candidates: { type: "array", items: { $ref: MEMORY_CANDIDATE_CLUSTER_V1_SCHEMA } }, reportDigest: digestJsonSchema },
  },
  assessment: {
    $id: MEMORY_CANDIDATE_ASSESSMENT_V1_SCHEMA, type: "object", additionalProperties: false,
    required: ["schema", "assessmentId", "batchId", "candidateId", "expectedCandidateRevision", "lifecycleInputsDigest", "accessStateRevision", "decayPolicyDigest", "outcome", "reasonCode", "assessedAt"],
    properties: { schema: { const: MEMORY_CANDIDATE_ASSESSMENT_V1_SCHEMA }, assessmentId: digestJsonSchema, batchId: { type: "string" }, candidateId: digestJsonSchema, expectedCandidateRevision: { type: "integer", minimum: 1 }, lifecycleInputsDigest: digestJsonSchema, accessStateRevision: { type: "integer", minimum: 0 }, decayPolicyDigest: digestJsonSchema, outcome: { enum: ["selected", "deferred", "invalidated"] }, reasonCode: { enum: Object.keys(CANDIDATE_REASON_REGISTRY) }, assessedAt: instantJsonSchema },
  },
  operation: {
    $id: MEMORY_CANDIDATE_OPERATION_V2_SCHEMA, type: "object", additionalProperties: false,
    required: ["schema", "operationId", "reportDigest", "workspaceId", "candidateId", "evidenceSetDigest", "intent", "immutableIntentDigest", "status", "reasonCode", "createdAt", "updatedAt"],
    properties: { schema: { const: MEMORY_CANDIDATE_OPERATION_V2_SCHEMA }, operationId: digestJsonSchema, reportDigest: digestJsonSchema, workspaceId: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" }, candidateId: digestJsonSchema, evidenceSetDigest: digestJsonSchema, intent: { type: "object", additionalProperties: false, required: ["occurrenceIds", "candidateCoreDigest", "candidatePayloadDigest", "targetRootVersion"], properties: { occurrenceIds: { type: "array", minItems: 1, uniqueItems: true, items: digestJsonSchema }, candidateCoreDigest: digestJsonSchema, candidatePayloadDigest: digestJsonSchema, targetRootVersion: { const: "oll-memory-candidates-v1" } } }, immutableIntentDigest: digestJsonSchema, status: { enum: ["intent_recorded", "committed", "quarantined"] }, reasonCode: { enum: Object.keys(CANDIDATE_REASON_REGISTRY) }, createdAt: instantJsonSchema, updatedAt: instantJsonSchema },
  },
  reservation: {
    $id: MEMORY_CANDIDATE_RESERVATION_V1_SCHEMA, type: "object", additionalProperties: false,
    required: ["schema", "reservationId", "planId", "candidateId", "expectedRevision", "evidenceSetDigest", "status", "reasonCode", "createdAt", "updatedAt"],
    properties: { schema: { const: MEMORY_CANDIDATE_RESERVATION_V1_SCHEMA }, reservationId: digestJsonSchema, planId: digestJsonSchema, candidateId: digestJsonSchema, expectedRevision: { type: "integer", minimum: 1 }, evidenceSetDigest: digestJsonSchema, status: { enum: ["held", "released", "review_pending", "quarantined"] }, reasonCode: { enum: Object.keys(CANDIDATE_REASON_REGISTRY) }, createdAt: instantJsonSchema, updatedAt: instantJsonSchema },
  },
  effect: {
    $id: MEMORY_CANDIDATE_EFFECT_V1_SCHEMA, type: "object", additionalProperties: false,
    required: ["schema", "effectId", "actionId", "candidateRevisions", "effectiveScope", "type", "payload"],
    properties: { schema: { const: MEMORY_CANDIDATE_EFFECT_V1_SCHEMA }, effectId: digestJsonSchema, actionId: digestJsonSchema, candidateRevisions: { type: "object", minProperties: 1, propertyNames: digestJsonSchema, additionalProperties: { type: "integer", minimum: 1 } }, effectiveScope: scopeJsonSchema, type: { enum: ["rule_proposal", "mandatory_review"] }, payload: { type: "object" } },
    oneOf: [
      { properties: { type: { const: "rule_proposal" }, payload: { type: "object", additionalProperties: false, required: ["ruleId", "ruleText", "ruleTextDigest", "reviewRequired"], properties: { ruleId: { type: "string", minLength: 1, maxLength: 100 }, ruleText: { type: "string", minLength: 1, maxLength: 4000 }, ruleTextDigest: digestJsonSchema, reviewRequired: { type: "boolean" } } } } },
      { properties: { type: { const: "mandatory_review" }, payload: { type: "object", additionalProperties: false, required: ["reviewId", "operationId", "ruleId", "expectedReviewRevision", "requiredAction", "requiredGrant", "registryRevision", "registryDigest", "assignedReviewer"], properties: { reviewId: digestJsonSchema, operationId: digestJsonSchema, ruleId: { type: "string", minLength: 1, maxLength: 100 }, expectedReviewRevision: { type: "integer", minimum: 1 }, requiredAction: { type: "string", minLength: 1, maxLength: 100 }, requiredGrant: { type: "string", minLength: 1, maxLength: 100 }, registryRevision: { type: "integer", minimum: 1 }, registryDigest: digestJsonSchema, assignedReviewer: { anyOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 300 }] } } } } },
    ],
  },
  applyPlan: {
    $id: MEMORY_CANDIDATE_APPLY_PLAN_V1_SCHEMA, type: "object", additionalProperties: false,
    required: ["schema", "planId", "operationId", "batchId", "workspaceId", "contextDigest", "handoffDigest", "candidateRevisions", "reservations", "effects", "effectCommits", "status", "reasonCode", "createdAt", "updatedAt"],
    properties: { schema: { const: MEMORY_CANDIDATE_APPLY_PLAN_V1_SCHEMA }, planId: digestJsonSchema, operationId: digestJsonSchema, batchId: { type: "string", minLength: 1, maxLength: 300 }, workspaceId: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" }, contextDigest: digestJsonSchema, handoffDigest: digestJsonSchema, candidateRevisions: { type: "object", minProperties: 1, propertyNames: digestJsonSchema, additionalProperties: { type: "integer", minimum: 1 } }, reservations: { type: "array", minItems: 1, items: { $ref: MEMORY_CANDIDATE_RESERVATION_V1_SCHEMA } }, effects: { type: "array", minItems: 1, uniqueItems: true, items: { $ref: MEMORY_CANDIDATE_EFFECT_V1_SCHEMA } }, effectCommits: { type: "object", minProperties: 1, propertyNames: digestJsonSchema, additionalProperties: { type: "object", additionalProperties: false, required: ["payloadDigest", "status", "committedAt"], properties: { payloadDigest: digestJsonSchema, status: { enum: ["pending", "committed"] }, committedAt: { anyOf: [{ type: "null" }, instantJsonSchema] } } } }, status: { enum: ["intent_recorded", "reserving", "applying", "terminal", "quarantined", "cancelled"] }, reasonCode: { enum: Object.keys(CANDIDATE_REASON_REGISTRY) }, createdAt: instantJsonSchema, updatedAt: instantJsonSchema },
  },
  reviewOutcome: {
    $id: MEMORY_CANDIDATE_REVIEW_OUTCOME_V1_SCHEMA, type: "object", additionalProperties: false,
    required: ["schema", "outcomeId", "operationId", "actionId", "reviewId", "expectedReviewRevision", "actualActorId", "grantDigest", "registryRevision", "registryDigest", "candidateRevisions", "effectiveScope", "disposition", "reasonCode", "observedAt"],
    properties: { schema: { const: MEMORY_CANDIDATE_REVIEW_OUTCOME_V1_SCHEMA }, outcomeId: digestJsonSchema, operationId: digestJsonSchema, actionId: digestJsonSchema, reviewId: digestJsonSchema, expectedReviewRevision: { type: "integer", minimum: 1 }, actualActorId: { type: "string" }, grantDigest: digestJsonSchema, registryRevision: { type: "integer", minimum: 1 }, registryDigest: digestJsonSchema, candidateRevisions: { type: "object", propertyNames: digestJsonSchema, additionalProperties: { type: "integer", minimum: 1 } }, effectiveScope: scopeJsonSchema, disposition: { enum: ["approved", "rejected", "expired"] }, reasonCode: { enum: Object.keys(CANDIDATE_REASON_REGISTRY) }, observedAt: instantJsonSchema },
  },
  projection: {
    $id: MEMORY_CANDIDATE_PROJECTION_V1_SCHEMA, type: "object", additionalProperties: false,
    required: ["schema", "workspaceId", "candidateId", "highestContiguousRevision", "journalDigest", "projectionDigest", "cluster", "reservation", "rebuiltAt"],
    properties: { schema: { const: MEMORY_CANDIDATE_PROJECTION_V1_SCHEMA }, workspaceId: { type: "string" }, candidateId: digestJsonSchema, highestContiguousRevision: { type: "integer", minimum: 1 }, journalDigest: digestJsonSchema, projectionDigest: digestJsonSchema, cluster: { $ref: MEMORY_CANDIDATE_CLUSTER_V1_SCHEMA }, reservation: { anyOf: [{ type: "null" }, { $ref: MEMORY_CANDIDATE_RESERVATION_V1_SCHEMA }] }, rebuiltAt: instantJsonSchema },
  },
} as const;
