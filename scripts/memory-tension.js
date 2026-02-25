#!/usr/bin/env bun
// Запись tension (противоречий) в OLL
// Использование: bun scripts/memory-tension.js --tension "описание противоречия" --fact1 "id1" --fact2 "id2" [--description "контекст"]

import { join } from "path";

const WORKSPACE = join(import.meta.dir, "..");
const TENSION_DIR = join(WORKSPACE, "ops", "tensions");

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

if (!opts.tension) {
  console.error("❌ Требуется --tension");
  process.exit(1);
}

if (!opts.fact1 || !opts.fact2) {
  console.error("❌ Требуется --fact1 и --fact2");
  process.exit(1);
}

async function validateFact(factId) {
  const globPattern = join(WORKSPACE, "life", "**", "items.json");
  const files = await new Bun.Glob(globPattern).dots(true).toArray();
  for (const file of files) {
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
  console.error(`❌ Факт ${opts.fact1} не найден в KG`);
  process.exit(1);
}
if (!(await validateFact(opts.fact2))) {
  console.error(`❌ Факт ${opts.fact2} не найден в KG`);
  process.exit(1);
}

const tension = opts.tension.trim().slice(0, 500);
const description = opts.description ? opts.description.slice(0, 150).trim() : undefined;
const TZ = process.env.ENGRAM_TZ || process.env.TZ || "Europe/Moscow";
const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
const now = new Date().toISOString();

await Bun.write(join(TENSION_DIR, ".gitkeep"), "");

const existing = await Bun.file(join(TENSION_DIR, "index.json")).exists()
  ? await Bun.file(join(TENSION_DIR, "index.json")).json()
  : { tensions: [], lastId: 0 };

const nextNum = (existing.lastId || 0) + 1;
const tensionId = `tension-${String(nextNum).padStart(4, "0")}`;

const newTension = {
  id: tensionId,
  tension,
  description,
  factRefs: [opts.fact1, opts.fact2],
  status: "pending",
  createdAt: now,
  createdDate: today,
  resolvedAt: null,
  resolution: null,
};

const tensionPath = join(TENSION_DIR, `${tensionId}.json`);
await Bun.write(tensionPath, JSON.stringify(newTension, null, 2));

existing.tensions.push(tensionId);
existing.lastId = nextNum;
await Bun.write(join(TENSION_DIR, "index.json"), JSON.stringify(existing, null, 2));

console.log(JSON.stringify({
  status: "created",
  id: tensionId,
  factRefs: [opts.fact1, opts.fact2],
  status: "pending"
}));
