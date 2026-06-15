#!/usr/bin/env bun
// Запись операционных наблюдений в OLL
// Использование: bun skills/engram/scripts/memory-observe.js --observation "текст" --category friction [--description "..."] [--dry-run]

import { join } from "path";
import { extractKeywords, jaccardSimilarity } from "./utils.js";

// Скрипт в skills/engram/scripts/ — workspace на 3 уровня выше
const WORKSPACE = process.env.ENGRAM_WORKSPACE || process.cwd() || join(import.meta.dir, "..", "..", "..");
const OBS_DIR = join(WORKSPACE, "workspace", "ops", "observations");

const VALID_CATEGORIES = ["friction", "surprise", "pattern"];

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && args[i + 1] && !args[i + 1].startsWith("--")) {
      opts[args[i].slice(2)] = args[i + 1];
      i++;
    } else if (args[i].startsWith("--")) {
      opts[args[i].slice(2)] = true;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv);

if (!opts.observation) {
  console.error("❌ Требуется --observation");
  process.exit(1);
}

const category = opts.category?.toLowerCase() || "friction";

if (!VALID_CATEGORIES.includes(category)) {
  console.error(`❌ Категория должна быть: ${VALID_CATEGORIES.join(", ")}`);
  process.exit(1);
}

const observation = opts.observation.trim().slice(0, 500);
const description = opts.description ? opts.description.slice(0, 150).trim() : undefined;
const TZ = process.env.ENGRAM_TZ || process.env.TZ || "Europe/Moscow";
const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
const now = new Date().toISOString();

// --- Hard-blocker pre-check (rejects obvious junk before any file I/O) ---
// Возник из hb-rethink 2026-06-15: 4/7 obs были test/junk ("test observation text here",
// "aaa..." padding, "test observation", "test observation without category"). 57% noise rate.
// Срабатывает и в --dry-run: пользователь должен видеть причину отказа.
const HARDBLOCK_PATTERNS = [
  { name: "empty", re: /^\s*$/ },
  { name: "test-observation", re: /test observation/i },
  { name: "placeholder", re: /placeholder/i },
  { name: "single-char-repeat", re: /^(.)\1{20,}/ }, // 21+ повторов одного символа (padding типа "aaa…")
];
for (const { name, re } of HARDBLOCK_PATTERNS) {
  if (re.test(observation)) {
    console.log(JSON.stringify({ status: "rejected", reason: "hard-blocker", pattern: name }));
    process.exit(0);
  }
}

// Создать директорию если нет (даже в dry-run — проверяем состояние)
await Bun.write(join(OBS_DIR, ".gitkeep"), "");

let existing;
try {
  existing = await Bun.file(join(OBS_DIR, "index.json")).exists()
    ? await Bun.file(join(OBS_DIR, "index.json")).json()
    : { observations: [], lastId: 0 };
} catch (e) {
  existing = { observations: [], lastId: 0 };
}

// --- Novelty check (выполняется и в --dry-run) ---
if (existing.observations.length > 0) {
  const newKeywords = extractKeywords(observation);
  let maxSimilarity = 0;
  let similarObsId = null;
  
  for (const obsId of existing.observations.slice(-20)) {
    try {
      const obsData = await Bun.file(join(OBS_DIR, `${obsId}.json`)).json();
      if (obsData.status === "archived") continue;
      const existingKeywords = extractKeywords(obsData.observation);
      const sim = jaccardSimilarity(newKeywords, existingKeywords);
      if (sim > maxSimilarity) {
        maxSimilarity = sim;
        similarObsId = obsId;
      }
    } catch {}
  }
  
  if (maxSimilarity > 0.7) {
    // Дубликат — показываем skipped независимо от --dry-run
    console.log(JSON.stringify({ status: "skipped", reason: "Duplicate observation", similarId: similarObsId, similarity: maxSimilarity }));
    process.exit(0);
  }
}

const nextNum = (existing.lastId || 0) + 1;
const obsId = `obs-${String(nextNum).padStart(4, "0")}`;

const newObservation = {
  id: obsId,
  observation,
  category,
  description,
  status: "pending",
  createdAt: now,
  createdDate: today,
  promotedAt: null,
  archivedAt: null,
  accessCount: 0,
};

// --- Dry-run: вывести что было бы записано и выйти ---
if (opts["dry-run"]) {
  console.log(JSON.stringify({
    status: "dry-run",
    id: obsId,
    category,
    would_write: {
      observation_file: join(OBS_DIR, `${obsId}.json`),
      observation_data: newObservation,
      index_file: join(OBS_DIR, "index.json"),
    },
  }, null, 2));
  process.exit(0);
}

// --- Запись ---
const obsPath = join(OBS_DIR, `${obsId}.json`);
await Bun.write(obsPath, JSON.stringify(newObservation, null, 2));

existing.observations.push(obsId);
existing.lastId = nextNum;
await Bun.write(join(OBS_DIR, "index.json"), JSON.stringify(existing, null, 2));

console.log(JSON.stringify({
  status: "created",
  id: obsId,
  category
}));
