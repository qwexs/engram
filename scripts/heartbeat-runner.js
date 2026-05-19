#!/usr/bin/env bun
/**
 * heartbeat-runner.js
 *
 * Deterministic Engram heartbeat runner for cron jobs.
 * Handles mechanical state/report/index work without relying on an LLM to
 * interpret HEARTBEAT.md correctly.
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadEngramConfig } from "./config.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));

const DEFAULT_STATE = {
  lastDailyNoteCreated: {},
  lastChecks: { email: null, calendar: null, weather: null },
  heartbeatInProgress: false,
  heartbeatLockedAt: null,
  subagentExtraction: false,
  lastExtraction: {},
  lastDomainScan: null,
  lastWeeklySynthesis: null,
  pendingObservations: 0,
  pendingTensions: 0,
  subagentRuns: {},
};

function parseArgs(argv) {
  const opts = {};
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv);

if (opts.help || opts.h) {
  console.log([
    "heartbeat-runner.js",
    "",
    "Usage:",
    "  bun skills/engram/scripts/heartbeat-runner.js --workspace <path> --agent-id <id> --session main --label-prefix <prefix>",
    "",
    "Options:",
    "  --workspace <path>       Workspace root. Defaults to ENGRAM_WORKSPACE or cwd.",
    "  --agent-id <id>          Agent id without agent- prefix. Defaults from engram.json.",
    "  --session <name>         Canonical Engram session. Default: main.",
    "  --label-prefix <prefix>  Prefix for heartbeat subagent labels. Default: hb for main, <agent>-hb otherwise.",
    "  --date <YYYY-MM-DD>      Date override. Default: today in ENGRAM_TZ/TZ.",
    "  --no-embed               Skip qmd embed.",
    "  --no-fix                 Run validate.js without --fix.",
    "  --timeout-ms <n>         Per-command timeout. Default: 300000.",
    "  --stale-lock-min <n>     Reset heartbeat lock older than N minutes. Default: 10.",
  ].join("\n"));
  process.exit(0);
}

const workspace = resolve(opts.workspace || process.env.ENGRAM_WORKSPACE || process.cwd());
process.env.ENGRAM_WORKSPACE = workspace;

const config = loadEngramConfig(workspace);
const agentId = String(opts["agent-id"] || config.agent.replace(/^agent-/, "") || "main").replace(/^agent-/, "");
const agentDir = "agent-" + agentId;
const session = opts.session || "main";
const labelPrefix = opts["label-prefix"] || (agentId === "main" ? "hb" : agentId + "-hb");
const tz = process.env.ENGRAM_TZ || process.env.TZ || "Europe/Moscow";
const today = opts.date || new Date().toLocaleDateString("sv-SE", { timeZone: tz });
const timeoutMs = Number(opts["timeout-ms"] || 300000);
const staleLockMin = Number(opts["stale-lock-min"] || 10);

const statePath = join(workspace, "memory", "heartbeat-state.json");
const noteDir = join(workspace, "memory", agentDir, session);
const notePath = join(noteDir, today + ".md");

const summary = {
  workspace,
  agentId,
  session,
  labelPrefix,
  date: today,
  extraction: "not run",
  synthesis: "not run",
  domains: "not run",
  maintenance: "not run",
  warnings: [],
};

function nowIso() {
  return new Date().toISOString();
}

function localIso() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) +
    "T" + pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds()) +
    sign + pad(Math.floor(abs / 60)) + ":" + pad(abs % 60);
}

async function readJson(path, fallback) {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return structuredClone(fallback);
  }
}

async function atomicWrite(path, content) {
  const tmp = path + ".tmp-" + process.pid + "-" + Date.now();
  await writeFile(tmp, content);
  renameSync(tmp, path);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

async function patchState(patches) {
  const state = await readJson(statePath, DEFAULT_STATE);
  for (const entry of Object.entries(patches)) setPath(state, entry[0], entry[1]);
  mkdirSync(dirname(statePath), { recursive: true });
  await atomicWrite(statePath, JSON.stringify(state, null, 2) + "\n");
  return state;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || workspace,
    env: { ...process.env, ENGRAM_WORKSPACE: workspace },
    encoding: "utf8",
    timeout: options.timeoutMs || timeoutMs,
    shell: process.platform === "win32",
  });
  return {
    command: command + " " + args.join(" "),
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function scriptPath(name) {
  return join(scriptDir, name);
}

function dailyTemplate(date) {
  return "# " + date + "\n\n## Events\n\n## Decisions\n\n## Learnings\n\n## Active Threads\n\n## Next\n";
}

async function ensureDailyNote() {
  mkdirSync(noteDir, { recursive: true });
  if (!existsSync(notePath)) await writeFile(notePath, dailyTemplate(today));
  await patchState({ ["lastDailyNoteCreated." + session]: today });
}

function stripWatermark(content) {
  return content.replace(/\s*<!-- extracted:L\d+:[^>]+ -->\s*$/, "").trimEnd() + "\n";
}

async function writeExtractionWatermark() {
  const content = await readFile(notePath, "utf8");
  const body = stripWatermark(content);
  const lineCount = body.split(/\r?\n/).length;
  const iso = localIso();
  await writeFile(notePath, body + "<!-- extracted:L" + lineCount + ":" + iso + " -->\n");
  await patchState({
    ["lastExtraction." + session]: iso,
    "subagentRuns.hb-extract": { status: "ok", label: labelPrefix + "-extract", facts: 0 },
  });
  summary.extraction = "ok (runner, 0 facts)";
}

function mondayFor(dateString) {
  const date = new Date(dateString + "T12:00:00");
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return date.toLocaleDateString("sv-SE");
}

async function runSynthesis() {
  const monday = mondayFor(today);
  if (today !== monday) {
    summary.synthesis = "skipped (not Monday)";
    return;
  }
  const state = await readJson(statePath, DEFAULT_STATE);
  if (state.lastWeeklySynthesis === monday) {
    summary.synthesis = "skipped (already ran this week)";
    return;
  }
  const result = run("bun", [scriptPath("rebuild-summaries.js"), "--apply-decay"]);
  if (result.status === 0) {
    await patchState({
      lastWeeklySynthesis: monday,
      "subagentRuns.hb-synthesis": { status: "ok", label: labelPrefix + "-synthesis" },
    });
    summary.synthesis = "ok (runner apply-decay)";
  } else {
    summary.synthesis = "error (rebuild-summaries failed)";
    summary.warnings.push(result.stderr || result.stdout || result.error || "rebuild-summaries failed");
  }
}

async function runDomains() {
  const registry = join(workspace, "memory", "domains", "registry.json");
  if (!existsSync(registry)) {
    summary.domains = "skipped (no registry)";
    return;
  }
  await patchState({
    "subagentRuns.hb-domains": {
      status: "skipped",
      label: labelPrefix + "-domains",
      reason: "runner does not spawn domain workers yet",
    },
  });
  summary.domains = "skipped (runner domain workers disabled)";
}

async function runMaintenance() {
  const validateArgs = [scriptPath("validate.js")];
  if (!opts["no-fix"]) validateArgs.push("--fix");
  validateArgs.push("--agent-id", agentId);

  const validate = run("bun", validateArgs);
  const qmdUpdate = run("qmd", ["update"]);
  const qmdEmbed = opts["no-embed"]
    ? { status: 0, stdout: "skipped", stderr: "", error: null, command: "qmd embed skipped" }
    : run("qmd", ["embed"], { timeoutMs: Math.max(timeoutMs, 600000) });

  summary.maintenance = [
    validate.status === 0 ? "validate ok" : "validate error",
    qmdUpdate.status === 0 ? "qmd update ok" : "qmd update error",
    opts["no-embed"] ? "qmd embed skipped" : (qmdEmbed.status === 0 ? "qmd embed ok" : "qmd embed error"),
  ].join("; ");

  for (const result of [validate, qmdUpdate, qmdEmbed]) {
    if (result.status !== 0) summary.warnings.push(result.stderr || result.stdout || result.error || result.command + " failed");
  }
}

async function writeReport() {
  const result = run("bun", [
    scriptPath("heartbeat-report.js"),
    "--session", session,
    "--date", today,
    "--extraction", summary.extraction,
    "--synthesis", summary.synthesis,
    "--domains", summary.domains,
    "--maintenance", summary.maintenance,
  ]);
  if (result.status !== 0) summary.warnings.push(result.stderr || result.stdout || result.error || "heartbeat-report failed");
}

async function main() {
  const initial = await readJson(statePath, DEFAULT_STATE);
  if (initial.heartbeatInProgress) {
    const lockedAt = initial.heartbeatLockedAt ? new Date(initial.heartbeatLockedAt).getTime() : 0;
    const ageMs = Date.now() - lockedAt;
    if (!lockedAt || ageMs > staleLockMin * 60 * 1000) {
      summary.warnings.push("stale heartbeat lock reset");
    } else {
      summary.maintenance = "skipped (heartbeat lock active)";
      console.log(JSON.stringify({ status: "skipped", reason: "heartbeat lock active", summary }, null, 2));
      console.log("HEARTBEAT_OK");
      return;
    }
  }

  await patchState({ heartbeatInProgress: true, heartbeatLockedAt: nowIso() });
  try {
    await ensureDailyNote();
    const rotateCheck = run("bun", [scriptPath("rotate-notes.js"), "--check", "--session", session]);
    if (rotateCheck.status !== 0 && rotateCheck.status !== 10) {
      summary.warnings.push(rotateCheck.stderr || rotateCheck.stdout || "rotate check failed");
    }
    await writeExtractionWatermark();
    if (rotateCheck.status === 10) summary.warnings.push("rotation needed but not performed by runner MVP");
    await runSynthesis();
    await runDomains();
    await runMaintenance();
    await writeReport();
  } finally {
    await patchState({ heartbeatInProgress: false, heartbeatLockedAt: null });
  }

  console.log(JSON.stringify({ status: summary.warnings.length ? "ok_with_warnings" : "ok", summary }, null, 2));
  console.log("HEARTBEAT_OK");
}

main().catch(async (err) => {
  summary.warnings.push(err && err.stack ? err.stack : String(err));
  await patchState({ heartbeatInProgress: false, heartbeatLockedAt: null }).catch(() => {});
  console.error(JSON.stringify({ status: "error", summary }, null, 2));
  process.exit(1);
});
