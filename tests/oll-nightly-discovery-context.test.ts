import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RegistrySnapshotV1, WorkspaceRegistryAdapter } from "../src/oll/contracts";
import { discoverNightlyWorkspaces } from "../src/oll/nightly-discovery";
import { buildNightlyContext, determineNightlyWindow, preflightNightlyContext } from "../src/oll/nightly-context";
import { sha256Digest } from "../src/oll/handoff-v2";

const roots: string[] = [];

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
}

function config(id: string, enabled = true) {
  return {
    schemaVersion: 1,
    workspace: { id },
    oll: {
      scheduleOwner: "nightly",
      nightly: {
        enabled, timezone: "Europe/Moscow", weekStart: "monday",
        coordinatorStateRoot: "${ENGRAM_STATE_ROOT}/oll-nightly",
        workspaceStateDir: "memory-state/oll",
        leaseTtlSeconds: 600, leaseRenewSeconds: 60,
        handoffTimeoutSeconds: 900, batchTimeoutSeconds: 21600,
        maxSpawnAttempts: 2, retryBackoffSeconds: [0, 0],
      },
      adaptation: { mode: "observe-only" },
    },
    models: { heartbeat: { subagents: { "hb-rethink": "deployment/full-reasoning" } } },
  };
}

function workspace(parent: string, id: string, enabled = true): string {
  const root = join(parent, id);
  write(join(root, "engram.json"), config(id, enabled));
  if (enabled) {
    write(join(root, "memory-state", "oll", "state.json"), {
      schema: "oll-nightly-state.v1", workspaceId: id, scheduleOwner: "nightly", nightlyEnabled: true,
      legacyHeartbeat: { admission: "disabled", application: "disabled" },
    });
    write(join(root, "memory-state", "oll", "rollout.json"), {
      schema: "oll.workspace-rollout-state.v1", workspaceId: id, targetMode: "observe-only", status: "observe_only_canary",
    });
  }
  return root;
}

class Registry implements WorkspaceRegistryAdapter {
  constructor(public entries: RegistrySnapshotV1["entries"]) {}
  async snapshot(): Promise<RegistrySnapshotV1> {
    return { schema: "oll.workspace-registry-snapshot.v1", capturedAt: "2026-08-10T00:40:00.000Z", entries: this.entries };
  }
}

function entry(id: string, path: string) {
  return {
    workspaceId: id,
    workspacePath: path,
    registryRevision: 7,
    registryDigest: sha256Digest("registry-v7"),
    configDigest: sha256Digest("adapter-untrusted-config-digest"),
  } as const;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("PR 5 immutable registry discovery", () => {
  test("sorts eligible entries and quarantines duplicates, ID drift, and path escape", async () => {
    const allowed = mkdtempSync(join(tmpdir(), "engram-registry-allowed-"));
    const outside = mkdtempSync(join(tmpdir(), "engram-registry-outside-"));
    roots.push(allowed, outside);
    const alpha = workspace(allowed, "alpha");
    const beta = workspace(allowed, "beta");
    const disabled = workspace(allowed, "disabled", false);
    const drift = workspace(allowed, "drift");
    write(join(drift, "engram.json"), config("other"));
    const escaped = workspace(outside, "escaped");
    const alias = join(allowed, "escaped-link");
    symlinkSync(escaped, alias, process.platform === "win32" ? "junction" : "dir");
    const duplicateA = workspace(allowed, "dup-a");
    const duplicateB = workspace(allowed, "dup-b");
    write(join(duplicateA, "engram.json"), config("duplicate"));
    write(join(duplicateB, "engram.json"), config("duplicate"));
    for (const duplicate of [duplicateA, duplicateB]) {
      write(join(duplicate, "memory-state", "oll", "state.json"), {
        schema: "oll-nightly-state.v1", workspaceId: "duplicate", scheduleOwner: "nightly", nightlyEnabled: true,
        legacyHeartbeat: { admission: "disabled", application: "disabled" },
      });
      write(join(duplicate, "memory-state", "oll", "rollout.json"), {
        schema: "oll.workspace-rollout-state.v1", workspaceId: "duplicate", targetMode: "observe-only", status: "observe_only_canary",
      });
    }
    const registry = new Registry([
      entry("beta", beta), entry("alpha", alpha), entry("disabled", disabled), entry("drift", drift),
      entry("escaped", alias), entry("duplicate", duplicateA), entry("duplicate", duplicateB),
    ]);
    const snapshot = await discoverNightlyWorkspaces({ adapter: registry, allowedRoots: [allowed] });
    expect(snapshot.entries.map((item) => item.workspaceId)).toEqual(["alpha", "beta"]);
    expect(snapshot.disabled).toEqual(["disabled"]);
    expect(snapshot.quarantined.map((item) => item.reason)).toEqual(expect.arrayContaining([
      "registry ID does not match engram workspace.id",
      "workspace path escapes the deployment allowlist",
      "duplicate canonical workspace ID",
    ]));
    expect(snapshot.quarantined.filter((item) => item.reason === "duplicate canonical workspace ID")).toHaveLength(2);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(snapshot.entries[0].configDigest).not.toBe(sha256Digest("adapter-untrusted-config-digest"));
  });

  test("a future registry entry appears in the next snapshot without changing scheduler input", async () => {
    const allowed = mkdtempSync(join(tmpdir(), "engram-registry-future-"));
    roots.push(allowed);
    const alpha = workspace(allowed, "alpha");
    const registry = new Registry([entry("alpha", alpha)]);
    const first = await discoverNightlyWorkspaces({ adapter: registry, allowedRoots: [allowed] });
    const future = workspace(allowed, "future");
    registry.entries = [...registry.entries, entry("future", future)];
    const second = await discoverNightlyWorkspaces({ adapter: registry, allowedRoots: [allowed] });
    expect(first.entries.map((item) => item.workspaceId)).toEqual(["alpha"]);
    expect(second.entries.map((item) => item.workspaceId)).toEqual(["alpha", "future"]);
  });

  test("quarantines config activation until matching state and rollout projections are published", async () => {
    const allowed = mkdtempSync(join(tmpdir(), "engram-registry-activation-"));
    roots.push(allowed);
    const alpha = workspace(allowed, "alpha");
    write(join(alpha, "memory-state", "oll", "state.json"), {
      schema: "oll-nightly-state.v1", workspaceId: "alpha", scheduleOwner: "nightly", nightlyEnabled: false,
      legacyHeartbeat: { admission: "disabled", application: "disabled" },
    });
    const snapshot = await discoverNightlyWorkspaces({ adapter: new Registry([entry("alpha", alpha)]), allowedRoots: [allowed] });
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.quarantined).toEqual([expect.objectContaining({ workspaceId: "alpha", reason: "nightly activation projection is inconsistent" })]);
  });
});

describe("PR 5 deterministic nightly context and preflight", () => {
  test("freezes a Moscow Monday seven-day half-open window", () => {
    expect(determineNightlyWindow({
      now: "2026-08-10T00:40:00.000Z", timezone: "Europe/Moscow", weeklyEnabled: true, weekStart: "monday",
    })).toEqual({
      mode: "weekly",
      timezone: "Europe/Moscow",
      windowStart: "2026-08-02T21:00:00.000Z",
      windowEnd: "2026-08-09T21:00:00.000Z",
    });
    expect(determineNightlyWindow({
      now: "2026-08-11T00:40:00.000Z", timezone: "Europe/Moscow", weeklyEnabled: true, weekStart: "monday",
    }).mode).toBe("daily");
  });

  test("defers a late signal to the next watermark window and explicit correction is actionable", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-context-"));
    roots.push(root);
    write(join(root, "memory-state", "oll", "state.json"), {
      schema: "oll-nightly-state.v1", workspaceId: "main",
      evaluation: { lastCompletedAt: null, signalRevisions: {}, completedCount: 0, lastScore: null },
    });
    const baseSignal = {
      schema: "oll.adaptation-signal.v1", workspaceId: "main", type: "correction",
      scope: { level: "person", subject: "telegram:42", domain: null },
      statement: "Use the report format", expectedBehavior: "Use it next time",
      authorizationDecision: { status: "authorized" }, confidence: 1, status: "pending", revision: 1,
    };
    write(join(root, "memory-state", "oll", "signals", "11111111-1111-4111-8111-111111111111.json"), {
      ...baseSignal, id: "11111111-1111-4111-8111-111111111111", createdAt: "2026-08-11T00:30:00.000Z",
    });
    write(join(root, "memory-state", "oll", "signals", "22222222-2222-4222-8222-222222222222.json"), {
      ...baseSignal, id: "22222222-2222-4222-8222-222222222222", createdAt: "2026-08-11T02:00:00.000Z",
    });
    const window = { mode: "daily" as const, timezone: "UTC", windowStart: null, windowEnd: "2026-08-11T01:00:00.000Z" };
    const first = buildNightlyContext({ workspace: root, workspaceId: "main", snapshotAt: window.windowEnd, window });
    expect(first.signals.map((signal) => signal.id)).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(preflightNightlyContext(first)).toMatchObject({ actionable: true, reasons: ["explicit_correction"] });

    write(join(root, "memory-state", "oll", "state.json"), {
      schema: "oll-nightly-state.v1", workspaceId: "main",
      evaluation: {
        lastCompletedAt: "2026-08-11T01:00:00.000Z",
        signalRevisions: first.signalRevisions,
        completedCount: 1,
        lastScore: 10,
      },
    });
    const nextWindow = { ...window, windowEnd: "2026-08-11T03:00:00.000Z" };
    const second = buildNightlyContext({ workspace: root, workspaceId: "main", snapshotAt: nextWindow.windowEnd, window: nextWindow });
    expect(second.signals.map((signal) => signal.id)).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  test("empty context records a deterministic no-spawn preflight", () => {
    const context = {
      schema: "oll.nightly-context.v1" as const, workspaceId: "main", snapshotAt: "2026-08-11T01:00:00.000Z",
      window: { mode: "daily" as const, timezone: "UTC", windowStart: null, windowEnd: "2026-08-11T01:00:00.000Z" },
      priorEvaluationAt: null, signalRevisions: {}, signals: [], observations: [], tensions: [], rules: [], contextDigest: sha256Digest("empty"),
    };
    expect(preflightNightlyContext(context)).toEqual({
      schema: "oll.nightly-preflight.v1", actionable: false, reasons: [],
      counts: { signals: 0, observations: 0, tensions: 0, rules: 0 }, score: 0,
    });
  });

  test("defense in depth keeps even a forged candidate-aware shadow context inert", () => {
    const candidate: any = {
      schema: "oll.memory-candidate.v1", candidateId: sha256Digest("candidate"), workspaceId: "main",
      sourceClass: "daily-decision", sourceRef: "memory/source#1", sourceVersionDigest: sha256Digest("source"),
      contentDigest: sha256Digest("content"), semanticKey: sha256Digest("semantic"),
      scopeCeiling: { level: "workspace", subject: "main" }, kind: "decision", redactionClass: "minimal",
      observedAt: "2026-08-14T12:00:00.000Z", statement: "Use a concise report format.",
      ranking: { score: 85, reasons: ["structured_decision"], duplicateCount: 1, accessCount: 0, decayTier: null },
      compilerVersion: 1, lifecycle: { status: "pending", disposition: null, revision: 1, updatedAt: "2026-08-14T12:00:00.000Z" },
    };
    const base: any = {
      schema: "oll.nightly-context.v2", workspaceId: "main", snapshotAt: "2026-08-14T23:00:00.000Z",
      window: { mode: "daily", timezone: "UTC", windowStart: null, windowEnd: "2026-08-14T23:00:00.000Z" },
      priorEvaluationAt: null, signalRevisions: {}, candidateRevisions: { [candidate.candidateId]: 1 },
      signals: [], memoryCandidates: [candidate], observations: [], tensions: [], rules: [], contextDigest: sha256Digest("context"),
      candidateCompiler: { mode: "shadow", reportDigest: sha256Digest("report"), considered: 1, eligible: 1, selected: 1, selectedBytes: 100, sourceCounts: { "daily-decision": 1 }, rejectionCounts: {} },
    };
    expect(preflightNightlyContext(base)).toMatchObject({ actionable: false, candidateMode: "shadow", counts: { memoryCandidates: 1 } });
    expect(preflightNightlyContext({ ...base, candidateCompiler: { ...base.candidateCompiler, mode: "materialize" } })).toMatchObject({
      actionable: true, candidateMode: "materialize", reasons: ["high_priority_memory_candidate"],
    });
  });
});
