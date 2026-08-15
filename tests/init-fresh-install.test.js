import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { chmodSync, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { spawnSync } from "child_process";

const SKILL_DIR = join(import.meta.dir, "..");
const INIT_SCRIPT = join(SKILL_DIR, "scripts", "init.js");
const VALIDATE_SCRIPT = join(SKILL_DIR, "scripts", "validate.js");
const FAKE_QMD = process.platform === "win32"
  ? `bun "${join(import.meta.dir, "fixtures", "fake-qmd.js")}"`
  : "true";

async function runInit(workspace, extraArgs = [], { force = true, extraEnv = {}, skipGatewayRestart = true } = {}) {
  const args = [INIT_SCRIPT];
  // Most tests have no gateway. The hook-readback regression below supplies a
  // fake OpenClaw binary and deliberately exercises restart + live read-back.
  if (skipGatewayRestart) args.push("--skip-gateway-restart");
  if (force) args.push("--force");
  else args.push("--yes");
  args.push(...extraArgs);
  const proc = Bun.spawn(
    ["bun", ...args],
    {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ENGRAM_WORKSPACE: workspace,
        // Never let tests fall back to the operator's production QMD index.
        ENGRAM_QMD: FAKE_QMD,
        ENGRAM_SKIP_HOOK_INSTALL: "1",
        HOME: workspace,
        USERPROFILE: workspace,
        OPENCLAW_HOOKS_DIR: join(workspace, ".openclaw", "hooks"),
        ...extraEnv,
      },
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
    expect(existsSync(join(workspace, "memory-state", "oll", "signals"))).toBe(true);
    expect(existsSync(join(workspace, "memory-state", "oll", "rules"))).toBe(true);
    expect(existsSync(join(workspace, "memory-state", "oll", "reviews"))).toBe(true);
    expect(existsSync(join(workspace, "memory-state", "oll", "operations"))).toBe(true);
    expect(existsSync(join(workspace, "memory-state", "oll", "audit"))).toBe(true);
    expect(existsSync(join(workspace, "memory-state", "oll", "handoffs", "incoming"))).toBe(true);
    expect(existsSync(join(workspace, "memory-state", "oll", "handoffs", "applied"))).toBe(true);
    expect(existsSync(join(workspace, "memory-state", "oll", "handoffs", "rejected"))).toBe(true);
    expect(existsSync(join(workspace, "memory-state", "oll", "apply-journal"))).toBe(true);
  });

  test("init creates template files", async () => {
    const { exitCode } = await runInit(workspace);
    expect(exitCode).toBe(0);

    expect(existsSync(join(workspace, "MEMORY.md"))).toBe(true);
    expect(existsSync(join(workspace, "memory", "README.md"))).toBe(true);
    expect(existsSync(join(workspace, "memory", "heartbeat-state.json"))).toBe(true);
    expect(existsSync(join(workspace, "memory", "weekly-synthesis-tracker.json"))).toBe(false);
    expect(existsSync(join(workspace, "memory-state", "oll", "state.json"))).toBe(true);
    expect(existsSync(join(workspace, "memory-state", "oll", "rollout.json"))).toBe(true);
    expect(existsSync(join(workspace, "memory-state", "oll", "legacy-admission-disabled.json"))).toBe(true);
    expect(existsSync(join(workspace, "life", "README.md"))).toBe(true);
    expect(existsSync(join(workspace, "life", "index.md"))).toBe(true);
    const config = JSON.parse(readFileSync(join(workspace, "engram.json"), "utf8"));
    expect(config.schemaVersion).toBe(1);
    expect(config.workspace).toEqual({ id: "main" });
    expect(config.kg).toBeUndefined();
    expect(config.oll).toMatchObject({
      scheduleOwner: "nightly",
      nightly: { enabled: true },
      adaptation: { mode: "active" },
    });
    expect(config.models.heartbeat.subagents["hb-rethink"]).toBeDefined();
    expect(config.models.heartbeat.subagents["hb-rethink2"]).toBeUndefined();
    expect(config.models.heartbeat.subagents["hb-autoresearch"]).toBeUndefined();
    const ollState = JSON.parse(readFileSync(join(workspace, "memory-state", "oll", "state.json"), "utf8"));
    expect(ollState).toMatchObject({ schema: "oll-nightly-state.v1", workspaceId: "main", nightlyEnabled: true });
    const ollRollout = JSON.parse(readFileSync(join(workspace, "memory-state", "oll", "rollout.json"), "utf8"));
    expect(ollRollout).toMatchObject({
      schema: "oll.workspace-rollout-state.v1",
      workspaceId: "main",
      releaseId: "fresh-init",
      rolloutBatchId: "fresh-init",
      targetMode: "active",
      status: "active",
      activationSource: "fresh-init-default",
      revision: 1,
    });
    const cutover = JSON.parse(readFileSync(join(workspace, "memory-state", "oll", "legacy-admission-disabled.json"), "utf8"));
    expect(cutover).toMatchObject({
      schema: "oll.legacy-admission-disabled.v1",
      workspaceId: "main",
      migrationId: "fresh-init",
    });
    expect(lstatSync(join(workspace, "skills", "engram")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(workspace, "skills", "engram"))).toBe(realpathSync(SKILL_DIR));
    const generatedEntrypoint = Bun.spawn(
      ["bun", "./skills/engram/scripts/heartbeat-runner.js", "--help"],
      { cwd: workspace, stdout: "pipe", stderr: "pipe" },
    );
    expect(await generatedEntrypoint.exited).toBe(0);
    expect(runValidate(workspace).exitCode).toBe(0);
  });

  test("init installs all eleven hooks and verifies the two OLL delivery hooks after restart", async () => {
    const stateRoot = join(workspace, "openclaw-state");
    const hooksDir = join(stateRoot, "hooks");
    const fakeOpenclaw = join(workspace, "fake-openclaw.js");
    writeFileSync(fakeOpenclaw, `#!/usr/bin/env bun
import { existsSync, readdirSync } from "node:fs";
const args = process.argv.slice(2);
const hooksDir = ${JSON.stringify(hooksDir)};
if (args[0] === "--version") { console.log("OpenClaw test"); process.exit(0); }
if (args[0] === "config" && args[1] === "get") { console.log("false"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "restart") { process.exit(0); }
if (args[0] === "hooks" && args[1] === "list" && args[2] === "--json") {
  const names = existsSync(hooksDir)
    ? readdirSync(hooksDir)
        .filter((name) => name.startsWith("engram-"))
        .filter((name) => process.env.FAKE_OMIT_OLL_HOOK !== "1" || name !== "engram-rule-context-load")
        .sort()
    : [];
  console.log(JSON.stringify({
    managedHooksDir: hooksDir,
    hooks: names.map((name) => ({
      name,
      eligible: true,
      loadable: true,
      source: "openclaw-managed",
    })),
  }));
  process.exit(0);
}
process.exit(2);
`);
    chmodSync(fakeOpenclaw, 0o755);

    const result = await runInit(workspace, ["--hooks-dir", hooksDir], {
      skipGatewayRestart: false,
      extraEnv: {
        ENGRAM_SKIP_HOOK_INSTALL: "0",
        ENGRAM_OPENCLAW: fakeOpenclaw,
        OPENCLAW_STATE_DIR: stateRoot,
      },
    });
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const installed = readdirSync(hooksDir).filter((name) => name.startsWith("engram-")).sort();
    expect(installed).toHaveLength(11);
    expect(installed).toContain("engram-rule-context-load");
    expect(installed).toContain("engram-rule-rollback");
    expect(existsSync(join(hooksDir, "engram-rule-context-load", "handler.js"))).toBe(true);
    expect(result.stdout).toContain("verified: 11 runtime hook entries (2 required OLL hooks present)");

    const failedReadback = await runInit(workspace, ["--hooks-dir", hooksDir], {
      skipGatewayRestart: false,
      extraEnv: {
        ENGRAM_SKIP_HOOK_INSTALL: "0",
        ENGRAM_OPENCLAW: fakeOpenclaw,
        OPENCLAW_STATE_DIR: stateRoot,
        FAKE_OMIT_OLL_HOOK: "1",
      },
    });
    expect(failedReadback.exitCode).toBe(1);
    expect(failedReadback.stderr + failedReadback.stdout).toContain("hook read-back missing canonical entries: engram-rule-context-load");
  });

  test("init --workspace initializes the explicit target, not the caller cwd", async () => {
    const caller = mkdtempSync(join(tmpdir(), "engram-init-caller-"));
    const target = mkdtempSync(join(tmpdir(), "engram-init-target-"));
    try {
      const proc = Bun.spawn(["bun", INIT_SCRIPT, "--workspace", target, "--force", "--skip-gateway-restart"], {
        cwd: caller,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ENGRAM_QMD: FAKE_QMD,
          ENGRAM_SKIP_HOOK_INSTALL: "1",
          HOME: caller,
          USERPROFILE: caller,
        },
      });
      expect(await proc.exited).toBe(0);
      expect(existsSync(join(target, "engram.json"))).toBe(true);
      expect(existsSync(join(caller, "engram.json"))).toBe(false);
    } finally {
      rmSync(caller, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("init --with-cron installs deterministic heartbeat without legacy OLL admission", async () => {
    const fake = join(workspace, "fake-openclaw.js");
    const log = join(workspace, "fake-openclaw-log.jsonl");
    writeFileSync(fake, `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const input = args.includes("--script") ? readFileSync(0, "utf8") : "";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }) + "\\n");
if (args[0] === "cron" && args[1] === "list") { console.log(JSON.stringify({ jobs: [] })); process.exit(0); }
if (args[0] === "cron" && args[1] === "add") { console.log(JSON.stringify({ id: "fresh-heartbeat" })); process.exit(0); }
process.exit(2);
`);
    chmodSync(fake, 0o755);
    const result = await runInit(workspace, ["--with-cron", "--cron-schedule", "20 * * * *"], {
      extraEnv: { ENGRAM_OPENCLAW: fake },
    });
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("deterministic heartbeat cron");
    const calls = readFileSync(log, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const added = calls.find((entry) => entry.args[0] === "cron" && entry.args[1] === "add");
    expect(added).toBeDefined();
    expect(added.args).toContain("--script");
    expect(added.input).toContain("Generated by install-deterministic-heartbeat-cron.js");
    expect(added.input).toContain("--spawn-hb-domains-write");
    expect(added.input).not.toContain("--spawn-rethink");
    expect(added.input).not.toContain("--spawn-rethink2");
    expect(added.input).not.toContain("--recover-stale-oll-locks");
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

  test("init --force preserves an explicit disabled or rolled-back OLL state", async () => {
    expect((await runInit(workspace)).exitCode).toBe(0);
    const configPath = join(workspace, "engram.json");
    const statePath = join(workspace, "memory-state", "oll", "state.json");
    const rolloutPath = join(workspace, "memory-state", "oll", "rollout.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.oll.nightly.enabled = false;
    config.oll.adaptation.mode = "observe-only";
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.nightlyEnabled = false;
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
    const rollout = JSON.parse(readFileSync(rolloutPath, "utf8"));
    rollout.status = "rolled_back";
    rollout.targetMode = "observe-only";
    rollout.revision = 2;
    writeFileSync(rolloutPath, JSON.stringify(rollout, null, 2) + "\n");
    const before = {
      config: readFileSync(configPath, "utf8"),
      state: readFileSync(statePath, "utf8"),
      rollout: readFileSync(rolloutPath, "utf8"),
    };

    const rerun = await runInit(workspace, [], { force: true });
    expect(rerun.exitCode, rerun.stderr || rerun.stdout).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(before.config);
    expect(readFileSync(statePath, "utf8")).toBe(before.state);
    expect(readFileSync(rolloutPath, "utf8")).toBe(before.rollout);
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
          env: {
            ...process.env,
            USERPROFILE: fakeHome,
            HOME: fakeHome,
            ENGRAM_QMD: FAKE_QMD,
            ENGRAM_SKIP_HOOK_INSTALL: "1",
            OPENCLAW_HOOKS_DIR: join(fakeHome, ".openclaw", "hooks"),
          },
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
          env: {
            ...process.env,
            USERPROFILE: fakeHome,
            HOME: fakeHome,
            ENGRAM_QMD: FAKE_QMD,
            ENGRAM_SKIP_HOOK_INSTALL: "1",
            OPENCLAW_HOOKS_DIR: join(fakeHome, ".openclaw", "hooks"),
          },
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
