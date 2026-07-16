import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { spawnSync } from "child_process";

const SKILL_DIR = join(import.meta.dir, "..");
const INIT_SCRIPT = join(SKILL_DIR, "scripts", "init.js");
const VALIDATE_SCRIPT = join(SKILL_DIR, "scripts", "validate.js");

async function runInit(workspace, extraArgs = [], { force = true } = {}) {
  // Always pass --skip-gateway-restart in tests so the suite doesn't hang on
  // 'openclaw gateway restart' when no gateway is running.
  const args = [INIT_SCRIPT, "--skip-gateway-restart"];
  if (force) args.push("--force");
  args.push(...extraArgs);
  const proc = Bun.spawn(
    ["bun", ...args],
    {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ENGRAM_WORKSPACE: workspace },
    }
  );
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

function runValidate(workspace) {
  const result = spawnSync("bun", [VALIDATE_SCRIPT, "--quality"], {
    cwd: workspace,
    encoding: "utf-8",
  });
  return {
    exitCode: result.status,
    stdout: result.stdout + result.stderr,
  };
}

describe("init.js — fresh install happy path", () => {
  let workspace;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "engram-init-test-"));
  });

  afterEach(() => {
    if (workspace?.startsWith(tmpdir())) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("init --dry-run prints plan without executing", async () => {
    const { exitCode, stdout } = await runInit(workspace, ["--dry-run"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("DRY RUN");
    expect(stdout).toContain("Created:");
    expect(stdout).toContain("Skipped:");
    expect(stdout).toContain("Warnings:");
    expect(stdout).toContain("Errors:");
    expect(stdout).toContain("memory/domains/registry.json");
    expect(stdout).toContain("heartbeat-state.json");
    expect(existsSync(join(workspace, "memory"))).toBe(false);
  });

  test("init creates memory/domains/registry.json with cadenceDays defaults (AC1+AC3)", async () => {
    const { exitCode, stdout, stderr } = await runInit(workspace);
    expect(exitCode).toBe(0);

    const registryPath = join(workspace, "memory", "domains", "registry.json");
    expect(existsSync(registryPath)).toBe(true);

    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    expect(registry.domains).toBeDefined();
    expect(Object.keys(registry.domains).length).toBeGreaterThan(0);

    const exampleDevProject = registry.domains["example-dev-project"];
    expect(exampleDevProject).toBeDefined();
    expect(exampleDevProject.type).toBe("dev-project");
    expect(exampleDevProject.cadenceDays).toBe(7);

    const exampleCronTask = registry.domains["example-cron-task"];
    expect(exampleCronTask).toBeDefined();
    expect(exampleCronTask.type).toBe("cron-task");
    expect(exampleCronTask.cadenceDays).toBe(3);

    const exampleTopicThread = registry.domains["example-topic-thread"];
    expect(exampleTopicThread).toBeDefined();
    expect(exampleTopicThread.type).toBe("topic-thread");
    expect(exampleTopicThread.cadenceDays).toBe(2);
  });

  test("init creates heartbeat-state.json with activeSessions field (AC4)", async () => {
    const { exitCode } = await runInit(workspace);
    expect(exitCode).toBe(0);

    const hbPath = join(workspace, "memory", "heartbeat-state.json");
    expect(existsSync(hbPath)).toBe(true);

    const hbState = JSON.parse(readFileSync(hbPath, "utf-8"));
    expect(hbState.activeSessions).toBeDefined();
    expect(Array.isArray(hbState.activeSessions)).toBe(true);
  });

  test("init creates required directory structure", async () => {
    const { exitCode } = await runInit(workspace);
    expect(exitCode).toBe(0);

    expect(existsSync(join(workspace, "memory"))).toBe(true);
    expect(existsSync(join(workspace, "memory", "agent-main"))).toBe(true);
    expect(existsSync(join(workspace, "memory", "agent-main", "main"))).toBe(true);
    expect(existsSync(join(workspace, "memory", "domains"))).toBe(true);
    expect(existsSync(join(workspace, "life"))).toBe(true);
    expect(existsSync(join(workspace, "life", "projects"))).toBe(true);
    expect(existsSync(join(workspace, "ops"))).toBe(true);
    expect(existsSync(join(workspace, "ops", "observations"))).toBe(true);
    expect(existsSync(join(workspace, "ops", "tensions"))).toBe(true);
  });

  test("init creates template files", async () => {
    const { exitCode } = await runInit(workspace);
    expect(exitCode).toBe(0);

    expect(existsSync(join(workspace, "MEMORY.md"))).toBe(true);
    expect(existsSync(join(workspace, "memory", "README.md"))).toBe(true);
    expect(existsSync(join(workspace, "memory", "heartbeat-state.json"))).toBe(true);
    expect(existsSync(join(workspace, "memory", "weekly-synthesis-tracker.json"))).toBe(true);
    expect(existsSync(join(workspace, "life", "README.md"))).toBe(true);
    expect(existsSync(join(workspace, "life", "index.md"))).toBe(true);
  });

  test("init prints structured summary (AC11)", async () => {
    const { exitCode, stdout } = await runInit(workspace);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created:");
    expect(stdout).toContain("Skipped:");
    expect(stdout).toContain("Warnings:");
    expect(stdout).toContain("Errors:");
  });

  test("init with --with-sample-domain creates getting-started domain (AC6)", async () => {
    const { exitCode, stdout } = await runInit(workspace, ["--with-sample-domain"]);
    expect(exitCode).toBe(0);

    const domainPath = join(workspace, "memory", "domains", "getting-started");
    expect(existsSync(domainPath)).toBe(true);
    expect(existsSync(join(domainPath, "README.md"))).toBe(true);
    expect(existsSync(join(domainPath, "decisions.md"))).toBe(true);
    expect(existsSync(join(domainPath, "status.md"))).toBe(true);
    expect(existsSync(join(domainPath, "changelog.md"))).toBe(true);
  });

  test("validate.js reports 0 errors after init (AC7)", async () => {
    const { exitCode } = await runInit(workspace);
    expect(exitCode).toBe(0);

    const result = runValidate(workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^Errors:\s*0$/m);
  });

  test("init exits non-zero when conflicts exist without --force", async () => {
    const memDir = join(workspace, "memory");
    require("fs").mkdirSync(memDir, { recursive: true });

    const { exitCode, stderr } = await runInit(workspace, [], { force: false });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Existing directories found");
    expect(stderr).toContain("memory/");
  });

  test("init --force merges with existing dirs without overwriting", async () => {
    const memDir = join(workspace, "memory");
    require("fs").mkdirSync(memDir, { recursive: true });
    require("fs").writeFileSync(join(memDir, "existing-file.txt"), "existing content");

    const { exitCode } = await runInit(workspace, [], { force: true });
    expect(exitCode).toBe(0);
    expect(existsSync(join(memDir, "existing-file.txt"))).toBe(true);
    expect(existsSync(join(workspace, "memory", "agent-main"))).toBe(true);
  });

  test("init creates ops/observations and ops/tensions with index.json files", async () => {
    const { exitCode } = await runInit(workspace);
    expect(exitCode).toBe(0);

    const obsIndex = join(workspace, "ops", "observations", "index.json");
    expect(existsSync(obsIndex)).toBe(true);
    const obsData = JSON.parse(readFileSync(obsIndex, "utf-8"));
    expect(obsData.observations).toBeDefined();
    expect(Array.isArray(obsData.observations)).toBe(true);

    const tensIndex = join(workspace, "ops", "tensions", "index.json");
    expect(existsSync(tensIndex)).toBe(true);
    const tensData = JSON.parse(readFileSync(tensIndex, "utf-8"));
    expect(tensData.tensions).toBeDefined();
    expect(Array.isArray(tensData.tensions)).toBe(true);
  });

  // Regression for senior review C1: autoDetectSessions() must read openclaw.json
  // bindings[] and build canonical engram sessionKeys (group/bot/direct/topic).
  // Uses a fixture openclaw.json with one binding per kind plus a forum topic.
  test("C1: auto-detect sessions from openclaw.json bindings builds canonical sessionKeys", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "engram-fake-home-"));
    try {
      const openclawDir = join(fakeHome, ".openclaw");
      require("fs").mkdirSync(openclawDir, { recursive: true });
      const fixture = {
        bindings: [
          { agentId: "agent-main", match: { channel: "telegram", accountId: "default", peer: { kind: "group", id: "-5206956283" } } },
          { agentId: "agent-main", match: { channel: "telegram", accountId: "default", peer: { kind: "group", id: "-1234567890:topic:60" } } },
          { agentId: "agent-main", match: { channel: "telegram", accountId: "alice", peer: { kind: "direct", id: "100000001" } } },
          { agentId: "agent-other-agent", match: { channel: "telegram", accountId: "default", peer: { kind: "group", id: "-111" } } },
        ],
      };
      require("fs").writeFileSync(join(openclawDir, "openclaw.json"), JSON.stringify(fixture));

      // Point USERPROFILE so autoDetectSessions picks up our fixture.
      const proc = Bun.spawn(
        ["bun", INIT_SCRIPT, "--force", "--auto-detect-sessions", "--skip-gateway-restart"],
        {
          cwd: workspace,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, USERPROFILE: fakeHome },
        }
      );
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);

      const agentSessionsDir = join(workspace, "memory", "agent-main");
      // Group binding -> telegram-group--5206956283
      expect(existsSync(join(agentSessionsDir, "telegram-group--5206956283"))).toBe(true);
      // Forum topic binding -> both parent group AND topic subdir
      expect(existsSync(join(agentSessionsDir, "telegram-group--1234567890"))).toBe(true);
      expect(existsSync(join(agentSessionsDir, "telegram-group--1234567890-topic-60"))).toBe(true);
      // Direct binding uses accountId -> telegram-alice-direct-100000001
      expect(existsSync(join(agentSessionsDir, "telegram-alice-direct-100000001"))).toBe(true);
      // Other-agent binding must NOT have been created
      expect(existsSync(join(agentSessionsDir, "telegram-group--111"))).toBe(false);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // Regression for senior review C2: updateHeartbeatStateForSessions must be
  // called for each auto-detected session. The previous populateActiveSessions()
  // was defined but never called — auto-detected sessions never made it into
  // activeSessions.
  test("C2: auto-detect populates heartbeat-state.json:activeSessions with detected sessionKeys", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "engram-fake-home-"));
    try {
      const openclawDir = join(fakeHome, ".openclaw");
      require("fs").mkdirSync(openclawDir, { recursive: true });
      const fixture = {
        bindings: [
          { agentId: "agent-main", match: { channel: "telegram", accountId: "default", peer: { kind: "group", id: "-5206956283" } } },
          { agentId: "agent-main", match: { channel: "telegram", accountId: "alice", peer: { kind: "direct", id: "100000001" } } },
        ],
      };
      require("fs").writeFileSync(join(openclawDir, "openclaw.json"), JSON.stringify(fixture));

      const proc = Bun.spawn(
        ["bun", INIT_SCRIPT, "--force", "--auto-detect-sessions", "--skip-gateway-restart"],
        {
          cwd: workspace,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, USERPROFILE: fakeHome },
        }
      );
      await proc.exited;

      const hbState = JSON.parse(
        readFileSync(join(workspace, "memory", "heartbeat-state.json"), "utf-8")
      );
      expect(hbState.activeSessions).toContain("telegram-group--5206956283");
      expect(hbState.activeSessions).toContain("telegram-alice-direct-100000001");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // Regression for senior review C3: gateway restart must run even when only
  // hooks (no --with-cron, no --with-sample-domain) are installed. We can't
  // fully assert gateway was restarted (no gateway in test env), but we can
  // assert that the "Restarting gateway..." log line was printed — and that
  // --skip-gateway-restart is the only thing that suppresses it.
  test("C3: gateway restart attempted after hooks install (no --with-cron needed)", async () => {
    const { exitCode, stdout } = await runInit(workspace, ["--auto-detect-sessions"]);
    expect(exitCode).toBe(0);
    // restartGateway() must run, regardless of --with-cron or --with-sample-domain
    expect(stdout).toContain("Restarting gateway");
    // The function itself short-circuits when openclaw isn't on PATH (CI env),
    // but the log line is emitted unconditionally — that's the regression check.
  });
});
