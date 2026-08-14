import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { NightlySpawnRequestV1, RegistrySnapshotV1, WorkspaceRegistryAdapter } from "../src/oll/contracts";
import { canonicalizeJcs, computeHandoffDigest, sha256Digest } from "../src/oll/handoff-v2";
import { runNightlyCoordinator } from "../src/oll/nightly-coordinator";
import {
  MEMORY_CANDIDATE_POLICY_V2_SCHEMA,
  MEMORY_CANDIDATE_RANKING_POLICY_V1_SCHEMA,
  MEMORY_CANDIDATE_SCOPE_REGISTRY_V1_SCHEMA,
  candidateScopeRegistryDigestV1,
  type CandidateScopeRegistryV1,
} from "../src/oll/memory-candidate-contracts-v2";
import { FakeNightlyRuntime } from "./fixtures/oll-nightly/fake-runtime";

const roots: string[] = [];
const NOW = "2026-08-11T00:40:00.000Z";

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
}

function createWorkspace(parent: string, id: string, actionable = true): string {
  const root = join(parent, id);
  write(join(root, "engram.json"), {
    schemaVersion: 1,
    workspace: { id },
    oll: {
      scheduleOwner: "nightly",
      nightly: {
        enabled: true, timezone: "UTC", weekStart: "monday",
        coordinatorStateRoot: "${ENGRAM_STATE_ROOT}/oll-nightly", workspaceStateDir: "memory-state/oll",
        leaseTtlSeconds: 600, leaseRenewSeconds: 60, handoffTimeoutSeconds: 1,
        batchTimeoutSeconds: 21600, maxSpawnAttempts: 2, retryBackoffSeconds: [0, 0],
      },
      weeklyMode: { enabled: false, day: "monday" },
      adaptation: {
        enabled: true, mode: "observe-only", autoApplyMaxRisk: "low",
        actorRegistry: "${ENGRAM_STATE_ROOT}/oll/actors.v1.json",
        companyRuleStore: "${ENGRAM_STATE_ROOT}/oll/company-rules",
        maxHandoffBytes: 262144, maxActionsPerHandoff: 50, maxInjectedRuleBytes: 8192,
      },
    },
    models: { heartbeat: { subagents: { "hb-rethink": "deployment/full-reasoning" } } },
  });
  write(join(root, "memory-state", "oll", "state.json"), {
    schema: "oll-nightly-state.v1", schemaVersion: 1, workspaceId: id, scheduleOwner: "nightly", nightlyEnabled: true,
    legacyHeartbeat: { admission: "disabled", application: "disabled", disabledAt: NOW },
    memoryReconciliation: { weeklyWindowStart: null, lastCompletedAt: null },
    capture: { lastObservedAt: null },
    evaluation: { lastCompletedAt: null, lastSnapshotAt: null, signalRevisions: {}, lastScore: null, completedCount: 0 },
    migration: { id: "legacy-heartbeat-v1", sourceDigest: sha256Digest("fixture"), mappingVersion: 1, backupManifest: "fixture", quarantineManifest: "fixture", completedAt: NOW },
  });
  write(join(root, "memory-state", "oll", "rollout.json"), {
    schema: "oll.workspace-rollout-state.v1", workspaceId: id, releaseId: "fixture-release",
    rolloutBatchId: "fixture-batch", targetMode: "observe-only", status: "observe_only_canary",
    schedulerJobId: "fixture-nightly", schedulerPayloadRevision: sha256Digest("fixture-payload"), updatedAt: NOW, revision: 1,
  });
  if (actionable) {
    const signalId = id === "alpha" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222";
    write(join(root, "memory-state", "oll", "signals", `${signalId}.json`), {
      schema: "oll.adaptation-signal.v1", id: signalId, workspaceId: id, type: "correction",
      scope: { level: "workspace", subject: id, domain: null },
      statement: "Use the approved report format", expectedBehavior: "Use it in the next report",
      evidence: [], capturedBy: "fixture", authorizationDecision: { status: "review_required" },
      dedupKey: sha256Digest(id), confidence: 1, status: "review_required", createdAt: "2026-08-11T00:30:00.000Z", reviewedAt: null, revision: 1,
    });
  }
  for (const directory of ["rules", "reviews", "operations", "audit", "handoffs/incoming", "handoffs/applied", "handoffs/rejected", "apply-journal"]) {
    mkdirSync(join(root, "memory-state", "oll", directory), { recursive: true });
  }
  mkdirSync(join(root, "ops", "observations"), { recursive: true });
  mkdirSync(join(root, "ops", "tensions"), { recursive: true });
  return root;
}

class Registry implements WorkspaceRegistryAdapter {
  constructor(readonly entries: RegistrySnapshotV1["entries"]) {}
  async snapshot(): Promise<RegistrySnapshotV1> {
    return { schema: "oll.workspace-registry-snapshot.v1", capturedAt: NOW, entries: this.entries };
  }
}

function registryEntry(id: string, workspacePath: string) {
  return { workspaceId: id, workspacePath, registryRevision: 1, registryDigest: sha256Digest("registry"), configDigest: sha256Digest("ignored") } as const;
}

function configureCandidateCompiler(workspacePath: string, workspaceId: string, mode: "disabled" | "shadow", options: { missingRegistry?: boolean; evidence?: boolean } = {}): void {
  const configPath = join(workspacePath, "engram.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (mode === "disabled") {
    config.oll.candidateCompiler = { mode: "disabled" };
    write(configPath, config);
    return;
  }
  config.oll.candidateCompiler = {
    schema: MEMORY_CANDIDATE_POLICY_V2_SCHEMA,
    mode: "shadow",
    forwardOnlySince: "2026-08-10T00:00:00Z",
    workspaceTimezone: "UTC",
    legacyTimestampParser: { version: "legacy-local-v1", daylightSavingAmbiguity: "reject" },
    daily: [{ session: "main", sections: ["decisions"], scopeCeiling: { level: "workspace", subject: workspaceId } }],
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
  if (!options.missingRegistry) {
    const base: Omit<CandidateScopeRegistryV1, "digest"> = {
      schema: MEMORY_CANDIDATE_SCOPE_REGISTRY_V1_SCHEMA,
      workspaceId,
      revision: 1,
      selfToDomain: {},
      domainToWorkspace: {},
      sourceAuthorities: {
        daily: { main: { level: "workspace", subject: workspaceId } },
        domains: {},
        kgScopes: {},
      },
    };
    config.oll.candidateScopeRegistry = { ...base, digest: candidateScopeRegistryDigestV1(base) };
  }
  write(configPath, config);
  if (!options.missingRegistry) {
    write(join(workspacePath, "memory-state", "oll", "candidate-rollout.json"), {
      schema: "oll.memory-candidate-rollout-projection.v1",
      workspaceId,
      releaseId: "11111111-1111-4111-8111-111111111111",
      planId: sha256Digest(`shadow-plan:${workspaceId}`),
      mode: "shadow",
      status: "shadow_canary",
      policyDigest: sha256Digest(canonicalizeJcs(config.oll.candidateCompiler)),
      scopeRegistryDigest: config.oll.candidateScopeRegistry.digest,
      evidenceDigest: sha256Digest("phase4-evidence"),
      approvedBy: "test-operator",
      revision: 2,
      updatedAt: NOW,
    });
  }
  mkdirSync(join(workspacePath, "memory", `agent-${workspaceId}`, "main"), { recursive: true });
  if (options.evidence !== false) {
    write(join(workspacePath, "memory", `agent-${workspaceId}`, "main", "2026-08-11.md"), [
      "# 2026-08-11", "", "## Decisions", "", "### 2026-08-11T00:35:00Z — decision", "", "- Candidate-only shadow statement.", "",
    ].join("\n"));
  }
}

function batchArtifact(stateRoot: string, batchId: string, ...parts: string[]): string {
  return join(stateRoot, "oll-nightly", "batches", batchId, ...parts);
}

function validEmptyHandoff(request: NightlySpawnRequestV1) {
  const withoutDigest = {
    schema: "oll.rethink-handoff.v2" as const,
    batchId: request.batchId,
    workspaceId: request.workspaceId,
    evaluationId: request.evaluationId,
    runId: request.runId,
    phase: "hb-rethink" as const,
    attempt: request.attempt,
    policyVersion: 1 as const,
    contextDigest: request.contextDigest,
    createdAt: NOW,
    actions: [],
  };
  return { ...withoutDigest, handoffDigest: computeHandoffDigest(withoutDigest) };
}

function environment(ids: Array<{ id: string; actionable?: boolean }> = [{ id: "alpha" }, { id: "beta" }]) {
  const root = mkdtempSync(join(tmpdir(), "engram-nightly-coordinator-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "engram-nightly-coordinator-state-"));
  roots.push(root, stateRoot);
  const workspaces = Object.fromEntries(ids.map(({ id, actionable = true }) => [id, createWorkspace(root, id, actionable)]));
  const registry = new Registry(Object.entries(workspaces).reverse().map(([id, path]) => registryEntry(id, path)));
  return { root, stateRoot, workspaces, registry };
}

function coordinatorOptions(env: ReturnType<typeof environment>, runtime: FakeNightlyRuntime, faultInjector?: any) {
  return {
    stateRoot: env.stateRoot,
    registryAdapter: env.registry,
    allowedWorkspaceRoots: [env.root],
    runtime,
    scriptsDir: "/canonical/scripts",
    resolveModel: () => "deployment/full-reasoning",
    now: () => NOW,
    sleep: async () => {},
    reconcile: async (workspace: any) => ({ workspace: workspace.workspacePath, status: "ok" as const }),
    faultInjector,
  };
}

function successRuntime(predicate: (request: NightlySpawnRequestV1) => boolean = () => true): FakeNightlyRuntime {
  return new FakeNightlyRuntime((request, runtime) => {
    if (!predicate(request)) return;
    write(request.expectedHandoffPath, validEmptyHandoff(request));
    runtime.queueHandoff(request.expectedHandoffPath);
  });
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("PR 5 strict FIFO nightly coordinator", () => {
  test("processes two workspaces through terminal apply in deterministic order with max concurrency one", async () => {
    const env = environment();
    const runtime = successRuntime();
    const report = await runNightlyCoordinator(coordinatorOptions(env, runtime));
    expect(report).toMatchObject({ status: "completed", completed: ["alpha", "beta"], failed: [], processingOrder: ["alpha", "beta"], spawned: 2, maxConcurrentRethinkRuns: 1 });
    expect(runtime.events.map((event) => `${event.type}:${event.workspaceId || ""}`)).toEqual([
      "spawn:alpha", "handoff:alpha", "terminal_apply:alpha",
      "spawn:beta", "handoff:beta", "terminal_apply:beta",
    ]);
  });

  test("empty preflight is durably skipped with zero model calls", async () => {
    const env = environment([{ id: "alpha", actionable: false }]);
    const runtime = successRuntime();
    const report = await runNightlyCoordinator(coordinatorOptions(env, runtime));
    expect(report).toMatchObject({ status: "completed", completed: ["alpha"], skipped: ["alpha"], spawned: 0 });
    expect(runtime.events).toEqual([]);
  });

  test("missing and explicit disabled candidate config preserve the legacy context and v2 handoff path", async () => {
    const missing = environment([{ id: "alpha" }]);
    let missingRequest: NightlySpawnRequestV1 | null = null;
    const missingRuntime = new FakeNightlyRuntime((request, runtime) => {
      missingRequest = request;
      write(request.expectedHandoffPath, validEmptyHandoff(request));
      runtime.queueHandoff(request.expectedHandoffPath);
    });
    const missingReport = await runNightlyCoordinator(coordinatorOptions(missing, missingRuntime));

    const disabled = environment([{ id: "alpha" }]);
    configureCandidateCompiler(disabled.workspaces.alpha, "alpha", "disabled");
    let disabledRequest: NightlySpawnRequestV1 | null = null;
    const disabledRuntime = new FakeNightlyRuntime((request, runtime) => {
      disabledRequest = request;
      write(request.expectedHandoffPath, validEmptyHandoff(request));
      runtime.queueHandoff(request.expectedHandoffPath);
    });
    const disabledReport = await runNightlyCoordinator(coordinatorOptions(disabled, disabledRuntime));

    const missingContext = readFileSync(batchArtifact(missing.stateRoot, missingReport.batchId, "contexts", "alpha.json"), "utf8");
    const disabledContext = readFileSync(batchArtifact(disabled.stateRoot, disabledReport.batchId, "contexts", "alpha.json"), "utf8");
    expect(disabledContext).toBe(missingContext);
    expect(JSON.parse(missingContext).schema).toBe("oll.nightly-context.v1");
    expect(missingRequest).not.toBeNull();
    expect(disabledRequest).not.toBeNull();
    expect((missingRequest as NightlySpawnRequestV1).prompt).toContain("oll.rethink-handoff.v2");
    expect((disabledRequest as NightlySpawnRequestV1).prompt).toContain("oll.rethink-handoff.v2");
    expect((missingRequest as NightlySpawnRequestV1).prompt).not.toContain("oll.rethink-handoff.v3");
    expect((disabledRequest as NightlySpawnRequestV1).prompt).not.toContain("oll.rethink-handoff.v3");
    expect(missingReport.candidateShadow).toBeUndefined();
    expect(disabledReport.candidateShadow).toBeUndefined();
    expect(existsSync(batchArtifact(missing.stateRoot, missingReport.batchId, "candidate-reports"))).toBe(false);
    expect(existsSync(batchArtifact(disabled.stateRoot, disabledReport.batchId, "candidate-reports"))).toBe(false);
  });

  test("shadow report stays outside model context and does not add a spawn, transition, review, or action", async () => {
    const env = environment([{ id: "alpha" }]);
    configureCandidateCompiler(env.workspaces.alpha, "alpha", "shadow");
    let request: NightlySpawnRequestV1 | null = null;
    const runtime = new FakeNightlyRuntime((spawnRequest, current) => {
      request = spawnRequest;
      write(spawnRequest.expectedHandoffPath, validEmptyHandoff(spawnRequest));
      current.queueHandoff(spawnRequest.expectedHandoffPath);
    });
    const report = await runNightlyCoordinator(coordinatorOptions(env, runtime));
    expect(report).toMatchObject({ status: "completed", spawned: 1, candidateShadow: { attempted: 1, succeeded: 1, failed: 0 } });
    const contextText = readFileSync(batchArtifact(env.stateRoot, report.batchId, "contexts", "alpha.json"), "utf8");
    const context = JSON.parse(contextText);
    expect(context.schema).toBe("oll.nightly-context.v1");
    expect(context).not.toHaveProperty("memoryCandidates");
    expect(context).not.toHaveProperty("candidateRevisions");
    expect(contextText).not.toContain("Candidate-only shadow statement");
    expect((request as unknown as NightlySpawnRequestV1).prompt).not.toContain("Candidate-only shadow statement");
    expect((request as unknown as NightlySpawnRequestV1).prompt).toContain("oll.rethink-handoff.v2");
    const candidateReport = JSON.parse(readFileSync(batchArtifact(env.stateRoot, report.batchId, "candidate-reports", "alpha.json"), "utf8"));
    expect(candidateReport).toMatchObject({ schema: "oll.memory-candidate-report.v2", executionMode: "shadow", selected: 1, projectedModelSpawns: 1, projectedReviews: 1 });
    const candidateRoot = join(env.workspaces.alpha, "memory-state", "oll", "candidates");
    expect(existsSync(candidateRoot)).toBe(false);
    expect(readdirSync(join(env.workspaces.alpha, "memory-state", "oll", "reviews"))).toEqual([]);
    expect(runtime.events.filter((event) => event.type === "spawn")).toHaveLength(1);
  });

  test("shadow candidates alone persist metrics but cannot trigger a model spawn", async () => {
    const env = environment([{ id: "alpha", actionable: false }]);
    configureCandidateCompiler(env.workspaces.alpha, "alpha", "shadow");
    const runtime = successRuntime();
    const report = await runNightlyCoordinator(coordinatorOptions(env, runtime));
    expect(report).toMatchObject({ status: "completed", skipped: ["alpha"], spawned: 0, candidateShadow: { attempted: 1, succeeded: 1, failed: 0 } });
    const candidateReport = JSON.parse(readFileSync(batchArtifact(env.stateRoot, report.batchId, "candidate-reports", "alpha.json"), "utf8"));
    expect(candidateReport.selected).toBe(1);
    expect(runtime.events).toEqual([]);
  });

  test("shadow compiler failure is content-free and cannot block an ordinary behavioral rethink", async () => {
    const env = environment([{ id: "alpha" }]);
    configureCandidateCompiler(env.workspaces.alpha, "alpha", "shadow", { missingRegistry: true });
    let request: NightlySpawnRequestV1 | null = null;
    const runtime = new FakeNightlyRuntime((spawnRequest, current) => {
      request = spawnRequest;
      write(spawnRequest.expectedHandoffPath, validEmptyHandoff(spawnRequest));
      current.queueHandoff(spawnRequest.expectedHandoffPath);
    });
    const report = await runNightlyCoordinator(coordinatorOptions(env, runtime));
    expect(report).toMatchObject({ status: "completed", completed: ["alpha"], failed: [], spawned: 1, candidateShadow: { attempted: 1, succeeded: 0, failed: 1 } });
    expect((request as unknown as NightlySpawnRequestV1).prompt).toContain("oll.rethink-handoff.v2");
    const terminalText = readFileSync(batchArtifact(env.stateRoot, report.batchId, "candidate-compilation-attempts", "alpha.terminal.json"), "utf8");
    expect(JSON.parse(terminalText)).toMatchObject({ status: "failed", errorClass: "scope_registry_invalid" });
    expect(terminalText).not.toContain(env.workspaces.alpha);
    expect(terminalText).not.toContain("Candidate-only shadow statement");
  });

  test("shadow report publication conflict is isolated from the legacy model path", async () => {
    const env = environment([{ id: "alpha" }]);
    configureCandidateCompiler(env.workspaces.alpha, "alpha", "shadow");
    const batchId = `nightly-${NOW}`;
    write(batchArtifact(env.stateRoot, batchId, "candidate-reports", "alpha.json"), { conflict: true });
    let request: NightlySpawnRequestV1 | null = null;
    const runtime = new FakeNightlyRuntime((spawnRequest, current) => {
      request = spawnRequest;
      write(spawnRequest.expectedHandoffPath, validEmptyHandoff(spawnRequest));
      current.queueHandoff(spawnRequest.expectedHandoffPath);
    });
    const report = await runNightlyCoordinator(coordinatorOptions(env, runtime));
    expect(report).toMatchObject({ status: "completed", spawned: 1, candidateShadow: { attempted: 1, succeeded: 0, failed: 1 } });
    expect((request as unknown as NightlySpawnRequestV1).prompt).toContain("oll.rethink-handoff.v2");
    const terminal = JSON.parse(readFileSync(batchArtifact(env.stateRoot, batchId, "candidate-compilation-attempts", "alpha.terminal.json"), "utf8"));
    expect(terminal).toMatchObject({ status: "failed", errorClass: "artifact_failed" });
  });

  test("accepts fleet reconciliation evidence from the deployment wrapper without reconciling the canary twice", async () => {
    const env = environment([{ id: "alpha", actionable: false }]);
    const runtime = successRuntime();
    let reconciled = 0;
    const report = await runNightlyCoordinator({
      ...coordinatorOptions(env, runtime),
      reconcile: async (workspace: any) => { reconciled += 1; return { workspace: workspace.workspacePath, status: "ok" as const }; },
      reconciliationCompletedExternally: true,
    });
    expect(report).toMatchObject({ status: "completed", completed: ["alpha"], skipped: ["alpha"] });
    expect(reconciled).toBe(0);
  });

  test("exhausts bounded timeout retries for one workspace and then continues FIFO", async () => {
    const env = environment();
    const runtime = successRuntime((request) => request.workspaceId === "beta");
    const report = await runNightlyCoordinator(coordinatorOptions(env, runtime));
    expect(report).toMatchObject({ status: "completed", completed: ["beta"], failed: ["alpha"], spawned: 3, maxConcurrentRethinkRuns: 1 });
    expect(runtime.events.filter((event) => event.type === "spawn").map((event) => event.workspaceId)).toEqual(["alpha", "alpha", "beta"]);
  });

  test("invalid correlated handoff fails one workspace without blocking the next", async () => {
    const env = environment();
    const runtime = new FakeNightlyRuntime((request, current) => {
      const handoff: any = validEmptyHandoff(request);
      if (request.workspaceId === "alpha") {
        handoff.contextDigest = sha256Digest("wrong");
        handoff.handoffDigest = computeHandoffDigest(handoff);
      }
      write(request.expectedHandoffPath, handoff);
      current.queueHandoff(request.expectedHandoffPath);
    });
    const report = await runNightlyCoordinator(coordinatorOptions(env, runtime));
    expect(report).toMatchObject({ status: "completed", completed: ["beta"], failed: ["alpha"] });
    expect(runtime.events.filter((event) => event.type === "spawn").map((event) => event.workspaceId)).toEqual(["alpha", "beta"]);
  });

  test("cancels an interrupted batch after the frozen six-hour timeout without spawning", async () => {
    const env = environment([{ id: "alpha" }]);
    const runtime = successRuntime();
    let injected = false;
    await expect(runNightlyCoordinator(coordinatorOptions(env, runtime, (observed: string) => {
      if (!injected && observed === "reconciling") {
        injected = true;
        throw new Error("crash-before-timeout");
      }
    }))).rejects.toThrow("crash-before-timeout");
    const later = "2026-08-11T07:40:00.000Z";
    const report = await runNightlyCoordinator({ ...coordinatorOptions(env, runtime), now: () => later });
    expect(report).toMatchObject({ resumed: true, status: "cancelled", spawned: 0, completed: [], failed: [] });
    expect(runtime.events.filter((event) => event.type === "spawn")).toEqual([]);
  });

  for (const transition of [
    "reconciling", "compiling", "preflight", "dispatching", "spawn_acknowledged", "awaiting_handoff",
    "handoff_received", "validating", "applying", "completed",
  ] as const) {
    test(`resumes the same batch after interruption at ${transition} without overlap`, async () => {
      const env = environment();
      const runtime = successRuntime();
      let injected = false;
      await expect(runNightlyCoordinator(coordinatorOptions(env, runtime, (observed: string) => {
        if (!injected && observed === transition) {
          injected = true;
          throw new Error(`crash-after-${transition}`);
        }
      }))).rejects.toThrow(`crash-after-${transition}`);
      const report = await runNightlyCoordinator(coordinatorOptions(env, runtime));
      expect(report).toMatchObject({ resumed: true, status: "completed", completed: ["alpha", "beta"], maxConcurrentRethinkRuns: 1 });
      expect(runtime.events.filter((event) => event.type === "spawn").map((event) => event.workspaceId)).toEqual(["alpha", "beta"]);
    });
  }
});
