#!/usr/bin/env bun
/**
 * process-handoff.js — Process HB subagent handoff blocks
 *
 * Usage:
 *   echo "<handoff text>" | bun scripts/process-handoff.js [--session main] [--date YYYY-MM-DD]
 *   bun scripts/process-handoff.js --session main --date 2026-02-27 < handoff.txt
 *
 * Handles: HB-EXTRACT, HB-DOMAINS, HB-SYNTHESIS
 *
 * Exit codes:
 *   0 — processed OK (even if no handoff found — idempotent)
 *   1 — parse error or script failure
 *
 * Stdout: summary of actions taken
 * Alerts: printed as [ALERT] lines — caller should surface to user
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, appendFileSync, existsSync } from "fs";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/ → engram/ → skills/ → workspace root
const WORKSPACE = process.env.ENGRAM_WORKSPACE || join(__dirname, "..", "..", "..");

// --- Arg parsing ---
const argv = process.argv.slice(2);
function getArg(name) {
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
  return null;
}

const session = getArg("session") ?? "main";
const date = getArg("date") ?? new Date().toLocaleDateString("sv-SE");

// --- Read stdin ---
const input = readFileSync(0, "utf-8"); // fd 0 = stdin

// --- Extract handoff block ---
// Pattern: === HB-<TYPE> HANDOFF === ... === END ===
const blockMatch = input.match(/=== (HB-\w+) HANDOFF ===([\s\S]*?)=== END ===/);
if (!blockMatch) {
  console.log("[process-handoff] No handoff block found in input — nothing to do");
  process.exit(0);
}

const handoffType = blockMatch[1]; // e.g. "HB-EXTRACT"
const blockBody = blockMatch[2];

// --- Parse fields ---
function parseField(body, name) {
  const m = body.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

const status = parseField(blockBody, "Status") ?? "error";
const summary = parseField(blockBody, "Summary") ?? "";
const statsRaw = parseField(blockBody, "Stats") ?? "{}";
const obsRaw = parseField(blockBody, "Observations") ?? "[]";
const tensionsRaw = parseField(blockBody, "Tensions") ?? "[]";
const alertsRaw = parseField(blockBody, "Alerts") ?? "[]";

let stats = {};
let observations = [];
let tensions = [];
let alerts = [];

try { stats = JSON.parse(statsRaw); } catch { stats = {}; }
try { observations = JSON.parse(obsRaw); } catch { observations = []; }
try { tensions = JSON.parse(tensionsRaw); } catch { tensions = []; }
try { alerts = JSON.parse(alertsRaw); } catch { alerts = []; }

const now = new Date().toISOString();
const isOk = status.toLowerCase() === "ok";

// --- Helpers ---
const SCRIPTS = join(__dirname);

function run(cmd) {
  try {
    // Replace "bun scripts/" with absolute path to engram scripts
    const resolved = cmd.replace(/^bun scripts\//, `bun ${SCRIPTS}/`);
    execSync(resolved, { cwd: WORKSPACE, stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch (e) {
    console.error(`[process-handoff] Command failed: ${cmd}\n  ${e.message}`);
    return false;
  }
}

function setState(path, value) {
  const v = typeof value === "string" ? value : JSON.stringify(value);
  run(`bun scripts/heartbeat-state.js --set ${path} ${v}`);
}

function updateReport(flag, value) {
  run(`bun scripts/heartbeat-report.js --session ${session} --date ${date} --${flag} "${value}"`);
}

// --- Get current watermark from daily note ---
function getCurrentWatermark(notePath) {
  if (!existsSync(notePath)) return 0;
  const content = readFileSync(notePath, "utf-8");
  const matches = [...content.matchAll(/<!--\s*extracted:L(\d+):[^>]*-->/g)];
  if (!matches.length) return 0;
  return parseInt(matches[matches.length - 1][1], 10);
}

// --- Watermark comparison: "L47" → 47 ---
function parseWatermarkNum(wm) {
  if (!wm) return 0;
  const m = String(wm).match(/L?(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// --- Process tensions ---
function processTensions(tens) {
  if (!Array.isArray(tens) || !tens.length) return 0;
  let written = 0;
  for (const t of tens) {
    if (!t.tension || !t.fact1 || !t.fact2) continue;
    const escaped = t.tension.replace(/"/g, '\\"');
    const ok = run(`bun scripts/memory-tension.js --tension "${escaped}" --fact1 ${t.fact1} --fact2 ${t.fact2}`);
    if (ok) written++;
  }
  return written;
}

// --- Process observations ---
function processObservations(obs) {
  if (!Array.isArray(obs) || !obs.length) return 0;
  let written = 0;
  for (const o of obs) {
    if (!o.observation || !o.category) continue;
    const escaped = o.observation.replace(/"/g, '\\"');
    const ok = run(`bun scripts/memory-observe.js --observation "${escaped}" --category ${o.category}`);
    if (ok) written++;
  }
  return written;
}

// ============================================================
// Handler: HB-EXTRACT
// ============================================================
function handleExtract() {
  if (!isOk) {
    console.log(`[hb-extract] Status: error — ${summary}`);
    setState("subagentRuns.hb-extract.status", "failed");
    updateReport("extraction", `error: ${summary}`);
    return;
  }

  const newWatermarkStr = stats.new_watermark ?? null;
  const newWatermarkNum = parseWatermarkNum(newWatermarkStr);
  const factsWritten = stats.facts_written ?? 0;
  const factsSkipped = stats.facts_skipped_dedup ?? 0;

  // Append watermark to daily note if advanced
  const notePath = join(WORKSPACE, "memory", "agent-main", session, `${date}.md`);
  const currentWm = getCurrentWatermark(notePath);

  if (newWatermarkNum > currentWm) {
    const watermarkLine = `\n<!-- extracted:L${newWatermarkNum}:${now} -->`;
    appendFileSync(notePath, watermarkLine, "utf-8");
    console.log(`[hb-extract] Watermark advanced: L${currentWm} → L${newWatermarkNum}`);
  } else {
    console.log(`[hb-extract] Watermark unchanged (L${currentWm}) — no new content`);
  }

  // Update state
  setState(`lastExtraction.${session}`, now);
  setState("subagentRuns.hb-extract.status", "ok");

  // Update report
  const reportVal = `ok (${factsWritten} facts${factsSkipped ? `, ${factsSkipped} skipped` : ""}, L${newWatermarkNum})`;
  updateReport("extraction", reportVal);

  // Process observations
  const obsWritten = processObservations(observations);
  if (obsWritten > 0) {
    console.log(`[hb-extract] Wrote ${obsWritten} observations`);
  }

  // Process tensions
  const tensWritten = processTensions(tensions);
  if (tensWritten > 0) {
    console.log(`[hb-extract] Wrote ${tensWritten} tensions`);
  }

  console.log(`[hb-extract] ✅ ${summary}`);
}

// ============================================================
// Handler: HB-DOMAINS
// ============================================================
function handleDomains() {
  if (!isOk) {
    console.log(`[hb-domains] Status: error — ${summary}`);
    setState("subagentRuns.hb-domains.status", "failed");
    updateReport("domains", `error: ${summary}`);
    return;
  }

  setState("lastDomainScan", now);
  setState("subagentRuns.hb-domains.status", "ok");
  updateReport("domains", `ok — ${summary}`);

  const obsWritten = processObservations(observations);
  if (obsWritten > 0) console.log(`[hb-domains] Wrote ${obsWritten} observations`);

  const tensWritten = processTensions(tensions);
  if (tensWritten > 0) console.log(`[hb-domains] Wrote ${tensWritten} tensions`);

  console.log(`[hb-domains] ✅ ${summary}`);
}

// ============================================================
// Handler: HB-SYNTHESIS
// ============================================================
function handleSynthesis() {
  if (!isOk) {
    console.log(`[hb-synthesis] Status: error — ${summary}`);
    setState("subagentRuns.hb-synthesis.status", "failed");
    updateReport("synthesis", `error: ${summary}`);
    return;
  }

  // Record this Monday as done
  const d = new Date();
  const day = d.getDay(); // 0=Sun, 1=Mon
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMon);
  const mondayStr = monday.toLocaleDateString("sv-SE");

  setState("lastWeeklySynthesis", mondayStr);
  setState("subagentRuns.hb-synthesis.status", "ok");
  updateReport("synthesis", `ok — ${summary}`);

  console.log(`[hb-synthesis] ✅ ${summary}`);
}

// ============================================================
// Dispatch
// ============================================================
console.log(`[process-handoff] Type: ${handoffType} | Status: ${status}`);

switch (handoffType) {
  case "HB-EXTRACT":   handleExtract();   break;
  case "HB-DOMAINS":   handleDomains();   break;
  case "HB-SYNTHESIS": handleSynthesis(); break;
  default:
    console.error(`[process-handoff] Unknown handoff type: ${handoffType}`);
    process.exit(1);
}

// Print alerts (caller surfaces to user)
if (Array.isArray(alerts) && alerts.length > 0) {
  for (const alert of alerts) {
    console.log(`[ALERT] ${alert}`);
  }
  process.exit(2); // exit 2 = alerts present
}

process.exit(0);
