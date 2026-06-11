#!/usr/bin/env bun
// Продвижение наблюдения (obs) в KG или архивация
//
// Promote:
//   bun skills/engram/scripts/memory-promote.js \
//     --obs-id obs-0002 --entity "projects/engram" \
//     --fact "Extraction misses content when daily note has only heartbeat markers" \
//     --category context --confidence 0.8 --abstraction pattern \
//     --tags "extraction,watermark" [--dry-run]
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

// ================================================================
// РЕЖИМ ПРОДВИЖЕНИЯ В KG
// ================================================================
if (!opts.entity || !opts.fact || !opts.category || !opts.confidence) {
  console.error("❌ Для promote требуются: --entity, --fact, --category, --confidence");
  console.error("   Для архивации добавьте флаг --archive");
  process.exit(1);
}

// --- Сформировать аргументы для memory-write.js ---
const writeArgs = [
  "bun", join(import.meta.dir, "memory-write.js"),
  "--entity", opts.entity,
  "--fact", opts.fact,
  "--category", opts.category,
  "--confidence", opts.confidence,
  "--source", obsId,  // backlink: KG fact.source = obs-id
];

if (opts.description) writeArgs.push("--description", opts.description);
if (opts.abstraction) writeArgs.push("--abstraction", opts.abstraction);
if (opts.tags) writeArgs.push("--tags", opts.tags);
if (opts.related) writeArgs.push("--related", opts.related);
writeArgs.push("--entity-create");
writeArgs.push("--semantic-check", "--search-collections", "life");

// --- Dry-run: вывести план и выйти ---
if (opts["dry-run"]) {
  console.log(JSON.stringify({
    status: "dry-run",
    mode: "promote",
    obsId,
    observation: obs.observation,
    would_call: writeArgs.slice(1).join(" "),
    would_set_obs: { status: "promoted", promotedAt: now },
  }, null, 2));
  process.exit(0);
}

// --- Вызов memory-write.js ---
const proc = Bun.spawn(writeArgs, { cwd: WORKSPACE, stdout: "pipe", stderr: "pipe" });
const outText = await new Response(proc.stdout).text();
const errText = await new Response(proc.stderr).text();
await proc.exited;

let writeResult;
try {
  writeResult = JSON.parse(outText);
} catch {
  console.error("❌ memory-write.js вернул не-JSON:", outText, errText);
  process.exit(1);
}

if (writeResult.status !== "created") {
  console.error("❌ memory-write.js вернул статус:", writeResult.status, writeResult);
  process.exit(1);
}

const kgFactId = writeResult.fact?.id;

// --- Обновить наблюдение: promoted + backlink ---
obs.status = "promoted";
obs.promotedAt = now;
obs.kgFactId = kgFactId || null;
await Bun.write(obsPath, JSON.stringify(obs, null, 2));

// --- Обновить stats в index.json ---
await updateIndexStats();

console.log(JSON.stringify({
  status: "promoted",
  obsId,
  kgFactId,
  entity: opts.entity,
  fact: opts.fact.slice(0, 80),
}));

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
