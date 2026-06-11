#!/usr/bin/env bun
// Обновление статуса эксперимента Autoresearch
// Использование: bun skills/engram/scripts/update-experiment.js --id EXP-... --status completed [--summary "..."] [--report-path <path>]

import { join } from "path";
import { updateStatus } from "./experiments-registry.js";

const WORKSPACE = process.env.ENGRAM_WORKSPACE || process.cwd() || join(import.meta.dir, "..", "..", "..");
const RESEARCH_DIR = join(WORKSPACE, "workspace", "research");

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

if (!opts.id) {
  console.error("❌ Требуется --id EXP-YYYY-MM-DD-NNN");
  process.exit(1);
}

if (!opts.status) {
  console.error("❌ Требуется --status <pending|running|completed|failed|skipped>");
  process.exit(1);
}

const VALID_STATUSES = ["pending", "running", "completed", "failed", "skipped"];
if (!VALID_STATUSES.includes(opts.status)) {
  console.error(`❌ Статус должен быть одним из: ${VALID_STATUSES.join(", ")}`);
  process.exit(1);
}

const id = opts.id;
const status = opts.status;
const summary = opts.summary || null;
const reportPath = opts["report-path"] || null;

const expDir = join(RESEARCH_DIR, id);

// Проверка существования эксперимента
const specFile = Bun.file(join(expDir, "spec.yaml"));
if (!(await specFile.exists())) {
  console.error(`❌ Эксперимент ${id} не найден`);
  process.exit(1);
}

// Обновление статуса в реестре и meta.json
try {
  await updateStatus(id, status, summary);
} catch (e) {
  console.error("❌ Ошибка обновления статуса:", e.message);
  process.exit(1);
}

// Копирование отчета если указан --report-path
if (reportPath) {
  try {
    const reportSourceFile = Bun.file(reportPath);
    if (!(await reportSourceFile.exists())) {
      console.error(`❌ Файл отчета не найден: ${reportPath}`);
      process.exit(1);
    }

    const reportContent = await reportSourceFile.text();
    const reportDestPath = join(expDir, "report.md");
    await Bun.write(reportDestPath, reportContent);
  } catch (e) {
    console.error("❌ Ошибка копирования отчета:", e.message);
    process.exit(1);
  }
}

console.log(JSON.stringify({
  status: "updated",
  id,
  new_status: status,
  summary: summary || undefined,
  report: reportPath ? join(expDir, "report.md") : undefined,
}));
