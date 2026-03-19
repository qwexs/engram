#!/usr/bin/env bun
// Список экспериментов Autoresearch с фильтрацией
// Использование: bun skills/engram/scripts/list-experiments.js [--status pending] [--limit 10] [--json]

import { listByStatus, loadRegistry } from "./experiments-registry.js";

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

const status = opts.status || null;
const limit = opts.limit ? parseInt(opts.limit, 10) : 0;
const jsonOutput = opts.json || false;

const VALID_STATUSES = ["pending", "running", "completed", "failed", "skipped"];
if (status && !VALID_STATUSES.includes(status)) {
  console.error(`❌ Статус должен быть одним из: ${VALID_STATUSES.join(", ")}`);
  process.exit(1);
}

// Загрузка реестра для статистики
const registry = await loadRegistry();

// Загрузка экспериментов
let experiments = await listByStatus(status);

// Применение лимита
if (limit > 0) {
  experiments = experiments.slice(0, limit);
}

// Вывод
if (jsonOutput) {
  console.log(JSON.stringify({
    stats: registry.stats,
    experiments,
  }, null, 2));
} else {
  // Человеко-читаемый вывод
  console.log("=== Статистика экспериментов ===");
  console.log(`Всего: ${registry.stats.total}`);
  console.log(`Pending: ${registry.stats.pending}`);
  console.log(`Running: ${registry.stats.running}`);
  console.log(`Completed: ${registry.stats.completed}`);
  console.log(`Failed: ${registry.stats.failed}`);
  console.log(`Skipped: ${registry.stats.skipped}`);
  console.log();

  if (experiments.length === 0) {
    console.log("Эксперименты не найдены");
  } else {
    console.log(`=== Эксперименты ${status ? `(status: ${status})` : ""} ===`);
    for (const exp of experiments) {
      console.log(`\n[${exp.id}] ${exp.status.toUpperCase()}`);
      console.log(`  Тип: ${exp.type}`);
      console.log(`  Гипотеза: ${exp.hypothesis}`);
      console.log(`  Создан: ${exp.created_at}`);
      if (exp.result_summary) {
        console.log(`  Результат: ${exp.result_summary}`);
      }
      if (exp.source_observations && exp.source_observations.length > 0) {
        console.log(`  Источники: ${exp.source_observations.join(", ")}`);
      }
    }
  }
}
