#!/usr/bin/env bun
// Резолюция tension (закрытие противоречия)
// Использование: bun skills/engram/scripts/memory-tension-resolve.js --id tension-0001 --resolution "fact X superseded by Y"

import { join } from "path";

// Скрипт в skills/engram/scripts/ — workspace на 3 уровня выше
const WORKSPACE = process.env.ENGRAM_WORKSPACE || process.cwd() || join(import.meta.dir, "..", "..", "..");
const TENSION_DIR = join(WORKSPACE, "workspace", "ops", "tensions");

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

if (!opts.id) {
  console.error("❌ Требуется --id (например tension-0001)");
  process.exit(1);
}

if (!opts.resolution) {
  console.error("❌ Требуется --resolution \"описание решения\"");
  process.exit(1);
}

const tensionPath = join(TENSION_DIR, `${opts.id}.json`);

// Проверить существование
const file = Bun.file(tensionPath);
if (!(await file.exists())) {
  console.error(`❌ Tension ${opts.id} не найден`);
  process.exit(1);
}

const tension = await file.json();

if (tension.status === "resolved" || tension.status === "dissolved") {
  console.log(JSON.stringify({
    status: `already_${tension.status}`,
    id: opts.id,
    resolvedAt: tension.resolvedAt,
  }));
  process.exit(0);
}

// Резолюция или растворение (dissolved = противоречия нет, факты совместимы)
const finalStatus = opts.dissolved ? "dissolved" : "resolved";
tension.status = finalStatus;
tension.resolvedAt = new Date().toISOString();
tension.resolution = opts.resolution.trim().slice(0, 500);

await Bun.write(tensionPath, JSON.stringify(tension, null, 2));

console.log(JSON.stringify({
  status: finalStatus,
  id: opts.id,
  resolution: tension.resolution,
}));
