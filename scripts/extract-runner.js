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
import { findSimilarFacts } from "./memory-dedup.js";

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

// High-signal daily-note sections written by agents / daily-note-append.js.
// Heartbeat Report is operational noise and must never become KG candidates.
const HIGH_SIGNAL_SECTIONS = new Set([
  "Events",
  "Decisions",
  "Learnings",
  "Active Threads",
]);

/**
 * Collect extractable bullets from a daily note.
 *
 * Contract (matches daily-note-append.js + EOF watermark layout):
 * - Agents append into named sections near the top of the file.
 * - Heartbeat writes `## Heartbeat Report` and `<!-- extracted:L… -->` at EOF.
 * - Therefore new content almost always sits ABOVE the watermark comment.
 *
 * Watermark is a completion marker ("extract ran for this note version"), not
 * a mid-file scan cursor. Idempotency for already-promoted bullets is handled
 * by memory-write.js hash/semantic dedup — not by skipping lines above the
 * comment. Scanning only after `watermark.line` permanently missed real Events/
 * and Decisions written above the EOF marker.
 */
export function collectDailyCandidates(content) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const watermark = extractLastWatermark(normalized);
  const candidates = [];
  let section = null;
  let inHeartbeatReport = false;
  let inHighSignal = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const heading = trimmed.match(/^##\s+(.+)$/);
    if (heading) {
      section = heading[1].trim();
      inHeartbeatReport = section === "Heartbeat Report";
      inHighSignal = HIGH_SIGNAL_SECTIONS.has(section);
      continue;
    }
    if (!trimmed || inHeartbeatReport || !inHighSignal) continue;
    if (/^<!--\s*(session:|extracted:)/.test(trimmed)) continue;
    if (!trimmed.startsWith("- ")) continue;

    const text = trimmed.replace(/^-\s*/, "").replace(/^\*\*[^*]+\*\*:\s*/, "").trim();
    if (!text || text.length < 12) continue;
    if (/^(Extraction|Synthesis|Domains|Maintenance):/i.test(text)) continue;
    if (/^Flag:/i.test(text)) continue;
    if (isExtractionNoise(text, { source: "daily" })) continue;

    const category =
      section === "Decisions" ? "decision"
        : section === "Learnings" ? "context"
          : "milestone";
    candidates.push({
      line: i + 1,
      section: section || "Events",
      text,
      category,
      source: "daily",
    });
  }

  return {
    watermark,
    candidates,
    lastLine: lineCount(normalized),
    scanMode: "full-high-signal",
  };
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
      if (isExtractionNoise(text, { role, source: "session" })) continue;
      const signal = classifyText(text, { role });
      if (!signal) continue;
      candidates.push({ line: i + 1, section: "Session", text, category: signal, source: "session", sessionFile: file.name });
    }
  }
  return candidates;
}

const TECHNICAL_PROCESS_NOISE = [
  /\b(?:embed|embedding)\s+process\b/i,
  /\bqmd\s+embed\b/i,
  /\bpid\s*[:=#]?\s*\d+\b/i,
  /\bprocess\s*(?:\(\s*\d+\s*\)|#?\d+)?\s+(?:already\s+)?(?:finished|completed|exited|gone|running)\b/i,
  /\bnetwork traffic\b/i,
];

function hasTechnicalProcessNoise(text) {
  return TECHNICAL_PROCESS_NOISE.some((pattern) => pattern.test(text));
}

function hasDurableCompletionContext(text) {
  return /(?:\b(?:deploy(?:ment|ed)?|release(?:d)?|migration|implementation|integration|upgrade|backup|feature|project|phase|milestone|configuration|setup|rollout|refactor|fix(?:ed)?|pipeline|workflow|service|server|application|app|database|schema|version)\b|д[её]плой|релиз|миграц|реализац|интеграц|обновлен|настройк|проект|этап|функц|исправлен|сервис|сервер|приложен|баз[аы]\s+данных|схем)/i.test(text);
}

function isExtractionNoise(text, { role = "user", source = "session" } = {}) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length < 12) return true;
  if (/\b(Exec completed|Script completed|Script failed|Exit code:|Wall time:|stdout|stderr)\b/i.test(normalized)) return true;
  if (/\b(remote: !|deploy lock|Run 'apps:unlock'|Assertion failed|SyntaxError:)\b/i.test(normalized)) return true;
  if (/\[[0-9;]{1,12}m/.test(normalized)) return true;
  if (/^\[[0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2}/.test(normalized)) return true;
  // Shared guard for raw telemetry accidentally copied into either session
  // summaries or structured daily-note Events.
  if (hasTechnicalProcessNoise(normalized)) return true;
  if (role === "assistant") {
    if (/^(Готово|Ок|Да|Проверил|Сделал|Добавил|Исправил|Запустил)[.!,:\s]/i.test(normalized)) return true;
    if (/^(Now let me|Let me|I'll|I will|I’m going to|I am going to)\b/i.test(normalized)) return true;
    if (/\b(bun test|pass\s*\/\s*0 fail|tests? passed|зел[её]н(?:ый|ая)|full gate)\b/i.test(normalized)) return true;
    // Bare assistant completion language is too easy to trigger from status
    // narration. Keep real deploy/release/migration outcomes, reject generic
    // "finished/completed" prose without durable project context.
    if (/\b(finished|completed)\b/i.test(normalized) && !hasDurableCompletionContext(normalized)) return true;
  }
  return false;
}

function classifyText(text, { role = "user" } = {}) {
  // Decision: explicit decisions, agreements, plans to act
  if (/(решил[аи]?|решили|принято решение|давай будем|будем делать|договорились|согласовали|утвердили|we decided|decision made|let\x27s go with|agreed to|approved)/i.test(text)) return "decision";
  // Preference: likes/dislikes, tool/language/framework choices
  if (/(предпочитаю|нравится|не нравится|лучше использовать|prefer|like|dislike|better to use|should use|should be)/i.test(text)) return "preference";
  // Correction: fixing wrong assumptions, clarifying
  if (/(на самом деле|поправ|correction|actually|I meant|не так|ошибся|исправил)/i.test(text)) return "correction";
  // Milestone: completed work, deployments, status changes
  if (/(запустили|задеплоили|завершили|готово|deployed|launched|released|зафиксировал|обновил|настроил|проверил|добавил|удалил|исправил|починил|установил|создал|написал|сделал)/i.test(text)) return "milestone";
  if (/\b(finished|completed)\b/i.test(text) && (role !== "assistant" || hasDurableCompletionContext(text))) return "milestone";
  // Context: notable findings, observations, status updates
  if (/(обнаружил|нашёл|выяснил|проверил|убедился|оказалось|статус|состояние|found out|discovered|turned out|status update)/i.test(text)) return "context";
  return null;
}

function inferEntity(text) {
  const lower = text.toLowerCase();
  // Generic defaults only — workspace-specific project/client routing belongs in
  // engram.json (see entityRoutes), not in the shared skill.
  const rules = [
    [/\b(engram|heartbeat|hb-|memory|kg|qmd|oll|autoresearch)\b/i, "projects/engram"],
    [/\b(openclaw|gateway|telegram|cron|runner)\b/i, "projects/openclaw"],
    [/\b(vpn|wireguard|dnsmasq|apriori-vm)\b/i, "projects/vpn"],
    [/\b(outline)\b/i, "projects/outline"],
    [/\b(projectmix)\b/i, "projects/projectmix"],
    [/\b(telemax)\b/i, "projects/telemax"],
    [/\b(qmd)\b/i, "projects/qmd"],
    [/\balice|алис[аыуеой]\b/i, "people/alice"],
  ];
  // Optional per-workspace map: engram.json → extraction.entityRoutes
  // { "acme|acme-corp": "projects/acme", ... } — regex source → entity path
  const configured = config?.extraction?.entityRoutes;
  if (configured && typeof configured === "object" && !Array.isArray(configured)) {
    for (const [pattern, entity] of Object.entries(configured)) {
      if (!pattern || !entity) continue;
      try {
        if (new RegExp(pattern, "i").test(text)) return String(entity);
      } catch {
        // ignore invalid regex in config
      }
    }
  }
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

// Категории, для которых допустим auto-supersede. Milestone/context/status
// пропускаются: слишком высокий риск false positive (сырые log-строки, тестовые
// outputs, ранее зачёркнутые "milestones" из quality gates).
const SUPERSEDE_CATEGORIES = new Set(["decision", "preference", "correction"]);

// Порог Jaccard для auto-supersede. Должен быть выше skip-порога (0.65 в
// memory-write.js), иначе auto-supersede будет конфликтовать с in-entity skip
// на той же similarity. По умолчанию 0.75 — оставляем запас.
const DEFAULT_SUPERSEDE_THRESHOLD = 0.75;

// Допуск между top-1 и top-2 score для трактовки как "ambiguous".
// Если разница меньше этого — считаем, что есть ничья и НЕ делаем supersede.
// Защищает от false positives когда две похожие формулировки сосуществуют
// легитимно (например, preference про разные подсистемы).
const SUPERSEDE_AMBIGUITY_MARGIN = 0.05;

/**
 * Найти существующий active fact, который можно безопасно заменить новым.
 * Только для high-confidence категорий (decision/preference/correction).
 *
 * Returns: { id, sim } | null
 *   - null если категория не supersede-eligible
 *   - null если нет кандидатов с sim >= threshold
 *   - null если есть 2+ кандидатов в пределах AMBIGUITY_MARGIN (ничейная ситуация)
 *   - { id, sim } если есть однозначный winner
 */
export async function findSupersedeTarget(fact, { workspace, threshold = DEFAULT_SUPERSEDE_THRESHOLD } = {}) {
  if (!SUPERSEDE_CATEGORIES.has(fact.category)) return null;

  const matches = await findSimilarFacts({
    workspace,
    entity: fact.entity,
    factText: fact.fact,
    threshold,
  });

  if (matches.length === 0) return null;

  // Strict ambiguity: если top-1 и top-2 в пределах margin — отказываемся.
  // Игнорируем category mismatch: если кандидат с тем же score — другая категория,
  // это всё равно легитимный конфликт (например, old был preference, new — decision
  // про то же самое), и решение должно быть ручным.
  if (matches.length >= 2 && (matches[0].sim - matches[1].sim) < SUPERSEDE_AMBIGUITY_MARGIN) {
    return { ambiguous: true, candidates: matches };
  }

  return { id: matches[0].id, sim: matches[0].sim };
}

/**
 * Записать fact через memory-write.js с поддержкой auto-supersede.
 * - Для decision/preference/correction: сначала проверяет, есть ли существующий
 *   active fact, который можно заменить (Jaccard ≥ threshold, однозначный winner).
 * - Если есть — добавляет --supersedes <id> в args memory-write.js.
 * - Если ambiguous — логируем, но НЕ передаём --supersedes (memory-write.js
 *   дальше сам решит: skip-on-jaccard или создать новый).
 *
 * Returns: { status, ..., supersede: { id, sim } | null, ambiguous: bool }
 */
async function runMemoryWriteWithSupersede(fact) {
  if (noWrite) return { status: "dry-run", fact: { id: "dry-run" }, supersede: null, ambiguous: false };

  let supersedeId = null;
  let supersedeSim = null;
  let ambiguous = false;

  if (SUPERSEDE_CATEGORIES.has(fact.category)) {
    const threshold = parseFloat(opts["supersede-threshold"]) || DEFAULT_SUPERSEDE_THRESHOLD;
    const target = await findSupersedeTarget(fact, { workspace, threshold });
    if (target && target.ambiguous) {
      ambiguous = true;
    } else if (target && target.id) {
      supersedeId = target.id;
      supersedeSim = target.sim;
    }
  }

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
  if (supersedeId) args.push("--supersedes", supersedeId);
  if (semanticCheck) args.push("--semantic-check", "--search-collections", "life");
  if (SUPERSEDE_CATEGORIES.has(fact.category)) args.push("--check-contradictions");

  const proc = spawnSync("bun", args, { cwd: workspace, env: { ...process.env, ENGRAM_WORKSPACE: workspace }, encoding: "utf8", shell: false, timeout: 300000 });
  if (proc.status !== 0) {
    return { status: "error", error: proc.stderr || proc.stdout || proc.error?.message || "memory-write failed", supersede: null, ambiguous: false };
  }
  try {
    const result = JSON.parse(proc.stdout || "{}");
    return { ...result, supersede: supersedeId ? { id: supersedeId, sim: supersedeSim } : null, ambiguous };
  } catch {
    return { status: "unknown", stdout: proc.stdout, supersede: null, ambiguous: false };
  }
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
  let supersededCount = 0;
  let supersedeAmbiguousCount = 0;
  let supersedeMinSim = null;
  const tensions = [];
  const flags = [];

  for (const candidate of allCandidates) {
    const result = await runMemoryWriteWithSupersede(buildFact(candidate, date));
    if (result.status === "created") {
      factsWritten++;
      if (result.supersede) {
        supersededCount++;
        if (supersedeMinSim === null || result.supersede.sim < supersedeMinSim) {
          supersedeMinSim = result.supersede.sim;
        }
      }
      if (result.ambiguous) supersedeAmbiguousCount++;
    }
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
  // Observability: high-signal daily bullets with zero writes and zero skips
  // means every write failed soft-path or dry-run planned nothing unexpected.
  // Dedup skips are healthy (facts_skipped > 0). Real anomalies get a flag.
  if (!noWrite && daily.candidates.length > 0 && factsWritten === 0 && factsSkipped === 0) {
    flags.push(
      `HIGH_SIGNAL_NOT_PROMOTED: ${daily.candidates.length} daily candidate(s) produced 0 created/skipped writes`
    );
  }

  const stats = {
    facts_written: factsWritten,
    facts_skipped_dedup: factsSkipped,
    facts_planned: factsPlanned,
    superseded_count: supersededCount,
    supersede_ambiguous_count: supersedeAmbiguousCount,
    supersede_min_jaccard: supersedeMinSim !== null ? Number(supersedeMinSim.toFixed(3)) : null,
    new_watermark: `L${newWatermark}`,
    previous_watermark: `L${daily.watermark?.watermark ?? 0}`,
    last_session_file: watermarkAdvanced ? lastSessionFile : null,
    sessions_processed: sessions.files.length,
    daily_candidates: daily.candidates.length,
    session_candidates: sessionCandidates.length,
    scan_mode: daily.scanMode || "full-high-signal",
    dry_run: noWrite,
    watermark_advanced: watermarkAdvanced,
  };
  const summary = noWrite
    ? `dry-run planned ${factsPlanned} facts (${factsSkipped} skipped), daily L${daily.watermark?.watermark ?? 0}->L${newWatermark}${watermarkAdvanced ? "" : " (watermark not advanced)"}, sessions ${sessions.files.length}`
    : `extracted ${factsWritten} facts (${factsSkipped} skipped, ${supersededCount} auto-superseded, ${supersedeAmbiguousCount} ambiguous), daily L${daily.watermark?.watermark ?? 0}->L${newWatermark}, sessions ${sessions.files.length}`;
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
