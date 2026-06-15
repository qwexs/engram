/**
 * install-cron.test.js — Tests for install-cron.js
 *
 * Invokes the CLI as a subprocess via Bun.spawn (matches cron usage).
 * All fixtures live in os.tmpdir() + "/" + crypto.randomUUID().
 *
 * Mocking strategy:
 *   - The fake is a single .mjs at <tmp>/bin/fake-openclaw.mjs that handles
 *     all cron subcommands and records every call to <bin>/call_log.jsonl.
 *   - Tests point install-cron.js at the fake via two env vars:
 *       ENGRAM_OPENCLAW_NODE_SCRIPT=<fake-mjs-path>
 *         → on Windows, install-cron.js uses `process.execPath <fake-mjs>`
 *           (Bun, Node-compatible), bypassing the .cmd wrapper so multi-line
 *           --message args are NOT truncated by cmd.exe.
 *       ENGRAM_OPENCLAW=<nonexistent>
 *         → ensures the .cmd-wrapper fallback is NOT used.
 *   - For tests that do NOT need openclaw (e.g. dry-run), neither env var
 *     is required.
 *
 * Why this approach (not the spec's .cmd wrapper):
 *   On Windows, `Bun.spawn` on a .cmd file goes through `cmd.exe`, which
 *   treats literal newlines in args as command separators. The result:
 *   `--message "line1\nline2"` is silently truncated to "line1". This is a
 *   real Windows/cmd.exe limitation — it also affects the real openclaw
 *   binary, not just our test mock. The install-cron.js script
 *   automatically works around it in production by using
 *   `process.execPath <openclaw.mjs>` when a node-direct script is
 *   available; tests use the same env var to trigger the same code path.
 *
 * Workspace isolation:
 *   The script reads `process.env.ENGRAM_WORKSPACE` (with fallback to
 *   --workspace, then cwd). Tests pass ENGRAM_WORKSPACE=<tmp> so config
 *   reads from a fresh empty dir per test.
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
const SCRIPT = "scripts/install-cron.js";

/** Unique tmp dir per test, forward-slash normalized. */
function makeTmp() {
  const base = tmpdir().replace(/\\/g, "/").replace(/\/$/, "");
  return `${base}/${crypto.randomUUID()}`;
}

/**
 * Set up a single-file fake openclaw that:
 *   - records every invocation to <bin>/call_log.jsonl
 *   - reads canned responses from <bin>/cron_list.json (or returns empty)
 *   - exits 1 on unknown commands
 *
 * Returns { binDir, mjsPath, logFile, listFile, setCronList, setCronGet }.
 */
function setupFakeOpenclaw(tmp) {
  const binDir = join(tmp, "bin");
  mkdirSync(binDir, { recursive: true });

  const fakeJs = `#!/usr/bin/env bun
import { writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const binDir = ${JSON.stringify(binDir)};
const logFile = join(binDir, "call_log.jsonl");
const listFile = join(binDir, "cron_list.json");
const getFile = join(binDir, "cron_get.json");

const args = process.argv.slice(2);

appendFileSync(
  logFile,
  JSON.stringify({ args, cwd: process.cwd() }) + "\\n"
);

if (args[0] === "--version") {
  console.log("OpenClaw 99.0.0 (fake)");
  process.exit(0);
}

if (args[0] === "cron") {
  const sub = args[1];
  if (sub === "list") {
    if (existsSync(listFile)) {
      process.stdout.write(readFileSync(listFile, "utf8"));
    } else {
      console.log('{"jobs":[],"total":0,"offset":0,"limit":0,"hasMore":false,"nextOffset":null}');
    }
    process.exit(0);
  }
  if (sub === "add") {
    console.log(JSON.stringify({ id: "fake-new-job-id" }));
    process.exit(0);
  }
  if (sub === "edit") {
    console.log("{}");
    process.exit(0);
  }
  if (sub === "rm") {
    console.log('{"ok":true}');
    process.exit(0);
  }
  if (sub === "get") {
    if (existsSync(getFile)) {
      process.stdout.write(readFileSync(getFile, "utf8"));
    } else {
      console.log("{}");
    }
    process.exit(0);
  }
}

console.error("fake-openclaw: unknown command: " + JSON.stringify(args));
process.exit(1);
`;

  const mjsPath = join(binDir, "fake-openclaw.mjs");
  writeFileSync(mjsPath, fakeJs);

  return {
    binDir,
    mjsPath,
    logFile: join(binDir, "call_log.jsonl"),
    listFile: join(binDir, "cron_list.json"),
    getFile: join(binDir, "cron_get.json"),
    setCronList(json) {
      writeFileSync(this.listFile, JSON.stringify(json));
    },
    setCronGet(json) {
      writeFileSync(this.getFile, JSON.stringify(json));
    },
  };
}

/** Read every line of call_log.jsonl. */
function readCallLog(logFile) {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/** Run install-cron.js as a subprocess. */
async function runInstallCron({
  workspace,
  args = [],
  extraEnv = {},
} = {}) {
  const cmd = ["bun", SCRIPT, ...args];
  const env = { ...process.env, ...extraEnv };
  if (workspace !== undefined) {
    env.ENGRAM_WORKSPACE = workspace;
  }
  const proc = Bun.spawn({
    cmd,
    cwd: CWD,
    env,
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

/**
 * Build the env that makes install-cron.js use the fake via the
 * `ENGRAM_OPENCLAW_NODE_SCRIPT` path. install-cron.js auto-detects
 * the script and calls it via `process.execPath <script>`, which on
 * Windows is Bun calling a .mjs directly (no cmd.exe in the middle).
 */
function envForFake(fake) {
  return {
    ENGRAM_OPENCLAW_NODE_SCRIPT: fake.mjsPath,
    // Disable the .cmd fallback in case the dev machine happens to have
    // real openclaw on PATH; we want the test to use ONLY the fake.
    ENGRAM_OPENCLAW: "__use_node_script_only__",
  };
}

// --- Fixture helpers ---

/** Build a cron-list job in the format openclaw cron list --json returns. */
function cronListJob({ id, name, message }) {
  return {
    id,
    name,
    enabled: true,
    createdAtMs: 1781163973897,
    updatedAtMs: 1781517009927,
    agentId: "main",
    schedule: { kind: "every", everyMs: 1800000, anchorMs: 1781163973897 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message,
      model: "sonnet-4-6",
      thinking: "medium",
      timeoutSeconds: 900,
      lightContext: true,
    },
    delivery: { mode: "none" },
    state: {},
  };
}

const NEW_PAYLOAD = `You are the cron job for the Clawd engram heartbeat.

Step 1 — Run the heartbeat runner:
Call tools.shell_command with command="bun ./skills/engram/scripts/heartbeat-runner.js ..."
workdir="/tmp/ws" timeout_ms=900000.

Step 2 — Drain the subagent-spawn queue (Phase 5.5):
Call tools.shell_command with command="bun ./skills/engram/scripts/spawn-claim.js ..."
workdir="/tmp/ws" timeout_ms=60000.

Step 3 — For each line in claim.stdout that parses as JSON with action="spawn":
Call tools.sessions_spawn(...).

Step 4 — Final reply: HEARTBEAT_OK.`;

const OLD_PAYLOAD = `Run the heartbeat. One command:
bun ./skills/engram/scripts/heartbeat-runner.js --workspace /tmp/ws
Reply HEARTBEAT_OK.`;

// --- Tests ---

describe("install-cron.js", () => {
  let tmp;
  let fake;
  beforeEach(() => {
    tmp = makeTmp();
    mkdirSync(tmp, { recursive: true });
    fake = setupFakeOpenclaw(tmp);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("1. --help prints usage and exits 0", async () => {
    const r = await runInstallCron({
      workspace: tmp,
      args: ["--help"],
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("install-cron");
    expect(r.stdout).toContain("--dry-run");
    expect(r.stdout).toContain("--cron-name");
    expect(r.stdout).toContain("install");
    expect(r.stdout).toContain("uninstall");
    expect(r.stdout).toContain("status");
  });

  test("2. --dry-run install prints spec JSON, exits 0, no openclaw invocation", async () => {
    const r = await runInstallCron({
      workspace: tmp,
      args: [
        "install",
        "--dry-run",
        "--agent-id",
        "main",
        "--label-prefix",
        "hb",
      ],
    });
    expect(r.exitCode).toBe(0);
    const spec = JSON.parse(r.stdout);
    expect(spec.name).toBe("Heartbeat (Engram runner)");
    expect(spec.agentId).toBe("main");
    expect(spec.schedule).toEqual({ kind: "every", everyMs: 1800000 });
    expect(spec.sessionTarget).toBe("isolated");
    expect(spec.payload.kind).toBe("agentTurn");
    expect(spec.payload.message).toContain("Step 1 — Run the heartbeat runner");
    expect(spec.payload.message).toContain("Step 2 — Drain the subagent-spawn queue");
    expect(spec.payload.message).toContain(`workdir="${tmp}"`);
    expect(spec.payload.message).toContain("--label-prefix hb");
    expect(spec.payload.message).toContain("--agent-id main");
    // No openclaw calls recorded
    expect(readCallLog(fake.logFile)).toEqual([]);
  });

  test("3. status: with mock job — prints job state JSON", async () => {
    fake.setCronList({
      jobs: [cronListJob({ id: "abc-123", name: "Heartbeat (Engram runner)", message: NEW_PAYLOAD })],
      total: 1,
    });
    const r = await runInstallCron({
      workspace: tmp,
      args: ["status"],
      extraEnv: envForFake(fake),
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.id).toBe("abc-123");
    expect(parsed.name).toBe("Heartbeat (Engram runner)");
    expect(parsed.payload.message).toContain("Step 1 — Run the heartbeat runner");
  });

  test("4. status: with no jobs — prints 'no cron jobs found', exits 0", async () => {
    const r = await runInstallCron({
      workspace: tmp,
      args: ["status"],
      extraEnv: envForFake(fake),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("no cron jobs found");
  });

  test("5. install --dry-run on empty cron list — prints full spec with all placeholders substituted", async () => {
    const r = await runInstallCron({
      workspace: tmp,
      args: [
        "install",
        "--dry-run",
        "--agent-id",
        "work",
        "--label-prefix",
        "work-hb",
        "--session",
        "main",
      ],
    });
    expect(r.exitCode).toBe(0);
    const spec = JSON.parse(r.stdout);
    expect(spec.payload.message).toContain(`workdir="${tmp}"`);
    expect(spec.payload.message).toContain("--workspace " + tmp);
    expect(spec.payload.message).toContain("--agent-id work");
    expect(spec.payload.message).toContain("--label-prefix work-hb");
    expect(spec.payload.message).toContain("--session main");
    expect(spec.payload.message).not.toContain("<WORKSPACE>");
    expect(spec.payload.message).not.toContain("<AGENT_ID>");
    expect(spec.payload.message).not.toContain("<SESSION>");
    expect(spec.payload.message).not.toContain("<LABEL_PREFIX>");
    expect(readCallLog(fake.logFile)).toEqual([]);
  });

  test("6. install on existing job with new payload — 'already up to date'", async () => {
    fake.setCronList({
      jobs: [cronListJob({ id: "job-new-1", name: "Heartbeat (Engram runner)", message: NEW_PAYLOAD })],
      total: 1,
    });
    const r = await runInstallCron({
      workspace: tmp,
      args: ["install"],
      extraEnv: envForFake(fake),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("already up to date");
    expect(r.stdout).toContain("job-new-1");
    const calls = readCallLog(fake.logFile);
    const editCall = calls.find(
      (c) => c.args[0] === "cron" && c.args[1] === "edit"
    );
    expect(editCall).toBeUndefined();
    const addCall = calls.find(
      (c) => c.args[0] === "cron" && c.args[1] === "add"
    );
    expect(addCall).toBeUndefined();
  });

  test("7. install on existing job with old payload — emits 'cron edit' call, prints 'updated'", async () => {
    fake.setCronList({
      jobs: [cronListJob({ id: "job-old-1", name: "Heartbeat (Engram runner)", message: OLD_PAYLOAD })],
      total: 1,
    });
    const r = await runInstallCron({
      workspace: tmp,
      args: ["install", "--agent-id", "main"],
      extraEnv: envForFake(fake),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("updated");
    expect(r.stdout).toContain("job-old-1");
    const calls = readCallLog(fake.logFile);
    const editCall = calls.find(
      (c) => c.args[0] === "cron" && c.args[1] === "edit"
    );
    expect(editCall).toBeDefined();
    expect(editCall.args[2]).toBe("job-old-1");
    const nameIdx = editCall.args.indexOf("--name");
    const messageIdx = editCall.args.indexOf("--message");
    expect(nameIdx).toBeGreaterThan(-1);
    expect(messageIdx).toBeGreaterThan(-1);
    expect(editCall.args[nameIdx + 1]).toBe("Heartbeat (Engram runner)");
    expect(editCall.args[messageIdx + 1]).toContain(
      "Step 1 — Run the heartbeat runner"
    );
    expect(editCall.args[messageIdx + 1]).toContain(
      "Step 2 — Drain the subagent-spawn queue"
    );
    // Verify the FULL multi-line message is preserved (not truncated by cmd.exe).
    // This is the regression test for the Windows/cmd.exe newline bug.
    expect(editCall.args[messageIdx + 1]).toContain("Step 3 — For each line");
    expect(editCall.args[messageIdx + 1]).toContain("Step 4 — Final reply");
    const addCall = calls.find(
      (c) => c.args[0] === "cron" && c.args[1] === "add"
    );
    expect(addCall).toBeUndefined();
  });

  test("8. install --dry-run with --schedule 5m — spec has everyMs: 300000", async () => {
    const r = await runInstallCron({
      workspace: tmp,
      args: ["install", "--dry-run", "--schedule", "5m"],
    });
    expect(r.exitCode).toBe(0);
    const spec = JSON.parse(r.stdout);
    expect(spec.schedule).toEqual({ kind: "every", everyMs: 300000 });
  });

  test("9. install --dry-run with --schedule '*/15 * * * *' — spec has cron expr", async () => {
    const r = await runInstallCron({
      workspace: tmp,
      args: ["install", "--dry-run", "--schedule", "*/15 * * * *"],
    });
    expect(r.exitCode).toBe(0);
    const spec = JSON.parse(r.stdout);
    expect(spec.schedule).toEqual({
      kind: "cron",
      expr: "*/15 * * * *",
      tz: "Europe/Moscow",
    });
  });

  test("10. install substitutes placeholders correctly", async () => {
    const r = await runInstallCron({
      workspace: tmp,
      args: [
        "install",
        "--dry-run",
        "--agent-id",
        "myagent",
        "--label-prefix",
        "myprefix",
        "--session",
        "mysession",
      ],
    });
    expect(r.exitCode).toBe(0);
    const spec = JSON.parse(r.stdout);
    expect(spec.payload.message).toContain(tmp);
    expect(spec.payload.message).toContain("myagent");
    expect(spec.payload.message).toContain("myprefix");
    expect(spec.payload.message).toContain("mysession");
    expect(spec.agentId).toBe("myagent");
    expect(spec.sessionKey).toBe("agent:myagent:mysession");
  });

  test("11. uninstall with existing job — emits 'cron rm <id>', prints 'removed'", async () => {
    fake.setCronList({
      jobs: [cronListJob({ id: "rm-target-1", name: "Heartbeat (Engram runner)", message: NEW_PAYLOAD })],
      total: 1,
    });
    const r = await runInstallCron({
      workspace: tmp,
      args: ["uninstall"],
      extraEnv: envForFake(fake),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/removed/);
    expect(r.stdout).toContain("rm-target-1");
    const calls = readCallLog(fake.logFile);
    const rmCall = calls.find(
      (c) => c.args[0] === "cron" && c.args[1] === "rm"
    );
    expect(rmCall).toBeDefined();
    expect(rmCall.args[2]).toBe("rm-target-1");
  });

  test("12. uninstall with no matching job — prints 'no job to remove', exits 0", async () => {
    const r = await runInstallCron({
      workspace: tmp,
      args: ["uninstall"],
      extraEnv: envForFake(fake),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("no job to remove");
    const calls = readCallLog(fake.logFile);
    const rmCall = calls.find(
      (c) => c.args[0] === "cron" && c.args[1] === "rm"
    );
    expect(rmCall).toBeUndefined();
  });

  test("13. unknown flag — exits 2 with helpful message", async () => {
    const r = await runInstallCron({
      workspace: tmp,
      args: ["--not-a-real-flag"],
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/Unknown option/);
    expect(r.stderr).toContain("--not-a-real-flag");
  });

  test("14. unknown action — exits 2", async () => {
    const r = await runInstallCron({
      workspace: tmp,
      args: ["frobnicate"],
      // No envForFake — we want the script to fail on the action check
      // before it even tries to find openclaw.
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/Unknown action/);
    expect(r.stderr).toContain("frobnicate");
  });

  test("15. missing openclaw binary — exits 3 with clear error", async () => {
    // We bypass both the node-script and the .cmd by setting
    // ENGRAM_OPENCLAW to a non-existent binary. The script's
    // resolveInvocation() returns the .cmd path; the binary check fails.
    const r = await runInstallCron({
      workspace: tmp,
      args: ["install"],
      extraEnv: {
        ENGRAM_OPENCLAW_NODE_SCRIPT: "",
        ENGRAM_OPENCLAW: join(tmp, "no-such-binary"),
      },
    });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toMatch(/not found/i);
  });

  test("16. schedule conversion table — every form by ms", async () => {
    const cases = [
      { in: "5m", outMs: 300000 },
      { in: "15m", outMs: 900000 },
      { in: "30m", outMs: 1800000 },
      { in: "1h", outMs: 3600000 },
      { in: "2h", outMs: 7200000 },
    ];
    for (const c of cases) {
      const r = await runInstallCron({
        workspace: tmp,
        args: ["install", "--dry-run", "--schedule", c.in],
      });
      expect(r.exitCode).toBe(0);
      const spec = JSON.parse(r.stdout);
      expect(spec.schedule).toEqual({ kind: "every", everyMs: c.outMs });
    }
  });

  test("17. schedule conversion table — cron form with Moscow tz", async () => {
    const cases = [
      "*/5 * * * *",
      "0 * * * *",
      "0 9 * * 1-5",
    ];
    for (const expr of cases) {
      const r = await runInstallCron({
        workspace: tmp,
        args: ["install", "--dry-run", "--schedule", expr],
      });
      expect(r.exitCode).toBe(0);
      const spec = JSON.parse(r.stdout);
      expect(spec.schedule).toEqual({
        kind: "cron",
        expr,
        tz: "Europe/Moscow",
      });
    }
  });

  test("18. install on missing job — emits 'cron add' with all flags", async () => {
    const r = await runInstallCron({
      workspace: tmp,
      args: [
        "install",
        "--agent-id",
        "main",
        "--label-prefix",
        "hb",
        "--session",
        "main",
      ],
      extraEnv: envForFake(fake),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/created/);
    expect(r.stdout).toContain("fake-new-job-id");
    const calls = readCallLog(fake.logFile);
    const addCall = calls.find(
      (c) => c.args[0] === "cron" && c.args[1] === "add"
    );
    expect(addCall).toBeDefined();
    const argv = addCall.args;
    expect(argv).toContain("--name");
    expect(argv).toContain("Heartbeat (Engram runner)");
    expect(argv).toContain("--agent");
    expect(argv).toContain("main");
    expect(argv).toContain("--session");
    expect(argv).toContain("isolated");
    expect(argv).toContain("--message");
    expect(argv).toContain("--model");
    expect(argv).toContain("--thinking");
    expect(argv).toContain("medium");
    expect(argv).toContain("--timeout-seconds");
    expect(argv).toContain("900");
    expect(argv).toContain("--light-context");
    expect(argv).toContain("--no-deliver");
    expect(argv).toContain("--json");
    const everyIdx = argv.indexOf("--every");
    expect(everyIdx).toBeGreaterThan(-1);
    expect(argv[everyIdx + 1]).toBe("30m");
  });

  test("19. install on missing job with --schedule '*/30 * * * *' — emits '--cron' (not '--every')", async () => {
    const r = await runInstallCron({
      workspace: tmp,
      args: ["install", "--schedule", "*/30 * * * *"],
      extraEnv: envForFake(fake),
    });
    expect(r.exitCode).toBe(0);
    const calls = readCallLog(fake.logFile);
    const addCall = calls.find(
      (c) => c.args[0] === "cron" && c.args[1] === "add"
    );
    expect(addCall).toBeDefined();
    const argv = addCall.args;
    expect(argv).toContain("--cron");
    expect(argv).toContain("*/30 * * * *");
    expect(argv).toContain("--tz");
    expect(argv).toContain("Europe/Moscow");
    expect(argv).not.toContain("--every");
  });

  test("20. custom --cron-name matches a non-default named job", async () => {
    fake.setCronList({
      jobs: [
        cronListJob({
          id: "apriori-1",
          name: "Heartbeat (Apriori Engram runner)",
          message: OLD_PAYLOAD,
        }),
      ],
      total: 1,
    });
    const r = await runInstallCron({
      workspace: tmp,
      args: [
        "install",
        "--cron-name",
        "Heartbeat (Apriori Engram runner)",
      ],
      extraEnv: envForFake(fake),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("updated");
    expect(r.stdout).toContain("apriori-1");
    const calls = readCallLog(fake.logFile);
    const editCall = calls.find(
      (c) => c.args[0] === "cron" && c.args[1] === "edit"
    );
    expect(editCall).toBeDefined();
    expect(editCall.args[2]).toBe("apriori-1");
  });

  test("21. workspace arg from --workspace flag (not ENGRAM_WORKSPACE)", async () => {
    const otherTmp = makeTmp();
    mkdirSync(otherTmp, { recursive: true });
    try {
      const r = await runInstallCron({
        workspace: tmp,
        args: [
          "install",
          "--dry-run",
          "--workspace",
          otherTmp,
          "--agent-id",
          "wsflag",
        ],
      });
      expect(r.exitCode).toBe(0);
      const spec = JSON.parse(r.stdout);
      expect(spec.payload.message).toContain(otherTmp);
      expect(spec.payload.message).not.toContain(`workdir="${tmp}"`);
      expect(spec.agentId).toBe("wsflag");
    } finally {
      rmSync(otherTmp, { recursive: true, force: true });
    }
  });
});
