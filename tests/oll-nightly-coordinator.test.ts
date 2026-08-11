import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { NightlySpawnRequestV1, RegistrySnapshotV1, WorkspaceRegistryAdapter } from "../src/oll/contracts";
import { computeHandoffDigest, sha256Digest } from "../src/oll/handoff-v2";
import { runNightlyCoordinator } from "../src/oll/nightly-coordinator";
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
    "reconciling", "preflight", "dispatching", "spawn_acknowledged", "awaiting_handoff",
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
