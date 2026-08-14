import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileMemoryCandidateReportV2 } from "../src/oll/memory-candidate-compiler-v2";
import {
  MEMORY_CANDIDATE_POLICY_V2_SCHEMA,
  MEMORY_CANDIDATE_RANKING_POLICY_V1_SCHEMA,
  MEMORY_CANDIDATE_SCOPE_REGISTRY_V1_SCHEMA,
  candidateOperationId,
  candidateReportDigest,
  candidateScopeRegistryDigestV1,
  type CandidateReportV2,
  type CandidateScopeRegistryV1,
  type CandidateSourcePolicyV2,
} from "../src/oll/memory-candidate-contracts-v2";
import { sha256Digest } from "../src/oll/handoff-v2";
import {
  assessCandidateSelectionV1,
  listPendingEvidenceV1,
  materializeCandidateReportV2,
  memoryCandidateStoreRootV1,
  readCandidateProjectionV1,
  recoverCandidateMaterializationV2,
  reserveCandidateV1,
} from "../src/oll/memory-candidate-store-v2";

const roots: string[] = [];
const T0 = "2026-08-14T12:00:00.000Z";
const T1 = "2026-08-14T13:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function writeJson(path: string, value: unknown): void {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function policy(scope: "workspace" | "domain" = "workspace"): CandidateSourcePolicyV2 {
  return {
    schema: MEMORY_CANDIDATE_POLICY_V2_SCHEMA,
    mode: "materialize",
    forwardOnlySince: "2026-08-14T00:00:00Z",
    workspaceTimezone: "UTC",
    legacyTimestampParser: null,
    daily: [{
      session: "main",
      sections: ["decisions"],
      scopeCeiling: scope === "workspace" ? { level: "workspace", subject: "main" } : { level: "domain", subject: "engram" },
    }],
    domains: [],
    kg: [{
      entityPrefix: "projects/",
      kinds: ["decision", "preference", "constraint"],
      admittedScopes: ["project:engram"],
      scopeMapping: { "project:engram": { level: "domain", subject: "engram" } },
    }],
    limits: {
      maxCandidatesPerRun: 20,
      maxContextBytes: 65_536,
      maxOccurrencesPerCluster: 20,
      sourceQuotas: {
        "daily-decision": 20,
        "daily-learning": 0,
        "retrieval-card": 0,
        "domain-decision": 0,
        "domain-proposal": 0,
        "kg-assertion": 20,
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

function registry(): CandidateScopeRegistryV1 {
  const base: Omit<CandidateScopeRegistryV1, "digest"> = {
    schema: MEMORY_CANDIDATE_SCOPE_REGISTRY_V1_SCHEMA,
    workspaceId: "main",
    revision: 1,
    selfToDomain: {},
    domainToWorkspace: { engram: "main" },
    sourceAuthorities: {
      daily: { main: { level: "workspace", subject: "main" } },
      domains: { engram: { level: "domain", subject: "engram" } },
      kgScopes: { "project:engram": { level: "domain", subject: "engram" } },
    },
  };
  return { ...base, digest: candidateScopeRegistryDigestV1(base) };
}

function assertion(status: "active" | "retracted" = "active") {
  return {
    schema: "engram.kg-assertion.v3-mvp",
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "main",
    entityId: "projects/engram-store",
    entityType: "project",
    kind: "constraint",
    predicate: "policy",
    object: { type: "string", value: "journal revisions are append only" },
    scope: ["project:engram"],
    lifecycle: { status, replacesId: null, supersededById: null, changedAt: "2026-08-14T10:00:00Z" },
    provenance: {
      sourceKind: "operator-curated",
      sessionKey: "main",
      messageId: "fixture-1",
      actorId: "actor:fixture",
      operationId: sha256Digest("fixture-operation"),
      observedAt: "2026-08-14T10:00:00Z",
    },
    createdAt: "2026-08-14T10:00:00Z",
  };
}

function workspace(options: { kg?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "engram-candidate-store-v2-"));
  roots.push(root);
  writeJson(join(root, "engram.json"), { workspace: { id: "main" } });
  writeJson(join(root, "life", "v3", "registry.json"), { revision: 7 });
  mkdirSync(join(root, "life", "v3", "assertions"), { recursive: true });
  mkdirSync(join(root, "memory", "agent-main", "main"), { recursive: true });
  if (options.kg) writeJson(join(root, "life", "v3", "assertions", "11111111-1111-4111-8111-111111111111.json"), assertion());
  else write(join(root, "memory", "agent-main", "main", "2026-08-14.md"), [
    "# 2026-08-14",
    "",
    "## Decisions",
    "",
    "### 2026-08-14T10:00:00Z — decision",
    "",
    "- Keep journal revisions append only.",
    "",
  ].join("\n"));
  return { root, policy: policy(), registry: registry() };
}

function allSourcesWorkspace() {
  const fixture = workspace();
  const p = policy();
  p.legacyTimestampParser = { version: "legacy-local-v1", daylightSavingAmbiguity: "reject" };
  p.daily[0].sections = ["decisions", "learnings", "retrieval-cards"];
  p.domains = [{ domainId: "engram", formats: ["canonical-decisions-v1", "canonical-proposals-v1"], scopeCeiling: { level: "domain", subject: "engram" } }];
  p.limits.sourceQuotas["daily-learning"] = 20;
  p.limits.sourceQuotas["retrieval-card"] = 20;
  p.limits.sourceQuotas["domain-decision"] = 20;
  p.limits.sourceQuotas["domain-proposal"] = 20;
  write(join(fixture.root, "memory", "agent-main", "main", "2026-08-14.md"), [
    "# 2026-08-14", "", "## Decisions", "", "### 2026-08-14T10:00:00Z — decision", "", "- Daily decision source stays authorized.", "",
    "## Learnings", "", "### 2026-08-14T10:01:00Z — learning", "", "- Daily learning source stays authorized.", "",
  ].join("\n"));
  write(join(fixture.root, "memory", "agent-main", "main", "retrieval", "2026-08-14-card.md"), [
    "# Retrieval card", "", "- **Type:** retrieval event card", "- **Date:** 2026-08-14", "- **Source:** `memory/agent-main/main/2026-08-14.md` — Decisions", "",
    "## Summary", "", "Retrieval card source stays authorized.", "",
  ].join("\n"));
  write(join(fixture.root, "memory", "domains", "engram", "decisions.md"), [
    "# Decisions", "", "### 2026-08-14 — Domain decision", "", "**Решение**: Domain decision source stays authorized.", "**Контекст**: test", "**Участники**: fixture", "",
  ].join("\n"));
  write(join(fixture.root, "memory", "domains", "engram", "changelog.md"), [
    "# Changelog", "", "## 2026-08-14 11:00 — PROPOSAL", "**Proposal**: Domain proposal source stays authorized.", "**Reason**: test", "",
  ].join("\n"));
  writeJson(join(fixture.root, "life", "v3", "assertions", "11111111-1111-4111-8111-111111111111.json"), assertion());
  return { ...fixture, policy: p };
}

function compile(root: string, p: CandidateSourcePolicyV2, scopeRegistry: CandidateScopeRegistryV1, snapshotAt = T0, batchId = `batch:${snapshotAt}`): CandidateReportV2 {
  return compileMemoryCandidateReportV2({
    workspace: root,
    workspaceId: "main",
    policy: p,
    scopeRegistry,
    snapshotAt,
    batchId,
    executionMode: "materialize",
  });
}

describe("OLL memory candidate Phase 3 store", () => {
  test("materializes only a fully verified report and replays immutable operation intent", () => {
    const fixture = workspace();
    const report = compile(fixture.root, fixture.policy, fixture.registry);
    const first = materializeCandidateReportV2({ workspace: fixture.root, workspaceId: "main", report, policy: fixture.policy, scopeRegistry: fixture.registry });
    const second = materializeCandidateReportV2({ workspace: fixture.root, workspaceId: "main", report, policy: fixture.policy, scopeRegistry: fixture.registry });
    expect(first.candidates.every((entry) => entry.status === "committed")).toBe(true);
    expect(second.candidates.every((entry) => entry.status === "replay_verified")).toBe(true);
    const projection = readCandidateProjectionV1({ workspace: fixture.root, workspaceId: "main", candidateId: report.candidates[0].candidateId })!;
    expect(projection.highestContiguousRevision).toBe(1);
    expect(projection.cluster).toEqual(report.candidates[0]);
  });

  test("quarantines a forged report before any candidate journal write", () => {
    const fixture = workspace();
    const report = compile(fixture.root, fixture.policy, fixture.registry);
    const forged = { ...report, selectedBytes: report.selectedBytes + 1 };
    expect(() => materializeCandidateReportV2({ workspace: fixture.root, workspaceId: "main", report: forged, policy: fixture.policy, scopeRegistry: fixture.registry })).toThrow();
    const root = memoryCandidateStoreRootV1(fixture.root);
    expect(readdirSync(join(root, "journal"))).toHaveLength(0);
    expect(readdirSync(join(root, "quarantine"))).toHaveLength(1);
    expect(readFileSync(join(root, "quarantine", readdirSync(join(root, "quarantine"))[0]), "utf8")).not.toContain("Keep journal");
  });

  test("recovers from the persisted report after source drift without recompiling", () => {
    const fixture = workspace();
    const report = compile(fixture.root, fixture.policy, fixture.registry);
    let crashed = false;
    expect(() => materializeCandidateReportV2({
      workspace: fixture.root,
      workspaceId: "main",
      report,
      policy: fixture.policy,
      scopeRegistry: fixture.registry,
      faultInjector(point) {
        if (!crashed && point === "after_operation_intent") { crashed = true; throw new Error("crash"); }
      },
    })).toThrow("crash");
    write(join(fixture.root, "memory", "agent-main", "main", "2026-08-14.md"), "# replaced after report publication\n");
    const recovered = recoverCandidateMaterializationV2({
      workspace: fixture.root,
      workspaceId: "main",
      compilationAttemptId: report.compilationAttemptId,
      policy: fixture.policy,
      scopeRegistry: fixture.registry,
    });
    expect(recovered.reportDigest).toBe(report.reportDigest);
    expect(recovered.candidates).toHaveLength(report.candidates.length);
    expect(readCandidateProjectionV1({ workspace: fixture.root, workspaceId: "main", candidateId: report.candidates[0].candidateId })!.cluster.canonicalStatement).toBe(report.candidates[0].canonicalStatement);
  });

  test("quarantines an existing operation payload mismatch", () => {
    const fixture = workspace();
    const report = compile(fixture.root, fixture.policy, fixture.registry);
    materializeCandidateReportV2({ workspace: fixture.root, workspaceId: "main", report, policy: fixture.policy, scopeRegistry: fixture.registry });
    const root = memoryCandidateStoreRootV1(fixture.root);
    const operationDirectory = readdirSync(join(root, "operations"))[0];
    const intentPath = join(root, "operations", operationDirectory, "intent.json");
    const intent = JSON.parse(readFileSync(intentPath, "utf8"));
    intent.intent.candidatePayloadDigest = sha256Digest("forged");
    intent.immutableIntentDigest = sha256Digest(JSON.stringify(intent.intent));
    writeFileSync(intentPath, `${JSON.stringify(intent)}\n`);
    expect(() => materializeCandidateReportV2({ workspace: fixture.root, workspaceId: "main", report, policy: fixture.policy, scopeRegistry: fixture.registry })).toThrow();
    expect(readdirSync(join(root, "quarantine")).length).toBeGreaterThan(0);
  });

  test("preflights every operation before the first candidate journal mutation", () => {
    const fixture = workspace();
    write(join(fixture.root, "memory", "agent-main", "main", "2026-08-14.md"), [
      "# 2026-08-14", "", "## Decisions", "", "### 2026-08-14T10:00:00Z — decision", "", "- First candidate statement.", "",
      "### 2026-08-14T10:01:00Z — decision", "", "- Second candidate statement.", "",
    ].join("\n"));
    const report = compile(fixture.root, fixture.policy, fixture.registry);
    expect(report.candidates).toHaveLength(2);
    readCandidateProjectionV1({ workspace: fixture.root, workspaceId: "main", candidateId: report.candidates[0].candidateId });
    const conflictingCandidate = report.candidates[1];
    const operationId = candidateOperationId({ reportDigest: report.reportDigest, candidateId: conflictingCandidate.candidateId, evidenceSetDigest: conflictingCandidate.evidenceSetDigest, workspaceId: "main" });
    writeJson(join(memoryCandidateStoreRootV1(fixture.root), "operations", operationId.slice(7), "intent.json"), {});
    expect(() => materializeCandidateReportV2({ workspace: fixture.root, workspaceId: "main", report, policy: fixture.policy, scopeRegistry: fixture.registry })).toThrow();
    expect(readdirSync(join(memoryCandidateStoreRootV1(fixture.root), "journal"))).toHaveLength(0);
  });

  test("quarantines a second valid report payload for the same frozen attempt", () => {
    const fixture = workspace();
    const first = compile(fixture.root, fixture.policy, fixture.registry, T0, "batch:same-attempt");
    materializeCandidateReportV2({ workspace: fixture.root, workspaceId: "main", report: first, policy: fixture.policy, scopeRegistry: fixture.registry });
    write(join(fixture.root, "memory", "agent-main", "main", "2026-08-14.md"), [
      "# 2026-08-14", "", "## Decisions", "", "### 2026-08-14T10:00:00Z — decision", "", "- A different admitted payload.", "",
    ].join("\n"));
    const conflicting = compile(fixture.root, fixture.policy, fixture.registry, T0, "batch:same-attempt");
    expect(conflicting.compilationAttemptId).toBe(first.compilationAttemptId);
    expect(conflicting.reportDigest).not.toBe(first.reportDigest);
    expect(() => materializeCandidateReportV2({ workspace: fixture.root, workspaceId: "main", report: conflicting, policy: fixture.policy, scopeRegistry: fixture.registry })).toThrow("immutable payload conflict");
    expect(readdirSync(join(memoryCandidateStoreRootV1(fixture.root), "quarantine")).length).toBeGreaterThan(0);
  });

  test("uses the append-only journal as authority and rebuilds a forged projection cache", () => {
    const fixture = workspace();
    const report = compile(fixture.root, fixture.policy, fixture.registry);
    materializeCandidateReportV2({ workspace: fixture.root, workspaceId: "main", report, policy: fixture.policy, scopeRegistry: fixture.registry });
    const root = memoryCandidateStoreRootV1(fixture.root);
    const candidate = report.candidates[0];
    const projectionPath = join(root, "projections", `${candidate.candidateId.slice(7)}.json`);
    writeFileSync(projectionPath, "{\"forged\":true}\n");
    const rebuilt = readCandidateProjectionV1({ workspace: fixture.root, workspaceId: "main", candidateId: candidate.candidateId })!;
    expect(rebuilt.cluster).toEqual(candidate);
    expect(JSON.parse(readFileSync(projectionPath, "utf8")).projectionDigest).toBe(rebuilt.projectionDigest);
    expect(readdirSync(join(root, "journal", candidate.candidateId.slice(7)))).toEqual(["00000000000000000001.json"]);
  });

  test("freezes assessment ranking/access inputs while live source revocation can only invalidate", () => {
    const fixture = workspace({ kg: true });
    const frozen = compile(fixture.root, fixture.policy, fixture.registry, T0, "batch:frozen");
    materializeCandidateReportV2({ workspace: fixture.root, workspaceId: "main", report: frozen, policy: fixture.policy, scopeRegistry: fixture.registry });
    const candidate = frozen.candidates[0];
    const assertionPath = join(fixture.root, "life", "v3", "assertions", "11111111-1111-4111-8111-111111111111.json");
    writeJson(assertionPath, assertion("retracted"));
    const current = compile(fixture.root, fixture.policy, fixture.registry, T1, "batch:current");
    expect(() => assessCandidateSelectionV1({
      workspace: fixture.root,
      workspaceId: "main",
      candidateId: candidate.candidateId,
      expectedCandidateRevision: 1,
      frozenReport: frozen,
      frozenPolicy: fixture.policy,
      frozenScopeRegistry: fixture.registry,
      currentReport: current,
      currentPolicy: fixture.policy,
      currentScopeRegistry: fixture.registry,
      faultInjector() { throw new Error("assessment crash"); },
    })).toThrow("assessment crash");
    expect(readCandidateProjectionV1({ workspace: fixture.root, workspaceId: "main", candidateId: candidate.candidateId })!.cluster.lifecycle.status).toBe("pending");
    const assessment = assessCandidateSelectionV1({
      workspace: fixture.root, workspaceId: "main", candidateId: candidate.candidateId, expectedCandidateRevision: 1,
      frozenReport: frozen, frozenPolicy: fixture.policy, frozenScopeRegistry: fixture.registry,
      currentReport: current, currentPolicy: fixture.policy, currentScopeRegistry: fixture.registry,
    });
    expect(assessment.accessStateRevision).toBe(frozen.accessStateRevision);
    expect(assessment.outcome).toBe("invalidated");
    expect(assessment.reasonCode).toBe("source_retracted");
    expect(readCandidateProjectionV1({ workspace: fixture.root, workspaceId: "main", candidateId: candidate.candidateId })!.cluster.lifecycle.status).toBe("invalidated");
    const replay = assessCandidateSelectionV1({
      workspace: fixture.root, workspaceId: "main", candidateId: candidate.candidateId, expectedCandidateRevision: 1,
      frozenReport: frozen, frozenPolicy: fixture.policy, frozenScopeRegistry: fixture.registry,
      currentReport: current, currentPolicy: fixture.policy, currentScopeRegistry: fixture.registry,
    });
    expect(replay).toEqual(assessment);
    expect(readCandidateProjectionV1({ workspace: fixture.root, workspaceId: "main", candidateId: candidate.candidateId })!.highestContiguousRevision).toBe(2);
  });

  test("scope narrowing invalidates the old identity and only a later report materializes the new identity", () => {
    const fixture = workspace();
    const frozen = compile(fixture.root, fixture.policy, fixture.registry, T0, "batch:broad");
    materializeCandidateReportV2({ workspace: fixture.root, workspaceId: "main", report: frozen, policy: fixture.policy, scopeRegistry: fixture.registry });
    const narrowedPolicy = policy("domain");
    const current = compile(fixture.root, narrowedPolicy, fixture.registry, T1, "batch:narrow");
    expect(current.candidates[0].candidateId).not.toBe(frozen.candidates[0].candidateId);
    const assessment = assessCandidateSelectionV1({
      workspace: fixture.root,
      workspaceId: "main",
      candidateId: frozen.candidates[0].candidateId,
      expectedCandidateRevision: 1,
      frozenReport: frozen,
      frozenPolicy: fixture.policy,
      frozenScopeRegistry: fixture.registry,
      currentReport: current,
      currentPolicy: narrowedPolicy,
      currentScopeRegistry: fixture.registry,
    });
    expect(assessment.reasonCode).toBe("scope_revoked");
    expect(readCandidateProjectionV1({ workspace: fixture.root, workspaceId: "main", candidateId: current.candidates[0].candidateId })).toBeNull();
    materializeCandidateReportV2({ workspace: fixture.root, workspaceId: "main", report: current, policy: narrowedPolicy, scopeRegistry: fixture.registry });
    expect(readCandidateProjectionV1({ workspace: fixture.root, workspaceId: "main", candidateId: current.candidates[0].candidateId })!.cluster.lifecycle.status).toBe("pending");
  });

  test("revalidates authorization fail-closed for every source class", () => {
    const fixture = allSourcesWorkspace();
    const frozen = compile(fixture.root, fixture.policy, fixture.registry, T0, "batch:all-sources");
    expect(new Set(frozen.occurrences.map((entry) => entry.sourceClass))).toEqual(new Set([
      "daily-decision", "daily-learning", "retrieval-card", "domain-decision", "domain-proposal", "kg-assertion",
    ]));
    materializeCandidateReportV2({ workspace: fixture.root, workspaceId: "main", report: frozen, policy: fixture.policy, scopeRegistry: fixture.registry });
    const revokedPolicy = structuredClone(fixture.policy);
    revokedPolicy.daily = [];
    revokedPolicy.domains = [];
    revokedPolicy.kg = [];
    const current = compile(fixture.root, revokedPolicy, fixture.registry, T1, "batch:revoked-all");
    for (const candidate of frozen.candidates) {
      const assessment = assessCandidateSelectionV1({
        workspace: fixture.root, workspaceId: "main", candidateId: candidate.candidateId, expectedCandidateRevision: 1,
        frozenReport: frozen, frozenPolicy: fixture.policy, frozenScopeRegistry: fixture.registry,
        currentReport: current, currentPolicy: revokedPolicy, currentScopeRegistry: fixture.registry,
      });
      expect(assessment.outcome).toBe("invalidated");
    }
    expect(frozen.candidates).toHaveLength(6);
  });

  test("inboxes evidence arriving under a reservation without mutating the cited epoch", () => {
    const fixture = workspace();
    const first = compile(fixture.root, fixture.policy, fixture.registry, T0, "batch:first");
    materializeCandidateReportV2({ workspace: fixture.root, workspaceId: "main", report: first, policy: fixture.policy, scopeRegistry: fixture.registry });
    const candidate = first.candidates[0];
    const reservation = reserveCandidateV1({
      workspace: fixture.root,
      workspaceId: "main",
      planId: sha256Digest("plan-1"),
      candidateId: candidate.candidateId,
      expectedRevision: 1,
      evidenceSetDigest: candidate.evidenceSetDigest,
      now: T1,
    });
    expect(reserveCandidateV1({
      workspace: fixture.root, workspaceId: "main", planId: sha256Digest("plan-1"), candidateId: candidate.candidateId,
      expectedRevision: 1, evidenceSetDigest: candidate.evidenceSetDigest, now: T1,
    })).toEqual(reservation);
    expect(() => reserveCandidateV1({
      workspace: fixture.root, workspaceId: "main", planId: sha256Digest("competing-plan"), candidateId: candidate.candidateId,
      expectedRevision: 1, evidenceSetDigest: candidate.evidenceSetDigest, now: T1,
    })).toThrow("revision CAS conflict");
    write(join(fixture.root, "memory", "agent-main", "main", "2026-08-14.md"), [
      "# 2026-08-14", "", "## Decisions", "", "### 2026-08-14T10:00:00Z — decision", "", "- Keep journal revisions append only.", "",
      "### 2026-08-14T12:30:00Z — decision", "", "- Keep journal revisions append only.", "",
    ].join("\n"));
    const second = compile(fixture.root, fixture.policy, fixture.registry, T1, "batch:second");
    const result = materializeCandidateReportV2({ workspace: fixture.root, workspaceId: "main", report: second, policy: fixture.policy, scopeRegistry: fixture.registry });
    expect(result.candidates[0].status).toBe("inboxed");
    const projection = readCandidateProjectionV1({ workspace: fixture.root, workspaceId: "main", candidateId: candidate.candidateId })!;
    expect(projection.highestContiguousRevision).toBe(2);
    expect(projection.cluster.evidenceSetDigest).toBe(candidate.evidenceSetDigest);
    expect(projection.cluster.evaluationEpoch).toBe(1);
    expect(listPendingEvidenceV1({ workspace: fixture.root, candidateId: candidate.candidateId }).length).toBeGreaterThan(0);
    const laterSameEvidence = compile(fixture.root, fixture.policy, fixture.registry, T1, "batch:third");
    expect(() => materializeCandidateReportV2({ workspace: fixture.root, workspaceId: "main", report: laterSameEvidence, policy: fixture.policy, scopeRegistry: fixture.registry })).not.toThrow();
    expect(listPendingEvidenceV1({ workspace: fixture.root, candidateId: candidate.candidateId }).length).toBe(result.candidates[0].inboxedOccurrences);
  });
});
