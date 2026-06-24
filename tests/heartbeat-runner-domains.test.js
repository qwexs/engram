import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
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

function seedDomainRegistry(domains) {
  const registryDir = join(root, "memory", "domains");
  mkdirSync(registryDir, { recursive: true });
  writeJson(join(registryDir, "registry.json"), { domains });
  for (const [name, cfg] of Object.entries(domains)) {
    const domainDir = join(registryDir, name);
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(join(domainDir, "decisions.md"), `# decisions: ${name}\n`);
    writeFileSync(join(domainDir, "status.md"), `# status: ${name}\n`);
    writeFileSync(join(domainDir, "changelog.md"), `## ${DATE} — bootstrap\n**Topic**: bootstrap\n`);
  }
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
  if (proc.exitCode !== 0) {
    throw new Error("runner exit " + proc.exitCode + ":\nSTDOUT:\n" + stdout + "\nSTDERR:\n" + stderr);
  }
  return JSON.parse(stdout.slice(0, stdout.lastIndexOf("\nHEARTBEAT_OK")).trim());
}

function spawnFiles() {
  const dir = join(root, "workspace", "ops", "heartbeat-spawns");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"));
}

describe("heartbeat-runner hb-domains-write trigger", () => {
  beforeEach(() => {
    root = join(tmpdir(), "engram-hb-dom-" + Date.now() + "-" + Math.random().toString(16).slice(2));
    mkdirSync(root, { recursive: true });
    writeJson(join(root, "memory", "heartbeat-state.json"), {
      heartbeatInProgress: false,
      activeSessions: ["main"],
      subagentRuns: {},
    });
  });

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test("scan-only mode does NOT queue hb-domains-write even when domains are due", () => {
    seedDomainRegistry({
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
    });
    const result = runRunner();
    expect(result.summary.domains).toContain("1 due");
    expect(result.summary.phases.oll.spawns.filter((s) => s.phase === "hb-domains-write")).toHaveLength(0);
    expect(spawnFiles().filter((f) => f.startsWith("hb-domains-write"))).toHaveLength(0);
  });

  test("with --spawn-hb-domains-write, queues one spawn per due topic-thread domain", () => {
    seedDomainRegistry({
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
      aicms: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "2" } },
      disabled: { type: "topic-thread", enabled: false, cadenceDays: 2, topic: { chatId: "-100", topicId: "3" } },
    });
    const result = runRunner(["--spawn-hb-domains-write"]);
    const queued = result.summary.phases.oll.spawns.filter((s) => s.phase === "hb-domains-write");
    expect(queued).toHaveLength(2);
    const queuedNames = queued.map((s) => s.runId).sort();
    expect(queuedNames[0]).toMatch(/^hb-domains-write-/);
    expect(spawnFiles().filter((f) => f.startsWith("hb-domains-write"))).toHaveLength(2);
    expect(result.summary.oll).toContain("domains-write queued 2");
  });

  test("non-topic-thread domains are still queued if they are due (e.g. dev-project)", () => {
    seedDomainRegistry({
      dev1: { type: "dev-project", cadenceDays: 1, subagentLabel: "dev1" },
    });
    const result = runRunner(["--spawn-hb-domains-write"]);
    const queued = result.summary.phases.oll.spawns.filter((s) => s.phase === "hb-domains-write");
    expect(queued).toHaveLength(1);
  });

  test("does not queue when cadenceDays is unset (legacy domain)", () => {
    seedDomainRegistry({
      legacy: { type: "topic-thread" },
    });
    const result = runRunner(["--spawn-hb-domains-write"]);
    const queued = result.summary.phases.oll.spawns.filter((s) => s.phase === "hb-domains-write");
    expect(queued).toHaveLength(0);
    expect(result.summary.domains).toContain("0 due");
  });

  test("does not queue when lastRun is fresh (within cadenceDays)", () => {
    // Runner uses real Date.now() for cadence comparison (not the --date flag),
    // so lastRun must be relative to actual current time.
    const recentLastRun = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    writeJson(join(root, "memory", "heartbeat-state.json"), {
      heartbeatInProgress: false,
      activeSessions: ["main"],
      subagentRuns: {},
      domainRuns: {
        engram: { lastRun: recentLastRun, lastRunId: "prev" },
      },
    });
    seedDomainRegistry({
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
    });
    const result = runRunner(["--spawn-hb-domains-write"]);
    const queued = result.summary.phases.oll.spawns.filter((s) => s.phase === "hb-domains-write");
    expect(queued).toHaveLength(0);
  });
});
