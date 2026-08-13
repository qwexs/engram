#!/usr/bin/env bun
/**
 * heartbeat-runner.js
 *
 * Deterministic Engram heartbeat runner for cron jobs.
 * Handles mechanical state/report/index work without relying on an LLM to
 * interpret HEARTBEAT.md correctly.
 */

import { existsSync, mkdirSync, renameSync, statSync, readdirSync } from "node:fs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  isLegacyOllAdmissionEnabled,
  loadEngramConfig,
  resolveSubagentModel,
  resolveWorkspaceId,
} from "./config.js";
import { parseHandoff, applyHandoff, defaultHandoffHandlers } from "./process-handoff-core.js";
import { applyDomainWriteHandoff, scanDomains, formatDomainScanSummary, shouldInlineNoopDailyNote, DEFAULT_MIN_DAILY_BYTES_FOR_SPAWN } from "./domains-runner.js";
import { findLatestDailyNoteWithContent, parseMarkdownSections, buildAutoDerivedStatus, hasAutoDerivedMarker } from "./_lib/auto-derive-status.js";
import { runtimeSpawnLabel, transitionSpawnRecord } from "./spawn-lifecycle.js";
import { runWorkspaceQmdMaintenance } from "../src/qmd/maintenance-adapter.ts";
import { legacyKgMutationState } from "./_lib/kg-v3-authority.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));

const DEFAULT_STATE = {
  lastDailyNoteCreated: {},
  lastChecks: { email: null, calendar: null, weather: null },
  heartbeatInProgress: false,
  heartbeatLockedAt: null,
  lastExtraction: {},
  lastSessionExtracted: {},
  lastDomainScan: null,
  pendingObservations: 0,
  pendingTensions: 0,
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
    "  --force-rethink-once     Bootstrap path: queue hb-rethink even if no trigger is due",
    "                           (bypasses the 7-day gate and post-synthesis check for this tick only).",
    "  --apply-low-risk-proposals",
    "                           After rethink handoff apply: audit [PROPOSAL:low-risk] blocks from the latest",
    "                           done/ rethink handoff into workspace/ops/heartbeat-spawns/rethink-applied-*.json",
    "                           (audit trail only — does not auto-edit source files).",
    "  --spawn-hb-domains-write Queue hb-domains-write per due domain (writes to memory/domains/<slug>/{changelog,status}.md via HB-DOMAINS HANDOFF).",
    "  --hb-domains-write-batch-size <n>",
    "                           Max hb-domains-write subagents to queue per tick. Default: 1 (sequential to avoid provider rate limits). Other phases stay parallel.",
    "  --[no-]hb-domains-write-apply",
    "                           Apply pending handoff files from workspace/ops/heartbeat-spawns/handoff/*.md",
    "                           (written by previous ticks' hb-domains-write subagents). Default: enabled.",
    "                           Disable for tests/debug via --no-hb-domains-write-apply.",,
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
// Legacy fallback remains only until the explicit fleet migration in PR 2.
// New configs always carry workspace.id; all spawned labels use this semantic
// identity instead of a caller-controlled prefix.
const workspaceId = resolveWorkspaceId(workspace, { allowAgentFallback: true });
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
const ollStatePath = join(workspace, "memory-state", "oll", "state.json");

const summary = {
  workspace,
  workspaceId,
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
  // crypto.randomUUID() guarantees uniqueness across processes and clock
  // skew; Date.now()+pid could collide on concurrent runs (e.g., parallel
  // cron ticks, manual + cron overlap).
  const tmp = path + ".tmp-" + randomUUID();
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

async function markWorkerCompleteIfCurrent(phase, runId) {
  const latest = await readJson(statePath, DEFAULT_STATE);
  const current = latest.subagentRuns?.[phase];
  if (!current || current.runId !== runId) return false;
  current.status = "ok";
  current.completedAt = localIso();
  mkdirSync(dirname(statePath), { recursive: true });
  await atomicWrite(statePath, JSON.stringify(latest, null, 2) + "\n");
  return true;
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

function summarizeTypedQmdResult(result) {
  const invocation = result.operationRecord?.invocation;
  return {
    command: invocation ? [invocation.executable, ...invocation.argv].join(" ") : "qmd",
    status: result.exitCode,
    signal: result.signal,
    elapsedMs: result.operationRecord?.elapsedMs ?? 0,
    error: result.spawnError?.message ?? (result.timedOut ? "timed out" : null),
    stdoutPreview: result.stdout ? String(result.stdout).trim().slice(0, 500) : "",
    stderrPreview: result.stderr ? String(result.stderr).trim().slice(0, 500) : "",
  };
}

function parseLastJsonLine(output) {
  const lines = String(output || "").trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* keep scanning */ }
  }
  return null;
}

function describeQmdEmbedOutcome(result, embedResult, skipped = false) {
  if (skipped) return { label: "qmd embed skipped", warning: null };
  if (result?.status !== 0) return { label: "qmd embed error", warning: null };
  if (embedResult?.schema !== "qmd.embed.v1") return { label: "qmd embed ok", warning: null };
  if (embedResult.skippedReason === "lock-held") {
    return { label: "qmd embed skipped (index lock held)", warning: null };
  }
  if (embedResult.status === "partial" || Number(embedResult.errors || 0) > 0) {
    return {
      label: `qmd embed partial (${embedResult.documentsEmbedded ?? 0} docs; ${embedResult.pendingAfter ?? "?"} pending; ${embedResult.errors ?? 0} errors)`,
      warning: `qmd embed completed partially: ${embedResult.errors ?? 0} errors, ${embedResult.pendingAfter ?? "unknown"} pending`,
    };
  }
  return {
    label: `qmd embed ok (${embedResult.documentsEmbedded ?? 0} docs; ${embedResult.pendingAfter ?? "?"} pending)`,
    warning: null,
  };
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

// Rethink is now a phase inside runSynthesis() — fires right after synthesis
// completes on Monday. No separate gate or proximity check needed.

// Audit-only: extract [PROPOSAL:low-risk] / [PROPOSAL:human-review] blocks from
// the most recent rethink handoff in done/. Does NOT edit source files.
function extractRethinkProposalBlocks(text) {
  const source = String(text || "");
  const lowRisk = [];
  const humanReview = [];
  const re = /\[PROPOSAL:(low-risk|human-review)\]([^\[]*(?:\[(?!PROPOSAL:)[^\[]*)*)/gi;
  let match;
  while ((match = re.exec(source)) !== null) {
    const kind = String(match[1] || "").toLowerCase();
    const body = String(match[0] || "").trim();
    if (!body) continue;
    if (kind === "low-risk") lowRisk.push(body);
    else if (kind === "human-review") humanReview.push(body);
  }
  return { lowRisk, humanReview };
}

async function applyLowRiskProposalsAudit() {
  const spawnsDir = join(workspace, "workspace", "ops", "heartbeat-spawns");
  const doneDir = join(spawnsDir, "done");
  const empty = { lowRisk: 0, humanReview: 0, sourcePath: null, source: null };
  if (!existsSync(doneDir)) {
    console.log(`[rethink-proposals] found 0 low-risk, 0 human-review`);
    return empty;
  }
  let files;
  try {
    files = await readdir(doneDir);
  } catch (err) {
    summary.warnings.push("rethink-proposals audit: cannot read done/: " + (err && err.message ? err.message : String(err)));
    console.log(`[rethink-proposals] found 0 low-risk, 0 human-review`);
    return empty;
  }
  // Prefer HB-RETHINK handoffs; fall back to any *.md by mtime/name.
  const mdFiles = files.filter((f) => typeof f === "string" && f.endsWith(".md"));
  if (mdFiles.length === 0) {
    console.log(`[rethink-proposals] found 0 low-risk, 0 human-review`);
    return empty;
  }
  const scored = [];
  for (const file of mdFiles) {
    const filePath = join(doneDir, file);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(filePath).mtimeMs || 0;
    } catch {
      mtimeMs = 0;
    }
    let text = "";
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const isRethink = /HB-RETHINK/i.test(text) || /rethink/i.test(file);
    scored.push({ file, filePath, mtimeMs, text, isRethink });
  }
  scored.sort((a, b) => {
    if (a.isRethink !== b.isRethink) return a.isRethink ? -1 : 1;
    return b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file);
  });
  const latest = scored.find((s) => s.isRethink) || scored[0];
  if (!latest) {
    console.log(`[rethink-proposals] found 0 low-risk, 0 human-review`);
    return empty;
  }
  const { lowRisk, humanReview } = extractRethinkProposalBlocks(latest.text);
  const stamp = localIso().replace(/[:.]/g, "-").replace(/[^+\dT-]/g, "");
  const outName = `rethink-applied-${stamp}.json`;
  const outPath = join(spawnsDir, outName);
  const record = {
    createdAt: localIso(),
    sourceHandoff: latest.file,
    sourcePath: latest.filePath,
    lowRiskCount: lowRisk.length,
    humanReviewCount: humanReview.length,
    lowRisk,
    humanReview,
    note: "audit-only — proposals recorded, source files not modified",
  };
  try {
    mkdirSync(spawnsDir, { recursive: true });
    await writeFile(outPath, JSON.stringify(record, null, 2) + "\n", "utf8");
  } catch (err) {
    summary.warnings.push("rethink-proposals audit: write failed: " + (err && err.message ? err.message : String(err)));
  }
  console.log(`[rethink-proposals] found ${lowRisk.length} low-risk, ${humanReview.length} human-review`);
  return {
    lowRisk: lowRisk.length,
    humanReview: humanReview.length,
    source: latest.file,
    sourcePath: latest.filePath,
    auditPath: outPath,
  };
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

async function getPendingObservationsFull() {
  const dir = join(workspace, "workspace", "ops", "observations");
  const index = await readJsonIfExists(join(dir, "index.json"), { observations: [] });
  const full = [];
  for (const id of Array.isArray(index.observations) ? index.observations : []) {
    const obs = await readJsonIfExists(join(dir, `${id}.json`), null);
    if (!obs || obs.status !== "pending") continue;
    full.push(obs);
  }
  return full;
}

async function getPendingTensionsFull() {
  const dir = join(workspace, "workspace", "ops", "tensions");
  const index = await readJsonIfExists(join(dir, "index.json"), { tensions: [] });
  const full = [];
  for (const id of Array.isArray(index.tensions) ? index.tensions : []) {
    const tension = await readJsonIfExists(join(dir, `${id}.json`), null);
    if (!tension || tension.status !== "pending") continue;
    full.push(tension);
  }
  return full;
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
  return Boolean(run && (run.status === "running" || run.status === "queued" || run.status === "spawned"));
}

function staleWorker(state, phase, legacyStartedAtKey, ttlHours) {
  const legacyFlag = phase === "hb-rethink"
    ? Boolean(state.rethinkInProgress)
    : phase === "hb-autoresearch"
      ? Boolean(state.autoresearchInProgress)
      : phase === "hb-rethink2"
        ? Boolean(state.rethink2InProgress)
        : false;
  if (!legacyFlag && !isWorkerRunning(state, phase)) return false;
  const startedAt = state.subagentRuns?.[phase]?.startedAt || (legacyStartedAtKey ? state[legacyStartedAtKey] : null) || null;
  return hoursSince(startedAt) > ttlHours;
}

function spawnLabel(phase) {
  return workspaceId + "-" + phase;
}

function spawnRunId(phase) {
  // A full UUID is the global correlation key. Phase/date remain separate
  // structured fields and are never encoded into the run identity.
  void phase;
  return randomUUID();
}

// Normalize a filesystem path to forward-slash form for storage in JSON state.
// `readFileSync` / `readdirSync` accept forward slashes on both Windows and
// POSIX, but backslashes are POSIX-incompatible. Storing POSIX paths keeps
// heartbeat-state.json portable. (See audits/engram-path-audit-2026-06-15.md.)
function toPosixPath(p) {
  return typeof p === "string" ? p.replace(/\\/g, "/") : p;
}

async function queueSpawnRequest({ phase, runId, label, task, experimentId = null, model = resolveSubagentModel(workspace, phase) }) {
  const dir = join(workspace, "workspace", "ops", "heartbeat-spawns");
  mkdirSync(dir, { recursive: true });
  const payload = { workspaceId, runId, phase, label, runtimeLabel: runtimeSpawnLabel(label, runId), model, cleanup: "delete", status: "queued", createdAt: localIso(), experimentId, task };
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
  const templateByPhase = { "hb-rethink": "HB-RETHINK.md", "hb-autoresearch": "HB-AUTORESEARCH.md", "hb-rethink2": "HB-RETHINK2.md", "hb-domains-write": "HB-DOMAINS-WRITE.md" };
  let template = await readReferenceTemplate(templateByPhase[phase]);

  // Substitute {{key}} placeholders from context. Anything not in context
  // is left as the raw placeholder so the LLM subagent can see what's
  // expected and reason about it (rather than silently dropping data).
  // Возник из hb-rethink 2026-06-15: queued task contained unfilled
  // `{{session}}`, `{{weighted_score}}` etc. — subagent received broken
  // context block. Now runner fills the values it actually has.
  if (phase === "hb-rethink") {
    // observations can be an array (full body) or an object (counts only).
    // The HB-RETHINK.md template expects full observation objects for analysis.
    // If we only have counts, surface a note telling the subagent to read files.
    const observationsJson = (() => {
      if (Array.isArray(context.observations)) return JSON.stringify(context.observations, null, 2);
      // Counts-only fallback (legacy path)
      return JSON.stringify(context.observations ?? {}, null, 2);
    })();
    // tensions can be an array (full body) or a count (number).
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
      .replace(/\{\{observations_json\}\}/g, observationsJson)
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
  } else if (phase === "hb-domains-write") {
    template = template
      .replace(/\{\{domain\}\}/g, String(context.domain ?? ""))
      .replace(/\{\{domain_type\}\}/g, String(context.domainType ?? ""))
      .replace(/\{\{session_key\}\}/g, String(context.sessionKey ?? ""))
      .replace(/\{\{date\}\}/g, context.date ?? new Date().toISOString().slice(0, 10))
      .replace(/\{\{workspace\}\}/g, String(context.workspace ?? workspace))
      .replace(/\{\{registry_path\}\}/g, String(context.registryPath ?? join(workspace, "memory", "domains", "registry.json")))
      .replace(/\{\{domains_root\}\}/g, String(context.domainsRoot ?? join(workspace, "memory", "domains")))
      .replace(/\{\{agent_id\}\}/g, String(context.agentId ?? agentDir))
      .replace(/\{\{scan_summary\}\}/g, JSON.stringify(context.scanResult ?? {}, null, 2))
      .replace(/\{\{daily_note_path\}\}/g, String(context.dailyNotePath ?? ""));
  }

  return [
    template.trim(),
    "",
    "## Runner Context",
    "Use this run id in the final handoff when a Run-Id field is supported.",
    "```json",
    JSON.stringify(context, null, 2),
    "```",
    "",
    "## Completion Contract (MANDATORY — LAST INSTRUCTION)",
    "First persist the complete handoff block to the exact absolute `handoffPath` above.",
    "Then your entire final assistant response must be exactly the single token below, with no Markdown, heading, explanation, or handoff text:",
    "ANNOUNCE_SKIP",
  ].join("\n");
}

async function markOllWorkerQueued({ phase, runId, label, runtimeLabel, model, requestPath, experimentId = null }) {
  const patches = {
    ["subagentRuns." + phase]: { status: "queued", workspaceId, phase, label, runtimeLabel, runId, model, requestPath, startedAt: localIso() },
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
  if (result.status !== 0 || !handoff.ok || !handoff.isOk) {
    const reason = handoff.ok ? handoff.summary : (result.stderr || result.stdout || result.error || "extract-runner failed");
    const text = "error (" + String(reason).slice(0, 160) + ")";
    if (!allActiveSessions) summary.extraction = text;
    summary.warnings.push(result.stderr || result.stdout || result.error || "extract-runner failed");
    return text;
  }

  const stats = handoff.stats || {};
  const iso = localIso();
  const patches = {
    ["lastExtraction." + targetSession]: iso,
  };
  if (stats.last_session_file) patches["lastSessionExtracted." + targetSession] = stats.last_session_file;
  await patchState(patches);

  const prev = stats.previous_watermark ?? "?";
  const next = stats.new_watermark ?? "?";
  const sessions = stats.sessions_processed ?? 0;
  const text = stats.dry_run
    ? `cursor dry-run (${sessions} sessions, ${prev}->${next}${stats.watermark_advanced ? "" : ", watermark not advanced"})`
    : `cursor ok (${sessions} sessions, ${prev}->${next})`;
  if (!allActiveSessions) summary.extraction = text;
  return text;
}

async function runSynthesis() {
  summary.synthesis = "retired (KG v3 fleet cutover)";
  summary.phases.synthesis = { status: "retired", reason: "legacy v2 synthesis entrypoint removed" };
}

// applyDomainHandoffs: scan workspace/ops/heartbeat-spawns/handoff/*.md for handoff
// blocks written by previous ticks' hb-domains-write subagents, parse them, and
// apply via applyDomainWriteHandoff (in-process, no subprocess). This closes the
// ISS-9 architectural gap where subagents wrote changelog files directly via
// file tools and the runner never advanced lastCheckedAt, so domains stayed due
// forever. Per-tick: runs BEFORE scanDomains so the scan reflects freshly
// applied state. Idempotent: applyDomainWriteHandoff checks appliedRunIds, so
// retries are no-ops. On success: file is moved to done/. On error: file stays
// for the next tick (warning added to summary).
const HB_DOMAINS_APPLY_FLAG = "hb-domains-write-apply";
// shouldApplyDomainHandoffs: drain-queue gate for hb-domains-write handoff
// files in workspace/ops/heartbeat-spawns/handoff/*.md. Always on by
// default — draining is the natural counterpart to spawning, and
// suppressing it when no spawn happens leaves handoffs to pile up
// indefinitely (regression fixed in ISS-14: previously gated on
// --spawn-hb-domains-write, which the cron tick never sets). Idempotent
// in either case (applyDomainHandoffs no-ops on an empty handoff/ dir).
// --no-hb-domains-write-apply disables for tests/debug. Exported for tests.
function shouldApplyDomainHandoffs(opts = {}) {
  return !opts["no-" + HB_DOMAINS_APPLY_FLAG];
}
async function applyDomainHandoffs() {
  const spawnsDir = join(workspace, "workspace", "ops", "heartbeat-spawns");
  const handoffDir = join(spawnsDir, "handoff");
  const doneDir = join(spawnsDir, "done");
  let applied = 0;
  let failed = 0;
  if (!existsSync(handoffDir)) return { applied, failed };
  let files;
  try {
    files = await readdir(handoffDir);
  } catch (err) {
    summary.warnings.push("hb-domains-write apply: cannot read " + handoffDir + ": " + (err && err.message ? err.message : String(err)));
    return { applied, failed };
  }
  files = files.filter((f) => typeof f === "string" && f.endsWith(".md")).sort();
  if (files.length === 0) return { applied, failed };
  try { mkdirSync(doneDir, { recursive: true }); } catch { /* ignore */ }
  for (const file of files) {
    const filePath = join(handoffDir, file);
    let text = "";
    try {
      text = await readFile(filePath, "utf8");
    } catch (err) {
      failed++;
      summary.warnings.push("hb-domains-write apply: cannot read " + file + ": " + (err && err.message ? err.message : String(err)));
      continue;
    }
    const parsed = parseHandoff(text);
    if (!parsed.ok) {
      failed++;
      summary.warnings.push("hb-domains-write apply: " + file + " — " + (parsed.error || "parse failed"));
      continue;
    }
    if (parsed.type !== "HB-DOMAINS") {
      failed++;
      summary.warnings.push("hb-domains-write apply: " + file + " — wrong handoff type " + parsed.type);
      continue;
    }
    try {
      const handlers = defaultHandoffHandlers({
        workspace,
        session: "main",
        date: today,
        domainsWrite: true,
      });
      const result = await applyHandoff(parsed, handlers);
      if (result.status === "error") {
        failed++;
        summary.warnings.push("hb-domains-write apply: " + file + " — " + (result.error || "apply error"));
        continue;
      }
      const destPath = join(doneDir, file);
      try {
        renameSync(filePath, destPath);
      } catch (err) {
        failed++;
        summary.warnings.push("hb-domains-write apply: " + file + " — moved to done failed: " + (err && err.message ? err.message : String(err)));
        continue;
      }
      const runId = file.slice(0, -3);
      const lifecycle = await transitionSpawnRecord({
        spawnsDir,
        runId,
        phase: "hb-domains-write",
        status: "done",
        handoffPath: destPath,
      });
      if (!lifecycle.ok && lifecycle.error !== "record-not-found") {
        summary.warnings.push("hb-domains-write lifecycle: " + file + " — " + lifecycle.error);
      }
      await markWorkerCompleteIfCurrent("hb-domains-write", runId);
      applied++;
    } catch (err) {
      failed++;
      summary.warnings.push("hb-domains-write apply: " + file + " — " + (err && err.message ? err.message : String(err)));
    }
  }
  return { applied, failed };
}

// applyRethinkHandoffs: scan workspace/ops/heartbeat-spawns/handoff/*.md for
// HB-RETHINK handoff blocks written by previous ticks' hb-rethink subagents,
// parse them, apply state patches (lastRethink, rethinkScore, etc.), and move
// to done/. Mirrors applyDomainHandoffs() but for rethink handoffs.
// Closes the architectural gap where rethink subagents wrote handoff files
// but the runner never processed them — handoffs piled up in handoff/ forever.
async function applyRethinkHandoffs() {
  const spawnsDir = join(workspace, "workspace", "ops", "heartbeat-spawns");
  const handoffDir = join(spawnsDir, "handoff");
  const doneDir = join(spawnsDir, "done");
  let applied = 0;
  let failed = 0;
  if (!isLegacyOllAdmissionEnabled(workspace)) {
    return { applied, failed, skipped: true, reason: "legacy OLL application disabled by nightly cutover" };
  }
  if (!existsSync(handoffDir)) return { applied, failed };
  let files;
  try {
    files = await readdir(handoffDir);
  } catch (err) {
    summary.warnings.push("hb-rethink apply: cannot read " + handoffDir + ": " + (err && err.message ? err.message : String(err)));
    return { applied, failed };
  }
  files = files.filter((f) => typeof f === "string" && f.endsWith(".md")).sort();
  if (files.length === 0) return { applied, failed };
  try { mkdirSync(doneDir, { recursive: true }); } catch { /* ignore */ }
  for (const file of files) {
    const filePath = join(handoffDir, file);
    let text = "";
    try {
      text = await readFile(filePath, "utf8");
    } catch (err) {
      failed++;
      summary.warnings.push("hb-rethink apply: cannot read " + file + ": " + (err && err.message ? err.message : String(err)));
      continue;
    }
    const parsed = parseHandoff(text);
    if (!parsed.ok) {
      // Not a rethink handoff — skip (might be domains-write)
      continue;
    }
    if (parsed.type !== "HB-RETHINK" && parsed.type !== "HB-RETHINK2" && parsed.type !== "HB-AUTORESEARCH") {
      // Not ours — leave for another handler
      continue;
    }
    try {
      const handlers = defaultHandoffHandlers({
        workspace,
        session: "main",
        date: today,
      });
      const result = await applyHandoff(parsed, handlers);
      if (result.status === "error") {
        failed++;
        summary.warnings.push("hb-rethink apply: " + file + " — " + (result.error || "apply error"));
        continue;
      }
      // Capture alerts from handoff apply so the cron agent can forward them.
      // Without this, business-language reports from rethink are silently dropped.
      if (Array.isArray(result.alerts) && result.alerts.length > 0) {
        if (!summary.rethinkAlerts) summary.rethinkAlerts = [];
        for (const alert of result.alerts) {
          if (alert && alert.trim()) summary.rethinkAlerts.push(alert.trim());
        }
      }
      if (parsed.type === "HB-RETHINK") {
        // Clear rethinkInProgress on successful apply
        await patchState({
          rethinkInProgress: false,
          rethinkStartedAt: null,
          lastRethink: localIso(),
          "subagentRuns.hb-rethink.status": "ok",
        });
      } else if (parsed.type === "HB-RETHINK2") {
        // Clear rethink2InProgress on successful apply
        await patchState({
          rethink2InProgress: false,
          rethink2StartedAt: null,
          pendingRethink2: null,
          "subagentRuns.hb-rethink2.status": "ok",
        });
      } else if (parsed.type === "HB-AUTORESEARCH") {
        // applyAutoresearchHandoff in process-handoff-core.js already
        // sets autoresearchInProgress=false; we just update subagentRuns.
        await patchState({
          "subagentRuns.hb-autoresearch.status": "ok",
        });
      }
      const destPath = join(doneDir, file);
      try {
        renameSync(filePath, destPath);
      } catch (err) {
        failed++;
        summary.warnings.push("hb-rethink apply: " + file + " — moved to done failed: " + (err && err.message ? err.message : String(err)));
        continue;
      }
      const runId = file.slice(0, -3);
      const phaseByType = {
        "HB-RETHINK": "hb-rethink",
        "HB-RETHINK2": "hb-rethink2",
        "HB-AUTORESEARCH": "hb-autoresearch",
      };
      const lifecycle = await transitionSpawnRecord({
        spawnsDir,
        runId,
        phase: phaseByType[parsed.type],
        status: "done",
        handoffPath: destPath,
      });
      if (!lifecycle.ok && lifecycle.error !== "record-not-found") {
        summary.warnings.push("hb-rethink lifecycle: " + file + " — " + lifecycle.error);
      }
      applied++;
    } catch (err) {
      failed++;
      summary.warnings.push("hb-rethink apply: " + file + " — " + (err && err.message ? err.message : String(err)));
    }
  }
  return { applied, failed };
}

async function runDomains() {
  const registry = join(workspace, "memory", "domains", "registry.json");
  if (!existsSync(registry)) {
    summary.domains = "skipped (no registry)";
    summary.phases.domains = { status: "skipped", reason: "no registry" };
    return null;
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
    return null;
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
  // Always return the scan so runOllTriggerShell can use due/stale signals
  // to queue hb-domains-write subagents. If --domains-write is passed,
  // continue into the manual write-mode path below.
  if (!opts["domains-write"]) return scan;

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
        suppressedPromotions: applied.suppressedPromotions ?? 0,
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
  return scan;
}

async function runOllTriggerShell({ domainScan = null } = {}) {
  const legacyAdmission = isLegacyOllAdmissionEnabled(workspace);
  let state = await readJson(statePath, DEFAULT_STATE);
  const obs = legacyAdmission ? await countPendingObservationCategories() : { friction: 0, surprise: 0, pattern: 0 };
  const observationsFull = legacyAdmission ? await getPendingObservationsFull() : [];
  const tensions = legacyAdmission ? await countPendingTensions() : 0;
  const tensionsFull = legacyAdmission ? await getPendingTensionsFull() : [];
  const experiments = legacyAdmission ? await getExperimentTriggerStats() : { pending: 0, running: 0 };
  const pendingAutoExperiments = legacyAdmission ? await listPendingAutoExperiments() : [];
  const score = obs.friction * 3 + obs.surprise * 2 + obs.pattern;
  const daysSinceRethink = daysSince(state.lastRethink);
  const rethinkReasons = [];
  if (score >= 15) rethinkReasons.push("score>=15");
  if (tensions >= 3) rethinkReasons.push("tensions>=3");
  // Weekly cadence: rethink fires as a phase after weekly synthesis.
  // runSynthesis() runs on Mondays and sets lastWeeklySynthesis = today.
  // When that flag matches today, synthesis just completed in this tick —
  // fire rethink right after. daysSinceRethink >= 7 prevents double-fire
  // if synthesis runs twice (e.g. state reset). --force-rethink-once
  // bypasses both checks for bootstrap on fresh installs.
  const synthesisRanThisTick = state.lastWeeklySynthesis === today;
  const weeklyCadenceDue = daysSinceRethink >= 7 && synthesisRanThisTick;
  if (weeklyCadenceDue) rethinkReasons.push("post-synthesis (weekly)");
  if (opts["force-rethink-once"] && !weeklyCadenceDue) {
    rethinkReasons.push("force-rethink-once");
  }

  const stale = {
    rethink: staleWorker(state, "hb-rethink", "rethinkStartedAt", ollStale.rethinkHours),
    autoresearch: staleWorker(state, "hb-autoresearch", "autoresearchStartedAt", ollStale.autoresearchHours),
    rethink2: staleWorker(state, "hb-rethink2", "rethink2StartedAt", ollStale.rethink2Hours),
    domainsWrite: staleWorker(state, "hb-domains-write", null, ollStale.rethinkHours),
  };

  const recovered = [];
  if (opts["recover-stale-oll-locks"]) {
    const recoveryPatches = {};
    const staleRecords = [];
    if (legacyAdmission && stale.rethink) {
      recoveryPatches.rethinkInProgress = false;
      recoveryPatches.rethinkStartedAt = null;
      recoveryPatches["subagentRuns.hb-rethink.status"] = "stale-reset";
      staleRecords.push({ phase: "hb-rethink", runId: state.subagentRuns?.["hb-rethink"]?.runId });
      recovered.push("hb-rethink");
    }
    if (legacyAdmission && stale.autoresearch) {
      recoveryPatches.autoresearchInProgress = false;
      recoveryPatches.autoresearchStartedAt = null;
      recoveryPatches.currentExperiment = null;
      recoveryPatches["subagentRuns.hb-autoresearch.status"] = "stale-reset";
      staleRecords.push({ phase: "hb-autoresearch", runId: state.subagentRuns?.["hb-autoresearch"]?.runId });
      recovered.push("hb-autoresearch");
    }
    if (legacyAdmission && stale.rethink2) {
      recoveryPatches.rethink2InProgress = false;
      recoveryPatches.rethink2StartedAt = null;
      recoveryPatches["subagentRuns.hb-rethink2.status"] = "stale-reset";
      staleRecords.push({ phase: "hb-rethink2", runId: state.subagentRuns?.["hb-rethink2"]?.runId });
      recovered.push("hb-rethink2");
    }
    if (stale.domainsWrite) {
      recoveryPatches["subagentRuns.hb-domains-write.status"] = "stale-reset";
      staleRecords.push({ phase: "hb-domains-write", runId: state.subagentRuns?.["hb-domains-write"]?.runId });
      recovered.push("hb-domains-write");
    }
    if (recovered.length > 0) {
      state = await patchState(recoveryPatches);
      const spawnsDir = join(workspace, "workspace", "ops", "heartbeat-spawns");
      for (const record of staleRecords) {
        if (!record.runId) continue;
        const lifecycle = await transitionSpawnRecord({
          spawnsDir,
          runId: record.runId,
          phase: record.phase,
          status: "failed",
          error: "stale-missing-handoff",
        });
        if (!lifecycle.ok && lifecycle.error !== "record-not-found") {
          summary.warnings.push("spawn lifecycle stale recovery: " + record.runId + " — " + lifecycle.error);
        }
      }
    }
  }

  const rethinkInProgress = Boolean(state.rethinkInProgress);
  const autoresearchInProgress = Boolean(state.autoresearchInProgress);
  const rethink2InProgress = Boolean(state.rethink2InProgress) || isWorkerRunning(state, "hb-rethink2");
  // Guard: if we just recovered a stale lock for rethink, don't immediately
  // re-spawn on the same tick. The stale lock means the previous run failed
  // to produce a handoff — re-spawning instantly creates an infinite loop.
  // The next tick (30 min later) will re-evaluate and spawn if still due.
  const rethinkJustRecovered = recovered.includes("hb-rethink");
  const wouldRunRethink = legacyAdmission && rethinkReasons.length > 0 && !rethinkInProgress && !isWorkerRunning(state, "hb-rethink") && !rethinkJustRecovered;
  const autoresearchJustRecovered = recovered.includes("hb-autoresearch");
  const wouldRunAutoresearch = legacyAdmission && pendingAutoExperiments.length > 0 && !autoresearchInProgress && !isWorkerRunning(state, "hb-autoresearch") && !autoresearchJustRecovered;
  const rethink2JustRecovered = recovered.includes("hb-rethink2");
  const wouldRunRethink2 = legacyAdmission && Boolean(state.pendingRethink2) && !rethink2InProgress && !rethink2JustRecovered;
  const details = legacyAdmission ? {
      observations: obs,
      tensions,
      score,
      daysSinceRethink,
      rethink: { wouldRun: wouldRunRethink, inProgress: rethinkInProgress, staleLock: stale.rethink, reasons: rethinkReasons },
      autoresearch: { wouldRun: wouldRunAutoresearch, inProgress: autoresearchInProgress, staleLock: stale.autoresearch, pending: pendingAutoExperiments.length, pendingTotal: experiments.pending, running: experiments.running },
      rethink2: { wouldRun: wouldRunRethink2, inProgress: rethink2InProgress, staleLock: stale.rethink2, pendingExperiment: state.pendingRethink2 || null },
      recovery: { enabled: Boolean(opts["recover-stale-oll-locks"]), recovered },
      legacyAdmission: "enabled",
      skipped: false,
      spawns: [],
      mode: (opts["spawn-rethink"] || opts["spawn-autoresearch"] || opts["spawn-rethink2"] || opts["spawn-hb-domains-write"]) ? "spawn-queue" : "report-only",
    } : {
      legacyAdmission: "disabled",
      skipped: true,
      reason: "nightly coordinator owns managed adaptation",
      spawns: [],
      mode: Boolean(opts["spawn-hb-domains-write"]) ? "domains-write-only" : "heartbeat-only",
    };
  summary.phases.oll = details;

  async function maybeQueue(phase, enabled, due, context) {
    if (!enabled || !due) return null;
    const label = spawnLabel(phase);
    const runId = spawnRunId(phase);
    const handoffPath = toPosixPath(join(workspace, "workspace", "ops", "heartbeat-spawns", "handoff", runId + ".md"));
    const task = await buildOllTask(phase, { ...context, runId, label, date: today, workspace, handoffPath });
    const request = await queueSpawnRequest({ phase, runId, label, task, experimentId: context.experimentId || null });
    await markOllWorkerQueued({ phase, runId, label, runtimeLabel: request.payload.runtimeLabel, model: request.payload.model, requestPath: request.path, experimentId: context.experimentId || null });
    const queued = { workspaceId, phase, runId, label, runtimeLabel: request.payload.runtimeLabel, model: request.payload.model, requestPath: request.path, experimentId: context.experimentId || null };
    details.spawns.push(queued);
    return queued;
  }

  await maybeQueue("hb-rethink", legacyAdmission && Boolean(opts["spawn-rethink"]), wouldRunRethink, { observations: observationsFull, tensions: tensionsFull, score, daysSinceRethink, reasons: rethinkReasons, agentId });
  const nextExperiment = pendingAutoExperiments[0] || null;
  await maybeQueue("hb-autoresearch", legacyAdmission && Boolean(opts["spawn-autoresearch"]), wouldRunAutoresearch, { experimentId: nextExperiment?.id || null, experiment: nextExperiment });
  await maybeQueue("hb-rethink2", legacyAdmission && Boolean(opts["spawn-rethink2"]), wouldRunRethink2, { experimentId: state.pendingRethink2 || null });

  // hb-domains-write: queue one spawn per due domain. We pass the per-domain
  // context (domain name, type, bound sessionKey, daily note path) so the
  // spawned subagent can read today's events for the bound topic and write
  // a curated changelog entry. Per-domain spawning is safer than batched
  // (no base-hash collision between domains). cadenceDays=2 default means
  // a typical topic with no recent updates fires after ~2 idle days.
  let deferred = 0;
  let suppressedCount = 0;
  let inlinedNoop = 0;
  // ISS-9 A5: cold-start backlog observability. When many domains are due for
  // the first time (lastRunMs == null) the runner can only spawn one per tick
  // (batch-size 1). Surface this so operators know to expect a long catch-up.
  //
  // ISS-9 hygiene follow-up: also exclude domains already suppressed by a
  // recent inline-noop via lastCheckedAt. Without this, a neverRun domain
  // becomes structurally due+overdue forever (lastRun never gets set by the
  // noop path) and the warning repeats on every tick — turning a one-off
  // cold-start signal into persistent noise. The filter surfaces only the
  // domains that actually need a subagent spawn to make progress.
  const neverRunDomainCount = (domainScan && Array.isArray(domainScan.domains))
    ? domainScan.domains.filter((d) => d && d.enabled && d.due && d.overdue && !d.suppressedByLastCheckedAt).length
    : 0;
  if (Boolean(opts["spawn-hb-domains-write"]) && neverRunDomainCount >= 3) {
    summary.warnings.push("hb-domains-write backlog " + neverRunDomainCount + " (cold-start; batch-size " + (parseInt(opts["hb-domains-write-batch-size"], 10) || 1) + " per tick; expect ~" + neverRunDomainCount + " ticks to drain)");
  }
  if (Boolean(opts["spawn-hb-domains-write"]) && domainScan && Array.isArray(domainScan.domains)) {
    // Read registry to get topic bindings (not exposed by scanDomains result).
    // Best-effort: if registry is missing or malformed, skip with a warning.
    let registryTopics = {};
    try {
      const registryData = await readJson(join(workspace, "memory", "domains", "registry.json"), { domains: {} });
      for (const [name, cfg] of Object.entries(registryData.domains || {})) {
        if (cfg && cfg.topic && cfg.topic.chatId && cfg.topic.topicId) {
          const absChatId = String(cfg.topic.chatId).replace(/^-/, "");
          registryTopics[name] = "telegram-group--" + absChatId + "-topic-" + cfg.topic.topicId;
        }
      }
    } catch (err) {
      summary.warnings.push("hb-domains-write: failed to read registry: " + (err && err.message ? err.message : String(err)));
    }
    const batchSize = parseInt(opts["hb-domains-write-batch-size"], 10) || 1;
    const dueList = domainScan.domains.filter((d) => d && d.enabled && d.due);
    suppressedCount = dueList.filter((d) => d.suppressedByLastCheckedAt).length;
    let activeList = dueList.filter((d) => !d.suppressedByLastCheckedAt);
    let workerDeferred = 0;
    if (isWorkerRunning(state, "hb-domains-write")) {
      workerDeferred = activeList.length;
      activeList = [];
    }

    // Inline noop apply: for topic-thread domains whose bound-session daily note
    // has an empty "## Events" section, advance lastCheckedAt via
    // applyDomainWriteHandoff directly without spawning a subagent. This
    // closes the gap where process-handoff is never invoked for hb-domains-write
    // spawns in production (subagents write changelog files directly, but
    // domainRuns.lastCheckedAt is never updated, so suppression never fires).
    // Disabled by --no-inline-noop (used by tests and debugging).
    const inlineNoopEnabled = !opts["no-inline-noop"];
    for (const due of activeList) {
      if (!inlineNoopEnabled) break;
      const sessionKey = registryTopics[due.name];
      if (!sessionKey) continue;
      if (due.type !== "topic-thread") continue;
      const dailyPath = notePathFor(sessionKey);
      // ISS-9 fix A6: pre-spawn daily-note peek. Use the exported helper so
      // the same logic can be unit-tested in domains-runner.test.ts and the
      // A6 spec (size threshold + key-words from decisions.md) lives in one
      // place.
      const minBytes = Number(opts["min-daily-bytes-for-spawn"] || DEFAULT_MIN_DAILY_BYTES_FOR_SPAWN);
      const decisionsPath = join(workspace, "memory", "domains", due.name, "decisions.md");
      const isEmpty = shouldInlineNoopDailyNote({ dailyPath, decisionsPath, minBytes });
      if (!isEmpty) continue;
      const noopHandoff = {
        ok: true,
        isOk: true,
        type: "HB-DOMAINS",
        body: [
          "=== HB-DOMAINS HANDOFF ===",
          "Status: ok",
          "Summary: no domain-relevant events in " + sessionKey + " on " + today,
          "Domain: " + due.name,
          "Run-Id: inline-noop-" + today + "-" + randomUUID().slice(0, 8),
          "Changelog-Entries: []",
          "Promotions: []",
          "=== END ===",
        ].join("\n"),
        summary: "noop",
      };
      try {
        const applied = await applyDomainWriteHandoff(noopHandoff, {
          workspace,
          statePath: join(workspace, "memory", "heartbeat-state.json"),
          now: new Date().toISOString(),
          dryRun: false,
          selectedDomain: due.name,
        });
        if (applied && applied.status === "noop") {
          inlinedNoop++;
          summary.warnings.push("hb-domains-write: inline noop applied for " + due.name);
        }
      } catch (err) {
        summary.warnings.push("hb-domains-write: inline noop failed for " + due.name + ": " + (err && err.message ? err.message : String(err)));
      }
    }
    if (inlinedNoop > 0) {
      // Re-scan after inlining so suppression is reflected in activeList.
      const rescanned = await scanDomains({ workspace, dryRun: true });
      const stillDue = (rescanned && Array.isArray(rescanned.domains)) ? rescanned.domains.filter((d) => d && d.enabled && d.due && !d.suppressedByLastCheckedAt) : [];
      suppressedCount = dueList.filter((d) => d.suppressedByLastCheckedAt).length + inlinedNoop;
      activeList = stillDue;
    }

    deferred = workerDeferred + Math.max(0, activeList.length - batchSize);
    for (const due of activeList.slice(0, batchSize)) {
      const sessionKey = registryTopics[due.name] || null;
      const dailyNotePath = sessionKey ? notePathFor(sessionKey) : "";
      await maybeQueue("hb-domains-write", true, true, {
        domain: due.name,
        domainType: due.type,
        sessionKey,
        dailyNotePath,
        scanResult: { name: due.name, type: due.type, due: due.due, overdue: due.overdue, ageDays: due.ageDays, files: due.files },
        registryPath: join(workspace, "memory", "domains", "registry.json"),
        domainsRoot: join(workspace, "memory", "domains"),
        agentId: agentId,
        workspace,
      });
    }
  }

  const rethinkQueued = details.spawns.some((spawn) => spawn.phase === "hb-rethink");
  const autoresearchQueued = details.spawns.some((spawn) => spawn.phase === "hb-autoresearch");
  const rethink2Queued = details.spawns.some((spawn) => spawn.phase === "hb-rethink2");
  const domainsWriteQueued = details.spawns.filter((spawn) => spawn.phase === "hb-domains-write").length;
  const domainsWriteDueCount = domainScan && Array.isArray(domainScan.domains) ? domainScan.domains.filter((d) => d && d.enabled && d.due).length : 0;
  let domainsWriteText = domainsWriteQueued > 0 ? ("domains-write queued " + domainsWriteQueued) : (domainsWriteDueCount > 0 && Boolean(opts["spawn-hb-domains-write"]) ? ("domains-write due " + domainsWriteDueCount) : (domainsWriteDueCount > 0 ? ("domains-write due " + domainsWriteDueCount + " (flag off)") : "domains-write idle"));
  if (deferred > 0) domainsWriteText += "; domains-write deferred " + deferred;
  if (inlinedNoop > 0) domainsWriteText += "; domains-write inlined-noop " + inlinedNoop;
  if (suppressedCount > 0) domainsWriteText += "; domains-write suppressed " + suppressedCount + " (no events, recently checked)";
  const applyStats = (summary.phases && summary.phases["hb-domains-write-apply"]) || null;
  if (applyStats && (applyStats.applied > 0 || applyStats.failed > 0)) {
    domainsWriteText += "; domains-write applied " + applyStats.applied + (applyStats.failed > 0 ? " (failed " + applyStats.failed + ")" : "");
  }
  const rethinkText = rethinkQueued ? "rethink queued" : wouldRunRethink ? "rethink due" : rethinkInProgress ? (stale.rethink ? "rethink stale lock" : "rethink in progress") : "rethink idle";
  const autoresearchText = autoresearchQueued ? ("autoresearch queued " + (nextExperiment?.id || "")).trim() : wouldRunAutoresearch ? ("autoresearch due " + pendingAutoExperiments.length) : ("autoresearch pending " + pendingAutoExperiments.length);
  const rethink2Text = rethink2Queued ? ("rethink2 queued " + state.pendingRethink2) : wouldRunRethink2 ? ("rethink2 pending " + state.pendingRethink2) : rethink2InProgress ? (stale.rethink2 ? "rethink2 stale lock" : "rethink2 in progress") : "rethink2 idle";
  summary.oll = legacyAdmission
    ? `score ${score} (${obs.friction}f/${obs.surprise}s/${obs.pattern}p), tensions ${tensions}; ${rethinkText}; ${autoresearchText}; ${rethink2Text}; ${domainsWriteText}`
    : `legacy OLL skipped (nightly coordinator owner); ${domainsWriteText}`;
  if (recovered.length > 0) summary.oll += "; recovered " + recovered.join(",");
}

async function runMaintenance() {
  const legacyMutation = legacyKgMutationState(workspace);
  const validateArgs = [scriptPath("validate.js")];
  if (!opts["no-fix"] && legacyMutation.allowed) validateArgs.push("--fix");
  validateArgs.push("--agent-id", agentId);

  const validate = run("bun", validateArgs);

  // 2026-07-05: auto-seed observation из validate warnings/errors (closes
  // P2 OLL bootstrap chicken-and-egg loop). Закрывает дыру, где validate.js
  // выдаёт warnings, но никто их не конвертирует в workspace/ops/observations/*.json,
  // поэтому observations directory stays lastId=0.
  // Throttle: 1 auto-seed / 24h через heartbeat-state.json.lastAutoSeedAt.
  // Skip если 0 errors И 0 warnings. Skip если --skip-maintenance.
  if (!opts["skip-maintenance"]) {
    await maybeAutoSeedFromValidate(validate);
  }

  const qmdMaintenance = await runWorkspaceQmdMaintenance({
    workspace,
    skipEmbed: Boolean(opts["no-embed"]),
    timeoutMs: Math.max(timeoutMs, 600000),
  });
  const qmdUpdate = qmdMaintenance.update;
  const qmdEmbed = qmdMaintenance.embed;
  const qmdEmbedResult = qmdEmbed?.structuredData ?? null;
  const qmdEmbedOutcome = qmdMaintenance.status === "delegated"
    ? { label: "qmd maintenance delegated", warning: null }
    : describeQmdEmbedOutcome(
      qmdEmbed ? { status: qmdEmbed.exitCode } : { status: 0 },
      qmdEmbedResult,
      Boolean(opts["no-embed"]),
    );

  summary.phases.maintenance = {
    validate: summarizeCommand(validate),
    adapter: { mode: qmdMaintenance.mode, status: qmdMaintenance.status },
    qmdUpdate: qmdUpdate ? summarizeTypedQmdResult(qmdUpdate) : null,
    qmdEmbed: qmdEmbed ? {
      ...summarizeTypedQmdResult(qmdEmbed),
      ...(qmdEmbedResult?.schema === "qmd.embed.v1" ? { result: qmdEmbedResult } : {}),
    } : null,
  };

  summary.maintenance = [
    validate.status === 0 ? "validate ok" : "validate error",
    "legacy projection retired",
    qmdMaintenance.status === "delegated"
      ? "qmd scheduler owns index"
      : (qmdUpdate?.ok ? "qmd update ok" : "qmd update error"),
    qmdEmbedOutcome.label,
  ].join("; ");

  for (const result of [validate]) {
    if (result.status !== 0) summary.warnings.push(result.stderr || result.stdout || result.error || result.command + " failed");
  }
  if (qmdMaintenance.error) summary.warnings.push(qmdMaintenance.error.message);
  if (qmdEmbedOutcome.warning) summary.warnings.push(qmdEmbedOutcome.warning);
}

// 2026-07-05: P2 — auto-seed observation из validate.js warnings/errors.
// 2026-07-26: Filtered per hb-rethink 2026-07-16 proposal — only seed for
// ERRORS (❌), or warnings (⚠️) >= 5. Known-benign warnings are ignore-listed.
// Skip observations whose text starts with "Fixed:" — post-mortems, not friction.
// Trigger: validate.js produced signal AND no auto-seed in last 24h.
// Создаёт friction observation через memory-observe.js, помечает lastAutoSeedAt.
// Закрывает OLL bootstrap chicken-and-egg: пустой observations dir не блокирует OLL,
// потому что validate.js warnings становятся signal.

// Known-benign validate.js warnings that should never auto-seed observations.
const VALIDATE_BENIGN_WARNINGS = [
  /Session dir ".+" not in heartbeat-state\.json/i,
  /Could not locate OpenClaw hooks directory/i,
  /Skill hooks dir missing/i,
  /Last run \d+m ago \(expected ≤\d+m\)/i,  // heartbeat timing — operational, not friction
  /Payload lightContext is \w+, expected true/i,
  /Schedule unexpected:/i,
];

async function maybeAutoSeedFromValidate(validateResult) {
  if (!validateResult) return;
  if (!isLegacyOllAdmissionEnabled(workspace)) return;
  const out = `${validateResult.stdout ?? ""}\n${validateResult.stderr ?? ""}`;
  const errorCount = (out.match(/❌/g) || []).length;
  const allWarnLines = out.split("\n").filter((l) => /⚠️/.test(l));
  // Filter out known-benign warnings
  const realWarnLines = allWarnLines.filter((l) => {
    return !VALIDATE_BENIGN_WARNINGS.some((re) => re.test(l));
  });
  const warnCount = realWarnLines.length;

  // Only seed for errors, or >= 5 non-benign warnings
  if (errorCount === 0 && warnCount < 5) return;

  const state = await readJson(statePath, {});
  const last = state.lastAutoSeedAt ? new Date(state.lastAutoSeedAt).getTime() : 0;
  const sinceMs = Date.now() - last;
  if (sinceMs < 24 * 60 * 60 * 1000) return; // throttle 24h

  // Берём первые 3 distinct error/non-benign warning строки для контекста
  const sample = realWarnLines
    .concat(out.split("\n").filter((l) => /❌/.test(l)))
    .slice(0, 3)
    .map((l) => l.replace(/^.*?(❌|⚠️)\s*/, "$1 "))
    .join(" | ")
    .replace(/[❌⚠️]/g, "")
    .trim()
    .slice(0, 400);

  const text = `validate.js выдал ${errorCount} errors и ${warnCount} non-benign warnings: ${sample}`;
  const obsResult = run("bun", [
    scriptPath("memory-observe.js"),
    "--observation", text,
    "--category", "friction",
    "--description", "auto-seeded из heartbeat maintenance (validate errors/non-benign warnings)",
  ]);

  if (obsResult.status === 0) {
    await patchState({ lastAutoSeedAt: nowIso() });
    summary.warnings.push(`auto-seeded friction observation from validate (${errorCount}e/${warnCount}w)`);
  } else {
    summary.warnings.push(`auto-seed from validate failed: exit ${obsResult.status}`);
  }
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

function discoverSessionDirs() {
  // Scan memory/agent-{id}/ for session directories that exist on disk
  // but are not yet tracked in heartbeat-state.activeSessions.
  // Skips subagent-* and cron-*-run-* (ephemeral, not tracked by design).
  const agentRoot = join(workspace, "memory", agentDir);
  if (!existsSync(agentRoot)) return [];
  const skipPatterns = [/^subagent-/, /^cron-.+-run-/];
  const discovered = [];
  let entries;
  try {
    entries = readdirSync(agentRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (skipPatterns.some((p) => p.test(entry.name))) continue;
    discovered.push(entry.name);
  }
  return discovered;
}

function planSessionReconciliation(initialState, onDiskSessions) {
  const existing = new Set(
    (Array.isArray(initialState.activeSessions) ? initialState.activeSessions : []).map(normalizeActiveSession).filter(Boolean)
  );
  const tracked = new Set(
    Object.keys(initialState.lastDailyNoteCreated || {}).map(normalizeActiveSession).filter(Boolean)
  );
  const onDisk = Array.from(new Set((onDiskSessions || []).map(normalizeActiveSession).filter(Boolean)));
  const toActivate = onDisk.filter((name) => !existing.has(name));
  const toTrack = onDisk.filter((name) => !tracked.has(name));
  const patches = {};
  if (toActivate.length > 0) patches["activeSessions"] = [...existing, ...toActivate];
  for (const name of toTrack) patches["lastDailyNoteCreated." + name] = null;
  return { added: toActivate, toTrack, patches };
}

async function reconcileActiveSessions(initialState) {
  // Auto-discover session dirs on disk and merge them into activeSessions
  // and lastDailyNoteCreated. This makes --all-active-sessions work without
  // requiring a manual init.js run after new sessions appear.
  if (!allActiveSessions) return { added: [], activeSessions: getActiveSessions(initialState) };
  const plan = planSessionReconciliation(initialState, discoverSessionDirs());
  if (Object.keys(plan.patches).length === 0) {
    return { added: [], activeSessions: getActiveSessions(initialState) };
  }
  const updated = await patchState(plan.patches);
  return { added: plan.added, activeSessions: getActiveSessions(updated) };
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

// Silent-thread check: signal-only soft alert when an active topic-thread
// session has had no significant event in the daily note for 4+ hours.
// The agent decides whether to backfill; this never auto-writes.
// Markers covered: topic-thread (chatId:topicId) + DM peer (accountId:id).
async function runSilentThreadCheck(activeSessions) {
  const SILENT_THRESHOLD_HOURS = 4;
  const registryPath = join(workspace, "memory", "domains", "registry.json");
  const registry = await readJsonIfExists(registryPath, { domains: {} });
  const topicSessions = new Map();
  for (const [slug, entry] of Object.entries(registry.domains || {})) {
    if (!entry || !entry.topic) continue;
    const sessionKey =
      "telegram-group--" + String(entry.topic.chatId).replace(/^-/, "") +
      "-topic-" + entry.topic.topicId;
    topicSessions.set(sessionKey, slug);
  }
  const peerSessions = new Map();
  for (const [slug, entry] of Object.entries(registry.domains || {})) {
    if (!entry || !Array.isArray(entry.peers)) continue;
    for (const peer of entry.peers) {
      if (!peer || peer.kind !== "direct") continue;
      const sessionKey =
        "telegram-" + (peer.accountId || "default") + "-direct-" + peer.id;
      peerSessions.set(sessionKey, slug);
    }
  }
  const silent = [];
  const checked = [];
  for (const sessionKey of activeSessions) {
    const slug = topicSessions.get(sessionKey) || peerSessions.get(sessionKey);
    if (!slug) continue;
    checked.push(sessionKey);
    const notePath = join(workspace, "memory", agentDir, sessionKey, today + ".md");
    let lastEventMs = null;
    let reason = "stale-events";
    try {
      if (!existsSync(notePath)) {
        silent.push({ sessionKey, slug, hoursSince: 24, reason: "no-daily-note" });
        continue;
      }
      const content = await readFile(notePath, "utf8");
      const lines = content.split(/\r?\n/);
      let inEvents = false;
      let lastEventLine = null;
      for (const line of lines) {
        if (/^## Events/.test(line)) { inEvents = true; continue; }
        if (inEvents && /^## /.test(line)) break;
        if (inEvents && /^-\s/.test(line)) lastEventLine = line;
      }
      if (!lastEventLine) {
        silent.push({ sessionKey, slug, hoursSince: 24, reason: "no-events-today" });
        continue;
      }
      const m = lastEventLine.match(/\[(\d{1,2}):(\d{2})\]/);
      if (m) {
        const hh = Number(m[1]);
        const mm = Number(m[2]);
        const now = new Date();
        const eventLocal = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          hh,
          mm
        );
        lastEventMs = eventLocal.getTime();
        if (lastEventMs > now.getTime() + 60000) lastEventMs -= 86400000;
      } else {
        lastEventMs = Date.now() - 86400000;
        reason = "no-timestamp";
      }
    } catch {
      silent.push({ sessionKey, slug, hoursSince: 24, reason: "read-failed" });
      continue;
    }
    const hoursSince = Math.floor((Date.now() - lastEventMs) / 3600000);
    if (hoursSince >= SILENT_THRESHOLD_HOURS) {
      silent.push({ sessionKey, slug, hoursSince, reason });
    }
  }
  return {
    thresholdHours: SILENT_THRESHOLD_HOURS,
    checked: checked.length,
    silent,
  };
}

// refreshAutoDerivedStatus: для каждого topic-thread домена проверяет,
// что status.md с маркером `<!-- auto-derived from ... -->` не устарел
// относительно latest daily note. Если daily note свежее — перегенерит.
// Никогда не трогает agent-curated status.md (без маркера).
//
// Это Layer 2 из дизайна «cold-start + heartbeat maintenance»:
//   - Layer 1 (cold-start, add-domain.js) — заполняет status.md при создании домена
//   - Layer 2 (эта функция) — поддерживает актуальность по мере накопления daily notes
//
// Маркер `<!-- auto-derived ... -->` — критичный invariant:
//   - Agent-curated status.md → НЕТ маркера → никогда не перетирается
//   - Auto-derived → ЕСТЬ маркер → обновляется при drift
async function refreshAutoDerivedStatus() {
  const registryPath = join(workspace, "memory", "domains", "registry.json");
  const registry = await readJsonIfExists(registryPath, { domains: {} });
  let refreshed = 0;
  let skipped = 0;
  let errors = 0;
  const detail = [];

  for (const [slug, entry] of Object.entries(registry.domains || {})) {
    if (!entry || entry.type !== "topic-thread" || !entry.topic) continue;

    const statusPath = join(workspace, "memory", "domains", slug, "status.md");
    if (!existsSync(statusPath)) {
      skipped++;
      continue;
    }

    let statusContent;
    try {
      statusContent = await readFile(statusPath, "utf8");
    } catch (err) {
      summary.warnings.push("auto-derive-status: " + slug + " read failed — " + (err && err.message ? err.message : String(err)));
      errors++;
      continue;
    }

    // Agent-curated status.md (без маркера) — никогда не трогаем. Это
    // сознательный design choice: если агент вручную переписал status.md,
    // heartbeat не должен затирать его синтетикой.
    if (!hasAutoDerivedMarker(statusContent)) {
      skipped++;
      continue;
    }

    // Compute sessionDir из registry binding.
    const absChatId = String(entry.topic.chatId).replace(/^-/, "");
    const sessionKey = "telegram-group--" + absChatId + "-topic-" + entry.topic.topicId;
    const sessionDir = join(workspace, "memory", "agent-" + agentId, sessionKey);

    const latest = findLatestDailyNoteWithContent(sessionDir);
    if (!latest) {
      skipped++;
      continue;
    }

    // Drift check: только если daily note свежее status.md.
    let statusMtime;
    let latestMtime;
    try {
      statusMtime = statSync(statusPath).mtimeMs;
      latestMtime = statSync(latest.path).mtimeMs;
    } catch (err) {
      summary.warnings.push("auto-derive-status: " + slug + " stat failed — " + (err && err.message ? err.message : String(err)));
      errors++;
      continue;
    }
    if (statusMtime >= latestMtime) {
      skipped++;
      continue;
    }

    // Regenerate.
    try {
      const latestContent = await readFile(latest.path, "utf-8");
      const sections = parseMarkdownSections(latestContent);
      const derived = buildAutoDerivedStatus(slug, latest.date, today, sections);
      await atomicWrite(statusPath, derived);
      refreshed++;
      detail.push({ slug, source: latest.date, size: latest.size });
    } catch (err) {
      summary.warnings.push("auto-derive-status: " + slug + " write failed — " + (err && err.message ? err.message : String(err)));
      errors++;
    }
  }

  return { refreshed, skipped, errors, detail };
}

async function main() {
  const initial = await readJson(statePath, DEFAULT_STATE);
  // Auto-discover session dirs on disk and reconcile into activeSessions.
  const reconciliation = await reconcileActiveSessions(initial);
  if (reconciliation.added.length > 0) {
    summary.sessionDiscovery = { added: reconciliation.added };
  }
  const activeSessions = allActiveSessions ? reconciliation.activeSessions : [session];
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
    // ISS-10: domain changelog rotation check. Single global call (not
    // per-session) — domains are workspace-scoped. Exits 10 if any domain
    // changelog.md exceeds LINE_THRESHOLD; runner warns but does not auto-
    // rotate (agent must run rotate-notes.js --rotate explicitly, by design
    // — same MVP gate as the per-session daily-note check above).
    const domainsRotateCheck = run("bun", [
      scriptPath("rotate-notes.js"),
      "--check-domains",
      "--domains-root",
      join(workspace, "memory", "domains"),
    ]);
    if (domainsRotateCheck.status === 10) {
      summary.warnings.push("rotation needed for one or more domain changelogs (not performed by runner MVP; run `bun skills/engram/scripts/rotate-notes.js --rotate --file <path> --type changelog` per domain)");
    } else if (domainsRotateCheck.status !== 0) {
      summary.warnings.push(domainsRotateCheck.stderr || domainsRotateCheck.stdout || `domains rotate check failed (status ${domainsRotateCheck.status})`);
    }
    await runSynthesis();
    // Apply pending hb-domains-write handoff files BEFORE scanDomains so the
    // domain scan reflects freshly advanced lastCheckedAt values. Always on
    // by default — see shouldApplyDomainHandoffs() for the rationale and
    // ISS-14 for the regression history. --no-hb-domains-write-apply
    // disables for tests/debug.
    // Apply pending hb-rethink handoff files BEFORE running OLL triggers
    // so rethink state (lastRethink, score) is fresh when deciding whether
    // to queue a new rethink. Mirrors the domains-write apply pattern.
    const rethinkApplyResult = await applyRethinkHandoffs();
    summary.phases = summary.phases || {};
    summary.phases["hb-rethink-apply"] = {
      applied: rethinkApplyResult.applied,
      failed: rethinkApplyResult.failed,
    };
    // Audit trail for rethink proposals (opt-in). Scans latest done/ handoff;
    // does not auto-edit source files.
    if (opts["apply-low-risk-proposals"]) {
      const proposalAudit = await applyLowRiskProposalsAudit();
      summary.phases["rethink-proposals-audit"] = proposalAudit;
    }
    if (shouldApplyDomainHandoffs(opts)) {
      const applyResult = await applyDomainHandoffs();
      summary.phases = summary.phases || {};
      summary.phases["hb-domains-write-apply"] = {
        applied: applyResult.applied,
        failed: applyResult.failed,
      };
    }
    const domainScan = await runDomains();
    const silentThreads = await runSilentThreadCheck(activeSessions);
    summary.phases = summary.phases || {};
    summary.phases.silentThreads = silentThreads;
    if (silentThreads.silent.length > 0) {
      for (const item of silentThreads.silent) {
        summary.warnings.push(
          "silent-thread: " + item.sessionKey +
            " (last event " + item.hoursSince + "h ago, " + item.reason + ")"
        );
      }
    }
    // Layer 2: refresh auto-derived status.md for topic-thread domains
    // whose latest daily note is newer than their status.md. Runs BEFORE
    // runOllTriggerShell so hb-domains-write spawns see fresh status.
    // Runs BEFORE runMaintenance so qmd update picks up the change.
    const autoDerive = await refreshAutoDerivedStatus();
    summary.phases = summary.phases || {};
    summary.phases.autoDeriveStatus = autoDerive;
    if (autoDerive.refreshed > 0) {
      summary.warnings.push(
        "auto-derive-status: refreshed " + autoDerive.refreshed + " (" +
          autoDerive.detail.map((d) => d.slug + " from " + d.source).join(", ") + ")"
      );
    }
    await runOllTriggerShell({ domainScan });
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
    describeQmdEmbedOutcome,
    shouldApplyDomainHandoffs,
    isWorkerRunning,
    staleWorker,
    buildOllTask,
    runtimeSpawnLabel,
    transitionSpawnRecord,
    planSessionReconciliation,
  };
}
