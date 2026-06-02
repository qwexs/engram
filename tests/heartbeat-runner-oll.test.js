import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ENGRAM_DIR = join(import.meta.dir, "..");
const RUNNER = join(ENGRAM_DIR, "scripts", "heartbeat-runner.js");
const DATE = "2026-05-21";

let root;

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function seedFrictionObservations(count = 5) {
  const dir = join(root, "workspace", "ops", "observations");
  mkdirSync(dir, { recursive: true });
  const ids = [];
  for (let i = 1; i <= count; i++) {
    const id = "obs-" + String(i).padStart(4, "0");
    ids.push(id);
    writeJson(join(dir, id + ".json"), { id, status: "pending", category: "friction" });
  }
  writeJson(join(dir, "index.json"), { observations: ids });
}

function runRunner(args = []) {
  const proc = Bun.spawnSync([
    "bun",
    RUNNER,
    "--workspace",
    root,
    "--session",
    "main",
    "--date",
    DATE,
    "--no-write-extraction",
    "--no-embed",
    "--skip-maintenance",
    "--timeout-ms",
    "30000",
    ...args,
  ], {
    cwd: ENGRAM_DIR,
    env: { ...process.env, ENGRAM_WORKSPACE: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  expect(proc.exitCode, stderr || stdout).toBe(0);
  return JSON.parse(stdout.slice(0, stdout.lastIndexOf("\nHEARTBEAT_OK")).trim());
}

function spawnFiles() {
  const dir = join(root, "workspace", "ops", "heartbeat-spawns");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"));
}

describe("heartbeat-runner OLL spawn gates", () => {
  beforeEach(() => {
    root = join(tmpdir(), "engram-hb-oll-" + Date.now() + "-" + Math.random().toString(16).slice(2));
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test("reports due rethink without queuing unless explicit spawn flag is present", () => {
    seedFrictionObservations();
    const result = runRunner();
    expect(result.summary.phases.oll.rethink.wouldRun).toBe(true);
    expect(result.summary.phases.oll.mode).toBe("report-only");
    expect(spawnFiles()).toEqual([]);
  });

  test("queues rethink once and blocks duplicate spawn while in progress", () => {
    seedFrictionObservations();
    const first = runRunner(["--spawn-rethink"]);
    expect(first.summary.oll).toContain("rethink queued");
    expect(spawnFiles()).toHaveLength(1);

    const second = runRunner(["--spawn-rethink"]);
    expect(second.summary.phases.oll.rethink.inProgress).toBe(true);
    expect(second.summary.phases.oll.rethink.wouldRun).toBe(false);
    expect(spawnFiles()).toHaveLength(1);

    const state = JSON.parse(readFileSync(join(root, "memory", "heartbeat-state.json"), "utf8"));
    expect(state.rethinkInProgress).toBe(true);
    expect(state.subagentRuns["hb-rethink"].status).toBe("queued");
  });

  test("recovers stale rethink lock only with explicit recovery flag", () => {
    seedFrictionObservations();
    mkdirSync(join(root, "memory"), { recursive: true });
    writeJson(join(root, "memory", "heartbeat-state.json"), {
      heartbeatInProgress: false,
      rethinkInProgress: true,
      rethinkStartedAt: "2026-05-21T00:00:00.000Z",
      subagentRuns: {
        "hb-rethink": {
          status: "queued",
          startedAt: "2026-05-21T00:00:00.000Z",
        },
      },
    });

    const blocked = runRunner(["--spawn-rethink", "--oll-stale-rethink-hours", "0"]);
    expect(blocked.summary.phases.oll.rethink.staleLock).toBe(true);
    expect(blocked.summary.phases.oll.spawns).toHaveLength(0);

    const recovered = runRunner(["--spawn-rethink", "--recover-stale-oll-locks", "--oll-stale-rethink-hours", "0"]);
    expect(recovered.summary.phases.oll.recovery.recovered).toContain("hb-rethink");
    expect(recovered.summary.phases.oll.spawns).toHaveLength(1);
    expect(spawnFiles()).toHaveLength(1);
  });

  test("workspace mode runs extraction/report for active sessions", () => {
    mkdirSync(join(root, "memory", "agent-main", "main"), { recursive: true });
    mkdirSync(join(root, "memory", "agent-main", "telegram-group--1"), { recursive: true });
    writeJson(join(root, "memory", "heartbeat-state.json"), {
      heartbeatInProgress: false,
      activeSessions: ["main", "telegram-group--1"],
      subagentRuns: {},
    });

    const result = runRunner(["--all-active-sessions"]);
    expect(result.summary.scope).toBe("workspace");
    expect(result.summary.activeSessions).toEqual(["main", "telegram-group--1"]);
    expect(result.summary.phases.extractions.main.handoff.status).toBe("ok");
    expect(result.summary.phases.extractions["telegram-group--1"].handoff.status).toBe("ok");

    const state = JSON.parse(readFileSync(join(root, "memory", "heartbeat-state.json"), "utf8"));
    expect(state.lastExtraction.main).toBeTruthy();
    expect(state.lastExtraction["telegram-group--1"]).toBeTruthy();
    expect(state.subagentRuns["hb-extract-main"].status).toBe("ok");
    expect(state.subagentRuns["hb-extract-telegram-group--1"].status).toBe("ok");

    const mainNote = readFileSync(join(root, "memory", "agent-main", "main", DATE + ".md"), "utf8");
    const groupNote = readFileSync(join(root, "memory", "agent-main", "telegram-group--1", DATE + ".md"), "utf8");
    expect(mainNote).toContain("## Heartbeat Report");
    expect(groupNote).toContain("## Heartbeat Report");
  });
});
