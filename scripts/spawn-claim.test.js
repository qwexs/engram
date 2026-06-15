/**
 * spawn-claim.test.js — Phase 6 tests for spawn-claim.js
 *
 * Invokes the CLI as a subprocess via Bun.spawn (matches cron usage).
 * All fixtures live in os.tmpdir() + "/" + crypto.randomUUID().
 * State file path is fixed by the script: <workspace>/memory/heartbeat-state.json
 *   so we lay out tmp/{spawns,memory}/ per test.
 */

import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
} from "bun:test";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root = parent of this test file's dir (scripts/).
// Portable across checkouts — no hardcoded user paths.
const CWD = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "scripts/spawn-claim.js";

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

function writeState(tmp, state) {
  const memoryDir = join(tmp, "memory");
  mkdirSync(memoryDir, { recursive: true });
  const body =
    state === undefined ? { subagentRuns: {} } : state;
  writeFileSync(
    join(memoryDir, "heartbeat-state.json"),
    JSON.stringify(body, null, 2) + "\n",
    "utf8"
  );
  return join(memoryDir, "heartbeat-state.json");
}

function readState(tmp) {
  return JSON.parse(
    readFileSync(join(tmp, "memory", "heartbeat-state.json"), "utf8")
  );
}

/** Setup: spawns dir + state file. Returns { spawnsDir, statePath }.
 *  queuedFiles: { "<name>": <object|string> } — strings are written raw. */
function setupWorkspace(tmp, opts = {}) {
  const spawnsDir = opts.spawnsDir || makeSpawnsDir(tmp);
  if (opts.createDone) {
    mkdirSync(join(spawnsDir, "done"), { recursive: true });
  }
  if (opts.queuedFiles) {
    for (const [name, body] of Object.entries(opts.queuedFiles)) {
      const content = typeof body === "string" ? body : JSON.stringify(body);
      writeFileSync(join(spawnsDir, name), content, "utf8");
    }
  }
  let statePath;
  if (!opts.skipState) {
    statePath = writeState(tmp, opts.state);
  }
  return { spawnsDir, statePath };
}

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

async function runClaim({ workspace, agentId, spawnsDir, extra = [] } = {}) {
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

describe("spawn-claim.js", () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTmp();
    mkdirSync(tmp, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("1. Empty queue → zero summary, exit 0, state unchanged", async () => {
    const { spawnsDir } = setupWorkspace(tmp);
    const { stdout, stderr, exitCode } = await runClaim({
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
      claimed: 0,
      errors: 0,
    });
    // done/ not created (mkdir only runs in the per-file loop)
    expect(existsSync(join(spawnsDir, "done"))).toBe(false);
    // state untouched
    const state = readState(tmp);
    expect(state.subagentRuns).toEqual({});
  });

  test("2. Missing spawns dir → zero summary, exit 0 (ENOENT handled)", async () => {
    const spawnsDir = join(tmp, "does-not-exist");
    setupWorkspace(tmp, { spawnsDir, skipState: true });
    const { stdout, exitCode } = await runClaim({
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
      claimed: 0,
      errors: 0,
    });
  });

  test("3. Missing --workspace → exit 1, stderr contains ERROR", async () => {
    const { stderr, stdout, exitCode } = await runClaim({
      workspace: undefined,
      agentId: "test-agent",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ERROR");
    expect(stdout.trim()).toBe("");
  });

  test("4. Single queued file → 1 spawn line, summary, file moved to done/", async () => {
    const { spawnsDir } = setupWorkspace(tmp, {
      queuedFiles: { "a.json": validQueued("a") },
    });
    const { stdout, exitCode } = await runClaim({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const lines = parseJsonLines(stdout);
    expect(lines).toHaveLength(2);
    expect(lines[0].action).toBe("spawn");
    expect(lines[0].requestFile).toBe("a.json");
    expect(lines[1]).toEqual({
      action: "summary",
      scanned: 1,
      claimed: 1,
      errors: 0,
    });
    // File moved: source gone, dest present
    expect(existsSync(join(spawnsDir, "a.json"))).toBe(false);
    expect(existsSync(join(spawnsDir, "done", "a.json"))).toBe(true);
  });

  test("5. Claimed file mutated → status:spawned, spawnedAt ISO, other fields preserved", async () => {
    const { spawnsDir } = setupWorkspace(tmp, {
      queuedFiles: { "a.json": validQueued("a") },
    });
    const { exitCode } = await runClaim({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const doneFile = JSON.parse(
      readFileSync(join(spawnsDir, "done", "a.json"), "utf8")
    );
    expect(doneFile.status).toBe("spawned");
    // spawnedAt is an ISO string (not asserting on exact value)
    expect(typeof doneFile.spawnedAt).toBe("string");
    expect(doneFile.spawnedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
    );
    // Required fields preserved
    expect(doneFile.runId).toBe("run-a");
    expect(doneFile.phase).toBe("hb-a");
    expect(doneFile.label).toBe("label-a");
    expect(doneFile.model).toBe("minimax-portal/MiniMax-M3");
    expect(doneFile.task).toBe("task for a");
  });

  test("6. State patched — subagentRuns.<phase>.status=spawned with runId/label/spawnedAt/requestPath", async () => {
    const { spawnsDir } = setupWorkspace(tmp, {
      queuedFiles: { "a.json": validQueued("a") },
    });
    const { exitCode } = await runClaim({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const state = readState(tmp);
    const entry = state.subagentRuns["hb-a"];
    expect(entry).toBeDefined();
    expect(entry.status).toBe("spawned");
    expect(entry.label).toBe("label-a");
    expect(entry.runId).toBe("run-a");
    expect(typeof entry.spawnedAt).toBe("string");
    expect(entry.spawnedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
    );
    expect(typeof entry.requestPath).toBe("string");
    expect(entry.requestPath.endsWith("a.json")).toBe(true);
  });

  test("7. State requestPath uses forward slashes (no backslashes)", async () => {
    const { spawnsDir } = setupWorkspace(tmp, {
      queuedFiles: { "a.json": validQueued("a") },
    });
    const { exitCode } = await runClaim({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const state = readState(tmp);
    const rp = state.subagentRuns["hb-a"].requestPath;
    expect(rp).not.toContain("\\");
    expect(rp).toContain("/");
    expect(rp.endsWith("done/a.json")).toBe(true);
  });

  test("8. spawned-status file untouched (silent skip, not re-claimed)", async () => {
    const { spawnsDir } = setupWorkspace(tmp, {
      queuedFiles: {
        "a.json": validQueued("a", { status: "spawned" }),
      },
    });
    const { stdout, exitCode } = await runClaim({
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
      claimed: 0,
      errors: 0,
    });
    // File still at original path, not moved
    expect(existsSync(join(spawnsDir, "a.json"))).toBe(true);
    expect(existsSync(join(spawnsDir, "done", "a.json"))).toBe(false);
  });

  test("9. Malformed JSON → stays in queue, errors:1, WARN + 'malformed'", async () => {
    const { spawnsDir } = setupWorkspace(tmp, {
      queuedFiles: { "bad.json": "not json{" },
    });
    const { stdout, stderr, exitCode } = await runClaim({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const lines = parseJsonLines(stdout);
    const summary = lines.find((l) => l.action === "summary");
    expect(summary.errors).toBe(1);
    expect(summary.claimed).toBe(0);
    expect(stderr).toContain("WARN");
    expect(stderr).toContain("malformed");
    // File stays in source
    expect(existsSync(join(spawnsDir, "bad.json"))).toBe(true);
    expect(existsSync(join(spawnsDir, "done", "bad.json"))).toBe(false);
  });

  test("10. Missing required field → stays in queue, errors:1, 'missing' on stderr", async () => {
    const bad = validQueued("a");
    delete bad.task;
    const { spawnsDir } = setupWorkspace(tmp, {
      queuedFiles: { "a.json": bad },
    });
    const { stdout, stderr, exitCode } = await runClaim({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const lines = parseJsonLines(stdout);
    const summary = lines.find((l) => l.action === "summary");
    expect(summary.errors).toBe(1);
    expect(summary.claimed).toBe(0);
    expect(stderr).toContain("missing");
    expect(existsSync(join(spawnsDir, "a.json"))).toBe(true);
    expect(existsSync(join(spawnsDir, "done", "a.json"))).toBe(false);
  });

  test("11. Multiple queued → all moved, 3 spawn lines, state patched for all 3", async () => {
    const { spawnsDir } = setupWorkspace(tmp, {
      queuedFiles: {
        "a.json": validQueued("a"),
        "b.json": validQueued("b"),
        "c.json": validQueued("c"),
      },
    });
    const { stdout, exitCode } = await runClaim({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const lines = parseJsonLines(stdout);
    const spawns = lines.filter((l) => l.action === "spawn");
    expect(spawns).toHaveLength(3);
    expect(spawns.map((l) => l.requestFile).sort()).toEqual([
      "a.json",
      "b.json",
      "c.json",
    ]);
    const summary = lines.find((l) => l.action === "summary");
    expect(summary).toEqual({
      action: "summary",
      scanned: 3,
      claimed: 3,
      errors: 0,
    });
    // All moved
    for (const name of ["a.json", "b.json", "c.json"]) {
      expect(existsSync(join(spawnsDir, name))).toBe(false);
      expect(existsSync(join(spawnsDir, "done", name))).toBe(true);
    }
    // State patched for all 3
    const state = readState(tmp);
    expect(Object.keys(state.subagentRuns).sort()).toEqual([
      "hb-a",
      "hb-b",
      "hb-c",
    ]);
    for (const phase of ["hb-a", "hb-b", "hb-c"]) {
      expect(state.subagentRuns[phase].status).toBe("spawned");
    }
  });

  test("12. State merge — existing subagentRuns.hb-foo unchanged when claiming hb-bar", async () => {
    const original = {
      subagentRuns: {
        "hb-foo": {
          status: "ok",
          label: "foo-original",
          requestPath: "/original/path/foo.json",
          spawnedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    const { spawnsDir } = setupWorkspace(tmp, {
      state: original,
      queuedFiles: { "bar.json": validQueued("bar") },
    });
    const { exitCode } = await runClaim({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const state = readState(tmp);
    // hb-foo preserved exactly
    expect(state.subagentRuns["hb-foo"]).toEqual(original.subagentRuns["hb-foo"]);
    // hb-bar patched
    expect(state.subagentRuns["hb-bar"]).toBeDefined();
    expect(state.subagentRuns["hb-bar"].status).toBe("spawned");
    expect(state.subagentRuns["hb-bar"].label).toBe("label-bar");
    expect(state.subagentRuns["hb-bar"].runId).toBe("run-bar");
  });

  test("13. State file missing → claim succeeds, files moved, stderr WARN, exit 0", async () => {
    const { spawnsDir } = setupWorkspace(tmp, {
      skipState: true,
      queuedFiles: { "a.json": validQueued("a") },
    });
    const { stdout, stderr, exitCode } = await runClaim({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    const lines = parseJsonLines(stdout);
    const summary = lines.find((l) => l.action === "summary");
    expect(summary.claimed).toBe(1);
    expect(summary.errors).toBe(0);
    // Files still moved to done/ even though state patch failed
    expect(existsSync(join(spawnsDir, "a.json"))).toBe(false);
    expect(existsSync(join(spawnsDir, "done", "a.json"))).toBe(true);
    // WARN to stderr
    expect(stderr).toContain("WARN");
  });

  test("14. done/ created on demand when it doesn't exist", async () => {
    const spawnsDir = makeSpawnsDir(tmp);
    // Explicitly do NOT create done/
    expect(existsSync(join(spawnsDir, "done"))).toBe(false);
    setupWorkspace(tmp, {
      spawnsDir,
      queuedFiles: { "a.json": validQueued("a") },
    });
    const { exitCode } = await runClaim({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });
    expect(exitCode).toBe(0);
    expect(existsSync(join(spawnsDir, "done"))).toBe(true);
    expect(existsSync(join(spawnsDir, "done", "a.json"))).toBe(true);
  });

  test("15. Atomicity — file stays in source when move fails (done/ is a file)", async () => {
    // Trigger a move failure by making the destination directory a regular
    // file. On Windows + POSIX, mkdirSync(done, {recursive:true}) throws
    // (EEXIST/ENOTDIR) when the path is occupied by a file. The script's
    // catch around the move block must keep the source file and bump errors.
    const spawnsDir = makeSpawnsDir(tmp);
    writeFileSync(
      join(spawnsDir, "done"),
      "i am a file, not a directory",
      "utf8"
    );
    writeQueuedFile(spawnsDir, "locked.json", validQueued("locked"));
    writeState(tmp, { subagentRuns: {} });

    const { stdout, stderr, exitCode } = await runClaim({
      workspace: tmp,
      agentId: "test-agent",
      spawnsDir,
    });

    // Move failure is non-fatal — exit 0 so other queued files (if any) can
    // still be processed, and the cron can decide how to handle the gap.
    expect(exitCode).toBe(0);
    const lines = parseJsonLines(stdout);
    const summary = lines.find((l) => l.action === "summary");
    expect(summary).toEqual({
      action: "summary",
      scanned: 1,
      claimed: 0,
      errors: 1,
    });
    expect(stderr).toContain("ERROR");
    // Source file preserved (unlinkSync was not reached)
    expect(existsSync(join(spawnsDir, "locked.json"))).toBe(true);
    // The done/ path is still occupied by our sentinel file (mkdir failed)
    expect(existsSync(join(spawnsDir, "done"))).toBe(true);
    expect(existsSync(join(spawnsDir, "done", "locked.json"))).toBe(false);
    // State not patched (no claims succeeded)
    const state = readState(tmp);
    expect(state.subagentRuns).toEqual({});
  });
});

// Helper used in test 15
function writeQueuedFile(dir, name, body) {
  writeFileSync(join(dir, name), JSON.stringify(body), "utf8");
}
