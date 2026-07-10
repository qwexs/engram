#!/usr/bin/env bun
/**
 * install-cron.js
 *
 * Provisions the OpenClaw cron job that drives the engram heartbeat
 * (Phase 5.5: heartbeat-runner.js → spawn-claim.js → sessions_spawn).
 *
 * The cron payload is a 4-step agent turn:
 *   1. shell_command: bun skills/engram/scripts/heartbeat-runner.js ...
 *   2. shell_command: bun skills/engram/scripts/spawn-claim.js ...
 *   3. for each JSON line with action="spawn": sessions_spawn(...)
 *   4. reply with runner output + "[phase-5.5] ..." + HEARTBEAT_OK
 *
 * This script is idempotent: re-running it updates the existing job's
 * payload.message and name to the current 4-step prose form, but does
 * NOT touch agentId, schedule, model, thinking, timeoutSeconds,
 * lightContext, sessionTarget, delivery, or sessionKey. So existing
 * schedule and routing are preserved across updates.
 *
 * ## Windows + multi-line --message note
 *
 * On Windows, `openclaw` resolves to a `.cmd` wrapper. When Bun.spawn
 * invokes a .cmd file, the args go through `cmd.exe`, which treats
 * literal newlines in arguments as command separators. The result:
 * `--message "line 1\nline 2"` is silently truncated to `line 1`.
 * This affects the REAL openclaw binary the same way — it has nothing
 * to do with the test mock.
 *
 * To preserve the multi-line message, on Windows we bypass the .cmd
 * wrapper and invoke `node <openclaw.mjs>` directly via `process.execPath`
 * (Bun is Node-compatible). The .mjs path is auto-detected from
 * `where openclaw.cmd` + npm-global layout, or override via
 * `ENGRAM_OPENCLAW_NODE_SCRIPT=<path>` (used by tests).
 *
 * On POSIX, the .cmd wrapper does not exist; we use `openclaw` directly
 * via PATH and multi-line args are preserved by the OS.
 *
 * ## WSL / Windows-shim safety
 *
 * On WSL specifically, the Windows .cmd shim from
 * `/mnt/c/.../npm/openclaw` is exposed via WSL interop in $PATH. The
 * shim is a `#!/bin/sh` script that does `exec node "$basedir/.../openclaw.mjs"`.
 * The inner `exec node` fails silently when WSL cannot find the Windows
 * `node` in its own PATH, so the outer `Bun.spawn` returns exit 0 without
 * actually invoking openclaw. install-cron.js would then proceed to call
 * `openclaw cron add ...` — and that call ALSO returns exit 0 with no
 * output, so the cron job is never created and the script exits 0.
 *
 * To prevent this silent failure, `isWindowsOpenclawShim()` rejects any
 * resolved path that looks like a Windows artifact (`.cmd`, `.bat`, `.exe`,
 * `.ps1`, `/mnt/c/...`, `/cygdrive/...`). On non-Windows, we resolve the
 * `openclaw` binary via `Bun.which()` first; if the result is a Windows
 * shim, the script exits 3 with a WSL-specific hint instead of silently
 * no-op'ing the install.
 *
 * Usage:
 *   bun skills/engram/scripts/install-cron.js [action] [options]
 *
 * Actions:
 *   install               Create or update the heartbeat cron job (default)
 *   uninstall             Remove the heartbeat cron job by name
 *   status                Show current cron job state as JSON
 *
 * Options:
 *   --agent-id <id>       Agent identifier (default: engram.json -> agent, normalized)
 *   --workspace <path>    Workspace path (default: $ENGRAM_WORKSPACE or cwd)
 *   --session <key>       Session key for runner (default: main)
 *   --label-prefix <p>    Label prefix for spawned subagents (default: hb)
 *   --cron-name <name>    Job name to look for (default: "Heartbeat (Engram runner)")
 *   --schedule <expr>     Schedule: "30m" (default), "5m", "1h", or cron expr
 *   --dry-run             Print cron job spec JSON, no openclaw calls
 *   -h, --help            Show this help
 *
 * Exit codes:
 *   0  Success
 *   1  openclaw error
 *   2  Bad args (unknown flag, unknown action, ...)
 *   3  openclaw binary not found / not in OpenClaw-managed workspace
 */

import { parseArgs } from "node:util";
import { execSync, spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { loadEngramConfig } from "./config.js";
import { findNodeScriptForCmdDir } from "./lib/find-openclaw-mjs.js";

// On Windows, npm/global wrappers install as `openclaw.cmd`; bun/Bun.spawn
// cannot exec the wrapper without the extension. ENGRAM_OPENCLAW overrides
// for testing (e.g. ENGRAM_OPENCLAW=/no/such/binary to test exit 3).
// `__use_node_script_only__` disables the .cmd fallback entirely so tests
// can rely purely on ENGRAM_OPENCLAW_NODE_SCRIPT.
const OPENCLAW_CMD =
  process.env.ENGRAM_OPENCLAW === "__use_node_script_only__"
    ? "__use_node_script_only__"
    : process.env.ENGRAM_OPENCLAW ||
      (process.platform === "win32" ? "openclaw.cmd" : "openclaw");

// Known CLI options (anything else is rejected with exit 2).
const KNOWN_OPTIONS = new Set([
  "agent-id",
  "workspace",
  "session",
  "label-prefix",
  "cron-name",
  "schedule",
  "dry-run",
  "help",
  "_",
]);

const KNOWN_ACTIONS = new Set(["install", "uninstall", "status"]);

const { values: args } = parseArgs({
  options: {
    "agent-id": { type: "string" },
    "workspace": { type: "string" },
    "session": { type: "string" },
    "label-prefix": { type: "string" },
    "cron-name": { type: "string" },
    "schedule": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "help": { type: "boolean", short: "h", default: false },
  },
  strict: false,
});

// Detect action from raw argv: first non-flag token. Required to live in
// KNOWN_ACTIONS (else exit 2 with a helpful message — see `if (firstArg...)`
// block below).
const argv = process.argv.slice(2);
let action = "install";
const firstArg = argv[0];
if (firstArg !== undefined) {
  if (firstArg.startsWith("-")) {
    // No action specified; use default "install".
  } else if (KNOWN_ACTIONS.has(firstArg)) {
    action = firstArg;
  } else {
    console.error(`❌ Unknown action: ${firstArg}`);
    console.error(`   Use one of: ${[...KNOWN_ACTIONS].join(", ")}`);
    process.exit(2);
  }
}

if (args.help) {
  console.log(`
install-cron — Install the engram heartbeat cron job

Usage:
  bun skills/engram/scripts/install-cron.js [action] [options]

Actions:
  install               Create or update the heartbeat cron job (default)
  uninstall             Remove the heartbeat cron job
  status                Show current cron job state

Options:
  --agent-id <id>       Agent identifier (default: engram.json -> agent)
  --workspace <path>    Workspace path (default: \$ENGRAM_WORKSPACE or cwd)
  --session <key>       Session key (default: main)
  --label-prefix <p>    Label prefix for spawned subagents (default: hb)
  --cron-name <name>    Job name to look for (default: "Heartbeat (Engram runner)")
  --schedule <expr>     Schedule: "30m" (default), "5m", "1h", or cron expr
  --dry-run             Print cron job spec JSON, no openclaw calls
  -h, --help            Show this help

Examples:
  bun skills/engram/scripts/install-cron.js
  bun skills/engram/scripts/install-cron.js install --agent-id main --schedule 30m
  bun skills/engram/scripts/install-cron.js status
  bun skills/engram/scripts/install-cron.js uninstall
  bun skills/engram/scripts/install-cron.js install --dry-run > cron-spec.json

Exit codes:
  0  Success
  1  openclaw error
  2  Bad args
  3  openclaw binary not found
`);
  process.exit(0);
}

// --- Validate args ---
for (const k of Object.keys(args)) {
  if (!KNOWN_OPTIONS.has(k)) {
    console.error(`❌ Unknown option: --${k}`);
    console.error(`   Run with --help for the list of known options.`);
    process.exit(2);
  }
}

// --- Resolve config ---
const WORKSPACE = (
  args.workspace || process.env.ENGRAM_WORKSPACE || process.cwd()
).replace(/\\/g, "/");

const config = loadEngramConfig(WORKSPACE);
const agentId =
  args["agent-id"] || config.agent.replace(/^agent-/, "") || "main";
const session = args.session || "main";
const labelPrefix = args["label-prefix"] || "hb";
const cronName = args["cron-name"] || "Heartbeat (Engram runner)";
const schedule = args.schedule || "30m";
const dryRun = !!args["dry-run"];

// Sub-agent model: prefer engram.json -> models.subagents_default,
// then models.default, then models.heartbeat.subagents.hb-extract,
// then OSS fallback "sonnet-4-6". Never hardcode deployment-specific
// model aliases in this script.
const subagentModel = (() => {
  if (config?.models?.subagents_default) {
    return String(config.models.subagents_default);
  }
  if (config?.models?.default) {
    return String(config.models.default);
  }
  if (config?.models?.heartbeat?.subagents?.["hb-extract"]) {
    return String(config.models.heartbeat.subagents["hb-extract"]);
  }
  return "sonnet-4-6";
})();

// --- Resolve openclaw invocation strategy ---
// On Windows, we need to bypass the .cmd wrapper to preserve multi-line
// --message args. ENGRAM_OPENCLAW_NODE_SCRIPT overrides auto-detection;
// auto-detection uses `where openclaw.cmd` to find the wrapper and resolves
// the sibling .mjs (npm-global layout) via
// `findNodeScriptForCmdDir` (see scripts/lib/find-openclaw-mjs.js for the
// layout table and rationale).
function autoDetectNodeScript() {
  if (process.platform !== "win32") return null;
  try {
    const out = execSync("where openclaw.cmd", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const cmdPath = out.split(/\r?\n/)[0]?.trim();
    if (!cmdPath) return null;
    return findNodeScriptForCmdDir(dirname(cmdPath));
  } catch {
    return null;
  }
}

const OPENCLAW_NODE_SCRIPT =
  process.env.ENGRAM_OPENCLAW_NODE_SCRIPT || autoDetectNodeScript();

// --- Resolve openclaw on non-Windows (Linux / macOS / WSL) ---
// WSL interop can surface Windows .cmd shims from /mnt/c/.../npm/openclaw
// in $PATH. From the Unix side, the shim appears to spawnSync as exit 0
// (the inner `exec node` fails silently when WSL can't find Windows
// `node` in its own PATH) but never actually invokes openclaw. We must
// reject these explicitly. See isWindowsOpenclawShim() for the full
// rejection rule and the WSL/Windows-shim safety section in the file
// header for context.
function isWindowsOpenclawShim(path) {
  if (!path) return false;
  if (/\.(cmd|bat|exe|ps1|cmd\.exe)$/i.test(path)) return true;
  if (/^\/mnt\/[a-z]\//i.test(path)) return true;
  if (/^\/cygdrive\//i.test(path)) return true;
  return false;
}

function autoDetectUnixBinary() {
  if (process.platform === "win32") return null;
  // Sentinel: caller forces the node-script path on Unix too (used by
  // tests via envForFake() to skip the Bun.which("openclaw") resolution
  // entirely). Returning null signals resolveInvocation() to fall back to
  // the node-direct path when OPENCLAW_NODE_SCRIPT is available.
  if (process.env.ENGRAM_OPENCLAW === "__use_node_script_only__") {
    return null;
  }
  // Honor ENGRAM_OPENCLAW override on Unix, but reject Windows shims
  // (e.g. when a dev sets ENGRAM_OPENCLAW=/mnt/c/.../npm/openclaw
  // expecting it to work). Note: empty string is treated as "unset" so
  // test 29 (which sets ENGRAM_OPENCLAW="" + an empty PATH) can exercise
  // the no-binary case instead of getting exe="" passed to spawnSync.
  const override = process.env.ENGRAM_OPENCLAW || null;
  if (override) {
    return isWindowsOpenclawShim(override) ? null : override;
  }
  // Resolve via Bun.which (preferred) or `command -v` (POSIX fallback).
  // Bun.which returns the absolute path or null — no shell, no quoting.
  let resolved = null;
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    resolved = Bun.which("openclaw");
  } else {
    try {
      const out = execSync("command -v openclaw", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      resolved = out.split(/\r?\n/)[0] || null;
    } catch {
      resolved = null;
    }
  }
  if (!resolved) return null;
  return isWindowsOpenclawShim(resolved) ? null : resolved;
}

const OPENCLAW_UNIX = autoDetectUnixBinary();

/**
 * Returns { exe, prefixArgs } such that running
 *   spawnSync(exe, [...prefixArgs, ...userArgs])
 * invokes openclaw with the given user args.
 *
 * On Windows, when a node-direct script is available, we ALWAYS use the
 * node-direct path (`node <openclaw.mjs>`) — NOT `process.execPath`. The
 * `openclaw.cmd` shim itself uses `node` to invoke the same .mjs (see
 * `npm\openclaw.cmd`), and we do the same so the .mjs's `node_modules`
 * (jiti, etc.) resolves correctly from the script's location regardless
 * of the caller's CWD. Using `process.execPath` (bun on this host) would
 * fail with `Cannot find package 'jiti'` whenever the CWD is not the
 * openclaw package dir. The .cmd wrapper is only used as a fallback when
 * auto-detection can't find the .mjs.
 *
 * On POSIX (Linux / macOS / WSL), we resolve the absolute path of the
 * `openclaw` binary via `Bun.which()` and reject Windows shims (see
 * isWindowsOpenclawShim). If the only `openclaw` on PATH is a Windows
 * .cmd shim surfaced by WSL interop, OPENCLAW_UNIX is null and
 * openclawAvailable() returns false — install-cron.js then exits 3
 * with a WSL-specific hint instead of silently no-op'ing the install.
 */
function resolveInvocation() {
  if (process.platform === "win32" && OPENCLAW_NODE_SCRIPT) {
    return { exe: "node", prefixArgs: [OPENCLAW_NODE_SCRIPT] };
  }
  if (process.platform !== "win32") {
    // Sentinel from envForFake(): on Unix, prefer the node-direct path
    // (with the fake .mjs) over a real Unix-binary resolution. Without
    // this branch, tests 1-26 would resolveInvocation() to
    // { exe: "__use_node_script_only__", prefixArgs: [] } and fail
    // openclawAvailable() with exit 3 because that string isn't a real
    // binary. Same role as the Windows branch above — dual compatibility.
    if (
      process.env.ENGRAM_OPENCLAW === "__use_node_script_only__" &&
      OPENCLAW_NODE_SCRIPT
    ) {
      return { exe: "node", prefixArgs: [OPENCLAW_NODE_SCRIPT] };
    }
    return { exe: OPENCLAW_UNIX, prefixArgs: [] };
  }
  return { exe: OPENCLAW_CMD, prefixArgs: [] };
}

// --- Check openclaw availability (skipped in dry-run) ---
function openclawAvailable() {
  try {
    const { exe, prefixArgs } = resolveInvocation();
    if (!exe) return false;
    const proc = spawnSync(exe, [...prefixArgs, "--version"], {
      encoding: "utf-8",
      stdio: "pipe",
    });
    return proc.status === 0;
  } catch {
    return false;
  }
}

if (!dryRun && !openclawAvailable()) {
  console.error(`❌ openclaw binary not found on PATH.`);
  console.error(`   Looking for: ${OPENCLAW_CMD}`);
  if (process.platform !== "win32") {
    if (process.env.ENGRAM_OPENCLAW && isWindowsOpenclawShim(process.env.ENGRAM_OPENCLAW)) {
      console.error(`   ENGRAM_OPENCLAW points to a Windows binary: ${process.env.ENGRAM_OPENCLAW}`);
      console.error(`   WSL interop surfaces Windows .cmd shims in $PATH that look valid but can't be invoked.`);
      console.error(`   Install openclaw natively on Linux: npm install -g openclaw`);
      console.error(`   Or unset ENGRAM_OPENCLAW and ensure a Unix openclaw is in $PATH.`);
    } else if (OPENCLAW_UNIX === null) {
      console.error(`   No Unix openclaw binary found. Install: npm install -g openclaw`);
    }
  } else if (process.platform === "win32" && !OPENCLAW_NODE_SCRIPT) {
    console.error(`   (Could not auto-detect openclaw.mjs to bypass the .cmd wrapper.)`);
    console.error(`   Set ENGRAM_OPENCLAW_NODE_SCRIPT=<path-to-openclaw.mjs> to override.`);
  }
  console.error(`   Install: see https://github.com/openclaw/openclaw`);
  console.error(`   Or pass --dry-run to print the spec without applying.`);
  process.exit(3);
}

// --- Schedule conversion ---
function buildSchedule(s) {
  // Duration like "30m", "5m", "1h", "10s", "1d"
  const m = /^(\d+)([smhd])$/.exec(s);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const mult =
      unit === "s"
        ? 1_000
        : unit === "m"
        ? 60_000
        : unit === "h"
        ? 3_600_000
        : 86_400_000;
    return { kind: "every", everyMs: n * mult };
  }
  // Otherwise: treat as cron expression (5-field), default tz Europe/Moscow.
  return { kind: "cron", expr: s, tz: "Europe/Moscow" };
}

// --- Cron payload prose template ---
// Placeholders: <WORKSPACE>, <AGENT_ID>, <SESSION>, <LABEL_PREFIX>.
// They are substituted by buildPayloadMessage() before the cron job is
// created or updated. Do NOT edit this template without checking
// references/HEARTBEAT.md Phase 5.5 — the agent's reply structure is
// what makes Phase 5.5 work end-to-end.
//
// Step 4 history (see references/heartbeat-legacy.md § Prompt format history):
//   - pre-2026-06-23: required the model to echo the full runner output
//     (~38kB / ~11k output tokens per tick) into the final reply. With
//     delivery.mode=none this is pure waste and frequently clipped at
//     max_tokens=8192, causing NO_REPLY / truncated summaries.
//   - 2026-06-23+: concise decision tree keyed on runner.summary.status
//     and warnings. Reply capped at ≤512 tokens, no echo. First
//     measurement on a quiet m2.7-fast tick: input ~14.1k (-52%),
//     output ~1.2k (-31%), wall time ~82s (-18%); on noisy ticks the
//     savings are 5-10x because the old echo path is fully eliminated.
const PROSE_TEMPLATE = `You are the cron job for the Clawd engram heartbeat. Do these steps in order using your available tools (do not write or run any JavaScript or shell scripts; call the tools directly).

Step 1 — Run the heartbeat runner:
Call tools.shell_command with command="bun ./skills/engram/scripts/heartbeat-runner.js --workspace <WORKSPACE> --agent-id <AGENT_ID> --session <SESSION> --label-prefix <LABEL_PREFIX> --all-active-sessions --timeout-ms 300000 --spawn-hb-domains-write --spawn-rethink --spawn-rethink2", workdir="<WORKSPACE>", timeout_ms=900000. Capture the output as \`runner\`.

Note on spawn flags: --spawn-hb-domains-write, --spawn-rethink, --spawn-rethink2 only open the gate for hb-rethink/rethink2/domains-write to be queued when their respective triggers fire. heartbeat-runner.js filters internally (wouldRunRethink, wouldRunRethink2, domainsWriteDue); cost is zero on ticks where triggers don't fire. This is the etalon default — fresh installs bootstrap the OLL loop end-to-end without manual seeding.

Step 2 — Drain the subagent-spawn queue (Phase 5.5):
The runner enqueues subagent spawn requests into workspace/ops/heartbeat-spawns/*.json (Bun scripts have no LLM tool access and cannot call sessions_spawn directly). You claim and dispatch them.
Call tools.shell_command with command="bun ./skills/engram/scripts/spawn-claim.js --workspace <WORKSPACE> --agent-id <AGENT_ID>", workdir="<WORKSPACE>", timeout_ms=60000. Capture the output as \`claim\`.

Step 3 — For each line in \`claim.stdout\` that parses as JSON with action="spawn":
Call tools.sessions_spawn with task=<rec.task>, label=<rec.label>, model=<rec.model>, cleanup="delete", cwd="<WORKSPACE>". Count successful calls as \`spawnedCount\`. Ignore the final {action:"summary",...} line and any non-spawn lines.

Step 4 — Final reply (CONCISE, NO ECHO):
Delivery is \`none\` — your reply is only stored in the session log, never sent to a chat. Keep it short.

Look at \`runner.summary.status\` and \`runner.summary.warnings\` (the JSON has them at the top level):
- status == "ok" and warnings empty → reply EXACTLY: \`HEARTBEAT_OK\` (one line, no other text)
- status == "ok" with warnings → reply with up to 5 one-liners (one per warning, each ≤200 chars), then \`HEARTBEAT_OK\`
- status == "error" → reply with up to 2 one-liners summarizing the first failures (≤200 chars each), then \`NO_REPLY\`
If \`claim.stdout\` was non-empty, append one final line: \`[phase-5.5] scanned N, claimed M, errors E, spawned K\` (use the {action:"summary",...} JSON line).

Do NOT echo the full runner output. Do NOT include the JSON, daily-note text, or any tool result verbatim. Do NOT call any tool beyond what is specified above. The whole reply must fit in ≤512 tokens.`;

// --- Heartbeat tool allow-list ---
// The heartbeat cron-job is a deterministic runner: it shells out to
// heartbeat-runner.js / spawn-claim.js and may dispatch subagent spawns.
// It does NOT need to write files, send messages, edit configs, or call
// any other heavy tool — payload delivery is `mode: none`. Listing all
// ~30+ agent tools in the system prompt burns thousands of input tokens
// per tick (~1.7M/day across 6 workspaces per ISS-01). Restricting to
// the minimum set cuts the system-prompt footprint drastically while
// keeping every step the message asks for working.
//
//   exec           — run heartbeat-runner.js + spawn-claim.js (Step 1+2)
//   sessions_spawn — dispatch Phase 5.5 subagents (Step 3)
//   read           — diagnose failures (read heartbeat-state.json etc.)
//
// If a future heartbeat step needs a new tool (e.g. message for ALERT
// delivery), add it here AND verify the heartbeat message template
// still works under the new allow-list.
const HEARTBEAT_TOOLS_ALLOW = ["exec", "sessions_spawn", "read"];

// Format for `openclaw cron add --tools` / `cron edit --tools`: comma-
// separated list is the canonical form (space-separated also accepted).
const HEARTBEAT_TOOLS_ALLOW_CLI = HEARTBEAT_TOOLS_ALLOW.join(",");

const NEW_PAYLOAD_MARKER_1 = "Step 1 — Run the heartbeat runner";
const NEW_PAYLOAD_MARKER_2 = "Step 2 — Drain the subagent-spawn queue";
// Marker for the 2026-06-23+ concise Step 4 (no echo, decision tree,
// ≤512-token reply cap). Presence of this string confirms the cron
// payload is on the current format; absence means an older echo-style
// prompt and a cron edit is required to upgrade.
const NEW_PAYLOAD_MARKER_3 = "Step 4 — Final reply (CONCISE, NO ECHO)";
// 2026-06-29+: --all-active-sessions flag in Step 1 command, for workspace-scope heartbeat
// coverage (instead of session-only). Maintained by the engram team; absence means the cron
// is on a pre-2026-06-29 payload and should be re-installed to upgrade.
const NEW_PAYLOAD_MARKER_4 = "--all-active-sessions --timeout-ms 300000";
// 2026-07-05+: --spawn-rethink --spawn-rethink2 в Step 1 command. Etalon default
// открывает gate для OLL-фаз; runner сам фильтрует по wouldRunRethink/wouldRunRethink2,
// цена нулевая пока триггеры не сработали. Закрывает OLL bootstrap chicken-and-egg loop
// на свежих установках.
const NEW_PAYLOAD_MARKER_5 = "--spawn-rethink --spawn-rethink2";

function buildPayloadMessage({ workspace, agentId, session, labelPrefix }) {
  return PROSE_TEMPLATE
    .replaceAll("<WORKSPACE>", workspace)
    .replaceAll("<AGENT_ID>", agentId)
    .replaceAll("<SESSION>", session)
    .replaceAll("<LABEL_PREFIX>", labelPrefix);
}

function isOnNewFormat(payload) {
  if (!payload || !payload.message) return false;
  return (
    payload.message.includes(NEW_PAYLOAD_MARKER_1) &&
    payload.message.includes(NEW_PAYLOAD_MARKER_2) &&
    payload.message.includes(NEW_PAYLOAD_MARKER_3) &&
    payload.message.includes(NEW_PAYLOAD_MARKER_4) &&
    payload.message.includes(NEW_PAYLOAD_MARKER_5) &&
    // toolsAllow must be present and match HEARTBEAT_TOOLS_ALLOW.
    // If absent (older install) or divergent, we re-apply via edit.
    Array.isArray(payload.toolsAllow) &&
    payload.toolsAllow.length === HEARTBEAT_TOOLS_ALLOW.length &&
    payload.toolsAllow.every((t, i) => t === HEARTBEAT_TOOLS_ALLOW[i])
  );
}

// --- Build full cron spec (for add / dry-run) ---
function buildCronSpec() {
  return {
    name: cronName,
    agentId,
    schedule: buildSchedule(schedule),
    sessionTarget: "isolated",
    sessionKey: `agent:${agentId}:${session}`,
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: buildPayloadMessage({
        workspace: WORKSPACE,
        agentId,
        session,
        labelPrefix,
      }),
      model: subagentModel,
      thinking: "medium",
      timeoutSeconds: 900,
      lightContext: true,
      toolsAllow: [...HEARTBEAT_TOOLS_ALLOW],
    },
    delivery: {
      mode: "none",
    },
  };
}

// --- openclaw I/O ---
// Real `openclaw cron list --json` prints "Config warnings: ..." to stdout
// before the JSON object. Strip everything before the first '{' so we
// always have parseable JSON regardless of warning presence.
function listCronJobs() {
  const { exe, prefixArgs } = resolveInvocation();
  const proc = spawnSync(exe, [...prefixArgs, "cron", "list", "--json"], {
    encoding: "utf-8",
  });
  if (proc.error) {
    console.error(`❌ openclaw error: ${proc.error.message}`);
    process.exit(1);
  }
  if (proc.status !== 0) {
    console.error(`❌ openclaw exited with code ${proc.status}`);
    if (proc.stderr) console.error(proc.stderr);
    process.exit(1);
  }
  const out = proc.stdout || "";
  const firstBrace = out.indexOf("{");
  if (firstBrace === -1) {
    throw new Error("openclaw cron list --json: no JSON object in output");
  }
  return JSON.parse(out.slice(firstBrace));
}

function findCronJobByName(jobsData, name) {
  const jobs = jobsData?.jobs || [];
  return jobs.find((j) => j.name === name) || null;
}

// Invoke openclaw with an argv array (no shell, no quoting issues).
// Uses the resolved invocation strategy (node-direct on Windows when
// available, otherwise the .cmd wrapper).
function runOpenclaw(cmdArgv) {
  const { exe, prefixArgs } = resolveInvocation();
  const proc = spawnSync(exe, [...prefixArgs, ...cmdArgv], {
    encoding: "utf-8",
  });
  if (proc.error) {
    console.error(`❌ openclaw error: ${proc.error.message}`);
    process.exit(1);
  }
  if (proc.status !== 0) {
    console.error(`❌ openclaw exited with code ${proc.status}`);
    if (proc.stderr) console.error(proc.stderr);
    process.exit(1);
  }
  return proc.stdout || "";
}

// --- Actions ---
function actionInstall() {
  const spec = buildCronSpec();

  if (dryRun) {
    console.log(JSON.stringify(spec, null, 2));
    return;
  }

  const jobsData = listCronJobs();
  const existing = findCronJobByName(jobsData, cronName);

  if (existing) {
    if (isOnNewFormat(existing.payload)) {
      console.log(`✅ already up to date (id=${existing.id})`);
      return;
    }
    // Update name + payload.message + tools allow-list. agentId, schedule,
    // model, thinking, timeoutSeconds, lightContext, sessionTarget,
    // delivery, sessionKey are preserved from the existing job — we MUST
    // NOT touch them.
    runOpenclaw([
      "cron",
      "edit",
      existing.id,
      "--name",
      cronName,
      "--message",
      spec.payload.message,
      "--tools",
      HEARTBEAT_TOOLS_ALLOW_CLI,
    ]);
    console.log(`✅ updated cron job ${existing.id} (message + tools allow-list)`);
    return;
  }

  // Create from scratch. Translate schedule into --every/--cron + --tz.
  const addArgv = [
    "cron",
    "add",
    "--name",
    cronName,
    "--agent",
    agentId,
    "--session",
    "isolated",
    "--session-key",
    `agent:${agentId}:${session}`,
    "--message",
    spec.payload.message,
    "--model",
    subagentModel,
    "--thinking",
    "medium",
    "--timeout-seconds",
    "900",
    "--light-context",
    "--tools",
    HEARTBEAT_TOOLS_ALLOW_CLI,
    "--no-deliver",
    "--json",
  ];
  if (spec.schedule.kind === "every") {
    const minutes = Math.round(spec.schedule.everyMs / 60_000);
    addArgv.push("--every", `${minutes}m`);
  } else {
    addArgv.push("--cron", spec.schedule.expr, "--tz", spec.schedule.tz);
  }
  const out = runOpenclaw(addArgv);
  const firstBrace = out.indexOf("{");
  const json = firstBrace >= 0 ? out.slice(firstBrace) : "{}";
  let id = "<unknown>";
  try {
    const parsed = JSON.parse(json);
    if (parsed.id) id = parsed.id;
  } catch {
    /* keep <unknown> */
  }
  console.log(`✅ created cron job ${id}`);
}

function actionUninstall() {
  if (dryRun) {
    console.log("{}");
    return;
  }
  const jobsData = listCronJobs();
  const existing = findCronJobByName(jobsData, cronName);
  if (!existing) {
    console.log("no job to remove");
    return;
  }
  runOpenclaw(["cron", "rm", existing.id]);
  console.log(`✅ removed cron job ${existing.id}`);
}

function actionStatus() {
  if (dryRun) {
    console.log("{}");
    return;
  }
  const jobsData = listCronJobs();
  const existing = findCronJobByName(jobsData, cronName);
  if (!existing) {
    console.log(`no cron jobs found matching name ${JSON.stringify(cronName)}`);
    return;
  }
  console.log(JSON.stringify(existing, null, 2));
}

// --- Dispatch ---
if (action === "install") actionInstall();
else if (action === "uninstall") actionUninstall();
else if (action === "status") actionStatus();
