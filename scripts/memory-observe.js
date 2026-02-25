#!/usr/bin/env bun
// Запись операционных наблюдений в OLL
// Использование: bun scripts/memory-observe.js --observation "текст наблюдения" --category friction [--description "описание"]

import { join } from "path";

const WORKSPACE = join(import.meta.dir, "..");
const OBS_DIR = join(WORKSPACE, "ops", "observations");

const VALID_CATEGORIES = ["friction", "surprise", "quality"];
const VALID_EXTENDED = ["process", "methodology"];

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

if (!VALID_CATEGORIES.includes(category) && !VALID_EXTENDED.includes(category)) {
  console.error(`❌ Категория должна быть: ${VALID_CATEGORIES.join(", ")} или ${VALID_EXTENDED.join(", ")} (с --extended)`);
  process.exit(1);
}

if (VALID_EXTENDED.includes(category) && !opts.extended) {
  console.error(`❌ Категория ${category} требует флага --extended`);
  process.exit(1);
}

const observation = opts.observation.trim().slice(0, 500);
const description = opts.description ? opts.description.slice(0, 150).trim() : undefined;
const TZ = process.env.ENGRAM_TZ || process.env.TZ || "Europe/Moscow";
const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
const now = new Date().toISOString();

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

await Bun.write(join(OBS_DIR, ".gitkeep"), "");

let existing;
try {
  existing = await Bun.file(join(OBS_DIR, "index.json")).exists()
    ? await Bun.file(join(OBS_DIR, "index.json")).json()
    : { observations: [], lastId: 0 };
} catch (e) {
  existing = { observations: [], lastId: 0 };
}

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

const obsPath = join(OBS_DIR, `${obsId}.json`);
await Bun.write(obsPath, JSON.stringify(newObservation, null, 2));

existing.observations.push(obsId);
existing.lastId = nextNum;
await Bun.write(join(OBS_DIR, "index.json"), JSON.stringify(existing, null, 2));

console.log(JSON.stringify({
  status: "created",
  id: obsId,
  category,
  status: "pending"
}));
