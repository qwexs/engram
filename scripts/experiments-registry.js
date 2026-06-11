#!/usr/bin/env bun
// Управление реестром экспериментов Autoresearch
// Паттерн аналогичен workspace/ops/observations/index.json

import { join } from "path";

// Скрипт в skills/engram/scripts/ — workspace на 3 уровня выше
const WORKSPACE = process.env.ENGRAM_WORKSPACE || process.cwd() || join(import.meta.dir, "..", "..", "..");
const RESEARCH_DIR = join(WORKSPACE, "workspace", "research");
const REGISTRY_PATH = join(RESEARCH_DIR, "experiments.json");

/**
 * Загрузка реестра экспериментов
 * @returns {Promise<{experiments: string[], lastIdByDate: Record<string, number>, stats: {total: number, pending: number, running: number, completed: number, failed: number, skipped: number}}>}
 */
export async function loadRegistry() {
  try {
    const file = Bun.file(REGISTRY_PATH);
    if (await file.exists()) {
      return await file.json();
    }
  } catch (e) {
    // Файл поврежден или не существует
  }

  // Дефолтный реестр
  return {
    experiments: [],
    lastIdByDate: {},
    stats: {
      total: 0,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    },
  };
}

/**
 * Сохранение реестра экспериментов
 * @param {Object} registry
 */
export async function saveRegistry(registry) {
  // Создать директорию если не существует
  await Bun.write(join(RESEARCH_DIR, ".gitkeep"), "");
  await Bun.write(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

/**
 * Генерация следующего ID для даты
 * @param {string} date - Дата в формате YYYY-MM-DD
 * @returns {Promise<string>}
 */
export async function nextId(date) {
  const registry = await loadRegistry();
  const currentNum = registry.lastIdByDate[date] || 0;
  const nextNum = currentNum + 1;
  const id = `EXP-${date}-${String(nextNum).padStart(3, "0")}`;
  return id;
}

/**
 * Добавление эксперимента в реестр
 * @param {string} id
 * @param {Object} spec
 */
export async function addExperiment(id, spec) {
  const registry = await loadRegistry();
  
  // Проверка на дубликат
  if (registry.experiments.includes(id)) {
    throw new Error(`Эксперимент ${id} уже существует в реестре`);
  }

  // Извлечение даты из ID
  const match = id.match(/^EXP-(\d{4}-\d{2}-\d{2})-(\d{3})$/);
  if (!match) {
    throw new Error(`Неверный формат ID: ${id}`);
  }
  const [, date, num] = match;
  const numInt = parseInt(num, 10);

  // Обновление lastIdByDate
  if (!registry.lastIdByDate[date] || registry.lastIdByDate[date] < numInt) {
    registry.lastIdByDate[date] = numInt;
  }

  // Добавление в список
  registry.experiments.push(id);

  // Обновление статистики
  registry.stats.total++;
  const status = spec.status || "pending";
  if (registry.stats[status] !== undefined) {
    registry.stats[status]++;
  }

  await saveRegistry(registry);
}

/**
 * Обновление статуса эксперимента
 * @param {string} id
 * @param {string} newStatus
 * @param {string} [summary]
 */
export async function updateStatus(id, newStatus, summary = null) {
  const registry = await loadRegistry();

  if (!registry.experiments.includes(id)) {
    throw new Error(`Эксперимент ${id} не найден в реестре`);
  }

  // Загрузка текущего spec для получения старого статуса
  const expDir = join(RESEARCH_DIR, id);
  const specPath = join(expDir, "spec.yaml");
  const specFile = Bun.file(specPath);

  if (!(await specFile.exists())) {
    throw new Error(`Файл спецификации не найден: ${specPath}`);
  }

  const specText = await specFile.text();
  const { parseYAML } = await import("./experiment-spec.js");
  const spec = parseYAML(specText);
  const oldStatus = spec.status || "pending";

  // Обновление статистики
  if (registry.stats[oldStatus] !== undefined && registry.stats[oldStatus] > 0) {
    registry.stats[oldStatus]--;
  }
  if (registry.stats[newStatus] !== undefined) {
    registry.stats[newStatus]++;
  }

  await saveRegistry(registry);

  // Обновление meta.json
  const TZ = process.env.ENGRAM_TZ || process.env.TZ || "Europe/Moscow";
  const now = new Date().toISOString();
  const metaPath = join(expDir, "meta.json");
  let meta = {};

  try {
    const metaFile = Bun.file(metaPath);
    if (await metaFile.exists()) {
      meta = await metaFile.json();
    }
  } catch (e) {
    // meta не существует или поврежден
  }

  meta.status = newStatus;
  meta.updatedAt = now;
  if (summary) {
    meta.summary = summary;
  }

  await Bun.write(metaPath, JSON.stringify(meta, null, 2));
}

/**
 * Получение списка экспериментов по статусу
 * @param {string} [status] - Фильтр по статусу (опционально)
 * @returns {Promise<Object[]>}
 */
export async function listByStatus(status = null) {
  const registry = await loadRegistry();
  const { parseYAML } = await import("./experiment-spec.js");
  const results = [];

  for (const id of registry.experiments) {
    const expDir = join(RESEARCH_DIR, id);
    const specPath = join(expDir, "spec.yaml");
    const specFile = Bun.file(specPath);

    if (!(await specFile.exists())) {
      continue;
    }

    const specText = await specFile.text();
    const spec = parseYAML(specText);

    if (!status || spec.status === status) {
      results.push({ id, ...spec });
    }
  }

  return results;
}

/**
 * Получение эксперимента по ID
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function getExperiment(id) {
  const registry = await loadRegistry();

  if (!registry.experiments.includes(id)) {
    return null;
  }

  const expDir = join(RESEARCH_DIR, id);
  const specPath = join(expDir, "spec.yaml");
  const metaPath = join(expDir, "meta.json");
  const reportPath = join(expDir, "report.md");

  const specFile = Bun.file(specPath);
  if (!(await specFile.exists())) {
    return null;
  }

  const { parseYAML } = await import("./experiment-spec.js");
  const specText = await specFile.text();
  const spec = parseYAML(specText);

  let meta = null;
  try {
    const metaFile = Bun.file(metaPath);
    if (await metaFile.exists()) {
      meta = await metaFile.json();
    }
  } catch (e) {
    // meta не существует
  }

  let report = null;
  try {
    const reportFile = Bun.file(reportPath);
    if (await reportFile.exists()) {
      report = await reportFile.text();
    }
  } catch (e) {
    // report не существует
  }

  return {
    id,
    spec,
    meta,
    report,
  };
}
