#!/usr/bin/env bun
/**
 * process-handoff.js — Process HB subagent handoff blocks
 *
 * Usage:
 *   echo "<handoff text>" | bun scripts/process-handoff.js [--session main] [--date YYYY-MM-DD]
 *   bun scripts/process-handoff.js --session main --date 2026-02-27 < handoff.txt
 *
 * Handles: HB-EXTRACT, HB-DOMAINS, HB-SYNTHESIS, HB-RETHINK, HB-AUTORESEARCH
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
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { getAgentDir } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/ → engram/ → skills/ → workspace root
const WORKSPACE = process.env.ENGRAM_WORKSPACE || join(__dirname, "..", "..", "..");
const AGENT_DIR = getAgentDir(WORKSPACE);

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
const obsRaw = parseField(blockBody, "Observations") ?? parseField(blockBody, "Flags") ?? "[]";
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

// --- Process flags (candidate observations from subagents) ---
// Flags are strings like "CANDIDATE_OBS: description". They are logged to daily note
// for agent review, NOT auto-written as observations. Only the agent writes observations.
function processFlags(flags) {
  if (!Array.isArray(flags) || !flags.length) return 0;
  let logged = 0;
  for (const f of flags) {
    // Support both old format (objects with .observation) and new format (strings)
    const text = typeof f === "string" ? f : (f.observation || JSON.stringify(f));
    if (!text || text === "[]") continue;
    const notePath = join(WORKSPACE, "memory", AGENT_DIR, session, `${date}.md`);
    try {
      const { appendFileSync } = require("fs");
      appendFileSync(notePath, `\n- **Flag**: ${text}\n`);
      logged++;
    } catch {}
  }
  return logged;
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
  const notePath = join(WORKSPACE, "memory", AGENT_DIR, session, `${date}.md`);
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

  // Track last processed session file (Phase 2 — session files extraction)
  const lastSessionFile = stats.last_session_file ?? null;
  if (lastSessionFile && lastSessionFile !== "null") {
    setState(`lastSessionExtracted.${session}`, lastSessionFile);
    console.log(`[hb-extract] Session file watermark: ${lastSessionFile}`);
  }

  // Update report
  const reportVal = `ok (${factsWritten} facts${factsSkipped ? `, ${factsSkipped} skipped` : ""}, L${newWatermarkNum})`;
  updateReport("extraction", reportVal);

  // Process flags (candidate observations — logged to daily note for agent review)
  const flagsLogged = processFlags(observations);
  if (flagsLogged > 0) {
    console.log(`[hb-extract] Logged ${flagsLogged} flags to daily note`);
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

  const flagsLogged = processFlags(observations);
  if (flagsLogged > 0) console.log(`[hb-domains] Logged ${flagsLogged} flags to daily note`);

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
// Handler: HB-RETHINK
// ============================================================
async function handleRethink() {
  // Always reset lock (even on error — prevent permanent stuck state)
  setState("rethinkInProgress", "false");
  setState("rethinkStartedAt", "null");

  if (!isOk) {
    console.log(`[hb-rethink] Status: error — ${summary}`);
    setState("subagentRuns.hb-rethink.status", "failed");
    updateReport("rethink", `error: ${summary}`);
    return;
  }

  // --- Parse multi-line Rethink-Report field (pipe format) ---
  // Format: "Rethink-Report: |\n  line1\n  line2\n..."
  const reportMatch = blockBody.match(/^Rethink-Report:\s*\|\n([\s\S]*?)(?=\n\w[\w-]*:|\n?$)/m);
  const report = reportMatch ? reportMatch[1] : "";

  // --- Parse Tensions-Resolved field ---
  const tensionsResolvedRaw = parseField(blockBody, "Tensions-Resolved") ?? "[]";
  let tensionsResolved = [];
  try { tensionsResolved = JSON.parse(tensionsResolvedRaw); } catch { tensionsResolved = []; }

  // --- Parse Experiment-Specs field ---
  const experimentSpecsRaw = parseField(blockBody, "Experiment-Specs") ?? "[]";
  let experimentSpecs = [];
  try { experimentSpecs = JSON.parse(experimentSpecsRaw); } catch { experimentSpecs = []; }

  // 1. Write report to daily note
  if (report.trim()) {
    const notePath = join(WORKSPACE, "memory", AGENT_DIR, session, `${date}.md`);
    try {
      const { appendFileSync } = require("fs");
      appendFileSync(notePath, `\n## OLL Rethink ${date}\n\n${report.trim()}\n`);
      console.log(`[hb-rethink] Report written to daily note`);
    } catch (e) {
      console.error(`[hb-rethink] Failed to write report: ${e.message}`);
    }
  }

  // 2. Auto-archive noise observations (low-risk, no approval needed)
  const archivedIds = Array.isArray(stats.archived) ? stats.archived : [];
  let archiveCount = 0;
  for (const obsId of archivedIds) {
    const ok = run(`bun scripts/memory-promote.js --archive --obs-id ${obsId} --reason "hb-rethink: noise observation auto-archived"`);
    if (ok) archiveCount++;
  }

  // 3. Auto-promote high-signal observations (low-risk, scored ≥ 5)
  const promotedItems = Array.isArray(stats.promoted) ? stats.promoted : [];
  let promoteCount = 0;
  for (const p of promotedItems) {
    if (!p.obsId || !p.entity || !p.fact || !p.category || !p.confidence) continue;
    const factEsc = p.fact.replace(/"/g, '\\"');
    const args = [`bun scripts/memory-promote.js`,
      `--obs-id ${p.obsId}`,
      `--entity "${p.entity}"`,
      `--fact "${factEsc}"`,
      `--category ${p.category}`,
      `--confidence ${p.confidence}`,
    ];
    if (p.abstraction) args.push(`--abstraction ${p.abstraction}`);
    if (p.tags) args.push(`--tags "${p.tags}"`);
    if (p.description) args.push(`--description "${p.description.replace(/"/g, '\\"')}"`);
    const ok = run(args.join(" "));
    if (ok) promoteCount++;
  }

  // 4. Resolve/dissolve tensions
  for (const t of tensionsResolved) {
    if (!t.id || !t.resolution) continue;
    const resEsc = t.resolution.replace(/"/g, '\\"');
    const dissolvedFlag = t.action === "dissolve" ? "--dissolved" : "";
    run(`bun scripts/memory-tension-resolve.js --id ${t.id} --resolution "${resEsc}" ${dissolvedFlag}`);
  }

  // 5. Process Experiment-Specs
  const createdExperiments = [];
  const proposedExperiments = [];
  
  for (const spec of experimentSpecs) {
    if (!spec.hypothesis || !spec.type || !spec.budget) continue;
    
    // Convert spec to YAML format
    const { generateYAML } = await import("./experiment-spec.js");
    const yamlSpec = generateYAML(spec);
    
    try {
      // Create experiment via stdin
      const result = execSync(`bun scripts/create-experiment.js --stdin`, {
        cwd: WORKSPACE,
        input: yamlSpec,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      
      const created = JSON.parse(result);
      
      if (spec.budget.decision === "auto") {
        createdExperiments.push(created.id);
        console.log(`[hb-rethink] Created auto experiment: ${created.id}`);
        
        // Log to daily note
        const notePath = join(WORKSPACE, "memory", AGENT_DIR, session, `${date}.md`);
        const shortHyp = spec.hypothesis.slice(0, 60) + (spec.hypothesis.length > 60 ? "..." : "");
        appendFileSync(notePath, `\n- **Autoresearch**: created ${created.id} (${shortHyp})\n`, "utf-8");
      } else if (spec.budget.decision === "propose") {
        proposedExperiments.push(created.id);
        console.log(`[hb-rethink] Created proposed experiment: ${created.id}`);
        
        // Add to alerts for user approval
        const shortHyp = spec.hypothesis.slice(0, 80) + (spec.hypothesis.length > 80 ? "..." : "");
        alerts.push(`[PROPOSE] Experiment ${created.id}: ${shortHyp} — approve or skip?`);
      }
    } catch (e) {
      console.error(`[hb-rethink] Failed to create experiment: ${e.message}`);
    }
  }

  // 6. Update state
  setState("lastRethink", now);
  if (stats.weighted_score !== undefined) {
    setState("lastRethinkScore", String(stats.weighted_score));
  }
  setState("subagentRuns.hb-rethink.status", "ok");

  // Increment rethinkCount (read-modify-write)
  try {
    const statePath = join(WORKSPACE, "workspace", "heartbeat-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    state.rethinkCount = (state.rethinkCount || 0) + 1;
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {}

  updateReport("rethink", `ok — ${summary}; archived ${archiveCount}, promoted ${promoteCount}, experiments ${createdExperiments.length + proposedExperiments.length}`);

  // 7. Ensure alert is always present — include full report for user delivery
  if (!alerts.length) {
    if (report.trim()) {
      alerts.push(`📊 OLL Rethink ${date}\n\n${report.trim()}`);
    } else {
      alerts.push(`/rethink report ready — see daily note ## OLL Rethink ${date}`);
    }
  }

  console.log(`[hb-rethink] ✅ ${summary} | archived: ${archiveCount}, promoted: ${promoteCount}, resolved: ${tensionsResolved.length}, experiments: ${createdExperiments.length} auto + ${proposedExperiments.length} proposed`);
}

// ============================================================
// Handler: HB-RETHINK2
// ============================================================
function handleRethink2() {
  const experimentId = parseField(blockBody, "Experiment") ?? null;
  const quality = parseField(blockBody, "Quality") ?? "low-value";
  const keyFinding = parseField(blockBody, "Key-Finding") ?? "";
  const recommendation = parseField(blockBody, "Recommendation") ?? "";
  const summary = parseField(blockBody, "Summary") ?? "";
  
  if (!experimentId) {
    console.error("[hb-rethink2] Missing Experiment ID");
    return;
  }

  // 1. Parse delivery decisions
  const deliveryMatch = blockBody.match(/^Delivery-Decisions:\n((?:\s+\w+:.*\n?)*)/m);
  let deliverOutline = false;
  let deliverGroup = false;
  if (deliveryMatch) {
    deliverOutline = /outline:\s*true/i.test(deliveryMatch[1]);
    deliverGroup = /group_notify:\s*true/i.test(deliveryMatch[1]);
  }

  // 2. Always: daily note
  const notePath = join(WORKSPACE, "memory", AGENT_DIR, session, `${date}.md`);
  try {
    const entry = `\n- **Research Result [${experimentId}]**: ${keyFinding}\n  - Recommendation: ${recommendation}\n  - Quality: ${quality}\n`;
    appendFileSync(notePath, entry, "utf-8");
  } catch {}

  // 3. Outline publication
  if (deliverOutline) {
    const outlineTitle = parseField(blockBody, "Outline-Title") ?? `Research: ${experimentId}`;
    const outlineMatch = blockBody.match(/^Outline-Content:\s*\|\n([\s\S]*?)(?=\n\w[\w-]*:|\n=== END ===)/m);
    const outlineContent = outlineMatch ? outlineMatch[1].replace(/^ {2}/gm, "") : "";
    
    if (outlineContent.trim()) {
      const specPath = join(WORKSPACE, "workspace", "research", experimentId, "spec.yaml");
      let collectionId = null;
      try {
        const { parseYAML } = require("./experiment-spec.js");
        const spec = parseYAML(readFileSync(specPath, "utf-8"));
        collectionId = spec?.delivery?.outline?.collection_id || spec?.output?.collection_id || null;
      } catch {}
      
      const tmpFile = join(WORKSPACE, "workspace", "research", experimentId, "outline-content.md");
      writeFileSync(tmpFile, outlineContent, "utf-8");
      
      const collArg = collectionId ? `--collection ${collectionId}` : "--collection 4ea21866-d76e-4257-826b-7a18ac70a002";
      const titleEsc = outlineTitle.replace(/"/g, '\\"');
      const outlineOk = run(`cat "${tmpFile}" | node skills/outline/scripts/create.js --title "${titleEsc}" ${collArg} --publish`);
      
      if (outlineOk) {
        console.log(`[hb-rethink2] Published to Outline: ${outlineTitle}`);
      }
    }
  }

  // 4. Group TG notification (deferred to morning 8-10 MSK)
  if (deliverGroup) {
    const groupMatch = blockBody.match(/^Group-Message:\s*\|\n([\s\S]*?)(?=\n\w[\w-]*:|\n=== END ===)/m);
    const groupMessage = groupMatch ? groupMatch[1].replace(/^ {2}/gm, "").trim() : "";
    
    if (groupMessage) {
      const queueDir = join(WORKSPACE, "workspace", "research", "delivery-queue");
      const { mkdirSync } = require("fs");
      try { mkdirSync(queueDir, { recursive: true }); } catch {}
      const queueFile = join(queueDir, `${experimentId}.json`);
      writeFileSync(queueFile, JSON.stringify({
        experiment_id: experimentId,
        message: groupMessage,
        chat_id: null,
        created_at: now,
        delivered: false
      }, null, 2), "utf-8");
      console.log(`[hb-rethink2] Group message queued for morning delivery`);
    }
  }

  // 5. Update experiment with quality rating
  const summaryEsc = summary.replace(/"/g, '\\"');
  run(`bun scripts/update-experiment.js --id ${experimentId} --status completed --summary "${summaryEsc}"`);

  // 6. Process follow-up observations
  const followUpRaw = parseField(blockBody, "Follow-Up-Observations") ?? "[]";
  let followUpObs = [];
  try { followUpObs = JSON.parse(followUpRaw); } catch {}
  
  let obsWritten = 0;
  for (const obs of followUpObs) {
    if (!obs.observation || !obs.category) continue;
    const obsEsc = obs.observation.replace(/"/g, '\\"');
    if (run(`bun scripts/memory-observe.js --observation "${obsEsc}" --category ${obs.category}`)) obsWritten++;
  }

  // 7. Update state
  setState("lastAutoresearch", now);
  setState("subagentRuns.hb-rethink2.status", "ok");

  // 8. Alert only if group message was queued
  if (deliverGroup) {
    alerts.push(`Research ${experimentId} completed — group notification queued for morning delivery`);
  }

  console.log(`[hb-rethink2] ✅ ${experimentId} | quality: ${quality} | outline: ${deliverOutline} | group: ${deliverGroup} | obs: ${obsWritten}`);
}

// ============================================================
// Handler: HB-AUTORESEARCH
// ============================================================
function handleAutoresearch() {
  // Always reset lock (even on error)
  setState("autoresearchInProgress", "false");
  setState("autoresearchStartedAt", "null");
  setState("currentExperiment", "null");

  if (!isOk) {
    console.log(`[hb-autoresearch] Status: error — ${summary}`);
    setState("subagentRuns.hb-autoresearch.status", "failed");
    return;
  }

  // --- Parse fields ---
  const experimentId = parseField(blockBody, "Experiment") ?? null;
  const hypothesis = parseField(blockBody, "Hypothesis") ?? null;
  const reportPath = parseField(blockBody, "Report-Path") ?? null;
  const followUpObsRaw = parseField(blockBody, "Follow-Up-Observations") ?? "[]";
  
  let followUpObs = [];
  try { followUpObs = JSON.parse(followUpObsRaw); } catch { followUpObs = []; }

  if (!experimentId) {
    console.error(`[hb-autoresearch] Missing Experiment ID in handoff`);
    setState("subagentRuns.hb-autoresearch.status", "failed");
    return;
  }

  // 1. Update experiment status
  const statusCmd = hypothesis === "CONFIRMED" ? "completed" : 
                    hypothesis === "REFUTED" ? "completed" :
                    hypothesis === "INCONCLUSIVE" ? "completed" : "failed";
  
  const summaryEsc = summary.replace(/"/g, '\\"');
  const ok = run(`bun scripts/update-experiment.js --id ${experimentId} --status ${statusCmd} --summary "${summaryEsc}"`);
  
  if (!ok) {
    console.error(`[hb-autoresearch] Failed to update experiment ${experimentId}`);
  }

  // 2. Process follow-up observations
  let obsWritten = 0;
  for (const obs of followUpObs) {
    if (!obs.observation || !obs.category) continue;
    const obsEsc = obs.observation.replace(/"/g, '\\"');
    const writeOk = run(`bun scripts/memory-observe.js --observation "${obsEsc}" --category ${obs.category}`);
    if (writeOk) obsWritten++;
  }

  // 3. Log to daily note
  if (reportPath) {
    const notePath = join(WORKSPACE, "memory", AGENT_DIR, session, `${date}.md`);
    try {
      const shortSummary = summary.slice(0, 100) + (summary.length > 100 ? "..." : "");
      appendFileSync(notePath, `\n- **Autoresearch ${experimentId}**: ${shortSummary} — [Report](${reportPath})\n`, "utf-8");
      console.log(`[hb-autoresearch] Report logged to daily note`);
    } catch (e) {
      console.error(`[hb-autoresearch] Failed to log to daily note: ${e.message}`);
    }
  }

  // 4. Update state
  setState("lastAutoresearch", now);
  setState("subagentRuns.hb-autoresearch.status", "ok");

  // 5. Signal that Rethink₂ should run for this experiment
  setState("pendingRethink2", experimentId);

  console.log(`[hb-autoresearch] ✅ ${experimentId} | ${hypothesis} | ${obsWritten} follow-up obs | Rethink₂ pending`);
}

// ============================================================
// Dispatch
// ============================================================
console.log(`[process-handoff] Type: ${handoffType} | Status: ${status}`);

switch (handoffType) {
  case "HB-EXTRACT":      handleExtract();      break;
  case "HB-DOMAINS":      handleDomains();      break;
  case "HB-SYNTHESIS":    handleSynthesis();    break;
  case "HB-RETHINK":      handleRethink();      break;
  case "HB-RETHINK2":     handleRethink2();     break;
  case "HB-AUTORESEARCH": handleAutoresearch(); break;
  default:
    console.error(`[process-handoff] Unknown handoff type: ${handoffType}`);
    process.exit(1);
}

// Print alerts (caller surfaces to user)
if (Array.isArray(alerts) && alerts.length > 0) {
  for (const alert of alerts) {
    // Strip leading [ALERT] prefix if subagent already included it
    const text = String(alert).replace(/^\[ALERT\]\s*/i, "");
    console.log(`[ALERT] ${text}`);
  }
  process.exit(2); // exit 2 = alerts present
}

// Explicit signal: no alerts, caller MUST reply NO_REPLY
console.log("[SILENT] Handoff processed — no user-facing output required");
process.exit(0);
