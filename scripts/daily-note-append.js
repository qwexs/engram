#!/usr/bin/env bun
// Запись записей в секции daily note во время сессии
// Использование: bun skills/engram/scripts/daily-note-append.js
//   --session main --agent-id main --section events --text "текст записи"

import { join, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import { loadEngramConfig } from "./config.js";

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
const workspace = opts.workspace || WORKSPACE;

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
const agentId = opts["agent-id"] || config.agent.replace(/^agent-/, "") || "main";
const session = opts.session;
const sectionTitle = SECTION_MAP[sectionKey];
const text = opts.text.trim();

// --- Определение пути к daily note ---
const TZ = process.env.ENGRAM_TZ || process.env.TZ || "Europe/Moscow";
const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });

const noteDir = join(workspace, "memory", `agent-${agentId}`, session);
const notePath = join(noteDir, `${today}.md`);

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

// --- Создать директорию если нет ---
if (!existsSync(noteDir)) {
  mkdirSync(noteDir, { recursive: true });
}

// --- Прочитать или создать файл ---
let content;
if (existsSync(notePath)) {
  content = await Bun.file(notePath).text();
} else {
  content = buildTemplate(today);
  await Bun.write(notePath, content);
}

// --- Найти секцию и вставить запись ---
const entry = `- ${text}`;

// Разбить на строки, сохраняя структуру
const lines = content.split("\n");

// Найти индекс заголовка секции (## SectionTitle)
const sectionHeader = `## ${sectionTitle}`;
let sectionIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === sectionHeader) {
    sectionIdx = i;
    break;
  }
}

if (sectionIdx === -1) {
  console.error(`❌ Секция "${sectionHeader}" не найдена в ${notePath}`);
  process.exit(1);
}

// Найти конец секции (следующий ## заголовок или EOF)
// Игнорировать: ## Heartbeat Report, <!-- extracted:... -->
let insertIdx = sectionIdx + 1;
while (insertIdx < lines.length) {
  const line = lines[insertIdx];
  // Стоп-условие: другой ## заголовок (кроме ### подзаголовков внутри текущей секции)
  if (/^## /.test(line) && line.trim() !== sectionHeader) {
    break;
  }
  // Стоп-условие: watermark extracted (всегда в конце файла)
  if (/^<!-- extracted:/.test(line)) {
    break;
  }
  insertIdx++;
}

// Вставить запись: ищем последнюю непустую строку секции, добавляем после
// Найти последнюю непустую строку в секции (между sectionIdx+1 и insertIdx)
let lastContentLine = sectionIdx; // если секция пустая — вставим сразу после заголовка
for (let i = sectionIdx + 1; i < insertIdx; i++) {
  if (lines[i].trim() !== "") {
    lastContentLine = i;
  }
}

// Вставить строку после lastContentLine
lines.splice(lastContentLine + 1, 0, entry);

const newContent = lines.join("\n");
await Bun.write(notePath, newContent);

console.log(JSON.stringify({
  status: "appended",
  section: sectionKey,
  sectionTitle,
  file: notePath,
  entry,
}));
