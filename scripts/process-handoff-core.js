#!/usr/bin/env bun

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { getAgentDir } from "./config.js";
import { applyDomainWriteHandoff } from "./domains-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE = process.env.ENGRAM_WORKSPACE || process.cwd() || join(__dirname, "..", "..", "..");
const DEFAULT_STATE = {
  lastDailyNoteCreated: {},
  lastChecks: { email: null, calendar: null, weather: null },
  heartbeatInProgress: false,
  heartbeatLockedAt: null,
  subagentExtraction: false,
  extractionModel: null, // populated from engram.json -> models.default at runtime
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
};

export function parseField(body, name) {
  const m = body.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

function parseJsonField(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

export function parseHandoff(text) {
  const input = String(text ?? "");
  const blockMatch = input.match(/=== (HB-\w+) HANDOFF ===([\s\S]*?)=== END ===/);
  if (!blockMatch) {
    return { ok: false, error: "No handoff block found", preview: input.slice(0, 200).replace(/\n/g, " ") };
  }
  const type = blockMatch[1];
  const body = blockMatch[2];
  const status = parseField(body, "Status") ?? "error";
  const summary = parseField(body, "Summary") ?? "";
  const stats = parseJsonField(parseField(body, "Stats") ?? "{}", {});
  const observations = parseJsonField(parseField(body, "Observations") ?? parseField(body, "Flags") ?? "[]", []);
  const tensions = parseJsonField(parseField(body, "Tensions") ?? "[]", []);
  const alerts = parseJsonField(parseField(body, "Alerts") ?? "[]", []);
  return { ok: true, type, body, status, summary, stats, observations, tensions, alerts, isOk: status.toLowerCase() === "ok" };
}

export function createHandoffContext(options = {}) {
  const workspace = options.workspace || process.env.ENGRAM_WORKSPACE || process.env.CLAWD_WORKSPACE || DEFAULT_WORKSPACE;
  const session = options.session ?? "main";
  const date = options.date ?? new Date().toLocaleDateString("sv-SE");
  const now = options.now ?? new Date().toISOString();
  const scriptsDir = options.scriptsDir ?? __dirname;
  const agentDir = options.agentDir ?? getAgentDir(workspace);
  return {
    workspace, session, date, now, scriptsDir, agentDir,
    statePath: join(workspace, "memory", "heartbeat-state.json"),
    notePath: join(workspace, "memory", agentDir, session, `${date}.md`),
    commandRunner: options.commandRunner ?? runCommand,
    domainsWrite: Boolean(options.domainsWrite),
    domainsDryRun: Boolean(options.domainsDryRun),
    selectedDomain: options.selectedDomain ?? null,
    logs: [],
  };
}

export async function applyHandoff(handoff, handlersOrContext = {}) {
  if (!handoff?.ok) return { status: "error", error: handoff?.error ?? "Invalid handoff", alerts: [], logs: [] };
  const handlers = typeof handlersOrContext[handoff.type] === "function"
    ? handlersOrContext
    : defaultHandoffHandlers(handlersOrContext);
  const handler = handlers[handoff.type];
  if (!handler) return { status: "error", error: `Unknown handoff type: ${handoff.type}`, alerts: [], logs: [] };
  return await handler(handoff);
}

export function defaultHandoffHandlers(context = {}) {
  const ctx = createHandoffContext(context);
  return {
    "HB-EXTRACT": (handoff) => applyExtractHandoff(handoff, ctx),
    "HB-DOMAINS": (handoff) => applyDomainsHandoff(handoff, ctx),
    "HB-SYNTHESIS": (handoff) => applySynthesisHandoff(handoff, ctx),
    "HB-RETHINK": (handoff) => applyRethinkHandoff(handoff, ctx),
    "HB-AUTORESEARCH": (handoff) => applyAutoresearchHandoff(handoff, ctx),
    "HB-RETHINK2": (handoff) => applyRethink2Handoff(handoff, ctx),
  };
}

function result(ctx, handoff, extra = {}) {
  return {
    status: extra.status ?? (handoff.isOk ? "ok" : "error"),
    summary: extra.summary ?? handoff.summary,
    alerts: [...normalizeAlerts(handoff.alerts), ...normalizeAlerts(extra.alerts)],
    logs: [...(ctx.logs ?? []), ...(extra.logs ?? [])],
    details: extra.details ?? {},
    error: extra.error,
  };
}

function log(ctx, line) { ctx.logs.push(line); }
function normalizeAlerts(alerts) {
  if (!Array.isArray(alerts)) return [];
  return alerts.map((alert) => String(alert).replace(/^\[ALERT\]\s*/i, "")).filter(Boolean);
}
function parseWatermarkNum(wm) {
  if (!wm) return 0;
  const m = String(wm).match(/L?(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}
function getCurrentWatermark(notePath) {
  if (!existsSync(notePath)) return 0;
  const content = readFileSync(notePath, "utf-8");
  const matches = [...content.matchAll(/<!--\s*extracted:L(\d+):[^>]*-->/g)];
  if (!matches.length) return 0;
  return parseInt(matches[matches.length - 1][1], 10);
}
function readState(ctx) {
  try {
    const raw = readFileSync(ctx.statePath, "utf-8");
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}
function writeState(ctx, state) {
  mkdirSync(dirname(ctx.statePath), { recursive: true });
  writeFileSync(ctx.statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}
function setPath(obj, dottedPath, value) {
  const keys = dottedPath.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}
function setState(ctx, dottedPath, value) {
  const state = readState(ctx);
  setPath(state, dottedPath, value);
  writeState(ctx, state);
}
function patchState(ctx, mutator) {
  const state = readState(ctx);
  mutator(state);
  writeState(ctx, state);
}
async function runCommand(args, options = {}) {
  const proc = Bun.spawnSync(args, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.input ? new Blob([options.input]) : undefined,
  });
  return {
    ok: proc.success,
    exitCode: proc.exitCode,
    stdout: proc.stdout ? new TextDecoder().decode(proc.stdout) : "",
    stderr: proc.stderr ? new TextDecoder().decode(proc.stderr) : "",
  };
}
async function runScript(ctx, scriptName, args = [], options = {}) {
  const env = { ...process.env, ENGRAM_WORKSPACE: ctx.workspace, ...(options.env ?? {}) };
  const res = await ctx.commandRunner(["bun", join(ctx.scriptsDir, scriptName), ...args], { cwd: ctx.workspace, env, input: options.input });
  if (!res.ok) log(ctx, `[process-handoff] Command failed: ${scriptName} ${args.join(" ")}\n  ${res.stderr || res.stdout || `exit ${res.exitCode}`}`);
  return res.ok;
}
async function updateReport(ctx, flag, value) {
  return await runScript(ctx, "heartbeat-report.js", ["--session", ctx.session, "--date", ctx.date, `--${flag}`, value]);
}
function appendToDailyNote(ctx, text) {
  mkdirSync(dirname(ctx.notePath), { recursive: true });
  appendFileSync(ctx.notePath, text, "utf-8");
}
async function processTensions(ctx, tensions) {
  if (!Array.isArray(tensions) || !tensions.length) return 0;
  let written = 0;
  for (const tension of tensions) {
    if (!tension.tension || !tension.fact1 || !tension.fact2) continue;
    const ok = await runScript(ctx, "memory-tension.js", ["--tension", tension.tension, "--fact1", String(tension.fact1), "--fact2", String(tension.fact2)]);
    if (ok) written++;
  }
  return written;
}
function processFlags(ctx, flags) {
  if (!Array.isArray(flags) || !flags.length) return 0;
  let logged = 0;
  for (const flag of flags) {
    const text = typeof flag === "string" ? flag : (flag.observation || JSON.stringify(flag));
    if (!text || text === "[]") continue;
    appendToDailyNote(ctx, `\n- **Flag**: ${text}\n`);
    logged++;
  }
  return logged;
}
function parseMultilineField(body, name) {
  // Fix 2026-07-05:
  //   1) было `(?=\n\w[\w-]*:|\n?$)`. Под флагом `m` ветка `\n?$` матчилась
  //      на конец ЛЮБОЙ строки, из-за чего non-greedy [\s\S]*? обрывался
  //      на первом `\n` после заголовка поля → ## OLL Rethink никогда не аппендился.
  //      Меняем на `(?![\s\S])` — negative lookahead «нет ни одного символа» = true
  //      только на конце строки независимо от флага `m`.
  //   2) было `\\n` в начале и `\n` в lookahead. Не работало с CRLF (\r\n) line
  //      endings, которые приходят из stdin на Windows. Меняем на `\\r?\\n` чтобы
  //      работало на обоих.
  const match = body.match(new RegExp(`^${name}:\\s*\\|\\r?\\n([\\s\\S]*?)(?=\\r?\\n\\w[\\w-]*:|(?![\\s\\S]))`, "m"));
  if (!match) return "";
  // Dedent: strip the two-space indent that handoff blocks use for readability.
  // Also strip leading \r on lines so the result is consistent regardless of CRLF/LF.
  return match[1].replace(/\r/g, "").replace(/^ {2}/gm, "");
}

export async function applyExtractHandoff(handoff, context = {}) {
  const ctx = createHandoffContext(context);
  log(ctx, `[process-handoff] Type: ${handoff.type} | Status: ${handoff.status}`);
  if (!handoff.isOk) {
    log(ctx, `[hb-extract] Status: error — ${handoff.summary}`);
    setState(ctx, "subagentRuns.hb-extract.status", "failed");
    await updateReport(ctx, "extraction", `error: ${handoff.summary}`);
    return result(ctx, handoff, { status: "ok" });
  }
  const newWatermarkNum = parseWatermarkNum(handoff.stats.new_watermark ?? null);
  const factsWritten = handoff.stats.facts_written ?? 0;
  const factsSkipped = handoff.stats.facts_skipped_dedup ?? 0;
  const currentWm = getCurrentWatermark(ctx.notePath);
  if (newWatermarkNum > currentWm) {
    appendToDailyNote(ctx, `\n<!-- extracted:L${newWatermarkNum}:${ctx.now} -->`);
    log(ctx, `[hb-extract] Watermark advanced: L${currentWm} → L${newWatermarkNum}`);
  } else {
    log(ctx, `[hb-extract] Watermark unchanged (L${currentWm}) — no new content`);
  }
  setState(ctx, `lastExtraction.${ctx.session}`, ctx.now);
  setState(ctx, "subagentRuns.hb-extract.status", "ok");
  const lastSessionFile = handoff.stats.last_session_file ?? null;
  if (lastSessionFile && lastSessionFile !== "null") {
    setState(ctx, `lastSessionExtracted.${ctx.session}`, lastSessionFile);
    log(ctx, `[hb-extract] Session file watermark: ${lastSessionFile}`);
  }
  await updateReport(ctx, "extraction", `ok (${factsWritten} facts${factsSkipped ? `, ${factsSkipped} skipped` : ""}, L${newWatermarkNum})`);
  const flagsLogged = processFlags(ctx, handoff.observations);
  if (flagsLogged > 0) log(ctx, `[hb-extract] Logged ${flagsLogged} flags to daily note`);
  const tensionsWritten = await processTensions(ctx, handoff.tensions);
  if (tensionsWritten > 0) log(ctx, `[hb-extract] Wrote ${tensionsWritten} tensions`);
  log(ctx, `[hb-extract] ✅ ${handoff.summary}`);
  return result(ctx, handoff, { details: { factsWritten, factsSkipped, newWatermark: newWatermarkNum, flagsLogged, tensionsWritten } });
}

export async function applyDomainsHandoff(handoff, context = {}) {
  const ctx = createHandoffContext(context);
  log(ctx, `[process-handoff] Type: ${handoff.type} | Status: ${handoff.status}`);
  if (!handoff.isOk) {
    log(ctx, `[hb-domains] Status: error — ${handoff.summary}`);
    setState(ctx, "subagentRuns.hb-domains.status", "failed");
    await updateReport(ctx, "domains", `error: ${handoff.summary}`);
    return result(ctx, handoff, { status: "ok" });
  }
  const hasWritePayload = parseField(handoff.body, "Domain") || parseField(handoff.body, "Run-Id") || parseField(handoff.body, "Base-Hashes");
  if (hasWritePayload) {
    if (!ctx.domainsWrite) {
      log(ctx, "[hb-domains] Write payload refused: --domains-write is required");
      return result(ctx, handoff, { status: "error", error: "Domain write handoff requires --domains-write" });
    }
    try {
      const applied = await applyDomainWriteHandoff(handoff, {
        workspace: ctx.workspace,
        statePath: ctx.statePath,
        now: ctx.now,
        dryRun: ctx.domainsDryRun,
        selectedDomain: ctx.selectedDomain,
        commandRunner: ctx.commandRunner,
        scriptsDir: ctx.scriptsDir,
      });
      setState(ctx, "lastDomainScan", ctx.now);
      setState(ctx, "subagentRuns.hb-domains", {
        status: "ok",
        mode: ctx.domainsDryRun ? "write-dry-run" : "write",
        domain: applied.domain,
        runId: applied.runId,
        changed: applied.changed,
        idempotent: applied.idempotent,
        appendedEntries: applied.appendedEntries ?? 0,
        promotedFacts: applied.promotedFacts ?? 0,
        proposedDecisionChanges: applied.proposedDecisionChanges ?? 0,
      });
      await updateReport(ctx, "domains", `ok — ${applied.domain} ${applied.status}; changed ${applied.changed ? "yes" : "no"}`);
      log(ctx, `[hb-domains] ✅ ${applied.domain} ${applied.status} | run ${applied.runId}`);
      return result(ctx, handoff, { details: applied });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      log(ctx, `[hb-domains] Write failed: ${message}`);
      setState(ctx, "subagentRuns.hb-domains.status", "failed");
      await updateReport(ctx, "domains", `error: ${message}`);
      return result(ctx, handoff, { status: "error", error: message });
    }
  }
  setState(ctx, "lastDomainScan", ctx.now);
  setState(ctx, "subagentRuns.hb-domains.status", "ok");
  await updateReport(ctx, "domains", `ok — ${handoff.summary}`);
  const flagsLogged = processFlags(ctx, handoff.observations);
  if (flagsLogged > 0) log(ctx, `[hb-domains] Logged ${flagsLogged} flags to daily note`);
  const tensionsWritten = await processTensions(ctx, handoff.tensions);
  if (tensionsWritten > 0) log(ctx, `[hb-domains] Wrote ${tensionsWritten} tensions`);
  log(ctx, `[hb-domains] ✅ ${handoff.summary}`);
  return result(ctx, handoff, { details: { flagsLogged, tensionsWritten } });
}

export async function applySynthesisHandoff(handoff, context = {}) {
  const ctx = createHandoffContext(context);
  log(ctx, `[process-handoff] Type: ${handoff.type} | Status: ${handoff.status}`);
  if (!handoff.isOk) {
    log(ctx, `[hb-synthesis] Status: error — ${handoff.summary}`);
    setState(ctx, "subagentRuns.hb-synthesis.status", "failed");
    await updateReport(ctx, "synthesis", `error: ${handoff.summary}`);
    return result(ctx, handoff, { status: "ok" });
  }
  const d = new Date(ctx.now);
  const diffToMon = d.getDay() === 0 ? -6 : 1 - d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMon);
  const mondayStr = monday.toLocaleDateString("sv-SE");
  setState(ctx, "lastWeeklySynthesis", mondayStr);
  setState(ctx, "subagentRuns.hb-synthesis.status", "ok");
  await updateReport(ctx, "synthesis", `ok — ${handoff.summary}`);
  log(ctx, `[hb-synthesis] ✅ ${handoff.summary}`);
  return result(ctx, handoff, { details: { lastWeeklySynthesis: mondayStr } });
}

export async function applyRethinkHandoff(handoff, context = {}) {
  const ctx = createHandoffContext(context);
  log(ctx, `[process-handoff] Type: ${handoff.type} | Status: ${handoff.status}`);
  setState(ctx, "rethinkInProgress", false);
  setState(ctx, "rethinkStartedAt", null);
  if (!handoff.isOk) {
    log(ctx, `[hb-rethink] Status: error — ${handoff.summary}`);
    setState(ctx, "subagentRuns.hb-rethink.status", "failed");
    await updateReport(ctx, "rethink", `error: ${handoff.summary}`);
    return result(ctx, handoff, { status: "ok" });
  }
  const reportText = parseMultilineField(handoff.body, "Rethink-Report");
  const proposedActions = parseJsonField(parseField(handoff.body, "Proposed-Actions") ?? "[]", []);
  const experimentSpecs = parseJsonField(parseField(handoff.body, "Experiment-Specs") ?? "[]", []);
  if (reportText.trim()) {
    appendToDailyNote(ctx, `\n## OLL Rethink ${ctx.date}\n\n${reportText.trim()}\n`);
    log(ctx, "[hb-rethink] Report written to daily note");
  }

  // === AUTO-EXECUTE actions (agent is autonomous) ===
  // Then surface a business-language report of what was done and why.
  let archiveCount = 0;
  const archiveDetails = [];
  for (const action of proposedActions) {
    if (action.type === "archive" && action.obs_id) {
      if (await runScript(ctx, "memory-promote.js", ["--archive", "--obs-id", String(action.obs_id), "--reason", action.reason || "hb-rethink: noise observation"])) {
        archiveCount++;
        archiveDetails.push({ id: action.obs_id, reason: action.reason, if_done: action.if_done, if_not_done: action.if_not_done });
      }
    }
  }
  let promoteCount = 0;
  const promoteDetails = [];
  for (const action of proposedActions) {
    if (action.type === "promote" && action.obs_id && action.entity && action.fact && action.category && action.confidence) {
      const args = ["--obs-id", String(action.obs_id), "--entity", action.entity, "--fact", action.fact, "--category", action.category, "--confidence", String(action.confidence)];
      if (action.abstraction) args.push("--abstraction", action.abstraction);
      if (action.tags) args.push("--tags", action.tags);
      if (action.description) args.push("--description", action.description);
      if (await runScript(ctx, "memory-promote.js", args)) {
        promoteCount++;
        promoteDetails.push({ id: action.obs_id, entity: action.entity, reason: action.reason, if_done: action.if_done, if_not_done: action.if_not_done });
      }
    }
  }
  let tensionResolvedCount = 0;
  const tensionDetails = [];
  for (const action of proposedActions) {
    if (action.type === "resolve_tension" && action.tension_id && action.resolution) {
      const args = ["--id", String(action.tension_id), "--resolution", action.resolution];
      if (action.action === "dissolve") args.push("--dissolved");
      if (await runScript(ctx, "memory-tension-resolve.js", args)) {
        tensionResolvedCount++;
        tensionDetails.push({ id: action.tension_id, resolution: action.resolution, reason: action.reason, if_done: action.if_done, if_not_done: action.if_not_done });
      }
    }
  }
  const createdExperiments = [];
  const experimentDetails = [];
  for (const spec of experimentSpecs) {
    if (!spec.hypothesis || !spec.type || !spec.budget) continue;
    try {
      const { generateYAML } = await import("./experiment-spec.js");
      const res = await ctx.commandRunner(["bun", join(ctx.scriptsDir, "create-experiment.js"), "--stdin"], {
        cwd: ctx.workspace,
        env: { ...process.env, ENGRAM_WORKSPACE: ctx.workspace },
        input: generateYAML(spec),
      });
      if (!res.ok) {
        log(ctx, `[hb-rethink] Failed to create experiment: ${res.stderr || res.stdout || `exit ${res.exitCode}`}`);
        continue;
      }
      const created = JSON.parse(res.stdout);
      createdExperiments.push(created.id);
      const shortHyp = spec.hypothesis.slice(0, 80) + (spec.hypothesis.length > 80 ? "..." : "");
      appendToDailyNote(ctx, `\n- **Autoresearch**: created ${created.id} (${shortHyp})\n`);
      experimentDetails.push({ id: created.id, hypothesis: shortHyp, cost: spec.budget.estimated_cost_usd, reason: `Research: ${shortHyp}` });
      log(ctx, `[hb-rethink] Created experiment: ${created.id}`);
    } catch (error) {
      log(ctx, `[hb-rethink] Failed to create experiment: ${error.message}`);
    }
  }

  // === BUILD BUSINESS-LANGUAGE REPORT ===
  // Agent acted autonomously. Now explain what was done and why, in business terms.
  const reportLines = [];
  if (archiveCount > 0) {
    reportLines.push(`**Архивировано наблюдений: ${archiveCount}**`);
    for (const d of archiveDetails) {
      reportLines.push(`• ${d.id}: ${d.reason || "шум"}`);
      if (d.if_done) reportLines.push(`  → ${d.if_done}`);
    }
  }
  if (promoteCount > 0) {
    reportLines.push(`**Продвинуто в KG: ${promoteCount}**`);
    for (const d of promoteDetails) {
      reportLines.push(`• ${d.id} → ${d.entity}: ${d.reason || "значимый факт"}`);
      if (d.if_done) reportLines.push(`  → ${d.if_done}`);
    }
  }
  if (tensionResolvedCount > 0) {
    reportLines.push(`**Разрешено противоречий: ${tensionResolvedCount}**`);
    for (const d of tensionDetails) {
      reportLines.push(`• ${d.id}: ${d.reason || d.resolution}`);
      if (d.if_done) reportLines.push(`  → ${d.if_done}`);
    }
  }
  if (createdExperiments.length > 0) {
    reportLines.push(`**Запущено экспериментов: ${createdExperiments.length}**`);
    for (const d of experimentDetails) {
      const cost = d.cost ? ` (~$${d.cost})` : "";
      reportLines.push(`• ${d.id}: ${d.hypothesis}${cost}`);
    }
  }
  const businessReport = reportLines.length > 0 ? reportLines.join("\n") : (reportText.trim() || "Нет действий за этот цикл.");

  patchState(ctx, (state) => {
    setPath(state, "lastRethink", ctx.now);
    if (handoff.stats.weighted_score !== undefined) setPath(state, "lastRethinkScore", handoff.stats.weighted_score);
    setPath(state, "subagentRuns.hb-rethink.status", "ok");
    state.rethinkCount = (state.rethinkCount || 0) + 1;
  });
  await updateReport(ctx, "rethink", `ok — ${handoff.summary}; archived ${archiveCount}, promoted ${promoteCount}, tensions ${tensionResolvedCount}, experiments ${createdExperiments.length}`);

  // Surface the business-language report as an alert
  const extraAlerts = [];
  const alertHeader = `OLL Rethink ${ctx.date}\n\n${businessReport}`;
  extraAlerts.push(alertHeader);

  log(ctx, `[hb-rethink] ✅ ${handoff.summary} | archived: ${archiveCount}, promoted: ${promoteCount}, tensions: ${tensionResolvedCount}, experiments: ${createdExperiments.length}`);
  return result(ctx, handoff, { alerts: extraAlerts, details: { archiveCount, promoteCount, tensionResolvedCount, createdExperiments, archiveDetails, promoteDetails, tensionDetails, experimentDetails } });
}

export async function applyAutoresearchHandoff(handoff, context = {}) {
  const ctx = createHandoffContext(context);
  log(ctx, `[process-handoff] Type: ${handoff.type} | Status: ${handoff.status}`);
  setState(ctx, "autoresearchInProgress", false);
  setState(ctx, "autoresearchStartedAt", null);
  setState(ctx, "currentExperiment", null);
  if (!handoff.isOk) {
    log(ctx, `[hb-autoresearch] Status: error — ${handoff.summary}`);
    setState(ctx, "subagentRuns.hb-autoresearch.status", "failed");
    return result(ctx, handoff, { status: "ok" });
  }
  const experimentId = parseField(handoff.body, "Experiment") ?? null;
  const hypothesis = parseField(handoff.body, "Hypothesis") ?? null;
  const reportPath = parseField(handoff.body, "Report-Path") ?? null;
  const followUpObs = parseJsonField(parseField(handoff.body, "Follow-Up-Observations") ?? "[]", []);
  if (!experimentId) {
    log(ctx, "[hb-autoresearch] Missing Experiment ID in handoff");
    setState(ctx, "subagentRuns.hb-autoresearch.status", "failed");
    return result(ctx, handoff, { status: "error", error: "Missing Experiment ID" });
  }
  const statusCmd = ["CONFIRMED", "REFUTED", "INCONCLUSIVE"].includes(hypothesis) ? "completed" : "failed";
  if (!await runScript(ctx, "update-experiment.js", ["--id", experimentId, "--status", statusCmd, "--summary", handoff.summary])) {
    log(ctx, `[hb-autoresearch] Failed to update experiment ${experimentId}`);
  }
  let obsWritten = 0;
  for (const obs of followUpObs) {
    if (!obs.observation || !obs.category) continue;
    if (await runScript(ctx, "memory-observe.js", ["--observation", obs.observation, "--category", obs.category])) obsWritten++;
  }
  if (reportPath) {
    const shortSummary = handoff.summary.slice(0, 100) + (handoff.summary.length > 100 ? "..." : "");
    appendToDailyNote(ctx, `\n- **Autoresearch ${experimentId}**: ${shortSummary} — [Report](${reportPath})\n`);
    log(ctx, "[hb-autoresearch] Report logged to daily note");
  }
  setState(ctx, "lastAutoresearch", ctx.now);
  setState(ctx, "subagentRuns.hb-autoresearch.status", "ok");
  setState(ctx, "pendingRethink2", experimentId);
  log(ctx, `[hb-autoresearch] ✅ ${experimentId} | ${hypothesis} | ${obsWritten} follow-up obs | Rethink₂ pending`);
  return result(ctx, handoff, { details: { experimentId, hypothesis, obsWritten } });
}

export async function applyRethink2Handoff(handoff, context = {}) {
  const ctx = createHandoffContext(context);
  setState(ctx, "rethink2InProgress", false);
  setState(ctx, "rethink2StartedAt", null);
  log(ctx, `[process-handoff] Type: ${handoff.type} | Status: ${handoff.status}`);
  const experimentId = parseField(handoff.body, "Experiment") ?? null;
  const quality = parseField(handoff.body, "Quality") ?? "low-value";
  const keyFinding = parseField(handoff.body, "Key-Finding") ?? "";
  const recommendation = parseField(handoff.body, "Recommendation") ?? "";
  if (!experimentId) {
    log(ctx, "[hb-rethink2] Missing Experiment ID");
    return result(ctx, handoff, { status: "error", error: "Missing Experiment ID" });
  }
  const deliveryMatch = handoff.body.match(/^Delivery-Decisions:\n((?:\s+\w+:.*\n?)*)/m);
  const deliverGroup = deliveryMatch ? /group_notify:\s*true/i.test(deliveryMatch[1]) : false;
  const deliverOutline = deliveryMatch ? /outline:\s*true/i.test(deliveryMatch[1]) : false;
  appendToDailyNote(ctx, `\n- **Research Result [${experimentId}]**: ${keyFinding}\n  - Recommendation: ${recommendation}\n  - Quality: ${quality}\n`);
  const extraAlerts = [];
  if (deliverGroup) {
    const groupMessage = parseMultilineField(handoff.body, "Group-Message").trim();
    if (groupMessage) {
      const queueDir = join(ctx.workspace, "workspace", "research", "delivery-queue");
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, `${experimentId}.json`), JSON.stringify({ experiment_id: experimentId, message: groupMessage, chat_id: null, created_at: ctx.now, delivered: false }, null, 2), "utf-8");
      log(ctx, "[hb-rethink2] Group message queued for morning delivery");
    }
    extraAlerts.push(`Research ${experimentId} completed — group notification queued for morning delivery`);
  }
  if (deliverOutline) {
    const outlineTitle = parseField(handoff.body, "Outline-Title") ?? `Research: ${experimentId}`;
    const outlineContent = parseMultilineField(handoff.body, "Outline-Content");
    if (outlineContent.trim()) {
      const specPath = join(ctx.workspace, "workspace", "research", experimentId, "spec.yaml");
      let collectionId = null;
      try {
        const { parseYAML } = await import("./experiment-spec.js");
        const spec = parseYAML(readFileSync(specPath, "utf-8"));
        collectionId = spec?.delivery?.outline?.collection_id || spec?.output?.collection_id || null;
      } catch {}
      const res = await ctx.commandRunner([
        "node",
        "skills/outline/scripts/create.js",
        "--title",
        outlineTitle,
        "--collection",
        collectionId || "4ea21866-d76e-4257-826b-7a18ac70a002",
        "--publish",
      ], {
        cwd: ctx.workspace,
        env: { ...process.env, ENGRAM_WORKSPACE: ctx.workspace },
        input: outlineContent,
      });
      if (res.ok) log(ctx, `[hb-rethink2] Published to Outline: ${outlineTitle}`);
      else log(ctx, `[hb-rethink2] Outline publish failed: ${res.stderr || res.stdout || `exit ${res.exitCode}`}`);
    }
  }
  await runScript(ctx, "update-experiment.js", ["--id", experimentId, "--status", "completed", "--summary", handoff.summary]);
  const followUpObs = parseJsonField(parseField(handoff.body, "Follow-Up-Observations") ?? "[]", []);
  let obsWritten = 0;
  for (const obs of followUpObs) {
    if (!obs.observation || !obs.category) continue;
    if (await runScript(ctx, "memory-observe.js", ["--observation", obs.observation, "--category", obs.category])) obsWritten++;
  }
  setState(ctx, "lastAutoresearch", ctx.now);
  setState(ctx, "subagentRuns.hb-rethink2.status", "ok");
  log(ctx, `[hb-rethink2] ✅ ${experimentId} | quality: ${quality} | outline: ${deliverOutline} | group: ${deliverGroup} | obs: ${obsWritten}`);
  return result(ctx, handoff, { alerts: extraAlerts, details: { experimentId, quality, deliverOutline, deliverGroup, obsWritten } });
}
