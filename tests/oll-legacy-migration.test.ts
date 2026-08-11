import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildWorkspaceMigrationPlan,
  DEPRECATED_HEARTBEAT_KEYS,
  migrateFleetLegacyOll,
  migrateWorkspaceLegacyOll,
} from "../src/oll/legacy-migration";
import { isLegacyOllAdmissionEnabled } from "../scripts/config.js";
import { applyHandoff, defaultHandoffHandlers, parseHandoff } from "../scripts/process-handoff-core.js";

const roots: string[] = [];
const NOW = "2026-08-11T21:00:00.000Z";
const CUTOVER_CLI = join(import.meta.dir, "..", "scripts", "oll-legacy-cutover.ts");

function write(path: string, content: string | Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function createWorkspace(id: string, options: { malformedHeartbeat?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), `engram-oll-pr2-${id}-`));
  roots.push(root);
  write(join(root, "engram.json"), {
    agent: `agent-${id}`,
    models: { default: "provider/cheap", heartbeat: { subagents: { "hb-rethink": "provider/full" } } },
  });
  if (options.malformedHeartbeat) {
    write(join(root, "memory", "heartbeat-state.json"), "{broken");
    return root;
  }
  write(join(root, "memory", "heartbeat-state.json"), {
    lastDailyNoteCreated: { main: "2026-08-11" },
    lastHeartbeat: "deprecated",
    schedule: "legacy",
    enabled: true,
    cronJobId: "legacy-job",
    model: "legacy/model",
    notes: "legacy",
    lastWeeklySynthesis: "2026-08-10",
    lastRethink: "2026-08-09T10:00:00.000Z",
    lastRethinkScore: 19,
    rethinkCount: 3,
    rethinkInProgress: true,
    rethinkStartedAt: "2026-08-10T00:00:00.000Z",
    pendingRethink2: "EXP-2026-08-10-001",
    autoresearchInProgress: true,
    subagentRuns: {
      "hb-extract": { status: "ok" },
      "hb-rethink": { status: "spawned", runId: "legacy-active" },
      "hb-rethink2": { status: "queued", runId: "legacy-r2" },
      "hb-autoresearch": { status: "spawned", runId: "legacy-auto" },
    },
  });
  write(join(root, "memory", "weekly-synthesis-tracker.json"), {
    lastRun: "2026-08-10",
    executedAt: "2026-08-10T00:40:00.000Z",
  });
  const spawns = join(root, "workspace", "ops", "heartbeat-spawns");
  write(join(spawns, "queued-rethink.json"), {
    runId: "legacy-queued",
    phase: "hb-rethink",
    label: `${id}-hb-rethink`,
    model: "provider/full",
    task: "legacy",
    status: "queued",
  });
  write(join(spawns, "done", "stale-autoresearch.json"), {
    runId: "legacy-stale",
    phase: "hb-autoresearch",
    label: `${id}-hb-autoresearch`,
    model: "provider/cheap",
    task: "legacy",
    status: "spawned",
    spawnedAt: "2026-08-01T00:00:00.000Z",
  });
  write(join(spawns, "done", "terminal-rethink.json"), {
    runId: "legacy-terminal",
    phase: "hb-rethink",
    status: "done",
  });
  write(join(spawns, "handoff", "legacy-queued.md"), [
    "=== HB-RETHINK HANDOFF ===",
    "Status: ok",
    "Summary: legacy",
    "=== END ===",
  ].join("\n"));
  write(join(spawns, "done", "legacy-terminal.md"), [
    "=== HB-RETHINK HANDOFF ===",
    "Status: ok",
    "Summary: terminal",
    "=== END ===",
  ].join("\n"));
  write(join(root, "workspace", "research", "experiments.json"), {
    experiments: ["EXP-2026-08-10-001"],
    stats: { pending: 1 },
  });
  write(join(root, "workspace", "research", "EXP-2026-08-10-001", "spec.yaml"), [
    "id: EXP-2026-08-10-001",
    "status: pending",
  ].join("\n"));
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("PR 2 legacy OLL workspace migration", () => {
  test("plans explicit source-to-target and quarantine dispositions without writes", () => {
    const workspace = createWorkspace("main");
    const plan = buildWorkspaceMigrationPlan({ workspace, workspaceId: "main", now: NOW });
    expect(plan.sourceToTarget.map((entry) => entry.disposition)).toContain("migrate");
    expect(plan.sourceToTarget.map((entry) => entry.disposition)).toContain("quarantine");
    expect(plan.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: expect.stringContaining("queued-rethink.json"), disposition: "quarantine" }),
      expect.objectContaining({ relativePath: expect.stringContaining("stale-autoresearch.json"), disposition: "quarantine" }),
      expect.objectContaining({ relativePath: expect.stringContaining("terminal-rethink.json"), disposition: "retain_terminal" }),
      expect.objectContaining({ kind: "experiment", disposition: "quarantine_reference" }),
    ]));
    const dryRun = migrateWorkspaceLegacyOll({ workspace, workspaceId: "main", now: NOW });
    expect(dryRun.status).toBe("planned");
    expect(existsSync(join(workspace, "memory-state", "oll", "legacy-admission-disabled.json"))).toBe(false);
  });

  test("atomically disables admission, migrates state, quarantines active records, and writes rollback evidence", async () => {
    const workspace = createWorkspace("main");
    const result = migrateWorkspaceLegacyOll({ workspace, workspaceId: "main", now: NOW, apply: true });
    expect(result).toMatchObject({ status: "migrated", changed: true, nightlyEnabled: false });
    expect(result.proof).toEqual({ legacyAdmission: "disabled", legacyApplication: "disabled", activeLegacyArtifacts: 0 });
    expect(isLegacyOllAdmissionEnabled(workspace)).toBe(false);

    const config = readJson(join(workspace, "engram.json"));
    expect(config.oll).toMatchObject({ scheduleOwner: "nightly", nightly: { enabled: false }, adaptation: { mode: "observe-only" } });
    const heartbeat = readJson(join(workspace, "memory", "heartbeat-state.json"));
    for (const key of DEPRECATED_HEARTBEAT_KEYS) expect(key in heartbeat).toBe(false);
    expect(heartbeat.subagentRuns).toEqual({ "hb-extract": { status: "ok" } });

    const state = readJson(join(workspace, "memory-state", "oll", "state.json"));
    expect(state).toMatchObject({
      schema: "oll-nightly-state.v1",
      workspaceId: "main",
      nightlyEnabled: false,
      memoryReconciliation: { weeklyWindowStart: "2026-08-10" },
      evaluation: { lastCompletedAt: "2026-08-09T10:00:00.000Z", lastScore: 19, completedCount: 3 },
    });
    expect(existsSync(join(workspace, "memory", "weekly-synthesis-tracker.json"))).toBe(false);
    expect(existsSync(join(workspace, "memory-state", "oll", "legacy-quarantine", "legacy-heartbeat-v1", "workspace", "ops", "heartbeat-spawns", "queued-rethink.json"))).toBe(true);
    expect(existsSync(join(workspace, "workspace", "ops", "heartbeat-spawns", "done", "terminal-rethink.json"))).toBe(true);

    const backup = readJson(join(workspace, "memory-state", "oll", "migrations", "legacy-heartbeat-v1", "backup-manifest.json"));
    expect(backup.files.length).toBeGreaterThanOrEqual(5);
    expect(backup.rollback.mode).toBe("operator-reviewed");
    const quarantine = readJson(join(workspace, "memory-state", "oll", "migrations", "legacy-heartbeat-v1", "quarantine-manifest.json"));
    expect(quarantine.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "experiment", disposition: "quarantine_reference" }),
    ]));

    const blocked = await applyHandoff(
      parseHandoff("=== HB-RETHINK HANDOFF ===\nStatus: ok\nSummary: must not apply\n=== END ==="),
      defaultHandoffHandlers({ workspace }),
    );
    expect(blocked).toMatchObject({ status: "error" });
    expect(blocked.error).toContain("disabled by the nightly cutover");

    const processHandoff = join(import.meta.dir, "..", "scripts", "process-handoff.js");
    for (const type of ["HB-RETHINK", "HB-RETHINK2", "HB-AUTORESEARCH"]) {
      const beforeHeartbeat = readFileSync(join(workspace, "memory", "heartbeat-state.json"), "utf8");
      const cli = spawnSync("bun", [processHandoff, "--workspace", workspace, "--session", "main", "--date", "2026-08-11"], {
        encoding: "utf8",
        input: `=== ${type} HANDOFF ===\nStatus: ok\nSummary: must not apply\n=== END ===`,
        env: { ...process.env, ENGRAM_WORKSPACE: workspace },
      });
      expect(cli.status).toBe(1);
      expect(cli.stderr).toContain("disabled by the nightly cutover");
      expect(readFileSync(join(workspace, "memory", "heartbeat-state.json"), "utf8")).toBe(beforeHeartbeat);
    }
  });

  test("a duplicate migration is byte-stable and reports unchanged", () => {
    const workspace = createWorkspace("main");
    migrateWorkspaceLegacyOll({ workspace, workspaceId: "main", now: NOW, apply: true });
    const statePath = join(workspace, "memory-state", "oll", "state.json");
    const before = readFileSync(statePath, "utf8");
    const second = migrateWorkspaceLegacyOll({ workspace, workspaceId: "main", now: "2026-08-12T21:00:00.000Z", apply: true });
    expect(second).toMatchObject({ status: "unchanged", changed: false, nightlyEnabled: false });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  test("malformed heartbeat JSON fails before the cutover marker is created", () => {
    const workspace = createWorkspace("broken", { malformedHeartbeat: true });
    expect(() => migrateWorkspaceLegacyOll({ workspace, workspaceId: "broken", now: NOW, apply: true })).toThrow();
    expect(existsSync(join(workspace, "memory-state", "oll", "legacy-admission-disabled.json"))).toBe(false);
  });

  test("spawn pump and claim fail closed after cutover", () => {
    const workspace = createWorkspace("main");
    migrateWorkspaceLegacyOll({ workspace, workspaceId: "main", now: NOW, apply: true });
    const spawns = join(workspace, "workspace", "ops", "heartbeat-spawns");
    write(join(spawns, "reintroduced.json"), {
      runId: "reintroduced",
      phase: "hb-rethink",
      label: "main-hb-rethink",
      model: "provider/full",
      task: "must be blocked",
      status: "queued",
    });
    const pump = spawnSync("bun", [join(import.meta.dir, "..", "scripts", "spawn-pump.js"), "--workspace", workspace, "--agent-id", "main"], { encoding: "utf8" });
    expect(pump.status).toBe(0);
    expect(pump.stdout).not.toContain('"action":"spawn"');
    expect(pump.stderr).toContain("blocked by nightly cutover");
    const claim = spawnSync("bun", [join(import.meta.dir, "..", "scripts", "spawn-claim.js"), "--workspace", workspace, "--agent-id", "main"], { encoding: "utf8" });
    expect(claim.status).toBe(0);
    expect(claim.stdout).not.toContain('"action":"spawn"');
    expect(existsSync(join(spawns, "reintroduced.json"))).toBe(true);
  });

  test("the destructive CLI path requires an explicit cutover acknowledgement", () => {
    const workspace = createWorkspace("main");
    const denied = spawnSync("bun", [CUTOVER_CLI, "--workspace", workspace, "--workspace-id", "main", "--apply"], { encoding: "utf8" });
    expect(denied.status).toBe(2);
    expect(denied.stderr).toContain("--apply requires --ack-cutover");
    expect(existsSync(join(workspace, "memory-state", "oll", "legacy-admission-disabled.json"))).toBe(false);
  });
});

describe("PR 2 resumable fleet cutover", () => {
  test("resumes a partial fleet journal and never enables nightly rethink", () => {
    const good = createWorkspace("alpha");
    const broken = createWorkspace("beta", { malformedHeartbeat: true });
    const registryRoot = mkdtempSync(join(tmpdir(), "engram-oll-registry-"));
    roots.push(registryRoot);
    const registryPath = join(registryRoot, "registry.json");
    write(registryPath, {
      schema: "oll.workspace-registry-snapshot.v1",
      capturedAt: NOW,
      entries: [
        { workspaceId: "alpha", workspacePath: good },
        { workspaceId: "beta", workspacePath: broken },
      ],
    });
    const stateRoot = join(registryRoot, "state");
    const first = migrateFleetLegacyOll({ registrySnapshotPath: registryPath, stateRoot, now: NOW, apply: true });
    expect(first.status).toBe("partial");
    expect(first.summary).toEqual({ total: 2, failed: 1, completed: 1 });
    expect(readJson(join(good, "engram.json")).oll.nightly.enabled).toBe(false);

    write(join(broken, "memory", "heartbeat-state.json"), { lastDailyNoteCreated: { main: "2026-08-11" } });
    const second = migrateFleetLegacyOll({ registrySnapshotPath: registryPath, stateRoot, now: NOW, apply: true });
    expect(second.status).toBe("completed");
    expect(second.workspaces[0]).toMatchObject({ workspaceId: "alpha", status: "unchanged", resumed: true });
    expect(readJson(join(broken, "engram.json")).oll.nightly.enabled).toBe(false);
    const journal = readJson(join(stateRoot, "oll-nightly", "migrations", "legacy-heartbeat-v1", "fleet-journal.json"));
    expect(journal).toMatchObject({ status: "completed", workspaces: { alpha: { status: "completed" }, beta: { status: "completed" } } });
  });
});
