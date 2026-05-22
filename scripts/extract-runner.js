#!/usr/bin/env bun
/**
 * Deterministic heartbeat extraction runner.
 *
 * This is the mechanical extraction phase used by heartbeat-runner.js. It
 * collects new daily-note/session content, writes conservative facts through
 * memory-write.js, and advances watermarks only after successful processing.
 */

import { existsSync, mkdirSync, readdirSync, statSync, renameSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadEngramConfig } from "./config.js";
import { parseHandoff } from "./process-handoff-core.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));

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
const workspace = resolve(opts.workspace || process.env.ENGRAM_WORKSPACE || process.cwd());
process.env.ENGRAM_WORKSPACE = workspace;
const config = loadEngramConfig(workspace);
const agentId = String(opts["agent-id"] || config.agent.replace(/^agent-/, "") || "main").replace(/^agent-/, "");
const agentDir = "agent-" + agentId;
const session = opts.session || "main";
const tz = process.env.ENGRAM_TZ || process.env.TZ || "Europe/Moscow";
const date = opts.date || new Date().toLocaleDateString("sv-SE", { timeZone: tz });
const noWrite = Boolean(opts["no-write"]);
const advanceWatermarkOnNoWrite = Boolean(opts["advance-watermark-on-no-write"]);
const semanticCheck = !opts["no-semantic-check"];

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

async function atomicWrite(path, content) {
  const tmp = path + ".tmp-" + process.pid + "-" + Date.now();
  await writeFile(tmp, content);
  renameSync(tmp, path);
}

function lineCount(text) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n").length : normalized.split("\n").length;
}

export function extractLastWatermark(content) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  let last = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^<!--\s*extracted:L(\d+):([^>]+)-->\s*$/);
    if (m) last = { line: i + 1, watermark: Number(m[1]), timestamp: m[2] };
  }
  return last;
}

function removeWatermarks(content) {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => !/^<!--\s*extracted:L\d+:[^>]+-->\s*$/.test(line))
    .join("\n")
    .replace(/\n*$/, "\n");
}

export function collectDailyCandidates(content) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const watermark = extractLastWatermark(normalized);
  const startLine = watermark?.line ?? 0;
  const candidates = [];
  let section = null;
  let inHeartbeatReport = false;

  for (let i = startLine; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const heading = trimmed.match(/^##\s+(.+)$/);
    if (heading) {
      section = heading[1].trim();
      inHeartbeatReport = section === "Heartbeat Report";
      continue;
    }
    if (!trimmed || inHeartbeatReport) continue;
    if (/^<!--\s*(session:|extracted:)/.test(trimmed)) continue;
    if (!trimmed.startsWith("- ")) continue;

    const text = trimmed.replace(/^-\s*/, "").replace(/^\*\*[^*]+\*\*:\s*/, "").trim();
    if (!text || text.length < 12) continue;
    if (/^(Extraction|Synthesis|Domains|Maintenance):/i.test(text)) continue;
    if (/^Flag:/i.test(text)) continue;

    const category = section === "Decisions" ? "decision" : section === "Learnings" ? "context" : "milestone";
    candidates.push({ line: i + 1, section: section || "Events", text, category, source: "daily" });
  }

  return { watermark, candidates, lastLine: lineCount(normalized) };
}

function parseSessionTimestamp(path, content) {
  const firstLine = content.split(/\r?\n/, 1)[0] || "";
  const m = firstLine.match(/^#\s*Session:\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+UTC/i);
  if (m) return Date.parse(m[1] + "T" + m[2] + "Z");
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

function isServiceSessionFile(path) {
  const name = basename(path).toLowerCase();
  return name.startsWith("cron-") || name.includes("-cron-");
}

export async function collectSessionFiles({ workspace, agentDir, session, lastSessionExtracted }) {
  const sessionsDir = join(workspace, "memory", agentDir, session, "sessions");
  if (!existsSync(sessionsDir)) return { files: [], sessionsDir };

  const files = readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(sessionsDir, name))
    .filter((path) => !isServiceSessionFile(path));

  const loaded = [];
  for (const path of files) {
    const content = await readFile(path, "utf8").catch(() => "");
    loaded.push({ path, name: basename(path), content, ts: parseSessionTimestamp(path, content) });
  }
  loaded.sort((a, b) => a.ts - b.ts || a.name.localeCompare(b.name));

  let lastTs = null;
  if (lastSessionExtracted) {
    const last = loaded.find((f) => f.name === lastSessionExtracted);
    if (last) lastTs = last.ts;
  }

  return {
    sessionsDir,
    files: lastTs == null ? loaded : loaded.filter((f) => f.ts > lastTs),
  };
}

export function collectSessionCandidates(file) {
  const candidates = [];
  const lines = file.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("```")) continue;
    const roleMatch = trimmed.match(/^(assistant|user|system)\s*:/i);
    if (roleMatch && trimmed.length < 1000) {
      const role = roleMatch[1].toLowerCase();
      const text = trimmed.replace(/^(assistant|user|system)\s*:\s*/i, "").trim();
      if (isSessionNoise(text, role)) continue;
      const signal = classifyText(text);
      if (!signal) continue;
      candidates.push({ line: i + 1, section: "Session", text, category: signal, source: "session", sessionFile: file.name });
    }
  }
  return candidates;
}

function isSessionNoise(text, role = "user") {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length < 12) return true;
  if (/\b(Exec completed|Script completed|Script failed|Exit code:|Wall time:|stdout|stderr)\b/i.test(normalized)) return true;
  if (/\b(remote: !|deploy lock|Run 'apps:unlock'|Assertion failed|SyntaxError:)\b/i.test(normalized)) return true;
  if (/\[[0-9;]{1,12}m/.test(normalized)) return true;
  if (/^\[[0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2}/.test(normalized)) return true;
  if (role === "assistant") {
    if (/^(Готово|Ок|Да|Проверил|Сделал|Добавил|Исправил|Запустил)[.!,:\s]/i.test(normalized)) return true;
    if (/^(Now let me|Let me|I'll|I will|I’m going to|I am going to)\b/i.test(normalized)) return true;
    if (/\b(bun test|pass\s*\/\s*0 fail|tests? passed|зел[её]н(?:ый|ая)|full gate)\b/i.test(normalized)) return true;
  }
  return false;
}

function classifyText(text) {
  if (/(решил[аи]?|решили|принято решение|давай будем|будем делать|we decided|decision made|let\x27s go with)/i.test(text)) return "decision";
  if (/(предпочитаю|нравится|не нравится|лучше использовать|prefer|like|dislike|better to use)/i.test(text)) return "preference";
  if (/(на самом деле|поправ|correction|actually|I meant)/i.test(text)) return "correction";
  if (/(запустили|задеплоили|завершили|готово|deployed|launched|finished|released|completed)/i.test(text)) return "milestone";
  return null;
}

function inferEntity(text) {
  const lower = text.toLowerCase();
  const rules = [
    [/\b(engram|heartbeat|hb-|memory|kg|qmd|oll|autoresearch)\b/i, "projects/engram"],
    [/\b(openclaw|gateway|telegram|cron|runner)\b/i, "projects/openclaw"],
    [/\b(vpn|wireguard|dnsmasq|apriori-vm)\b/i, "projects/vpn"],
    [/\b(outline)\b/i, "projects/outline"],
    [/\b(projectmix)\b/i, "projects/projectmix"],
    [/\b(telemax)\b/i, "projects/telemax"],
    [/\b(qmd)\b/i, "projects/qmd"],
    [/\bsergey|серге[йяюем]\b/i, "people/sergey"],
  ];
  for (const [re, entity] of rules) {
    if (re.test(lower)) return entity;
  }
  return "projects/engram";
}

function buildFact(candidate, date) {
  const category = candidate.category || classifyText(candidate.text) || "context";
  const confidence = category === "decision" || category === "preference" || category === "correction" ? 0.85 : 0.7;
  const abstraction = category === "preference" ? "pattern" : "episode";
  return {
    entity: inferEntity(candidate.text),
    fact: candidate.text.replace(/\s+/g, " ").slice(0, 500),
    description: `${candidate.source === "session" ? "Session" : "Daily note"} extraction ${date}`.slice(0, 150),
    category,
    confidence,
    abstraction,
    tags: ["heartbeat", "extraction", candidate.source].join(","),
    source: date,
  };
}

function runMemoryWrite(fact) {
  if (noWrite) return { status: "dry-run", fact: { id: "dry-run" } };
  const args = [
    join(scriptDir, "memory-write.js"),
    "--entity", fact.entity,
    "--fact", fact.fact,
    "--description", fact.description,
    "--category", fact.category,
    "--confidence", String(fact.confidence),
    "--abstraction", fact.abstraction,
    "--tags", fact.tags,
    "--source", fact.source,
    "--entity-create",
  ];
  if (semanticCheck) args.push("--semantic-check", "--search-collections", "life");
  if (["preference", "decision", "correction"].includes(fact.category)) args.push("--check-contradictions");

  const proc = spawnSync("bun", args, { cwd: workspace, env: { ...process.env, ENGRAM_WORKSPACE: workspace }, encoding: "utf8", shell: false, timeout: 300000 });
  if (proc.status !== 0) {
    return { status: "error", error: proc.stderr || proc.stdout || proc.error?.message || "memory-write failed" };
  }
  try { return JSON.parse(proc.stdout || "{}"); } catch { return { status: "unknown", stdout: proc.stdout }; }
}

async function updateWatermark(notePath, processedLine) {
  const raw = await readFile(notePath, "utf8");
  const body = removeWatermarks(raw).trimEnd() + "\n";
  const lastLine = Math.max(processedLine, lineCount(body));
  await atomicWrite(notePath, body + `<!-- extracted:L${lastLine}:${localIso()} -->\n`);
  return lastLine;
}

function handoffBlock({ status, summary, stats, flags = [], tensions = [], alerts = [] }) {
  return [
    "=== HB-EXTRACT HANDOFF ===",
    `Status: ${status}`,
    `Summary: ${summary}`,
    `Stats: ${JSON.stringify(stats)}`,
    `Flags: ${JSON.stringify(flags)}`,
    `Tensions: ${JSON.stringify(tensions)}`,
    `Alerts: ${JSON.stringify(alerts)}`,
    "=== END ===",
  ].join("\n");
}

export async function runExtraction() {
  const notePath = join(workspace, "memory", agentDir, session, date + ".md");
  if (!existsSync(notePath)) {
    mkdirSync(dirname(notePath), { recursive: true });
    await writeFile(notePath, `# ${date}\n\n## Events\n\n## Decisions\n\n## Learnings\n\n## Active Threads\n\n## Next\n`);
  }

  const statePath = join(workspace, "memory", "heartbeat-state.json");
  let state = {};
  try { state = JSON.parse(await readFile(statePath, "utf8")); } catch {}
  const lastSessionExtracted = opts["last-session-extracted"] || state.lastSessionExtracted?.[session] || null;

  const dailyContent = await readFile(notePath, "utf8");
  const daily = collectDailyCandidates(dailyContent);
  const sessions = await collectSessionFiles({ workspace, agentDir, session, lastSessionExtracted });

  const sessionCandidates = [];
  let lastSessionFile = null;
  for (const file of sessions.files) {
    sessionCandidates.push(...collectSessionCandidates(file));
    lastSessionFile = file.name;
  }

  const allCandidates = [...daily.candidates, ...sessionCandidates];
  let factsWritten = 0;
  let factsSkipped = 0;
  let factsPlanned = 0;
  const tensions = [];
  const flags = [];

  for (const candidate of allCandidates) {
    const result = runMemoryWrite(buildFact(candidate, date));
    if (result.status === "created") factsWritten++;
    else if (result.status === "dry-run") factsPlanned++;
    else if (result.status === "skipped") factsSkipped++;
    else {
      flags.push(`CANDIDATE_OBS: extraction write failed for ${candidate.source} line ${candidate.line}: ${result.error || result.status}`);
      const block = handoffBlock({
        status: "error",
        summary: `write failed after ${factsWritten} facts`,
        stats: { facts_written: factsWritten, facts_skipped_dedup: factsSkipped, new_watermark: `L${daily.watermark?.watermark ?? 0}`, last_session_file: null, sessions_processed: sessions.files.length },
        flags,
        tensions,
      });
      return { handoff: parseHandoff(block), block };
    }
    if (Array.isArray(result.tensions)) tensions.push(...result.tensions);
  }

  const watermarkAdvanced = !noWrite || advanceWatermarkOnNoWrite;
  const newWatermark = watermarkAdvanced
    ? await updateWatermark(notePath, daily.lastLine)
    : (daily.watermark?.watermark ?? 0);
  const stats = {
    facts_written: factsWritten,
    facts_skipped_dedup: factsSkipped,
    facts_planned: factsPlanned,
    new_watermark: `L${newWatermark}`,
    previous_watermark: `L${daily.watermark?.watermark ?? 0}`,
    last_session_file: watermarkAdvanced ? lastSessionFile : null,
    sessions_processed: sessions.files.length,
    daily_candidates: daily.candidates.length,
    session_candidates: sessionCandidates.length,
    dry_run: noWrite,
    watermark_advanced: watermarkAdvanced,
  };
  const summary = noWrite
    ? `dry-run planned ${factsPlanned} facts (${factsSkipped} skipped), daily L${daily.watermark?.watermark ?? 0}->L${newWatermark}${watermarkAdvanced ? "" : " (watermark not advanced)"}, sessions ${sessions.files.length}`
    : `extracted ${factsWritten} facts (${factsSkipped} skipped), daily L${daily.watermark?.watermark ?? 0}->L${newWatermark}, sessions ${sessions.files.length}`;
  const block = handoffBlock({ status: "ok", summary, stats, flags, tensions });
  return { handoff: parseHandoff(block), block };
}

if (import.meta.main) {
  runExtraction().then(({ handoff, block }) => {
    if (!handoff.ok) {
      console.error("[extract-runner] failed to build handoff");
      process.exit(1);
    }
    console.log(block);
    process.exit(handoff.status === "ok" ? 0 : 1);
  }).catch((err) => {
    const block = handoffBlock({
      status: "error",
      summary: err?.message || String(err),
      stats: { facts_written: 0, facts_skipped_dedup: 0, new_watermark: "L0", last_session_file: null },
      flags: [`CANDIDATE_OBS: extract-runner crashed: ${err?.message || String(err)}`],
    });
    console.log(block);
    process.exit(1);
  });
}
