/**
 * spawn-pump.test.js — Phase 6 tests for spawn-pump.js
 *
 * Invokes the CLI as a subprocess via Bun.spawn (matches cron usage).
 * All fixtures live in os.tmpdir() + "/" + crypto.randomUUID().
 * Never touches the real workspace/ops/heartbeat-spawns/.
 */

import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root = parent of this test file's dir (scripts/).
// Portable across checkouts — no hardcoded user paths.
const CWD = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "scripts/spawn-pump.js";

/** Unique tmp dir per test, forward-slash normalized. */
function makeTmp() {
  const base = tmpdir().replace(/\\/g, "/").replace(/\/$/, "");
  return `${base}/${crypto.randomUUID()}`;
}

function makeSpawnsDir(tmp) {
  const dir = join(tmp, "spawns");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build a valid queued payload. Phase defaults to "hb-<name>" so test fixtures
 *  produce distinct state keys if used with claim. */
function validQueued(name, overrides = {}) {
  return {
    status: "queued",
    runId: `run-${name}`,
    phase: `hb-${name}`,
    label: `label-${name}`,
    model: "minimax-portal/MiniMax-M3",
    task: `task for ${name}`,
    ...overrides,
  };
}

function writeQueuedFile(dir, name, body) {
  writeFileSync(join(dir, name), JSON.stringify(body), "utf8");
}

async function runPump({ workspace, agentId, spawnsDir, extra = [] } = {}) {
  const args = [SCRIPT];
  if (workspace !== undefined) args.push("--workspace", workspace);
  if (agentId !== undefined) args.push("--agent-id", agentId);
  if (spawnsDir) args.push("--spawns-dir", spawnsDir);
  args.push(...extra);
  const proc = Bun.spawn({
    cmd: ["bun", ...args],
    cwd: CWD,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("spawn-pump.js", () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTmp();
    mkdirSync(tmp, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("1. Empty dir override → zero summary, exit 0", async () => {
    const spawnsDir = makeSpawnsDir(tmp);
    const { stdout, stderr, exitCode } = await runPump({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const lines = parseJsonLines(stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      action: "summary",
      scanned: 0,
      queued: 0,
      errors: 0,
    });
  });

  test("2. Missing dir → zero summary, exit 0 (ENOENT handled)", async () => {
    const spawnsDir = join(tmp, "does-not-exist");
    const { stdout, exitCode } = await runPump({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const lines = parseJsonLines(stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      action: "summary",
      scanned: 0,
      queued: 0,
      errors: 0,
    });
  });

  test("3. Missing --workspace → exit 1, stderr contains ERROR", async () => {
    const { stderr, stdout, exitCode } = await runPump({
      workspace: undefined,
      agentId: "test-agent",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ERROR");
    // No summary line when args are bad.
    expect(stdout.trim()).toBe("");
  });

  test("4. Missing --agent-id → exit 1, stderr contains ERROR", async () => {
    const { stderr, stdout, exitCode } = await runPump({
      workspace: tmp,
      agentId: undefined,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ERROR");
    expect(stdout.trim()).toBe("");
  });

  test("5. Single queued file → 1 spawn line + summary {scanned:1, queued:1}", async () => {
    const spawnsDir = makeSpawnsDir(tmp);
    writeQueuedFile(spawnsDir, "a.json", validQueued("a"));
    const { stdout, exitCode } = await runPump({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const lines = parseJsonLines(stdout);
    expect(lines).toHaveLength(2);
    const summary = lines[lines.length - 1];
    expect(summary).toEqual({
      action: "summary",
      scanned: 1,
      queued: 1,
      errors: 0,
    });
    const spawn = lines.find((l) => l.action === "spawn");
    expect(spawn).toBeDefined();
    expect(spawn.action).toBe("spawn");
  });

  test("6. Multiple queued files → 3 spawn lines (lex order) + summary", async () => {
    const spawnsDir = makeSpawnsDir(tmp);
    writeQueuedFile(spawnsDir, "c.json", validQueued("c"));
    writeQueuedFile(spawnsDir, "a.json", validQueued("a"));
    writeQueuedFile(spawnsDir, "b.json", validQueued("b"));
    const { stdout, exitCode } = await runPump({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const lines = parseJsonLines(stdout);
    expect(lines).toHaveLength(4);
    const spawns = lines.filter((l) => l.action === "spawn");
    expect(spawns).toHaveLength(3);
    expect(spawns.map((l) => l.requestFile)).toEqual([
      "a.json",
      "b.json",
      "c.json",
    ]);
    expect(lines[lines.length - 1]).toEqual({
      action: "summary",
      scanned: 3,
      queued: 3,
      errors: 0,
    });
  });

  test("7. spawned-status file → silent skip (queued:0, errors:0)", async () => {
    const spawnsDir = makeSpawnsDir(tmp);
    writeQueuedFile(
      spawnsDir,
      "x.json",
      validQueued("x", { status: "spawned" })
    );
    const { stdout, exitCode } = await runPump({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const lines = parseJsonLines(stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      action: "summary",
      scanned: 1,
      queued: 0,
      errors: 0,
    });
  });

  test("8. done-status file → silent skip", async () => {
    const spawnsDir = makeSpawnsDir(tmp);
    writeQueuedFile(
      spawnsDir,
      "x.json",
      validQueued("x", { status: "done" })
    );
    const { stdout, exitCode } = await runPump({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const lines = parseJsonLines(stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      action: "summary",
      scanned: 1,
      queued: 0,
      errors: 0,
    });
  });

  test("9. failed-status file → silent skip", async () => {
    const spawnsDir = makeSpawnsDir(tmp);
    writeQueuedFile(
      spawnsDir,
      "x.json",
      validQueued("x", { status: "failed" })
    );
    const { stdout, exitCode } = await runPump({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const lines = parseJsonLines(stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      action: "summary",
      scanned: 1,
      queued: 0,
      errors: 0,
    });
  });

  test("10. Malformed JSON → errors:1, WARN + 'malformed' on stderr", async () => {
    const spawnsDir = makeSpawnsDir(tmp);
    writeFileSync(join(spawnsDir, "bad.json"), "not json{", "utf8");
    const { stdout, stderr, exitCode } = await runPump({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const lines = parseJsonLines(stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      action: "summary",
      scanned: 1,
      queued: 0,
      errors: 1,
    });
    expect(stderr).toContain("WARN");
    expect(stderr).toContain("malformed");
  });

  test("11. Missing required field → errors:1, 'missing' on stderr", async () => {
    const spawnsDir = makeSpawnsDir(tmp);
    const bad = validQueued("x");
    delete bad.task;
    writeQueuedFile(spawnsDir, "x.json", bad);
    const { stdout, stderr, exitCode } = await runPump({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const lines = parseJsonLines(stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      action: "summary",
      scanned: 1,
      queued: 0,
      errors: 1,
    });
    expect(stderr).toContain("missing");
  });

  test("12. Mixed queue (queued + spawned + malformed) → 1 spawn, errors:1", async () => {
    const spawnsDir = makeSpawnsDir(tmp);
    writeQueuedFile(spawnsDir, "a.json", validQueued("a"));
    writeQueuedFile(
      spawnsDir,
      "b.json",
      validQueued("b", { status: "spawned" })
    );
    writeFileSync(join(spawnsDir, "c.json"), "not json{", "utf8");
    const { stdout, exitCode } = await runPump({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const lines = parseJsonLines(stdout);
    const spawns = lines.filter((l) => l.action === "spawn");
    expect(spawns).toHaveLength(1);
    expect(spawns[0].requestFile).toBe("a.json");
    const summary = lines.find((l) => l.action === "summary");
    expect(summary).toEqual({
      action: "summary",
      scanned: 3,
      queued: 1,
      errors: 1,
    });
  });

  test("13. Non-json files ignored → scanned counts only .json", async () => {
    const spawnsDir = makeSpawnsDir(tmp);
    writeQueuedFile(spawnsDir, "a.json", validQueued("a"));
    writeFileSync(join(spawnsDir, "readme.txt"), "hi", "utf8");
    writeFileSync(join(spawnsDir, "notes.md"), "# notes", "utf8");
    const { stdout, exitCode } = await runPump({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const lines = parseJsonLines(stdout);
    const spawns = lines.filter((l) => l.action === "spawn");
    expect(spawns).toHaveLength(1);
    expect(spawns[0].requestFile).toBe("a.json");
    const summary = lines.find((l) => l.action === "summary");
    expect(summary).toEqual({
      action: "summary",
      scanned: 1,
      queued: 1,
      errors: 0,
    });
  });

  test("14. Output fields exact match — requestPath abs, requestFile basename", async () => {
    const spawnsDir = makeSpawnsDir(tmp);
    const queued = validQueued("a", {
      runId: "run-abc",
      phase: "hb-foo",
      label: "label-foo",
      model: "minimax-portal/MiniMax-M3",
      task: "do the thing",
    });
    writeQueuedFile(spawnsDir, "a.json", queued);
    const { stdout, exitCode } = await runPump({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const lines = parseJsonLines(stdout);
    const spawn = lines.find((l) => l.action === "spawn");
    expect(spawn).toBeDefined();
    // Exact field set
    expect(Object.keys(spawn).sort()).toEqual(
      [
        "action",
        "label",
        "model",
        "phase",
        "requestFile",
        "requestPath",
        "runId",
        "task",
      ].sort()
    );
    // Field values
    expect(spawn.action).toBe("spawn");
    expect(spawn.runId).toBe("run-abc");
    expect(spawn.phase).toBe("hb-foo");
    expect(spawn.label).toBe("label-foo");
    expect(spawn.model).toBe("minimax-portal/MiniMax-M3");
    expect(spawn.task).toBe("do the thing");
    expect(spawn.requestFile).toBe("a.json");
    // requestPath is the abs path to the queued file
    expect(typeof spawn.requestPath).toBe("string");
    expect(spawn.requestPath.length).toBeGreaterThan(0);
    expect(spawn.requestPath.endsWith("a.json")).toBe(true);
    // The abs path must include the spawns dir we passed in.
    // Normalize both to forward slashes for the containment check
    // (Windows abs paths use backslashes).
    const normalized = spawn.requestPath.replace(/\\/g, "/");
    const expected = spawnsDir.replace(/\\/g, "/");
    expect(normalized).toBe(`${expected}/a.json`);
  });
});
