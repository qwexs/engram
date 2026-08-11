import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

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
  return runRunnerRaw([...args, "--no-inline-noop"]);
}

function runRunnerRaw(args) {
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
    expect(spawnFiles()).toHaveLength(0);
  });

  test("with --spawn-hb-domains-write, queues one spawn per due topic-thread domain", () => {
    seedDomainRegistry({
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
      aicms: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "2" } },
      disabled: { type: "topic-thread", enabled: false, cadenceDays: 2, topic: { chatId: "-100", topicId: "3" } },
    });
    const result = runRunner(["--spawn-hb-domains-write", "--hb-domains-write-batch-size", "10"]);
    const queued = result.summary.phases.oll.spawns.filter((s) => s.phase === "hb-domains-write");
    expect(queued).toHaveLength(2);
    const queuedNames = queued.map((s) => s.runId).sort();
    expect(queuedNames[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(spawnFiles()).toHaveLength(2);
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

  // ISS-9 A4: null/undefined cadenceDays → DEFAULT_CADENCE_DAYS=2 fallback.
  // The legacy contract (silent never-due) is gone — see domains-runner.test.ts
  // for full unit coverage of the fallback. This integration test pins the
  // runner-level behavior end-to-end.
  test("queues domain with no cadenceDays using A4 default (2 days)", () => {
    seedDomainRegistry({
      legacy: { type: "topic-thread" },
    });
    const result = runRunner(["--spawn-hb-domains-write"]);
    const queued = result.summary.phases.oll.spawns.filter((s) => s.phase === "hb-domains-write");
    expect(queued).toHaveLength(1);
    expect(result.summary.domains).toContain("1 due");
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

  test("queued hb-domains-write runIds are unique (randomUUID, no Date.now collision)", () => {
    // Review opencode-review-2026-06-24 BLOCKER #7: spawnRunId used
    // Date.now() and could collide if two spawns fire in the same millisecond.
    // Fix: randomUUID slice appended. Generate many spawns and verify uniqueness.
    const domainNames = {};
    for (let i = 0; i < 10; i += 1) {
      domainNames["d" + i] = { type: "topic-thread", cadenceDays: 1, topic: { chatId: "-100", topicId: String(i + 1) } };
    }
    seedDomainRegistry(domainNames);
    const result = runRunner(["--spawn-hb-domains-write", "--hb-domains-write-batch-size", "20"]);
    const queued = result.summary.phases.oll.spawns.filter((s) => s.phase === "hb-domains-write");
    expect(queued).toHaveLength(10);
    const ids = new Set(queued.map((s) => s.runId));
    expect(ids.size).toBe(10); // All runIds unique
    // Sanity: runId format includes UUID-ish 8-char hex suffix
    for (const q of queued) {
      expect(q.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(q.phase).toBe("hb-domains-write");
    }
  });

  test("atomicWrite produces unique tmp filenames (no Date.now collision)", () => {
    // Review BLOCKER #6: atomicWrite tmp filename used Date.now()+pid; could
    // collide on parallel runs. Fix: randomUUID. Verify by hammering
    // patchState back-to-back and checking state file integrity.
    const domainNames = {
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
    };
    seedDomainRegistry(domainNames);
    // Run twice in quick succession with an explicit terminal transition
    // between them — both should produce exactly one hb-domains-write spawn
    // and the rapid atomic state writes must not corrupt JSON.
    const r1 = runRunner(["--spawn-hb-domains-write"]);
    const between = JSON.parse(readFileSync(join(root, "memory", "heartbeat-state.json"), "utf-8"));
    between.subagentRuns["hb-domains-write"].status = "ok";
    writeJson(join(root, "memory", "heartbeat-state.json"), between);
    const r2 = runRunner(["--spawn-hb-domains-write"]);
    const q1 = r1.summary.phases.oll.spawns.filter((s) => s.phase === "hb-domains-write").map((s) => s.runId);
    const q2 = r2.summary.phases.oll.spawns.filter((s) => s.phase === "hb-domains-write").map((s) => s.runId);
    expect(q1).toHaveLength(1);
    expect(q2).toHaveLength(1);
    expect(q1[0]).not.toBe(q2[0]); // Different runIds even though both invocations are sub-second apart
    // State file should still be valid JSON after both runs.
    const stateRaw = readFileSync(join(root, "memory", "heartbeat-state.json"), "utf-8");
    expect(() => JSON.parse(stateRaw)).not.toThrow();
  });
});

describe("heartbeat-runner hb-domains-write batch size", () => {
  beforeEach(() => {
    root = join(tmpdir(), "engram-hb-batch-" + Date.now() + "-" + Math.random().toString(16).slice(2));
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

  test("batch size=1 queues exactly 1 spawn even when 3 due", () => {
    seedDomainRegistry({
      d1: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
      d2: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "2" } },
      d3: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "3" } },
    });
    const result = runRunner(["--spawn-hb-domains-write", "--hb-domains-write-batch-size", "1"]);
    const queued = result.summary.phases.oll.spawns.filter((s) => s.phase === "hb-domains-write");
    expect(queued).toHaveLength(1);
    expect(spawnFiles()).toHaveLength(1);
  });

  test("batch size=3 queues all 3 spawns", () => {
    seedDomainRegistry({
      d1: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
      d2: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "2" } },
      d3: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "3" } },
    });
    const result = runRunner(["--spawn-hb-domains-write", "--hb-domains-write-batch-size", "3"]);
    const queued = result.summary.phases.oll.spawns.filter((s) => s.phase === "hb-domains-write");
    expect(queued).toHaveLength(3);
    expect(spawnFiles()).toHaveLength(3);
  });

  test("default (no flag) means batch size=1", () => {
    seedDomainRegistry({
      d1: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
      d2: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "2" } },
      d3: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "3" } },
    });
    const result = runRunner(["--spawn-hb-domains-write"]);
    const queued = result.summary.phases.oll.spawns.filter((s) => s.phase === "hb-domains-write");
    expect(queued).toHaveLength(1);
  });

  test("summary contains 'deferred 2' when batch size=1 and 3 due", () => {
    seedDomainRegistry({
      d1: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
      d2: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "2" } },
      d3: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "3" } },
    });
    const result = runRunner(["--spawn-hb-domains-write", "--hb-domains-write-batch-size", "1"]);
    expect(result.summary.oll).toContain("deferred 2");
  });
});

describe("heartbeat-runner hb-domains-write lastCheckedAt suppression", () => {
  beforeEach(() => {
    root = join(tmpdir(), "engram-hb-suppress-" + Date.now() + "-" + Math.random().toString(16).slice(2));
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test("lastCheckedAt within cadenceDays suppresses trigger entirely", () => {
    const recentChecked = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    writeJson(join(root, "memory", "heartbeat-state.json"), {
      heartbeatInProgress: false,
      activeSessions: ["main"],
      subagentRuns: {},
      domainRuns: {
        engram: { lastCheckedAt: recentChecked, lastRun: null, lastRunId: "prev" },
      },
    });
    seedDomainRegistry({
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
    });
    const result = runRunner(["--spawn-hb-domains-write"]);
    const queued = result.summary.phases.oll.spawns.filter((s) => s.phase === "hb-domains-write");
    expect(queued).toHaveLength(0);
    expect(result.summary.oll).toContain("suppressed 1");
  });

  test("lastCheckedAt older than cadenceDays does NOT suppress", () => {
    const oldChecked = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    writeJson(join(root, "memory", "heartbeat-state.json"), {
      heartbeatInProgress: false,
      activeSessions: ["main"],
      subagentRuns: {},
      domainRuns: {
        engram: { lastCheckedAt: oldChecked, lastRun: null, lastRunId: "prev" },
      },
    });
    seedDomainRegistry({
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
    });
    const result = runRunner(["--spawn-hb-domains-write"]);
    const queued = result.summary.phases.oll.spawns.filter((s) => s.phase === "hb-domains-write");
    expect(queued).toHaveLength(1);
    expect(result.summary.oll).not.toContain("suppressed");
  });

  test("noop handoff advances lastCheckedAt, not lastRun", async () => {
    const { applyDomainWriteHandoff } = await import(join(ENGRAM_DIR, "scripts", "domains-runner.js"));
    const domainsRoot = join(root, "memory", "domains");
    const domainRoot = join(domainsRoot, "engram");
    mkdirSync(domainRoot, { recursive: true });
    writeFileSync(join(domainRoot, "decisions.md"), "");
    writeFileSync(join(domainRoot, "status.md"), "");
    writeFileSync(join(domainRoot, "changelog.md"), "");
    writeJson(join(domainsRoot, "registry.json"), {
      domains: {
        engram: { type: "topic-thread", cadenceDays: 2, enabled: true },
      },
    });
    const oldLastRun = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    writeJson(join(root, "memory", "heartbeat-state.json"), {
      heartbeatInProgress: false,
      activeSessions: ["main"],
      subagentRuns: {},
      domainRuns: {
        engram: { lastRun: oldLastRun, lastRunId: "prev-run" },
      },
    });
    const statusContent = readFileSync(join(domainRoot, "status.md"), "utf8");
    const changelogContent = readFileSync(join(domainRoot, "changelog.md"), "utf8");
    const statusHash = createHash("sha256").update(statusContent).digest("hex");
    const changelogHash = createHash("sha256").update(changelogContent).digest("hex");
    const baseHashesJson = JSON.stringify({
      "status.md": statusHash,
      "changelog.md": changelogHash,
    });
    const handoffBody = `Domain: engram
Run-Id: test-run-001
Status: ok
Base-Hashes: ${baseHashesJson}
Changelog-Entries: []`;
    const handoff = { ok: true, isOk: true, type: "HB-DOMAINS", body: handoffBody, summary: "noop" };
    await applyDomainWriteHandoff(handoff, {
      workspace: root,
      statePath: join(root, "memory", "heartbeat-state.json"),
      now: new Date().toISOString(),
      dryRun: false,
      selectedDomain: "engram",
    });
    const state = JSON.parse(readFileSync(join(root, "memory", "heartbeat-state.json"), "utf8"));
    const domainRun = state.domainRuns?.engram;
    expect(domainRun?.lastCheckedAt).not.toBeNull();
    expect(domainRun?.lastCheckedAt).not.toBeUndefined();
    expect(domainRun?.lastRun).toBe(oldLastRun);
  });

  test("applyDomainWriteHandoff accepts noop handoff (no Base-Hashes, empty entries)", async () => {
    const { applyDomainWriteHandoff } = await import(join(ENGRAM_DIR, "scripts", "domains-runner.js"));
    const domainsRoot = join(root, "memory", "domains");
    const domainRoot = join(domainsRoot, "engram");
    mkdirSync(domainRoot, { recursive: true });
    writeFileSync(join(domainRoot, "decisions.md"), "");
    writeFileSync(join(domainRoot, "status.md"), "## status v1\n");
    writeFileSync(join(domainRoot, "changelog.md"), "## 2026-06-23 — bootstrap\n");
    writeJson(join(domainsRoot, "registry.json"), {
      domains: { engram: { type: "topic-thread", cadenceDays: 2, enabled: true } },
    });
    const oldLastRun = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    writeJson(join(root, "memory", "heartbeat-state.json"), {
      heartbeatInProgress: false,
      activeSessions: ["main"],
      subagentRuns: {},
      domainRuns: { engram: { lastRun: oldLastRun, lastRunId: "prev-run" } },
    });
    const noopBody = [
      "=== HB-DOMAINS HANDOFF ===",
      "Status: ok",
      "Summary: no domain-relevant events in topic-60 on 2026-06-24",
      "Domain: engram",
      "Run-Id: test-noop-001",
      "Changelog-Entries: []",
      "Promotions: []",
      "=== END ===",
    ].join("\n");
    const result = await applyDomainWriteHandoff(
      { ok: true, isOk: true, type: "HB-DOMAINS", body: noopBody, summary: "noop" },
      {
        workspace: root,
        statePath: join(root, "memory", "heartbeat-state.json"),
        now: new Date().toISOString(),
        dryRun: false,
        selectedDomain: "engram",
      }
    );
    expect(result.status).toBe("noop");
    expect(result.changed).toBe(false);
    expect(result.appendedEntries).toBe(0);
    const state = JSON.parse(readFileSync(join(root, "memory", "heartbeat-state.json"), "utf8"));
    const dr = state.domainRuns?.engram;
    expect(dr.lastCheckedAt).not.toBeNull();
    expect(dr.lastRunId).toBe("test-noop-001");
    expect(dr.lastRun).toBe(oldLastRun);
    // Files untouched
    expect(readFileSync(join(domainRoot, "status.md"), "utf8")).toBe("## status v1\n");
    expect(readFileSync(join(domainRoot, "changelog.md"), "utf8")).toBe("## 2026-06-23 — bootstrap\n");
  });

  test("applyDomainWriteHandoff rejects handoff with Status-Content but no Base-Hashes", async () => {
    const { applyDomainWriteHandoff } = await import(join(ENGRAM_DIR, "scripts", "domains-runner.js"));
    const domainsRoot = join(root, "memory", "domains");
    const domainRoot = join(domainsRoot, "engram");
    mkdirSync(domainRoot, { recursive: true });
    writeFileSync(join(domainRoot, "decisions.md"), "");
    writeFileSync(join(domainRoot, "status.md"), "");
    writeFileSync(join(domainRoot, "changelog.md"), "");
    writeJson(join(domainsRoot, "registry.json"), {
      domains: { engram: { type: "topic-thread", cadenceDays: 2, enabled: true } },
    });
    writeJson(join(root, "memory", "heartbeat-state.json"), {
      heartbeatInProgress: false,
      activeSessions: ["main"],
      subagentRuns: {},
    });
    const badBody = [
      "Domain: engram",
      "Run-Id: test-bad-001",
      "Status-Content: |",
      "  new content",
      "Changelog-Entries: []",
    ].join("\n");
    await expect(
      applyDomainWriteHandoff(
        { ok: true, isOk: true, type: "HB-DOMAINS", body: badBody, summary: "" },
        {
          workspace: root,
          statePath: join(root, "memory", "heartbeat-state.json"),
          now: new Date().toISOString(),
          dryRun: false,
          selectedDomain: "engram",
        }
      )
    ).rejects.toThrow(/Base-Hashes is required/);
  });

  test("applyDomainWriteHandoff idempotency: re-applied runId is noop without re-applying changes", async () => {
    const { applyDomainWriteHandoff } = await import(join(ENGRAM_DIR, "scripts", "domains-runner.js"));
    const domainsRoot = join(root, "memory", "domains");
    const domainRoot = join(domainsRoot, "engram");
    mkdirSync(domainRoot, { recursive: true });
    writeFileSync(join(domainRoot, "decisions.md"), "");
    writeFileSync(join(domainRoot, "status.md"), "");
    writeFileSync(join(domainRoot, "changelog.md"), "");
    writeJson(join(domainsRoot, "registry.json"), {
      domains: { engram: { type: "topic-thread", cadenceDays: 2, enabled: true } },
    });
    writeJson(join(root, "memory", "heartbeat-state.json"), {
      heartbeatInProgress: false,
      activeSessions: ["main"],
      subagentRuns: {},
      domainRuns: { engram: { appliedRunIds: ["already-applied-001"] } },
    });
    const dupBody = [
      "Domain: engram",
      "Run-Id: already-applied-001",
      "Changelog-Entries: []",
    ].join("\n");
    const result = await applyDomainWriteHandoff(
      { ok: true, isOk: true, type: "HB-DOMAINS", body: dupBody, summary: "" },
      {
        workspace: root,
        statePath: join(root, "memory", "heartbeat-state.json"),
        now: new Date().toISOString(),
        dryRun: false,
        selectedDomain: "engram",
      }
    );
    expect(result.status).toBe("noop");
    expect(result.idempotent).toBe(true);
  });

  test("inline-noop: due topic-thread domain with empty bound-session daily note applies noop without spawning", () => {
    seedDomainRegistry({
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
    });
    // No daily note seeded → empty events → inline noop.
    const result = runRunnerRaw(["--spawn-hb-domains-write"]);
    const queued = result.summary.phases.oll.spawns.filter((s) => s.phase === "hb-domains-write");
    expect(queued).toHaveLength(0);
    expect(result.summary.oll).toContain("inlined-noop 1");
    expect(result.summary.oll).toContain("suppressed 1");
    // domainRuns should now have lastCheckedAt for engram.
    const state = JSON.parse(readFileSync(join(root, "memory", "heartbeat-state.json"), "utf8"));
    expect(state.domainRuns?.engram?.lastCheckedAt).not.toBeNull();
    expect(state.domainRuns?.engram?.lastCheckedAt).not.toBeUndefined();
  });

  test("inline-noop: topic-thread domain with non-empty daily note still spawns subagent", () => {
    seedDomainRegistry({
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
    });
    // Seed a daily note with real events under ## Events section.
    const noteDir = join(root, "memory", "agent-main", "telegram-group--100-topic-1");
    mkdirSync(noteDir, { recursive: true });
    writeFileSync(
      join(noteDir, DATE + ".md"),
      "# " + DATE + "\n\n## Events\n\n- 09:30 Алиса обсудил важное решение про cadence.\n\n## Decisions\n"
    );
    const result = runRunnerRaw(["--spawn-hb-domains-write"]);
    const queued = result.summary.phases.oll.spawns.filter((s) => s.phase === "hb-domains-write");
    expect(queued).toHaveLength(1);
    expect(result.summary.oll).not.toContain("inlined-noop");
  });

  // ISS-9 hygiene follow-up: A5 cold-start warning must not repeat on every
  // tick just because lastRun never gets set by the inline-noop path. A
  // neverRun domain that is already suppressed by lastCheckedAt should not
  // count toward the backlog count.
  test("cold-start backlog warning suppressed when neverRun domains are already lastCheckedAt-suppressed (ISS-9 hygiene)", () => {
    seedDomainRegistry({
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
      archive: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "2" } },
      docs: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "3" } },
    });
    // All three domains have NO events in their bound-session daily notes.
    // The runner will inline-noop all of them and advance lastCheckedAt.
    // The second tick should report NO cold-start backlog because every
    // neverRun domain is now lastCheckedAt-suppressed.
    runRunnerRaw(["--spawn-hb-domains-write"]);
    const result = runRunnerRaw(["--spawn-hb-domains-write"]);
    const backlogWarning = (result.summary.warnings || []).find((w) => w.includes("hb-domains-write backlog"));
    expect(backlogWarning).toBeUndefined();
  });

  test("cold-start backlog warning fires only for neverRun domains not yet lastCheckedAt-suppressed (ISS-9 hygiene)", () => {
    seedDomainRegistry({
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
      archive: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "2" } },
      docs: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "3" } },
    });
    // First tick: nothing has been noop'd yet — every domain is genuinely
    // neverRun and unsuppressed, so backlog warning MUST fire.
    const result = runRunnerRaw(["--spawn-hb-domains-write"]);
    const backlogWarning = (result.summary.warnings || []).find((w) => w.includes("hb-domains-write backlog"));
    expect(backlogWarning).toBeDefined();
    expect(backlogWarning).toContain("cold-start");
    expect(backlogWarning).toMatch(/backlog\s*3\b/);
  });
});

describe("heartbeat-runner hb-domains-write apply phase (ISS-9)", () => {
  beforeEach(() => {
    root = join(tmpdir(), "engram-hb-apply-" + Date.now() + "-" + Math.random().toString(16).slice(2));
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

  function writeHandoffFile(runId, body) {
    const dir = join(root, "workspace", "ops", "heartbeat-spawns", "handoff");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, runId + ".md"), body);
    return join(dir, runId + ".md");
  }

  function noopHandoffBody(domain, runId, sessionKey = "telegram-group--100-topic-1", date = DATE) {
    return [
      "=== HB-DOMAINS HANDOFF ===",
      "Status: ok",
      "Summary: no domain-relevant events in " + sessionKey + " on " + date,
      "Domain: " + domain,
      "Run-Id: " + runId,
      "Changelog-Entries: []",
      "Promotions: []",
      "=== END ===",
    ].join("\n");
  }

  test("applies noop handoff file in handoff/ → file moved to done/, lastCheckedAt advanced", () => {
    seedDomainRegistry({
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
    });
    writeHandoffFile("hb-domains-write-" + DATE + "-test0001", noopHandoffBody("engram", "hb-domains-write-" + DATE + "-test0001"));
    const result = runRunner(["--spawn-hb-domains-write"]);
    const applyStats = result.summary.phases["hb-domains-write-apply"];
    expect(applyStats).toBeDefined();
    expect(applyStats.applied).toBe(1);
    expect(applyStats.failed).toBe(0);
    // handoff/ is empty after apply
    const handoffDir = join(root, "workspace", "ops", "heartbeat-spawns", "handoff");
    expect(readdirSync(handoffDir)).toEqual([]);
    // done/ contains the file
    const doneDir = join(root, "workspace", "ops", "heartbeat-spawns", "done");
    const doneFiles = readdirSync(doneDir);
    expect(doneFiles).toContain("hb-domains-write-" + DATE + "-test0001.md");
    // domainRuns.engram.lastCheckedAt set
    const state = JSON.parse(readFileSync(join(root, "memory", "heartbeat-state.json"), "utf8"));
    expect(state.domainRuns?.engram?.lastCheckedAt).not.toBeNull();
    expect(state.domainRuns?.engram?.appliedRunIds).toContain("hb-domains-write-" + DATE + "-test0001");
    // summary text mentions applied count
    expect(result.summary.oll).toContain("applied 1");
  });

  test("successful apply closes the matching spawned worker so the next run is not TTL-blocked", () => {
    const runId = "hb-domains-write-" + DATE + "-worker01";
    seedDomainRegistry({
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
    });
    writeJson(join(root, "memory", "heartbeat-state.json"), {
      heartbeatInProgress: false,
      activeSessions: ["main"],
      subagentRuns: {
        "hb-domains-write": { status: "spawned", runId, startedAt: "2026-05-21T00:00:00.000Z" },
      },
    });
    const doneDir = join(root, "workspace", "ops", "heartbeat-spawns", "done");
    mkdirSync(doneDir, { recursive: true });
    writeJson(join(doneDir, runId + ".json"), {
      runId,
      phase: "hb-domains-write",
      status: "spawned",
      spawnedAt: "2026-05-21T00:00:00.000Z",
    });
    writeHandoffFile(runId, noopHandoffBody("engram", runId));

    runRunner(["--spawn-hb-domains-write"]);

    const state = JSON.parse(readFileSync(join(root, "memory", "heartbeat-state.json"), "utf8"));
    expect(state.subagentRuns["hb-domains-write"]).toMatchObject({ status: "ok", runId });
    const lifecycle = JSON.parse(readFileSync(join(doneDir, runId + ".json"), "utf8"));
    expect(lifecycle.status).toBe("done");
  });

  test("late handoff from an older run does not close a newer spawned worker", () => {
    const oldRunId = "hb-domains-write-" + DATE + "-oldrun01";
    const newRunId = "hb-domains-write-" + DATE + "-newrun01";
    seedDomainRegistry({
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
    });
    writeJson(join(root, "memory", "heartbeat-state.json"), {
      heartbeatInProgress: false,
      activeSessions: ["main"],
      subagentRuns: {
        "hb-domains-write": { status: "spawned", runId: newRunId, startedAt: new Date().toISOString() },
      },
    });
    const doneDir = join(root, "workspace", "ops", "heartbeat-spawns", "done");
    mkdirSync(doneDir, { recursive: true });
    writeJson(join(doneDir, oldRunId + ".json"), {
      runId: oldRunId,
      phase: "hb-domains-write",
      status: "spawned",
      spawnedAt: "2026-05-21T00:00:00.000Z",
    });
    writeHandoffFile(oldRunId, noopHandoffBody("engram", oldRunId));

    runRunner(["--spawn-hb-domains-write"]);

    const state = JSON.parse(readFileSync(join(root, "memory", "heartbeat-state.json"), "utf8"));
    expect(state.subagentRuns["hb-domains-write"]).toMatchObject({ status: "spawned", runId: newRunId });
  });

  test("invalid handoff (no HB-DOMAINS block) leaves file in place, warning added", () => {
    seedDomainRegistry({
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
    });
    writeHandoffFile("garbage-001", "this is not a valid handoff block\n");
    const result = runRunner(["--spawn-hb-domains-write"]);
    const applyStats = result.summary.phases["hb-domains-write-apply"];
    expect(applyStats.failed).toBe(1);
    expect(applyStats.applied).toBe(0);
    // File still in handoff/
    const handoffDir = join(root, "workspace", "ops", "heartbeat-spawns", "handoff");
    expect(readdirSync(handoffDir)).toContain("garbage-001.md");
    // Warning in summary
    expect(result.summary.warnings.some((w) => /garbage-001/.test(w))).toBe(true);
  });

  test("--no-hb-domains-write-apply disables the apply phase", () => {
    seedDomainRegistry({
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
    });
    writeHandoffFile("hb-domains-write-" + DATE + "-test0002", noopHandoffBody("engram", "hb-domains-write-" + DATE + "-test0002"));
    const result = runRunner(["--spawn-hb-domains-write", "--no-hb-domains-write-apply"]);
    // No apply phase ran
    expect(result.summary.phases["hb-domains-write-apply"]).toBeUndefined();
    // File still in handoff/
    const handoffDir = join(root, "workspace", "ops", "heartbeat-spawns", "handoff");
    expect(readdirSync(handoffDir)).toContain("hb-domains-write-" + DATE + "-test0002.md");
  });

  test("applies multiple handoff files in lexicographic order, each advancing its own domain", () => {
    seedDomainRegistry({
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
      aicms: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "2" } },
    });
    writeHandoffFile("a-001.md", noopHandoffBody("aicms", "hb-domains-write-" + DATE + "-aaa-001"));
    writeHandoffFile("b-002.md", noopHandoffBody("engram", "hb-domains-write-" + DATE + "-bbb-002"));
    const result = runRunner(["--spawn-hb-domains-write"]);
    const applyStats = result.summary.phases["hb-domains-write-apply"];
    expect(applyStats.applied).toBe(2);
    expect(applyStats.failed).toBe(0);
    const state = JSON.parse(readFileSync(join(root, "memory", "heartbeat-state.json"), "utf8"));
    expect(state.domainRuns?.engram?.lastCheckedAt).not.toBeNull();
    expect(state.domainRuns?.aicms?.lastCheckedAt).not.toBeNull();
  });

  test("apply phase runs by default when --spawn-hb-domains-write is set even without explicit --hb-domains-write-apply", () => {
    seedDomainRegistry({
      engram: { type: "topic-thread", cadenceDays: 2, topic: { chatId: "-100", topicId: "1" } },
    });
    writeHandoffFile("hb-domains-write-" + DATE + "-test0003", noopHandoffBody("engram", "hb-domains-write-" + DATE + "-test0003"));
    const result = runRunner(["--spawn-hb-domains-write"]);
    expect(result.summary.phases["hb-domains-write-apply"]).toBeDefined();
    expect(result.summary.phases["hb-domains-write-apply"].applied).toBe(1);
  });
});
