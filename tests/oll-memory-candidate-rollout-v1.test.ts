import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Digest } from "../src/oll/handoff-v2";
import {
  MEMORY_CANDIDATE_POLICY_V2_SCHEMA,
  MEMORY_CANDIDATE_RANKING_POLICY_V1_SCHEMA,
  MEMORY_CANDIDATE_SCOPE_REGISTRY_V1_SCHEMA,
  candidateScopeRegistryDigestV1,
  type CandidateScopeRegistryV1,
  type CandidateSourcePolicyV2,
} from "../src/oll/memory-candidate-contracts-v2";
import {
  CandidateRolloutError,
  applyCandidateCompilerRolloutV1,
  inspectCandidateCompilerProjectionV1,
  inspectCandidateRollbackBarrierV1,
  listCandidateRollbackReceiptsV1,
  planCandidateCompilerRolloutV1,
  rollbackCandidateCompilerV1,
  type CandidateRolloutEvidenceV1,
} from "../src/oll/memory-candidate-rollout-v1";

const roots: string[] = [];
const NOW = "2026-08-14T20:00:00.000Z";
const SHADOW_RELEASE = "11111111-1111-4111-8111-111111111111";
const MATERIALIZE_RELEASE = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function json(path: string, value: unknown): string {
  mkdirSync(join(path, ".."), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, body, "utf8");
  return body;
}

function policy(mode: "shadow" | "materialize"): CandidateSourcePolicyV2 {
  return {
    schema: MEMORY_CANDIDATE_POLICY_V2_SCHEMA,
    mode,
    forwardOnlySince: "2026-08-14T00:00:00Z",
    workspaceTimezone: "UTC",
    legacyTimestampParser: null,
    daily: [{ session: "main", sections: ["decisions"], scopeCeiling: { level: "workspace", subject: "main" } }],
    domains: [],
    kg: [],
    limits: {
      maxCandidatesPerRun: 20,
      maxContextBytes: 65_536,
      maxOccurrencesPerCluster: 8,
      sourceQuotas: {
        "daily-decision": 8, "daily-learning": 0, "retrieval-card": 0,
        "domain-decision": 0, "domain-proposal": 0, "kg-assertion": 0,
      },
    },
    decayPolicy: {
      schema: "oll.memory-candidate-decay-policy.v1", hotDays: 7, warmDays: 30,
      accessCountCap: 10, warmScorePenalty: 12, coldKgContribution: "provenance-only",
      trustedAccessEventSchema: "engram.kg-v3-access-event.v1",
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

function evidence(workspaceId = "main", materialize = false): CandidateRolloutEvidenceV1 {
  return {
    schema: "oll.memory-candidate-rollout-evidence.v1",
    workspaceId,
    phase4: { targetedPassed: 70, fullPassed: 978, typecheckPassed: true, privacyPassed: true, openHighFindings: 0 },
    shadow: {
      dailyCycles: materialize ? 7 : 0,
      weeklyCycles: materialize ? 1 : 0,
      scopeOrPrivacyEscapes: 0,
      replayDrift: 0,
      payloadConflicts: 0,
      unexpectedEffects: 0,
      sourceStarvation: 0,
      projectedLoadBounded: materialize,
      crashRecoveryPassed: materialize,
      rollbackDrillPassed: materialize,
    },
    capturedAt: NOW,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "engram-candidate-rollout-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "state");
  json(join(workspace, "engram.json"), {
    workspace: { id: "main" },
    oll: { candidateCompiler: { mode: "disabled" } },
  });
  const evidencePath = join(stateRoot, "oll-memory-candidate-rollouts", "evidence", "phase4.json");
  const evidenceBody = json(evidencePath, evidence());
  return { root, workspace, stateRoot, evidencePath, evidenceDigest: sha256Digest(evidenceBody), scopeRegistry: registry() };
}

function request(input: ReturnType<typeof fixture>, mode: "shadow" | "materialize", releaseId: string, now = NOW) {
  return {
    stateRoot: input.stateRoot,
    workspace: input.workspace,
    workspaceId: "main",
    releaseId,
    targetMode: mode,
    policy: policy(mode),
    scopeRegistry: input.scopeRegistry,
    evidencePath: input.evidencePath,
    evidenceDigest: input.evidenceDigest,
    approvedBy: "operator:sergey",
    now,
  } as const;
}

describe("OLL memory candidate Phase 5 rollout", () => {
  test("plans read-only, requires acknowledgement, and publishes an exact shadow projection last", () => {
    const input = fixture();
    const value = request(input, "shadow", SHADOW_RELEASE);
    const plan = planCandidateCompilerRolloutV1(value);
    expect(plan).toMatchObject({ schema: "oll.memory-candidate-rollout-plan.v1", currentMode: "disabled", targetMode: "shadow", mutatesLiveState: false });
    expect(existsSync(plan.projectionPath)).toBe(false);
    expect(() => applyCandidateCompilerRolloutV1({ ...value, acknowledge: false })).toThrow(CandidateRolloutError);
    const result = applyCandidateCompilerRolloutV1({ ...value, acknowledge: true });
    expect(result).toMatchObject({ status: "applied", release: { status: "shadow_canary", mode: "shadow" } });
    expect(applyCandidateCompilerRolloutV1({ ...value, acknowledge: true })).toMatchObject({ status: "idempotent" });
    expect(inspectCandidateCompilerProjectionV1({ workspace: input.workspace, workspaceId: "main" })).toMatchObject({ mode: "shadow", consistent: true, projection: { status: "shadow_canary" } });
    expect(JSON.parse(readFileSync(join(input.workspace, "engram.json"), "utf8")).oll.candidateCompiler.schema).toBe(MEMORY_CANDIDATE_POLICY_V2_SCHEMA);
  });

  test("resumes the same rollout after crashes around every live publication boundary", () => {
    const points = ["after_applying_projection", "after_config_publication", "after_active_projection"] as const;
    for (const [index, point] of points.entries()) {
      const input = fixture();
      const releaseId = `${String(index + 3).repeat(8)}-${String(index + 3).repeat(4)}-4${String(index + 3).repeat(3)}-8${String(index + 3).repeat(3)}-${String(index + 3).repeat(12)}`;
      const value = request(input, "shadow", releaseId);
      expect(() => applyCandidateCompilerRolloutV1({
        ...value,
        acknowledge: true,
        faultInjector(observed) { if (observed === point) throw new Error(`crash:${point}`); },
      })).toThrow(`crash:${point}`);
      const resumed = applyCandidateCompilerRolloutV1({ ...value, acknowledge: true });
      expect(resumed).toMatchObject({ status: "applied", release: { mode: "shadow", status: "shadow_canary" } });
      expect(applyCandidateCompilerRolloutV1({ ...value, acknowledge: true })).toMatchObject({ status: "idempotent" });
    }
  });

  test("materialize is a separate gate requiring seven daily and one weekly clean shadow cycles", () => {
    const input = fixture();
    applyCandidateCompilerRolloutV1({ ...request(input, "shadow", SHADOW_RELEASE), acknowledge: true });
    expect(() => planCandidateCompilerRolloutV1(request(input, "materialize", MATERIALIZE_RELEASE, "2026-08-14T21:00:00.000Z"))).toThrow("seven daily cycles");
    const body = json(input.evidencePath, evidence("main", true));
    input.evidenceDigest = sha256Digest(body);
    const value = request(input, "materialize", MATERIALIZE_RELEASE, "2026-08-14T21:00:00.000Z");
    const result = applyCandidateCompilerRolloutV1({ ...value, acknowledge: true });
    expect(result).toMatchObject({ status: "applied", release: { status: "materialize_review_only", mode: "materialize" } });
    expect(inspectCandidateCompilerProjectionV1({ workspace: input.workspace, workspaceId: "main" })).toMatchObject({ mode: "materialize", consistent: true });
  });

  test("classifies every candidate-aware coordinator phase for the rollback barrier", () => {
    const input = fixture();
    const contextPath = join(input.stateRoot, "oll-nightly", "batches", "batch-1", "contexts", "main.json");
    json(join(input.stateRoot, "oll-nightly", "current-batch.json"), { schema: "oll.current-batch.v1", batchId: "batch-1" });
    json(contextPath, { schema: "oll.nightly-context.v2", candidateCompiler: { mode: "materialize" } });
    const cases = [
      ["preflight", "pre_dispatch", 0],
      ["spawn_acknowledged", "acknowledged", 1],
      ["awaiting_handoff", "acknowledged", 1],
      ["handoff_received", "handoff_received", 1],
      ["applying", "applying", 1],
      ["review_pending", "review_pending", 1],
      ["completed", "terminal", 0],
    ] as const;
    for (const [status, phase, unsupported] of cases) {
      json(join(input.stateRoot, "oll-nightly", "batches", "batch-1", "batch.json"), {
        batchId: "batch-1", activeWorkspace: "main", activeRunId: "33333333-3333-4333-8333-333333333333",
        activeHandoffPath: join(input.workspace, "handoff.json"), status,
      });
      expect(inspectCandidateRollbackBarrierV1({ ...input, workspaceId: "main", now: NOW })).toMatchObject({
        coordinator: { phase }, unsupportedPhases: unsupported, binaryRollbackReady: unsupported === 0,
      });
    }
  });

  test("rollback disables new batches, quarantines an acknowledged v3 run, and preserves evidence", () => {
    const input = fixture();
    applyCandidateCompilerRolloutV1({ ...request(input, "shadow", SHADOW_RELEASE), acknowledge: true });
    const body = json(input.evidencePath, evidence("main", true));
    input.evidenceDigest = sha256Digest(body);
    applyCandidateCompilerRolloutV1({ ...request(input, "materialize", MATERIALIZE_RELEASE, "2026-08-14T21:00:00.000Z"), acknowledge: true });
    json(join(input.stateRoot, "oll-nightly", "current-batch.json"), { schema: "oll.current-batch.v1", batchId: "batch-1" });
    json(join(input.stateRoot, "oll-nightly", "batches", "batch-1", "contexts", "main.json"), { schema: "oll.nightly-context.v2", candidateCompiler: { mode: "materialize" } });
    json(join(input.stateRoot, "oll-nightly", "batches", "batch-1", "batch.json"), {
      batchId: "batch-1", activeWorkspace: "main", activeRunId: "33333333-3333-4333-8333-333333333333",
      activeHandoffPath: join(input.workspace, "handoff.json"), status: "spawn_acknowledged",
    });
    expect(() => rollbackCandidateCompilerV1({
      stateRoot: input.stateRoot, workspace: input.workspace, workspaceId: "main", releaseId: MATERIALIZE_RELEASE,
      scopeRegistry: input.scopeRegistry, approvedBy: "operator:sergey", reason: "synthetic rollback drill", acknowledge: false, now: "2026-08-14T22:00:00.000Z",
    })).toThrow("explicit acknowledgement");
    const report = rollbackCandidateCompilerV1({
      stateRoot: input.stateRoot, workspace: input.workspace, workspaceId: "main", releaseId: MATERIALIZE_RELEASE,
      scopeRegistry: input.scopeRegistry, approvedBy: "operator:sergey", reason: "synthetic rollback drill", acknowledge: true, now: "2026-08-14T22:00:00.000Z",
    });
    expect(report).toMatchObject({ configuredMode: "disabled", modeRollbackReady: true, binaryRollbackReady: false, evidencePreserved: true });
    expect(inspectCandidateCompilerProjectionV1({ workspace: input.workspace, workspaceId: "main" })).toMatchObject({ mode: "disabled", consistent: true, projection: { status: "disabled" } });
    expect(listCandidateRollbackReceiptsV1(input.stateRoot, MATERIALIZE_RELEASE)).toEqual([
      expect.objectContaining({ action: "quarantined_frozen_v3", batchId: "batch-1" }),
    ]);
    expect(existsSync(input.evidencePath)).toBe(true);
    expect(rollbackCandidateCompilerV1({
      stateRoot: input.stateRoot, workspace: input.workspace, workspaceId: "main", releaseId: MATERIALIZE_RELEASE,
      scopeRegistry: input.scopeRegistry, approvedBy: "operator:sergey", reason: "synthetic rollback drill", acknowledge: true, now: "2026-08-14T22:01:00.000Z",
    })).toMatchObject({ status: "idempotent", releaseId: MATERIALIZE_RELEASE });
  });

  test("read-back fails closed when config activation has no matching projection", () => {
    const input = fixture();
    const config = JSON.parse(readFileSync(join(input.workspace, "engram.json"), "utf8"));
    config.oll.candidateCompiler = policy("shadow");
    config.oll.candidateScopeRegistry = input.scopeRegistry;
    json(join(input.workspace, "engram.json"), config);
    expect(inspectCandidateCompilerProjectionV1({ workspace: input.workspace, workspaceId: "main" })).toMatchObject({ mode: "shadow", consistent: false });
  });
});
