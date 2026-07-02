import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ENGRAM_DIR = join(import.meta.dir, "..");
const ADD_DOMAIN = join(ENGRAM_DIR, "scripts", "add-domain.js");

let workspace;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "engram-add-domain-test-"));
  // Minimal engram.json — add-domain.js reads agent/agentId from it
  mkdirSync(join(workspace, "memory", "domains"), { recursive: true });
  // Initialize registry.json so add-domain sees a valid file
  // (add-domain will write to it, no need to pre-create)
});

afterEach(() => {
  if (workspace?.startsWith(tmpdir())) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function runAddDomain(args = []) {
  const proc = Bun.spawnSync(
    ["bun", ADD_DOMAIN, ...args],
    {
      cwd: workspace,
      env: { ...process.env, ENGRAM_WORKSPACE: workspace },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  return { exitCode: proc.exitCode, stdout, stderr };
}

function readRegistry() {
  const registryPath = join(workspace, "memory", "domains", "registry.json");
  return JSON.parse(readFileSync(registryPath, "utf-8"));
}

describe("add-domain.js — ISS-9 A7 cadenceAdaptive default", () => {
  test("topic-thread domain gets cadenceAdaptive:true + windowDays:7 by default", () => {
    const { exitCode, stderr } = runAddDomain([
      "--domain", "test-topic",
      "--type", "topic-thread",
      "--topic", "-1009999999:1",
      "--description", "Test topic-thread domain",
    ]);
    expect(exitCode).toBe(0);
    if (stderr) console.error("stderr:", stderr);

    const registry = readRegistry();
    expect(registry.domains["test-topic"]).toBeDefined();
    expect(registry.domains["test-topic"].type).toBe("topic-thread");
    expect(registry.domains["test-topic"].cadenceDays).toBe(2);
    expect(registry.domains["test-topic"].cadenceAdaptive).toBe(true);
    expect(registry.domains["test-topic"].cadenceAdaptiveWindowDays).toBe(7);
  });

  // ISS-9 audit 2026-07-02 — cadenceAdaptive is now topic-thread-only.
  // dev-project / cron-task have no chat session by design, so the flag would
  // be a permanent no-op there. Operators can flip it manually in registry.json
  // if a non-topic domain ever gains a topic binding.
  test("dev-project domain does NOT get cadenceAdaptive by default", () => {
    const { exitCode, stdout } = runAddDomain([
      "--domain", "test-dev",
      "--type", "dev-project",
      "--description", "Test dev-project domain",
    ]);
    expect(exitCode).toBe(0);

    const registry = readRegistry();
    expect(registry.domains["test-dev"].type).toBe("dev-project");
    expect(registry.domains["test-dev"].cadenceDays).toBe(3);
    expect(registry.domains["test-dev"].cadenceAdaptive).toBeUndefined();
    expect(registry.domains["test-dev"].cadenceAdaptiveWindowDays).toBeUndefined();
    // Output line should NOT mention cadenceAdaptive for non-topic types
    expect(stdout).not.toContain("cadenceAdaptive");
  });

  test("cron-task domain does NOT get cadenceAdaptive by default", () => {
    const { exitCode, stdout } = runAddDomain([
      "--domain", "test-cron",
      "--type", "cron-task",
      "--description", "Test cron-task domain",
    ]);
    expect(exitCode).toBe(0);

    const registry = readRegistry();
    expect(registry.domains["test-cron"].type).toBe("cron-task");
    expect(registry.domains["test-cron"].cadenceDays).toBe(1);
    expect(registry.domains["test-cron"].cadenceAdaptive).toBeUndefined();
    expect(registry.domains["test-cron"].cadenceAdaptiveWindowDays).toBeUndefined();
    expect(stdout).not.toContain("cadenceAdaptive");
  });

  test("output advertises cadenceAdaptive in registry summary line (topic-thread only)", () => {
    const { exitCode, stdout } = runAddDomain([
      "--domain", "test-advert",
      "--type", "topic-thread",
      "--topic", "-1009999999:2",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("cadenceAdaptive=7d");
  });

  test("operator can override cadenceAdaptive via later registry edit (smoke)", () => {
    const { exitCode } = runAddDomain([
      "--domain", "test-override",
      "--type", "topic-thread",
      "--topic", "-1009999999:3",
    ]);
    expect(exitCode).toBe(0);

    // Edit registry.json to disable adaptive for this domain
    const registryPath = join(workspace, "memory", "domains", "registry.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    registry.domains["test-override"].cadenceAdaptive = false;
    require("node:fs").writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");

    const reread = JSON.parse(readFileSync(registryPath, "utf-8"));
    expect(reread.domains["test-override"].cadenceAdaptive).toBe(false);
    // cadenceAdaptiveWindowDays preserved for re-enable later
    expect(reread.domains["test-override"].cadenceAdaptiveWindowDays).toBe(7);
  });

  test("scanDomains picks up default cadenceAdaptive=true on a fresh topic-thread domain", () => {
    const { exitCode } = runAddDomain([
      "--domain", "scan-test",
      "--type", "topic-thread",
      "--topic", "-1009999999:42",
    ]);
    expect(exitCode).toBe(0);

    // Write minimal daily-note (lastCheckedAt suppression needs cadenceDays=2 so today < 2 days)
    const agentDir = join(workspace, "memory", "agent-agent-main");
    const sessionDir = join(agentDir, "telegram-group--1009999999-topic-42");
    mkdirSync(sessionDir, { recursive: true });
    const today = new Date().toISOString().split("T")[0];
    require("node:fs").writeFileSync(
      join(sessionDir, `${today}.md`),
      `# ${today}\n\n## Events\n\n- test event\n\n## Decisions\n\n## Next\n\n`
    );

    // Also seed a domain dir so scanDomains doesn't flag it as missing
    const domainDir = join(workspace, "memory", "domains", "scan-test");
    mkdirSync(domainDir, { recursive: true });
    require("node:fs").writeFileSync(join(domainDir, "decisions.md"), "# decisions\n");
    require("node:fs").writeFileSync(join(domainDir, "status.md"), "# status\n");
    require("node:fs").writeFileSync(join(domainDir, "changelog.md"), `# changelog\n`);

    const proc = Bun.spawnSync(
      ["bun", join(ENGRAM_DIR, "scripts", "domains-runner.js"), "--workspace", workspace, "--dry-run"],
      { cwd: workspace, env: { ...process.env, ENGRAM_WORKSPACE: workspace }, stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).toBe(0);
    const scan = JSON.parse(proc.stdout.toString());
    const dom = scan.domains.find((d) => d.name === "scan-test");
    expect(dom).toBeDefined();
    // cadenceAdaptive should be populated (object), not null
    expect(dom.cadenceAdaptive).not.toBeNull();
    expect(dom.cadenceAdaptive.windowDays).toBe(7);
  });
});