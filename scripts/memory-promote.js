#!/usr/bin/env bun
// Архивация observation. Automatic observation → KG promotion was retired
// after the KG v3 cutover; canonical assertions enter only through typed ingress.
//
// Archive:
//   bun skills/engram/scripts/memory-promote.js \
//     --archive --obs-id obs-0003 --reason "domain status report, not friction"

import { join } from "path";

const WORKSPACE = process.env.ENGRAM_WORKSPACE || process.cwd() || join(import.meta.dir, "..", "..", "..");
const OBS_DIR = join(WORKSPACE, "workspace", "ops", "observations");

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
const now = new Date().toISOString();

// --- Валидация базовых аргументов ---
if (!opts["obs-id"]) {
  console.error("❌ Требуется --obs-id");
  process.exit(1);
}

const obsId = opts["obs-id"];
const obsPath = join(OBS_DIR, `${obsId}.json`);

// --- Загрузить наблюдение ---
let obs;
try {
  obs = await Bun.file(obsPath).json();
} catch {
  console.error(`❌ Наблюдение ${obsId} не найдено: ${obsPath}`);
  process.exit(1);
}

if (obs.status !== "pending") {
  console.error(`❌ Наблюдение ${obsId} имеет статус "${obs.status}" — ожидался "pending"`);
  process.exit(1);
}

// ================================================================
// РЕЖИМ АРХИВАЦИИ
// ================================================================
if (opts.archive) {
  const reason = opts.reason || "archived manually";

  if (opts["dry-run"]) {
    console.log(JSON.stringify({
      status: "dry-run",
      mode: "archive",
      obsId,
      would_set: { status: "archived", archivedAt: now, archiveReason: reason },
    }, null, 2));
    process.exit(0);
  }

  obs.status = "archived";
  obs.archivedAt = now;
  obs.archiveReason = reason;
  await Bun.write(obsPath, JSON.stringify(obs, null, 2));
  await updateIndexStats();

  console.log(JSON.stringify({ status: "archived", obsId, reason }));
  process.exit(0);
}

console.error("❌ Automatic observation → KG promotion is retired; use typed KG v3 ingress for an explicit durable assertion");
process.exit(1);

// ================================================================
// Утилита: пересчитать stats из всех obs файлов и обновить index
// ================================================================
async function updateIndexStats() {
  let index;
  const indexPath = join(OBS_DIR, "index.json");
  try {
    index = await Bun.file(indexPath).json();
  } catch {
    index = { observations: [], lastId: 0 };
  }

  // Пересчитать stats из файлов (точно, не инкрементально)
  const stats = { total: 0, pending: 0, promoted: 0, implemented: 0, archived: 0 };
  for (const obsId of (index.observations || [])) {
    try {
      const o = await Bun.file(join(OBS_DIR, `${obsId}.json`)).json();
      stats.total++;
      const s = o.status || "pending";
      if (s === "pending") stats.pending++;
      else if (s === "promoted") stats.promoted++;
      else if (s === "implemented") stats.implemented++;
      else if (s === "archived") stats.archived++;
    } catch {}
  }

  index.stats = stats;
  await Bun.write(indexPath, JSON.stringify(index, null, 2));
}
