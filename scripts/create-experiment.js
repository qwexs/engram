#!/usr/bin/env bun
// Создание нового эксперимента Autoresearch
// Использование: bun skills/engram/scripts/create-experiment.js --spec <yaml-string-or-file> [--dry-run] [--stdin]

import { join } from "path";
import { parseYAML, validateExperimentSpec, generateYAML } from "./experiment-spec.js";
import { loadRegistry, nextId, addExperiment } from "./experiments-registry.js";

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

// Чтение YAML из stdin или из аргумента --spec
let yamlText = "";

if (opts.stdin) {
  // Чтение из stdin
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    yamlText += decoder.decode(chunk);
  }
} else if (opts.spec) {
  // Проверка: это файл или строка?
  try {
    const specFile = Bun.file(opts.spec);
    if (await specFile.exists()) {
      yamlText = await specFile.text();
    } else {
      yamlText = opts.spec;
    }
  } catch (e) {
    yamlText = opts.spec;
  }
} else {
  console.error("❌ Требуется --spec <yaml-string-or-file> или --stdin");
  process.exit(1);
}

if (!yamlText.trim()) {
  console.error("❌ YAML спецификация пуста");
  process.exit(1);
}

// Парсинг YAML
let spec;
try {
  spec = parseYAML(yamlText);
} catch (e) {
  console.error("❌ Ошибка парсинга YAML:", e.message);
  process.exit(1);
}

// Валидация спецификации (без ID, так как он будет назначен)
const TZ = process.env.ENGRAM_TZ || process.env.TZ || "Europe/Moscow";
const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
const now = new Date().toISOString();

// Дополнение спецификации дефолтными значениями если отсутствуют
if (!spec.id) {
  spec.id = await nextId(today);
}
if (!spec.created_by) {
  spec.created_by = "rethink";
}
if (!spec.created_at) {
  spec.created_at = now;
}
if (!spec.status) {
  spec.status = "pending";
}
if (!spec.result_summary) {
  spec.result_summary = null;
}
if (!spec.follow_up_observations) {
  spec.follow_up_observations = [];
}

// Валидация
const validation = validateExperimentSpec(spec);
if (!validation.valid) {
  console.error("❌ Валидация спецификации не прошла:");
  for (const error of validation.errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

// Dry-run: вывод того, что было бы создано
if (opts["dry-run"]) {
  const expDir = join(RESEARCH_DIR, spec.id);
  console.log(JSON.stringify({
    status: "dry-run",
    id: spec.id,
    would_write: {
      directory: expDir,
      spec_file: join(expDir, "spec.yaml"),
      registry_file: join(RESEARCH_DIR, "experiments.json"),
    },
    spec,
  }, null, 2));
  process.exit(0);
}

// Создание директории эксперимента
const expDir = join(RESEARCH_DIR, spec.id);
await Bun.write(join(expDir, ".gitkeep"), "");

// Запись spec.yaml
const specYaml = generateYAML(spec);
const specPath = join(expDir, "spec.yaml");
await Bun.write(specPath, specYaml);

// Добавление в реестр
try {
  await addExperiment(spec.id, spec);
} catch (e) {
  console.error("❌ Ошибка добавления в реестр:", e.message);
  process.exit(1);
}

console.log(JSON.stringify({
  status: "created",
  id: spec.id,
  type: spec.type,
  spec_path: specPath,
}));
