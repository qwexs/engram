#!/usr/bin/env bun
// Запись tension (противоречий между фактами) в OLL
// Использование: bun skills/engram/scripts/memory-tension.js
//   --tension "описание противоречия" --fact1 "id1" --fact2 "id2" [--description "контекст"]

import { join } from "path";

// Скрипт в skills/engram/scripts/ — workspace на 3 уровня выше
const WORKSPACE = process.env.ENGRAM_WORKSPACE || join(import.meta.dir, "..", "..", "..");
const TENSION_DIR = join(WORKSPACE, "ops", "tensions");

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

// --- Валидация ---
if (!opts.tension) {
  console.error("❌ Требуется --tension");
  process.exit(1);
}

if (!opts.fact1 || !opts.fact2) {
  console.error("❌ Требуется --fact1 и --fact2");
  process.exit(1);
}

// --- Проверка существования фактов в KG ---
async function validateFact(factId) {
  const glob = new Bun.Glob("**/items.json");
  const lifeDir = join(WORKSPACE, "life");
  for await (const file of glob.scan({ cwd: lifeDir, absolute: true })) {
    try {
      const data = await Bun.file(file).json();
      if (data.facts?.find(f => f.id === factId)) {
        return true;
      }
    } catch {}
  }
  return false;
}

if (!(await validateFact(opts.fact1))) {
  console.error(`❌ Факт ${opts.fact1} не найден в KG (life/**/items.json)`);
  process.exit(1);
}
if (!(await validateFact(opts.fact2))) {
  console.error(`❌ Факт ${opts.fact2} не найден в KG (life/**/items.json)`);
  process.exit(1);
}

// --- Jaccard similarity для novelty check ---
function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(w => w.length > 3);
}

function jaccardSimilarity(words1, words2) {
  const set1 = new Set(words1);
  const set2 = new Set(words2);
  const intersection = [...set1].filter(w => set2.has(w));
  const union = new Set([...set1, ...set2]);
  return union.size > 0 ? intersection.length / union.size : 0;
}

// --- Параметры ---
const tension = opts.tension.trim().slice(0, 500);
const description = opts.description ? opts.description.slice(0, 150).trim() : undefined;
const TZ = process.env.ENGRAM_TZ || process.env.TZ || "Europe/Moscow";
const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
const now = new Date().toISOString();

// --- Создать директорию если нет ---
await Bun.write(join(TENSION_DIR, ".gitkeep"), "");

// --- Загрузить индекс ---
let existing;
try {
  existing = (await Bun.file(join(TENSION_DIR, "index.json")).exists())
    ? await Bun.file(join(TENSION_DIR, "index.json")).json()
    : { tensions: [], lastId: 0 };
} catch {
  existing = { tensions: [], lastId: 0 };
}

// --- Novelty check: Jaccard >0.7 с существующими tensions → skip ---
if (existing.tensions.length > 0) {
  const newKeywords = extractKeywords(tension);
  let maxSimilarity = 0;
  let similarId = null;

  for (const tensionId of existing.tensions.slice(-20)) {
    try {
      const tData = await Bun.file(join(TENSION_DIR, `${tensionId}.json`)).json();
      if (tData.status === "resolved") continue;
      const existingKeywords = extractKeywords(tData.tension);
      const sim = jaccardSimilarity(newKeywords, existingKeywords);
      if (sim > maxSimilarity) {
        maxSimilarity = sim;
        similarId = tensionId;
      }
    } catch {}
  }

  if (maxSimilarity > 0.7) {
    console.log(JSON.stringify({
      status: "skipped",
      reason: "Duplicate tension",
      similarId,
      similarity: parseFloat(maxSimilarity.toFixed(3)),
    }));
    process.exit(0);
  }
}

// --- Создать tension ---
const nextNum = (existing.lastId || 0) + 1;
const tensionId = `tension-${String(nextNum).padStart(4, "0")}`;

const newTension = {
  id: tensionId,
  tension,
  fact1: opts.fact1,
  fact2: opts.fact2,
  description: description || undefined,
  status: "pending",
  createdAt: now,
  resolvedAt: null,
  resolution: null,
};

// Убрать undefined поля
if (!newTension.description) delete newTension.description;

const tensionPath = join(TENSION_DIR, `${tensionId}.json`);
await Bun.write(tensionPath, JSON.stringify(newTension, null, 2));

// --- Обновить индекс ---
existing.tensions.push(tensionId);
existing.lastId = nextNum;
await Bun.write(join(TENSION_DIR, "index.json"), JSON.stringify(existing, null, 2));

console.log(JSON.stringify({
  status: "created",
  id: tensionId,
  fact1: opts.fact1,
  fact2: opts.fact2,
}));
