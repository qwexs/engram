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
import { loadEngramConfig, resolveSubagentModel } from "./config.js";
import { parseHandoff } from "./process-handoff-core.js";
import { applyDomainWriteHandoff, scanDomains, formatDomainScanSummary } from "./domains-runner.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));

const DEFAULT_STATE = {
  lastDailyNoteCreated: {},
  lastChecks: { email: null, calendar: null, weather: null },
  heartbeatInProgress: false,
  heartbeatLockedAt: null,
  subagentExtraction: false,
  lastExtraction: {},
  lastSessionExtracted: {},
  lastDomainScan: null,
  lastWeeklySynthesis: null,
  pendingObservations: 0,
  pendingTensions: 0,
  rethinkInProgress: false,
  rethinkStartedAt: null,
  lastRethink: null,
  lastRethinkScore: null,
  rethinkCount: 0,
  autoresearchInProgress: false,
  autoresearchStartedAt: null,
  currentExperiment: null,
  lastAutoresearch: null,
  pendingRethink2: null,
  rethink2InProgress: false,
  rethink2StartedAt: null,
  subagentRuns: {},
  activeSessions: [],
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
    "  --all-active-sessions    Run extraction/report for all heartbeat-state activeSessions, then workspace phases once.",
    "  --active-sessions <csv>   Override activeSessions for this run (comma-separated canonical session names).",
    "  --label-prefix <prefix>  Prefix for heartbeat subagent labels. Default: hb for main, <agent>-hb otherwise.",
    "  --date <YYYY-MM-DD>      Date override. Default: today in ENGRAM_TZ/TZ.",
    "  --no-embed               Skip qmd embed.",
    "  --no-semantic-check      Skip QMD semantic dedup inside extract-runner.",
    "  --no-write-extraction    Dry-run extraction writes without advancing watermark.",
    "  --advance-watermark-on-no-write",
    "                           Allow dry-run extraction to advance watermark/session cursor.",
    "  --no-fix                 Run validate.js without --fix.",
    "  --skip-maintenance       Skip validate/qmd maintenance (test/smoke only).",
    "  --domains-write          Enable guarded domain write handoff application.",
    "  --domains-dry-run        Validate domain write handoff without mutating files.",
    "  --domain <name>          Select one domain for write mode.",
    "  --domains-handoff-file <path>",
    "                           HB-DOMAINS handoff block to apply in write mode.",
    "  --spawn-rethink          Queue hb-rethink when OLL trigger is due.",
    "  --spawn-autoresearch     Queue hb-autoresearch for the next pending auto experiment.",
    "  --spawn-rethink2         Queue hb-rethink2 when pendingRethink2 is set.",
    "  --recover-stale-oll-locks",
    "                           Clear stale OLL worker locks before evaluating spawn flags.",
    "  --oll-stale-rethink-hours <n>",
    "                           hb-rethink stale TTL. Default: 2.",
    "  --oll-stale-autoresearch-min <n>",
    "                           hb-autoresearch stale TTL. Default: 30.",
    "  --oll-stale-rethink2-hours <n>",
    "                           hb-rethink2 stale TTL. Default: 2.",
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
const allActiveSessions = Boolean(opts["all-active-sessions"]);
const labelPrefix = opts["label-prefix"] || (agentId === "main" ? "hb" : agentId + "-hb");
const tz = process.env.ENGRAM_TZ || process.env.TZ || "Europe/Moscow";
const today = opts.date || new Date().toLocaleDateString("sv-SE", { timeZone: tz });
const timeoutMs = Number(opts["timeout-ms"] || 300000);
const staleLockMin = Number(opts["stale-lock-min"] || 10);
const ollStale = {
  rethinkHours: Number(opts["oll-stale-rethink-hours"] || 2),
  autoresearchHours: Number(opts["oll-stale-autoresearch-min"] || 30) / 60,
  rethink2Hours: Number(opts["oll-stale-rethink2-hours"] || 2),
};

const statePath = join(workspace, "memory", "heartbeat-state.json");

const summary = {
  workspace,
  agentId,
  session,
  scope: allActiveSessions ? "workspace" : "session",
  activeSessions: [],
  labelPrefix,
  date: today,
  extraction: "not run",
  synthesis: "not run",
  domains: "not run",
  oll: "not run",
  maintenance: "not run",
  phases: {},
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
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd || workspace,
    env: { ...process.env, ENGRAM_WORKSPACE: workspace },
    encoding: "utf8",
    timeout: options.timeoutMs || timeoutMs,
    shell: false,
  });
  return {
    command: command + " " + args.join(" "),
    status: result.status,
    signal: result.signal,
    elapsedMs: Date.now() - startedAt,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function summarizeCommand(result) {
  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  return {
    command: result.command,
    status: result.status,
    signal: result.signal,
    elapsedMs: result.elapsedMs,
    error: result.error,
    stdoutPreview: stdout ? stdout.slice(0, 500) : "",
    stderrPreview: stderr ? stderr.slice(0, 500) : "",
  };
}

function parseLastJsonLine(output) {
  const lines = String(output || "").trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* keep scanning */ }
  }
  return null;
}

function formatSynthesisStats(stats) {
  if (!stats) return "ok (runner apply-decay)";
  const parts = [
    `${stats.updated ?? 0} updated`,
    `${stats.unchanged ?? 0} unchanged`,
    `${stats.skipped ?? 0} skipped`,
    `${stats.errors ?? 0} errors`,
  ];
  if (stats.hot != null || stats.warm != null || stats.coldExcluded != null) {
    parts.push(`hot ${stats.hot ?? 0}`);
    parts.push(`warm ${stats.warm ?? 0}`);
    parts.push(`coldExcluded ${stats.coldExcluded ?? 0}`);
  }
  return `ok (${parts.join(", ")})`;
}

function daysSince(iso, fallback = 999) {
  if (!iso) return fallback;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return fallback;
  return Math.floor((Date.now() - ms) / 86400000);
}

function hoursSince(iso, fallback = 999) {
  if (!iso) return fallback;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return fallback;
  return Math.floor((Date.now() - ms) / 3600000);
}

async function readJsonIfExists(path, fallback) {
  try {
    if (!existsSync(path)) return structuredClone(fallback);
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return structuredClone(fallback);
  }
}

async function countPendingObservationCategories() {
  const dir = join(workspace, "workspace", "ops", "observations");
  const index = await readJsonIfExists(join(dir, "index.json"), { observations: [] });
  const counts = { friction: 0, surprise: 0, pattern: 0, total: 0 };
  for (const id of Array.isArray(index.observations) ? index.observations : []) {
    const obs = await readJsonIfExists(join(dir, `${id}.json`), null);
    if (!obs || obs.status !== "pending") continue;
    const category = String(obs.category || "").toLowerCase();
    if (Object.hasOwn(counts, category)) counts[category]++;
    counts.total++;
  }
  return counts;
}

async function countPendingTensions() {
  const dir = join(workspace, "workspace", "ops", "tensions");
  const index = await readJsonIfExists(join(dir, "index.json"), { tensions: [] });
  let pending = 0;
  for (const id of Array.isArray(index.tensions) ? index.tensions : []) {
    const tension = await readJsonIfExists(join(dir, `${id}.json`), null);
    if (tension && tension.status === "pending") pending++;
  }
  return pending;
}

async function getExperimentTriggerStats() {
  const registry = await readJsonIfExists(join(workspace, "workspace", "research", "experiments.json"), { stats: {}, experiments: [] });
  return {
    pending: Number(registry.stats?.pending || 0),
    running: Number(registry.stats?.running || 0),
    total: Number(registry.stats?.total || 0),
  };
}

async function listPendingAutoExperiments() {
  try {
    const { listByStatus } = await import("./experiments-registry.js");
    const pending = await listByStatus("pending");
    return pending.filter((experiment) => experiment?.budget?.decision === "auto");
  } catch {
    return [];
  }
}

function isWorkerRunning(state, phase) {
  const run = state.subagentRuns?.[phase];
  return Boolean(run && (run.status === "running" || run.status === "queued"));
}

function staleWorker(state, phase, legacyStartedAtKey, ttlHours) {
  const legacyFlag = phase === "hb-rethink"
    ? Boolean(state.rethinkInProgress)
    : phase === "hb-autoresearch"
      ? Boolean(state.autoresearchInProgress)
      : Boolean(state.rethink2InProgress);
  if (!legacyFlag && !isWorkerRunning(state, phase)) return false;
  const startedAt = state.subagentRuns?.[phase]?.startedAt || state[legacyStartedAtKey] || null;
  return hoursSince(startedAt) > ttlHours;
}

function spawnLabel(phase) {
  return labelPrefix + "-" + phase.replace(/^hb-/, "");
}

function spawnRunId(phase) {
  return phase + "-" + today + "-" + Date.now();
}

// Normalize a filesystem path to forward-slash form for storage in JSON state.
// `readFileSync` / `readdirSync` accept forward slashes on both Windows and
// POSIX, but backslashes are POSIX-incompatible. Storing POSIX paths keeps
// heartbeat-state.json portable. (See audits/engram-path-audit-2026-06-15.md.)
function toPosixPath(p) {
  return typeof p === "string" ? p.replace(/\\/g, "/") : p;
}

async function queueSpawnRequest({ phase, runId, label, task, experimentId = null, model = resolveSubagentModel(workspace, label) }) {
  const dir = join(workspace, "workspace", "ops", "heartbeat-spawns");
  mkdirSync(dir, { recursive: true });
  const payload = { runId, phase, label, model, cleanup: "delete", status: "queued", createdAt: localIso(), experimentId, task };
  const path = join(dir, runId + ".json");
  await atomicWrite(path, JSON.stringify(payload, null, 2) + "\n");
  return { path: toPosixPath(path), payload };
}

async function readReferenceTemplate(name) {
  try {
    return await readFile(join(scriptDir, "..", "references", name), "utf8");
  } catch {
    return "";
  }
}

async function buildOllTask(phase, context) {
  const templateByPhase = { "hb-rethink": "HB-RETHINK.md", "hb-autoresearch": "HB-AUTORESEARCH.md", "hb-rethink2": "HB-RETHINK2.md" };
  let template = await readReferenceTemplate(templateByPhase[phase]);

  // Substitute {{key}} placeholders from context. Anything not in context
  // is left as the raw placeholder so the LLM subagent can see what's
  // expected and reason about it (rather than silently dropping data).
  // Возник из hb-rethink 2026-06-15: queued task contained unfilled
  // `{{session}}`, `{{weighted_score}}` etc. — subagent received broken
  // context block. Now runner fills the values it actually has.
  if (phase === "hb-rethink") {
    // tensions is a count (number) at this point, not a list. Surface a
    // JSON array for the template: [] when zero, or a stub note when >0
    // telling the subagent to read workspace/ops/tensions/index.json.
    const tensionsJson = (() => {
      if (Array.isArray(context.tensions)) return JSON.stringify(context.tensions, null, 2);
      const n = Number(context.tensions ?? 0);
      if (n === 0) return "[]";
      return JSON.stringify([{ note: `${n} tensions pending — read workspace/ops/tensions/index.json for details (runner only has the count, not the bodies)` }], null, 2);
    })();
    template = template
      .replace(/\{\{session\}\}/g, context.session ?? "main")
      .replace(/\{\{date\}\}/g, context.date ?? new Date().toISOString().slice(0, 10))
      .replace(/\{\{weighted_score\}\}/g, String(context.score ?? 0))
      .replace(/\{\{days_since_rethink\}\}/g, String(context.daysSinceRethink ?? 0))
      .replace(/\{\{trigger_reason\}\}/g, Array.isArray(context.reasons) ? context.reasons.join(", ") : String(context.reasons ?? ""))
      .replace(/\{\{observations_json\}\}/g, JSON.stringify(context.observations ?? {}, null, 2))
      .replace(/\{\{tensions_json\}\}/g, tensionsJson);
  } else if (phase === "hb-autoresearch") {
    template = template
      .replace(/\{\{session\}\}/g, context.session ?? "main")
      .replace(/\{\{date\}\}/g, context.date ?? new Date().toISOString().slice(0, 10))
      .replace(/\{\{experiment_id\}\}/g, String(context.experimentId ?? ""))
      .replace(/\{\{spec_yaml\}\}/g, String(context.specYaml ?? "(spec.yaml not yet loaded — fill from workspace/research/{id}/spec.yaml)"));
  } else if (phase === "hb-rethink2") {
    template = template
      .replace(/\{\{session\}\}/g, context.session ?? "main")
      .replace(/\{\{date\}\}/g, context.date ?? new Date().toISOString().slice(0, 10))
      .replace(/\{\{experiment_id\}\}/g, String(context.experimentId ?? ""))
      .replace(/\{\{report_content\}\}/g, String(context.reportContent ?? "(report.md not yet loaded — fill from workspace/research/{id}/report.md)"))
      .replace(/\{\{spec_yaml\}\}/g, String(context.specYaml ?? "(spec.yaml not yet loaded — fill from workspace/research/{id}/spec.yaml)"))
      .replace(/\{\{delivery_config\}\}/g, JSON.stringify(context.deliveryConfig ?? {}, null, 2));
  }

  return [
    template.trim(),
    "",
    "## Runner Context",
    "Use this run id in the final handoff when a Run-Id field is supported.",
    "```json",
    JSON.stringify(context, null, 2),
    "```",
  ].join("\n");
}

async function markOllWorkerQueued({ phase, runId, label, requestPath, experimentId = null }) {
  const patches = {
    ["subagentRuns." + phase]: { status: "queued", label, runId, requestPath, startedAt: localIso() },
  };
  if (phase === "hb-rethink") {
    patches.rethinkInProgress = true;
    patches.rethinkStartedAt = localIso();
    patches.lastRethinkScore = summary.phases.oll?.score ?? null;
  } else if (phase === "hb-autoresearch") {
    patches.autoresearchInProgress = true;
    patches.autoresearchStartedAt = localIso();
    patches.currentExperiment = experimentId;
  } else if (phase === "hb-rethink2") {
    patches.rethink2InProgress = true;
    patches.rethink2StartedAt = localIso();
  }
  await patchState(patches);
}

async function commandRunner(args, options = {}) {
  const [command, ...rest] = args;
  const result = run(command, rest, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
  });
  return {
    ok: result.status === 0,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr || result.error || "",
  };
}

function scriptPath(name) {
  return join(scriptDir, name);
}

function noteDirFor(targetSession) {
  return join(workspace, "memory", agentDir, targetSession);
}

function notePathFor(targetSession) {
  return join(noteDirFor(targetSession), today + ".md");
}

function dailyTemplate(date) {
  return "# " + date + "\n\n## Events\n\n## Decisions\n\n## Learnings\n\n## Active Threads\n\n## Next\n";
}

async function ensureDailyNote(targetSession = session) {
  const noteDir = noteDirFor(targetSession);
  const notePath = notePathFor(targetSession);
  mkdirSync(noteDir, { recursive: true });
  if (!existsSync(notePath)) await writeFile(notePath, dailyTemplate(today));
  await patchState({ ["lastDailyNoteCreated." + targetSession]: today });
}

function stripWatermark(content) {
  return content.replace(/\s*<!-- extracted:L\d+:[^>]+ -->\s*$/, "").trimEnd() + "\n";
}

function sanitizeLabelPart(value) {
  return String(value || "main").replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function extractionRunKey(targetSession = session) {
  return allActiveSessions ? "hb-extract-" + sanitizeLabelPart(targetSession) : "hb-extract";
}

function setExtractionPhase(targetSession, value) {
  if (allActiveSessions) {
    if (!summary.phases.extractions) summary.phases.extractions = {};
    summary.phases.extractions[targetSession] = value;
  } else {
    summary.phases.extraction = value;
  }
}

async function runExtraction(targetSession = session) {
  const state = await readJson(statePath, DEFAULT_STATE);
  const args = [
    scriptPath("extract-runner.js"),
    "--workspace", workspace,
    "--agent-id", agentId,
    "--session", targetSession,
    "--date", today,
  ];
  const lastSessionFile = state.lastSessionExtracted?.[targetSession];
  if (lastSessionFile) args.push("--last-session-extracted", lastSessionFile);
  if (opts["no-semantic-check"]) args.push("--no-semantic-check");
  if (opts["no-write-extraction"]) args.push("--no-write");
  if (opts["advance-watermark-on-no-write"]) args.push("--advance-watermark-on-no-write");

  const result = run("bun", args);
  const phase = {
    command: summarizeCommand(result),
    handoff: null,
  };
  const handoff = parseHandoff(result.stdout || "");
  if (handoff.ok) {
    phase.handoff = {
      status: handoff.status,
      summary: handoff.summary,
      stats: handoff.stats,
    };
  }
  setExtractionPhase(targetSession, phase);
  const runKey = extractionRunKey(targetSession);
  if (result.status !== 0 || !handoff.ok || !handoff.isOk) {
    const reason = handoff.ok ? handoff.summary : (result.stderr || result.stdout || result.error || "extract-runner failed");
    const text = "error (" + String(reason).slice(0, 160) + ")";
    if (!allActiveSessions) summary.extraction = text;
    summary.warnings.push(result.stderr || result.stdout || result.error || "extract-runner failed");
    await patchState({
      ["subagentRuns." + runKey]: { status: "failed", label: labelPrefix + "-extract-" + sanitizeLabelPart(targetSession), session: targetSession, reason },
    });
    return text;
  }

  const stats = handoff.stats || {};
  const iso = localIso();
  const patches = {
    ["lastExtraction." + targetSession]: iso,
    ["subagentRuns." + runKey]: {
      status: "ok",
      label: labelPrefix + "-extract-" + sanitizeLabelPart(targetSession),
      session: targetSession,
      facts: stats.facts_written ?? 0,
      skipped: stats.facts_skipped_dedup ?? 0,
      sessions: stats.sessions_processed ?? 0,
      watermark: stats.new_watermark ?? null,
      dryRun: Boolean(stats.dry_run),
      watermarkAdvanced: stats.watermark_advanced ?? true,
    },
  };
  if (stats.last_session_file) patches["lastSessionExtracted." + targetSession] = stats.last_session_file;
  await patchState(patches);

  const prev = stats.previous_watermark ?? "?";
  const next = stats.new_watermark ?? "?";
  const facts = stats.facts_written ?? 0;
  const planned = stats.facts_planned ?? 0;
  const skipped = stats.facts_skipped_dedup ?? 0;
  const sessions = stats.sessions_processed ?? 0;
  const text = stats.dry_run
    ? `dry-run (${planned} planned, ${skipped} skipped, ${sessions} sessions, ${prev}->${next}${stats.watermark_advanced ? "" : ", watermark not advanced"})`
    : `ok (${facts} facts, ${skipped} skipped, ${sessions} sessions, ${prev}->${next})`;
  if (!allActiveSessions) summary.extraction = text;
  return text;
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
    summary.phases.synthesis = { status: "skipped", reason: "not Monday" };
    return;
  }
  const state = await readJson(statePath, DEFAULT_STATE);
  if (state.lastWeeklySynthesis === monday) {
    summary.synthesis = "skipped (already ran this week)";
    summary.phases.synthesis = { status: "skipped", reason: "already ran this week", week: monday };
    return;
  }
  const result = run("bun", [scriptPath("rebuild-summaries.js"), "--apply-decay", "--json"]);
  const stats = parseLastJsonLine(result.stdout);
  summary.phases.synthesis = { command: summarizeCommand(result), week: monday, stats };
  if (result.status === 0) {
    await patchState({
      lastWeeklySynthesis: monday,
      "subagentRuns.hb-synthesis": {
        status: "ok",
        label: labelPrefix + "-synthesis",
        entitiesScanned: stats?.entitiesScanned ?? null,
        updated: stats?.updated ?? null,
        unchanged: stats?.unchanged ?? null,
        skipped: stats?.skipped ?? null,
        errors: stats?.errors ?? null,
        hot: stats?.hot ?? null,
        warm: stats?.warm ?? null,
        coldIncluded: stats?.coldIncluded ?? null,
        coldExcluded: stats?.coldExcluded ?? null,
      },
    });
    summary.synthesis = formatSynthesisStats(stats);
  } else {
    summary.synthesis = "error (rebuild-summaries failed)";
    summary.warnings.push(result.stderr || result.stdout || result.error || "rebuild-summaries failed");
  }
}

async function runDomains() {
  const registry = join(workspace, "memory", "domains", "registry.json");
  if (!existsSync(registry)) {
    summary.domains = "skipped (no registry)";
    summary.phases.domains = { status: "skipped", reason: "no registry" };
    return;
  }
  let scan;
  try {
    scan = scanDomains({ workspace });
  } catch (err) {
    const reason = err && err.stack ? err.stack : String(err);
    summary.domains = "error (domain scan failed)";
    summary.phases.domains = { status: "error", error: reason };
    summary.warnings.push(reason);
    await patchState({
      "subagentRuns.hb-domains": {
        status: "failed",
        label: labelPrefix + "-domains",
        reason: "domain scan failed",
      },
    });
    return;
  }
  await patchState({
    lastDomainScan: localIso(),
    "subagentRuns.hb-domains": {
      status: "ok",
      label: labelPrefix + "-domains",
      mode: "scan-only",
      registered: scan.registered,
      checked: scan.checked,
      missing: scan.missing,
      stale: scan.stale,
      due: scan.due,
      overdue: scan.overdue,
      alerts: scan.alerts.length,
    },
  });
  summary.domains = formatDomainScanSummary(scan);
  summary.phases.domains = { status: "ok", mode: "scan-only", scan };

  if (!opts["domains-write"]) return;

  const selectedDomain = opts.domain || null;
  const handoffFile = opts["domains-handoff-file"] || null;
  if (!selectedDomain) {
    summary.domains += "; write skipped (no --domain)";
    summary.phases.domains.write = { status: "skipped", reason: "no --domain" };
    return;
  }
  if (!handoffFile) {
    summary.domains += "; write skipped (no --domains-handoff-file)";
    summary.phases.domains.write = { status: "skipped", reason: "no --domains-handoff-file", domain: selectedDomain };
    return;
  }

  const selected = scan.domains.find((domain) => domain.name === selectedDomain);
  if (!selected) {
    const reason = "domain not registered: " + selectedDomain;
    summary.domains += "; write error (" + reason + ")";
    summary.phases.domains.write = { status: "error", reason };
    summary.warnings.push(reason);
    await patchState({ "subagentRuns.hb-domains.status": "failed" });
    return;
  }
  if (!selected.enabled) {
    const reason = "domain disabled: " + selectedDomain;
    summary.domains += "; write skipped (" + reason + ")";
    summary.phases.domains.write = { status: "skipped", reason, domain: selectedDomain };
    return;
  }

  let handoff;
  try {
    const raw = await readFile(resolve(handoffFile), "utf8");
    handoff = parseHandoff(raw);
    if (!handoff.ok) throw new Error(handoff.error || "invalid handoff");
    if (handoff.type !== "HB-DOMAINS") throw new Error("expected HB-DOMAINS handoff, got " + handoff.type);
    if (!handoff.isOk) throw new Error("domains handoff status is " + handoff.status + ": " + handoff.summary);
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    summary.domains += "; write error (" + reason + ")";
    summary.phases.domains.write = { status: "error", reason, domain: selectedDomain };
    summary.warnings.push(reason);
    await patchState({ "subagentRuns.hb-domains.status": "failed" });
    return;
  }

  try {
    const applied = await applyDomainWriteHandoff(handoff, {
      workspace,
      statePath,
      now: localIso(),
      dryRun: Boolean(opts["domains-dry-run"]),
      selectedDomain,
      commandRunner,
      scriptsDir: scriptDir,
    });
    await patchState({
      lastDomainScan: localIso(),
      "subagentRuns.hb-domains": {
        status: "ok",
        label: labelPrefix + "-domains",
        mode: opts["domains-dry-run"] ? "write-dry-run" : "write",
        domain: applied.domain,
        runId: applied.runId,
        changed: applied.changed,
        idempotent: applied.idempotent,
        appendedEntries: applied.appendedEntries ?? 0,
        promotedFacts: applied.promotedFacts ?? 0,
        proposedDecisionChanges: applied.proposedDecisionChanges ?? 0,
      },
    });
    summary.domains += "; write " + applied.status + " (" + applied.domain + ", changed " + (applied.changed ? "yes" : "no") + ")";
    summary.phases.domains.write = { status: applied.status, result: applied };
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    summary.domains += "; write error (" + reason + ")";
    summary.phases.domains.write = { status: "error", reason, domain: selectedDomain };
    summary.warnings.push(reason);
    await patchState({ "subagentRuns.hb-domains.status": "failed" });
  }
}

async function runOllTriggerShell() {
  let state = await readJson(statePath, DEFAULT_STATE);
  const obs = await countPendingObservationCategories();
  const tensions = await countPendingTensions();
  const experiments = await getExperimentTriggerStats();
  const pendingAutoExperiments = await listPendingAutoExperiments();
  const score = obs.friction * 3 + obs.surprise * 2 + obs.pattern;
  const daysSinceRethink = daysSince(state.lastRethink);
  const rethinkReasons = [];
  if (score >= 15) rethinkReasons.push("score>=15");
  if (tensions >= 3) rethinkReasons.push("tensions>=3");
  if (daysSinceRethink >= 14) rethinkReasons.push("lastRethink>=14d");

  const stale = {
    rethink: staleWorker(state, "hb-rethink", "rethinkStartedAt", ollStale.rethinkHours),
    autoresearch: staleWorker(state, "hb-autoresearch", "autoresearchStartedAt", ollStale.autoresearchHours),
    rethink2: staleWorker(state, "hb-rethink2", "rethink2StartedAt", ollStale.rethink2Hours),
  };

  const recovered = [];
  if (opts["recover-stale-oll-locks"]) {
    const recoveryPatches = {};
    if (stale.rethink) {
      recoveryPatches.rethinkInProgress = false;
      recoveryPatches.rethinkStartedAt = null;
      recoveryPatches["subagentRuns.hb-rethink.status"] = "stale-reset";
      recovered.push("hb-rethink");
    }
    if (stale.autoresearch) {
      recoveryPatches.autoresearchInProgress = false;
      recoveryPatches.autoresearchStartedAt = null;
      recoveryPatches.currentExperiment = null;
      recoveryPatches["subagentRuns.hb-autoresearch.status"] = "stale-reset";
      recovered.push("hb-autoresearch");
    }
    if (stale.rethink2) {
      recoveryPatches.rethink2InProgress = false;
      recoveryPatches.rethink2StartedAt = null;
      recoveryPatches["subagentRuns.hb-rethink2.status"] = "stale-reset";
      recovered.push("hb-rethink2");
    }
    if (recovered.length > 0) state = await patchState(recoveryPatches);
  }

  const rethinkInProgress = Boolean(state.rethinkInProgress);
  const autoresearchInProgress = Boolean(state.autoresearchInProgress);
  const rethink2InProgress = Boolean(state.rethink2InProgress) || isWorkerRunning(state, "hb-rethink2");
  const wouldRunRethink = rethinkReasons.length > 0 && !rethinkInProgress && !isWorkerRunning(state, "hb-rethink");
  const wouldRunAutoresearch = pendingAutoExperiments.length > 0 && !autoresearchInProgress && !isWorkerRunning(state, "hb-autoresearch");
  const wouldRunRethink2 = Boolean(state.pendingRethink2) && !rethink2InProgress;
  const details = {
    observations: obs,
    tensions,
    score,
    daysSinceRethink,
    rethink: { wouldRun: wouldRunRethink, inProgress: rethinkInProgress, staleLock: stale.rethink, reasons: rethinkReasons },
    autoresearch: { wouldRun: wouldRunAutoresearch, inProgress: autoresearchInProgress, staleLock: stale.autoresearch, pending: pendingAutoExperiments.length, pendingTotal: experiments.pending, running: experiments.running },
    rethink2: { wouldRun: wouldRunRethink2, inProgress: rethink2InProgress, staleLock: stale.rethink2, pendingExperiment: state.pendingRethink2 || null },
    recovery: { enabled: Boolean(opts["recover-stale-oll-locks"]), recovered },
    spawns: [],
    mode: (opts["spawn-rethink"] || opts["spawn-autoresearch"] || opts["spawn-rethink2"]) ? "spawn-queue" : "report-only",
  };
  summary.phases.oll = details;

  async function maybeQueue(phase, enabled, due, context) {
    if (!enabled || !due) return null;
    const label = spawnLabel(phase);
    const runId = spawnRunId(phase);
    const task = await buildOllTask(phase, { ...context, runId, label, date: today, workspace });
    const request = await queueSpawnRequest({ phase, runId, label, task, experimentId: context.experimentId || null });
    await markOllWorkerQueued({ phase, runId, label, requestPath: request.path, experimentId: context.experimentId || null });
    const queued = { phase, runId, label, requestPath: request.path, experimentId: context.experimentId || null };
    details.spawns.push(queued);
    return queued;
  }

  await maybeQueue("hb-rethink", Boolean(opts["spawn-rethink"]), wouldRunRethink, { observations: obs, tensions, score, daysSinceRethink, reasons: rethinkReasons });
  const nextExperiment = pendingAutoExperiments[0] || null;
  await maybeQueue("hb-autoresearch", Boolean(opts["spawn-autoresearch"]), wouldRunAutoresearch, { experimentId: nextExperiment?.id || null, experiment: nextExperiment });
  await maybeQueue("hb-rethink2", Boolean(opts["spawn-rethink2"]), wouldRunRethink2, { experimentId: state.pendingRethink2 || null });

  const rethinkQueued = details.spawns.some((spawn) => spawn.phase === "hb-rethink");
  const autoresearchQueued = details.spawns.some((spawn) => spawn.phase === "hb-autoresearch");
  const rethink2Queued = details.spawns.some((spawn) => spawn.phase === "hb-rethink2");
  const rethinkText = rethinkQueued ? "rethink queued" : wouldRunRethink ? "rethink due" : rethinkInProgress ? (stale.rethink ? "rethink stale lock" : "rethink in progress") : "rethink idle";
  const autoresearchText = autoresearchQueued ? ("autoresearch queued " + (nextExperiment?.id || "")).trim() : wouldRunAutoresearch ? ("autoresearch due " + pendingAutoExperiments.length) : ("autoresearch pending " + pendingAutoExperiments.length);
  const rethink2Text = rethink2Queued ? ("rethink2 queued " + state.pendingRethink2) : wouldRunRethink2 ? ("rethink2 pending " + state.pendingRethink2) : rethink2InProgress ? (stale.rethink2 ? "rethink2 stale lock" : "rethink2 in progress") : "rethink2 idle";
  summary.oll = `score ${score} (${obs.friction}f/${obs.surprise}s/${obs.pattern}p), tensions ${tensions}; ${rethinkText}; ${autoresearchText}; ${rethink2Text}`;
  if (recovered.length > 0) summary.oll += "; recovered " + recovered.join(",");
}

async function runMaintenance() {
  const validateArgs = [scriptPath("validate.js")];
  if (!opts["no-fix"]) validateArgs.push("--fix");
  validateArgs.push("--agent-id", agentId);

  const validate = run("bun", validateArgs);

  // Regenerate derived facts-active.md (BEFORE qmd update, so qmd picks it up).
  // Закрывает backburner "QMD индексирует *.md, а не items.json" (см. v3.3 §3.5).
  const deriveFacts = run("node", [scriptPath("derive-facts.js")]);

  const qmdCommand = qmdCommandName();
  const qmdUpdate = run(qmdCommand, qmdCommandArgs("update"));
  const qmdEmbed = opts["no-embed"]
    ? { status: 0, stdout: "skipped", stderr: "", error: null, command: "qmd embed skipped", signal: null, elapsedMs: 0 }
    : run(qmdCommand, qmdCommandArgs("embed"), { timeoutMs: Math.max(timeoutMs, 600000) });

  summary.phases.maintenance = {
    validate: summarizeCommand(validate),
    deriveFacts: summarizeCommand(deriveFacts),
    qmdUpdate: summarizeCommand(qmdUpdate),
    qmdEmbed: summarizeCommand(qmdEmbed),
  };

  summary.maintenance = [
    validate.status === 0 ? "validate ok" : "validate error",
    deriveFacts.status === 0 ? "derive-facts ok" : "derive-facts error",
    qmdUpdate.status === 0 ? "qmd update ok" : "qmd update error",
    opts["no-embed"] ? "qmd embed skipped" : (qmdEmbed.status === 0 ? "qmd embed ok" : "qmd embed error"),
  ].join("; ");

  for (const result of [validate, deriveFacts, qmdUpdate, qmdEmbed]) {
    if (result.status !== 0) summary.warnings.push(result.stderr || result.stdout || result.error || result.command + " failed");
  }
}

function qmdCommandArgs(command) {
  const qmd = config.qmd || {};
  const args = [];
  if (qmd.index) args.push("--index", String(qmd.index));
  args.push(command);
  let collections = Array.isArray(qmd.collections) ? qmd.collections : [];
  if (qmd.autoDiscoverCollections) {
    const discovered = discoverQmdCollections();
    if (discovered.length) {
      const merged = new Set(collections);
      for (const name of discovered) merged.add(name);
      collections = Array.from(merged);
    }
  }
  for (const collection of collections) {
    if (collection) args.push("-c", String(collection));
  }
  return args;
}

function discoverQmdCollections() {
  const qmd = config.qmd || {};
  if (!qmd.index) return [];
  const command = String(qmd.command || "qmd");
  const proc = spawnSync(command, ["--index", String(qmd.index), "collection", "list", "--format", "cli"], {
    encoding: "utf8",
    timeout: 30000,
  });
  if (proc.status !== 0) {
    summary.warnings.push("qmd collection list failed; falling back to engram.json qmd.collections");
    return [];
  }
  return parseQmdCollectionList(String(proc.stdout || ""));
}

/**
 * Parse the `--format cli` output of `qmd collection list` into an array of
 * collection names. Extracted from discoverQmdCollections so it can be
 * unit-tested without mocking child_process.spawnSync.
 */
function parseQmdCollectionList(stdout) {
  const names = [];
  const re = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*\(qmd:\/\/[^)]+\/\)/gm;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    names.push(m[1]);
  }
  return names;
}

function qmdCommandName() {
  return String(config.qmd?.command || "qmd");
}

async function writeReport(targetSession = session, extractionText = summary.extraction) {
  const result = run("bun", [
    scriptPath("heartbeat-report.js"),
    "--session", targetSession,
    "--date", today,
    "--extraction", extractionText,
    "--synthesis", summary.synthesis,
    "--domains", summary.domains,
    "--oll", summary.oll,
    "--maintenance", summary.maintenance,
  ]);
  if (allActiveSessions) {
    if (!summary.phases.reports) summary.phases.reports = {};
    summary.phases.reports[targetSession] = { command: summarizeCommand(result) };
  } else {
    summary.phases.report = { command: summarizeCommand(result) };
  }
  if (result.status !== 0) summary.warnings.push(result.stderr || result.stdout || result.error || "heartbeat-report failed");
}

function normalizeActiveSession(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (!raw.startsWith("agent:")) return raw;
  const parts = raw.split(":");
  if (parts.length >= 3) return parts.slice(2).join(":");
  return raw;
}

function getActiveSessions(initialState) {
  const explicit = opts["active-sessions"]
    ? String(opts["active-sessions"]).split(",")
    : (Array.isArray(initialState.activeSessions) ? initialState.activeSessions : []);
  const source = explicit.length > 0 ? explicit : [session];
  const seen = new Set();
  const result = [];
  for (const entry of source) {
    const normalized = normalizeActiveSession(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.length > 0 ? result : [session];
}

async function main() {
  const initial = await readJson(statePath, DEFAULT_STATE);
  const activeSessions = allActiveSessions ? getActiveSessions(initial) : [session];
  summary.activeSessions = activeSessions;
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
    const extractionReports = {};
    for (const targetSession of activeSessions) {
      await ensureDailyNote(targetSession);
      const rotateCheck = run("bun", [scriptPath("rotate-notes.js"), "--check", "--session", targetSession]);
      if (rotateCheck.status !== 0 && rotateCheck.status !== 10) {
        summary.warnings.push(rotateCheck.stderr || rotateCheck.stdout || `rotate check failed (${targetSession})`);
      }
      if (rotateCheck.status === 10) summary.warnings.push(`rotation needed but not performed by runner MVP (${targetSession})`);
      extractionReports[targetSession] = await runExtraction(targetSession);
    }
    if (allActiveSessions) {
      summary.extraction = activeSessions.map((targetSession) => `${targetSession}: ${extractionReports[targetSession]}`).join("; ");
    }
    await runSynthesis();
    await runDomains();
    await runOllTriggerShell();
    if (opts["skip-maintenance"]) {
      summary.maintenance = "skipped";
      summary.phases.maintenance = { status: "skipped", reason: "skip-maintenance" };
    } else {
      await runMaintenance();
    }
    for (const targetSession of activeSessions) {
      await writeReport(targetSession, extractionReports[targetSession]);
    }
  } finally {
    await patchState({ heartbeatInProgress: false, heartbeatLockedAt: null });
  }

  console.log(JSON.stringify({ status: summary.warnings.length ? "ok_with_warnings" : "ok", summary }, null, 2));
  console.log("HEARTBEAT_OK");
}

// Run main() only when this file is the entry point (e.g. `bun
// scripts/heartbeat-runner.js`). When imported from a test harness, skip
// the side-effect and expose testable helpers below.
if (import.meta.main) {
  main().catch(async (err) => {
    summary.warnings.push(err && err.stack ? err.stack : String(err));
    await patchState({ heartbeatInProgress: false, heartbeatLockedAt: null }).catch(() => {});
    console.error(JSON.stringify({ status: "error", summary }, null, 2));
    process.exit(1);
  });
}

// Test exports. Available when the module is imported (not running as the
// entry point). Production behaviour is unchanged.
if (!import.meta.main) {
  globalThis.__engramHeartbeatRunnerExports = {
    parseQmdCollectionList,
    discoverQmdCollections,
    qmdCommandArgs,
  };
}
