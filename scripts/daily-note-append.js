#!/usr/bin/env bun
// Запись записей в секции daily note во время сессии
// Использование: bun skills/engram/scripts/daily-note-append.js
//   --session main --agent-id main --section events --text "текст записи"
//   --retrieval-id heartbeat-lock --retrieval-title "Heartbeat stale-lock repair"

import { join, dirname, isAbsolute, resolve } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { loadEngramConfig } from "./config.js";
import { withDailyNoteLock } from "../src/daily-note-lock.ts";
import { markWorkspaceQmdDirty } from "../src/qmd/maintenance-integration.ts";
import { normalizeSessionSegment, splitCanonicalSessionKey } from "../src/session-key.ts";
import { observerOwnsDailyCapture } from "./_lib/observer-daily-ownership.ts";

// Т.к. скрипт в skills/engram/scripts/, workspace на 3 уровня выше
const WORKSPACE = process.env.ENGRAM_WORKSPACE || process.cwd() || join(import.meta.dir, "..", "..", "..");

const SECTION_MAP = {
  events: "Events",
  decisions: "Decisions",
  learnings: "Learnings",
  threads: "Active Threads",
  next: "Next",
};

// --- Парсинг аргументов ---
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      opts[args[i].slice(2)] = args[i + 1];
      i++;
    } else if (args[i].startsWith("--")) {
      opts[args[i].slice(2)] = true;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv);

// --- Workspace override ---
if (opts.workspace && !isAbsolute(opts.workspace)) {
  console.error(`❌ --workspace должен быть абсолютным путём: "${opts.workspace}"`);
  process.exit(1);
}
const workspace = resolve(opts.workspace || WORKSPACE);

// Explicit historical source repair, not foreground Events/Decisions capture.
// No --text replacement is accepted: the quotation is copied from verified evidence.
if (opts["restore-source-of"]) {
  const allowed = new Set(["workspace", "session", "restore-source-of", "bundle-file", "authorized-by", "authorized-at", "apply"]);
  if (Object.keys(opts).some(key => !allowed.has(key)) || !opts.workspace || !opts.session) {
    throw new Error("source repair requires explicit --workspace and --session; arbitrary text/section options are forbidden");
  }
  const { restoreAppliedSourceQuote } = await import("../src/memory-observation/source-quote-correction.ts");
  const result = await restoreAppliedSourceQuote({ workspace, session: opts.session, observationId: opts["restore-source-of"],
    bundleFile: opts["bundle-file"], authorizedBy: opts["authorized-by"], authorizedAt: opts["authorized-at"], apply: opts.apply === true });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// --- Валидация ---
if (!opts.session) {
  console.error("❌ Требуется --session (например: main, telegram-12345)");
  process.exit(1);
}

if (!opts.section) {
  console.error("❌ Требуется --section: events | decisions | learnings | threads | next");
  process.exit(1);
}

if (!opts.text) {
  console.error("❌ Требуется --text — текст для добавления");
  process.exit(1);
}

const sectionKey = opts.section.toLowerCase();
if (!SECTION_MAP[sectionKey]) {
  console.error(`❌ Неверная секция "${opts.section}". Допустимые: ${Object.keys(SECTION_MAP).join(", ")}`);
  process.exit(1);
}

const config = loadEngramConfig(workspace);
const splitSession = splitCanonicalSessionKey(opts.session);
const agentId = opts["agent-id"] || splitSession?.agentId || config.agent.replace(/^agent-/, "") || "main";
const session = splitSession?.sessionKey || normalizeSessionSegment(opts.session);
const RUNTIME_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (session && RUNTIME_UUID_RE.test(session)) {
  console.error(`❌ --session не может быть runtime/turn UUID: "${opts.session}". Передайте стабильный canonical session key.`);
  process.exit(1);
}
if (!session) {
  console.error(`❌ Небезопасный или пустой --session: "${opts.session}"`);
  process.exit(1);
}
if ((sectionKey === "events" || sectionKey === "decisions") && observerOwnsDailyCapture(workspace, agentId, session)) {
  console.error("Observer owns Events/Decisions in this partition; foreground capture is disabled.");
  process.exit(1);
}
const sectionTitle = SECTION_MAP[sectionKey];
const text = opts.text.trim();
const recordKind = sectionKey === "decisions" ? "decision" : sectionKey === "learnings" ? "learning" : null;
const recordTimestamp = recordKind ? new Date().toISOString() : null;
const retrievalId = typeof opts["retrieval-id"] === "string" ? opts["retrieval-id"].trim() : "";
const retrievalTitle = typeof opts["retrieval-title"] === "string" ? opts["retrieval-title"].trim() : "";

if (Boolean(retrievalId) !== Boolean(retrievalTitle)) {
  console.error("❌ Для retrieval-card нужны оба параметра: --retrieval-id и --retrieval-title");
  process.exit(1);
}

if (retrievalId && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(retrievalId)) {
  console.error("❌ --retrieval-id: строчные латинские буквы, цифры и дефисы; максимум 80 символов");
  process.exit(1);
}

// --- Определение пути к daily note ---
const TZ = process.env.ENGRAM_TZ || process.env.TZ || "Europe/Moscow";
const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });

const noteDir = join(workspace, "memory", `agent-${agentId}`, session);
const notePath = join(noteDir, `${today}.md`);
const retrievalDir = join(noteDir, "retrieval");
const retrievalPath = retrievalId ? join(retrievalDir, `${today}-${retrievalId}.md`) : null;

if (retrievalPath && existsSync(retrievalPath)) {
  console.error(`❌ Retrieval-card уже существует: ${retrievalPath}`);
  process.exit(1);
}

// --- Шаблон для нового файла ---
function buildTemplate(date) {
  return `# ${date}

## Events

## Decisions

## Learnings

## Active Threads

## Next
`;
}

const entry = `- ${text}`;
const entryLines = recordKind
  ? ["", `### ${recordTimestamp} — ${recordKind}`, "", entry]
  : [entry];

withDailyNoteLock(notePath, () => {
  if (!existsSync(noteDir)) mkdirSync(noteDir, { recursive: true });
  const content = existsSync(notePath) ? readFileSync(notePath, "utf8") : buildTemplate(today);
  const lines = content.split("\n");
  const sectionHeader = `## ${sectionTitle}`;
  let sectionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === sectionHeader) {
      sectionIdx = i;
      break;
    }
  }
  if (sectionIdx === -1) throw new Error(`Секция "${sectionHeader}" не найдена в ${notePath}`);

  let insertIdx = sectionIdx + 1;
  while (insertIdx < lines.length) {
    const line = lines[insertIdx];
    if (/^## /.test(line) && line.trim() !== sectionHeader) break;
    if (/^<!-- extracted:/.test(line)) break;
    insertIdx++;
  }
  let lastContentLine = sectionIdx;
  for (let i = sectionIdx + 1; i < insertIdx; i++) {
    if (lines[i].trim() !== "") lastContentLine = i;
  }
  lines.splice(lastContentLine + 1, 0, ...entryLines);
  writeFileSync(notePath, lines.join("\n"), "utf8");
});

if (retrievalPath) {
  mkdirSync(retrievalDir, { recursive: true });
  const sourcePath = `memory/agent-${agentId}/${session}/${today}.md`;
  const retrievalCard = `# ${retrievalTitle}

- **Type:** retrieval event card
- **Date:** ${today}
- **Source:** \`${sourcePath}\` — ${sectionTitle}

## Summary

${text}
`;
  await Bun.write(retrievalPath, retrievalCard);
}

await markWorkspaceQmdDirty({
  workspace,
  reason: `daily-note-append:${sectionKey}`,
});

console.log(JSON.stringify({
  status: "appended",
  section: sectionKey,
  sectionTitle,
  file: notePath,
  entry,
  recordTimestamp,
  retrievalCard: retrievalPath,
}));
