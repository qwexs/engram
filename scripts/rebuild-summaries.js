#!/usr/bin/env bun
// Детерминированная генерация summary.md для всех entity в life/
// Использование:
//   bun skills/engram/scripts/rebuild-summaries.js [--dry-run] [--entity areas/people/sergey] [--apply-decay]
// Без --apply-decay — поведение как раньше (все active facts).
// С --apply-decay    — применяет decay classification (Hot/Warm/Cold) и новый формат.

import { join, dirname, relative } from "path";
import { existsSync, mkdirSync } from "fs";

// Скрипт в skills/engram/scripts/ — workspace на 3 уровня выше
const WORKSPACE = process.env.ENGRAM_WORKSPACE || join(import.meta.dir, "..", "..", "..");
const LIFE_DIR = join(WORKSPACE, "life");

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
const dryRun = !!opts["dry-run"];
const applyDecay = !!opts["apply-decay"];
const entityFilter = opts.entity ? opts.entity.replace(/^\/+|\/+$/g, "") : null;

const TZ = process.env.ENGRAM_TZ || process.env.TZ || "Europe/Moscow";
const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });

// ---------------------------------------------------------------------------
// Decay: классификация факта по тиру (Hot / Warm / Cold)
// ---------------------------------------------------------------------------

/**
 * Вычислить количество дней между двумя ISO-датами (или date strings)
 * @param {string} dateStr — ISO date или date-time строка
 * @param {string} todayStr — today в формате YYYY-MM-DD
 * @returns {number} — дней прошло (дробное). NaN если дата невалидна.
 */
function daysSince(dateStr, todayStr) {
  if (!dateStr) return NaN;
  // Поддержка как "2026-01-01" так и "2026-01-01T12:00:00Z"
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return NaN;
  const t = new Date(todayStr);
  return (t.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Классифицировать факт по тиру recency.
 * @param {object} fact — объект факта из items.json
 * @param {string} todayStr — сегодняшняя дата в формате YYYY-MM-DD
 * @returns {"Hot"|"Warm"|"Cold"}
 */
function classifyFact(fact, todayStr) {
  // Опорная дата: lastAccessed > createdAt > source
  const refDate = fact.lastAccessed || fact.createdAt || fact.source || null;
  let days = daysSince(refDate, todayStr);

  // Если дата недоступна или невалидна — считаем Warm (не выбрасываем)
  if (isNaN(days) || days < 0) days = 15;

  // Порог Cold зависит от confidence
  const conf = fact.confidence ?? 0.5;
  const coldThreshold = conf < 0.5 ? 14 : 30;

  let tier;
  if (days <= 7) {
    tier = "Hot";
  } else if (days <= coldThreshold) {
    tier = "Warm";
  } else {
    tier = "Cold";
  }

  // Frequency resistance: Cold → Warm если accessCount >= 10
  if (tier === "Cold" && (fact.accessCount ?? 0) >= 10) {
    tier = "Warm";
  }

  return tier;
}

/**
 * Определить, включать ли факт в summary по матрице abstraction × tier.
 * @param {object} fact
 * @param {"Hot"|"Warm"|"Cold"} tier
 * @returns {boolean}
 */
function shouldInclude(fact, tier) {
  const abstraction = (fact.abstraction || "episode").toLowerCase();

  if (tier === "Hot") return true;   // все абстракции
  if (tier === "Warm") return true;  // все абстракции

  // Cold: только principle
  if (tier === "Cold") {
    return abstraction === "principle";
  }

  return false;
}

// ---------------------------------------------------------------------------
// Генерация summary.md — стандартный режим (без decay)
// ---------------------------------------------------------------------------
function buildSummary(entityName, entityRelPath, facts) {
  const activeFacts = facts.filter(f => f.status !== "superseded" && f.status !== "archived");
  const supersededCount = facts.length - activeFacts.length;

  if (activeFacts.length === 0) {
    return null; // Нет активных фактов — пропустить
  }

  // Сортировать по confidence desc, потом по date desc
  const sorted = [...activeFacts].sort((a, b) => {
    const confDiff = (b.confidence ?? 0.5) - (a.confidence ?? 0.5);
    if (Math.abs(confDiff) > 0.01) return confDiff;
    const dateA = a.createdAt || a.source || "";
    const dateB = b.createdAt || b.source || "";
    return dateB.localeCompare(dateA);
  });

  // Top 3-5 фактов для заголовка
  const topFacts = sorted.slice(0, 5);

  // Группировка по category
  const byCategory = {};
  for (const fact of activeFacts) {
    const cat = fact.category || "general";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(fact);
  }

  // Отображаемое имя entity
  const displayName = entityName
    .split("/")
    .pop()
    .replace(/-/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());

  let md = `# ${displayName}\n\n`;

  // Top facts (краткое превью)
  if (topFacts.length > 0) {
    md += `${topFacts.slice(0, 3).map(f => `> ${f.fact}`).join("\n")}\n\n`;
  }

  // Key Facts
  md += `## Key Facts\n\n`;
  for (const fact of topFacts) {
    const conf = fact.confidence != null ? fact.confidence : 0.5;
    const date = fact.source || (fact.createdAt ? fact.createdAt.split("T")[0] : today);
    md += `- ${fact.fact} _(confidence: ${conf.toFixed(1)}, ${date})_\n`;
  }
  md += "\n";

  // Categories
  const categories = Object.keys(byCategory).sort();
  if (categories.length > 0) {
    md += `## Categories\n\n`;
    for (const cat of categories) {
      md += `- **${cat}**: ${byCategory[cat].length} ${byCategory[cat].length === 1 ? "fact" : "facts"}\n`;
    }
    md += "\n";
  }

  // Footer
  md += `_Last updated: ${today}. ${activeFacts.length} active facts, ${supersededCount} superseded._\n`;

  return md;
}

// ---------------------------------------------------------------------------
// Генерация summary.md — режим decay (--apply-decay)
// ---------------------------------------------------------------------------

/**
 * Построить краткий обзор из Hot-фактов (2-3 предложения).
 * Берём до 3 hot-фактов и объединяем их тексты в связный параграф.
 */
function buildOverview(hotFacts) {
  if (hotFacts.length === 0) return "";
  // Берём до 3 самых уверенных hot-фактов
  const top = hotFacts.slice(0, 3);
  return top.map(f => f.fact.endsWith(".") ? f.fact : f.fact + ".").join(" ");
}

/**
 * Построить summary.md с decay-фильтрацией.
 * @returns {{ content: string|null, decayStats: object }}
 */
function buildSummaryWithDecay(entityName, entityRelPath, facts) {
  const activeFacts = facts.filter(f => f.status !== "superseded" && f.status !== "archived");

  if (activeFacts.length === 0) {
    return { content: null, decayStats: { hot: 0, warm: 0, coldIncluded: 0, coldExcluded: 0 } };
  }

  // Классифицировать каждый факт
  const classified = activeFacts.map(f => ({
    fact: f,
    tier: classifyFact(f, today),
  }));

  // Считаем статистику cold
  const coldAll = classified.filter(c => c.tier === "Cold");
  const coldIncluded = coldAll.filter(c => shouldInclude(c.fact, "Cold")); // principles
  const coldExcluded = coldAll.filter(c => !shouldInclude(c.fact, "Cold"));

  // Включаемые факты
  const included = classified.filter(c => shouldInclude(c.fact, c.tier));

  const hotFacts  = included.filter(c => c.tier === "Hot").map(c => c.fact);
  const warmFacts = included.filter(c => c.tier === "Warm").map(c => c.fact);
  // Cold, которые прошли (только principles)
  const coldPrinciples = coldIncluded.map(c => c.fact);

  const decayStats = {
    hot: hotFacts.length,
    warm: warmFacts.length,
    coldIncluded: coldPrinciples.length,
    coldExcluded: coldExcluded.length,
  };

  // Если нечего включать — пропустить
  const totalIncluded = hotFacts.length + warmFacts.length + coldPrinciples.length;
  if (totalIncluded === 0) {
    return { content: null, decayStats };
  }

  // Сортировка по accessCount desc внутри каждого тира
  const sortByAccessDesc = arr =>
    [...arr].sort((a, b) => (b.accessCount ?? 0) - (a.accessCount ?? 0));

  const sortedHot        = sortByAccessDesc(hotFacts);
  const sortedWarm       = sortByAccessDesc(warmFacts);
  const sortedColdPrinciples = sortByAccessDesc(coldPrinciples);

  // Отображаемое имя entity
  const displayName = entityName
    .split("/")
    .pop()
    .replace(/-/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());

  let md = `# ${displayName}\n\n`;

  // Обзор из Hot-фактов
  const overview = buildOverview(sortedHot);
  if (overview) {
    md += `${overview}\n\n`;
  }

  // Current (Hot)
  if (sortedHot.length > 0) {
    md += `## Current (Hot)\n\n`;
    for (const f of sortedHot) {
      const conf = f.confidence != null ? f.confidence : 0.5;
      md += `- ${f.fact} _(confidence: ${conf.toFixed(2)})_\n`;
    }
    md += "\n";
  }

  // Background (Warm)
  if (sortedWarm.length > 0) {
    md += `## Background (Warm)\n\n`;
    for (const f of sortedWarm) {
      const conf = f.confidence != null ? f.confidence : 0.5;
      md += `- ${f.fact} _(confidence: ${conf.toFixed(2)})_\n`;
    }
    md += "\n";
  }

  // Enduring (Principles) — Cold principles always included
  if (sortedColdPrinciples.length > 0) {
    md += `## Enduring (Principles)\n\n`;
    for (const f of sortedColdPrinciples) {
      const conf = f.confidence != null ? f.confidence : 0.5;
      md += `- ${f.fact} _(confidence: ${conf.toFixed(2)}, principle)_\n`;
    }
    md += "\n";
  }

  // Footer со статистикой
  md += `---\n`;
  md += `*${activeFacts.length} active facts, ${totalIncluded} included in summary`;
  md += ` (${decayStats.hot} hot, ${decayStats.warm} warm, ${decayStats.coldExcluded} cold excluded).`;
  md += ` Updated ${today}.*\n`;

  return { content: md, decayStats };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------
function simpleDiff(oldContent, newContent, label) {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  let diff = `--- ${label} (current)\n+++ ${label} (new)\n`;
  const maxLines = Math.max(oldLines.length, newLines.length);
  let changes = 0;
  for (let i = 0; i < maxLines && changes < 10; i++) {
    const old = oldLines[i] ?? "";
    const nw = newLines[i] ?? "";
    if (old !== nw) {
      diff += `L${i + 1}: - ${old}\n`;
      diff += `L${i + 1}: + ${nw}\n`;
      changes++;
    }
  }
  if (changes === 0) diff += "(no changes)\n";
  return diff;
}

// ---------------------------------------------------------------------------
// Найти все items.json в life/
// ---------------------------------------------------------------------------
async function findAllItemsJson() {
  const results = [];
  const glob = new Bun.Glob("**/items.json");
  for await (const file of glob.scan({ cwd: LIFE_DIR, absolute: true })) {
    results.push(file);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Главная логика
// ---------------------------------------------------------------------------
const stats = {
  updated: 0,
  skipped: 0,
  errors: 0,
  // Decay-статистика (заполняется только при --apply-decay)
  hot: 0,
  warm: 0,
  coldExcluded: 0,
};

let itemsFiles;
try {
  itemsFiles = await findAllItemsJson();
} catch (e) {
  console.error(`❌ Ошибка поиска items.json: ${e.message}`);
  process.exit(1);
}

if (itemsFiles.length === 0) {
  console.error("❌ Не найдено ни одного items.json в life/");
  process.exit(1);
}

for (const itemsPath of itemsFiles) {
  const entityDir = dirname(itemsPath);
  const entityRelPath = relative(LIFE_DIR, entityDir).replace(/\\/g, "/");

  // Фильтр по --entity
  if (entityFilter && entityRelPath !== entityFilter) {
    continue;
  }

  let data;
  try {
    data = await Bun.file(itemsPath).json();
  } catch (e) {
    console.error(`❌ Ошибка чтения ${itemsPath}: ${e.message}`);
    stats.errors++;
    continue;
  }

  const facts = data.facts || [];
  const entityName = data.entity || entityRelPath;

  // Выбрать режим генерации
  let newContent;
  let entityDecayStats = null;

  if (applyDecay) {
    const result = buildSummaryWithDecay(entityName, entityRelPath, facts);
    newContent = result.content;
    entityDecayStats = result.decayStats;
    // Накопить глобальную статистику
    if (entityDecayStats) {
      stats.hot          += entityDecayStats.hot;
      stats.warm         += entityDecayStats.warm;
      stats.coldExcluded += entityDecayStats.coldExcluded;
    }
  } else {
    newContent = buildSummary(entityName, entityRelPath, facts);
  }

  if (!newContent) {
    stats.skipped++;
    continue;
  }

  const summaryPath = join(entityDir, "summary.md");

  if (dryRun) {
    let oldContent = "";
    if (existsSync(summaryPath)) {
      oldContent = await Bun.file(summaryPath).text();
    }
    console.log(`\n[DRY-RUN] ${entityRelPath}/summary.md`);
    if (applyDecay && entityDecayStats) {
      console.log(
        `  decay: hot=${entityDecayStats.hot} warm=${entityDecayStats.warm}` +
        ` coldExcluded=${entityDecayStats.coldExcluded} coldIncluded(principles)=${entityDecayStats.coldIncluded}`
      );
    }
    console.log(simpleDiff(oldContent, newContent, "summary.md"));
    stats.updated++;
    continue;
  }

  // Записать файл
  try {
    mkdirSync(entityDir, { recursive: true });
    await Bun.write(summaryPath, newContent);
    stats.updated++;
  } catch (e) {
    console.error(`❌ Ошибка записи ${summaryPath}: ${e.message}`);
    stats.errors++;
  }
}

// ---------------------------------------------------------------------------
// Итоговый вывод
// ---------------------------------------------------------------------------
if (!dryRun) {
  const output = {
    updated: stats.updated,
    skipped: stats.skipped,
    errors: stats.errors,
  };
  if (applyDecay) {
    output.hot          = stats.hot;
    output.warm         = stats.warm;
    output.coldExcluded = stats.coldExcluded;
  }
  console.log(JSON.stringify(output));
} else {
  let line = `\n[DRY-RUN] Итого: ${stats.updated} обновлено, ${stats.skipped} пропущено, ${stats.errors} ошибок`;
  if (applyDecay) {
    line += ` | decay: hot=${stats.hot} warm=${stats.warm} coldExcluded=${stats.coldExcluded}`;
  }
  console.log(line);
}

if (stats.errors > 0) {
  process.exit(1);
}
