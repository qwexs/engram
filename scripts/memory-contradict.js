#!/usr/bin/env bun
// Детектор противоречий в фактах через keyword overlap
// Intra-entity: bun scripts/memory-contradict.js --fact "Prefers JS" --entity "people/sergey"
// Cross-entity: bun scripts/memory-contradict.js --fact "Prefers JS" --entity "people/sergey" --cross-entity

import { join } from "path";
import { resolveQmdCommand } from "./config.js";

const WORKSPACE = process.env.ENGRAM_WORKSPACE || process.cwd() || join(import.meta.dir, "..", "..", "..");
const QMD = resolveQmdCommand(WORKSPACE);

// Парсинг аргументов
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

if (!opts.fact) {
  console.error("❌ Требуется --fact \"текст факта\"");
  process.exit(1);
}
if (!opts.entity) {
  console.error("❌ Требуется --entity \"путь/к/сущности\"");
  process.exit(1);
}

const factText = opts.fact;
const entity = opts.entity.replace(/\\/g, "/"); // нормализация для Windows
const crossEntity = !!opts["cross-entity"];
// Множественные коллекции для cross-entity поиска
const collections = opts.collections
  ? opts.collections.split(",").map(c => c.trim()).filter(Boolean)
  : ["life"];

// Извлечь ключевые слова из текста
function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(w => w.length > 3);
}

// Jaccard similarity по keyword overlap
function keywordSimilarity(words1, words2) {
  const set1 = new Set(words1);
  const set2 = new Set(words2);
  const intersection = [...set1].filter(w => set2.has(w));
  const union = new Set([...set1, ...set2]);
  return union.size > 0 ? intersection.length / union.size : 0;
}

// Загрузить факты из entity items.json
async function loadEntityFacts(entityPath) {
  const itemsPath = join(WORKSPACE, "life", entityPath, "items.json");
  try {
    const data = await Bun.file(itemsPath).json();
    return (data.facts || [])
      .filter(f => f.status === "active" && (f.fact || f.text))
      .map(f => ({ ...f, fact: f.fact || f.text, entityPath }));
  } catch {
    return [];
  }
}

// Найти конфликты через keyword overlap
function findConflicts(newKeywords, facts) {
  const conflicts = [];
  for (const fact of facts) {
    if (!fact.fact) continue; // пропустить факты без текста
    const existingKeywords = extractKeywords(fact.fact);
    const similarity = keywordSimilarity(newKeywords, existingKeywords);
    const commonWords = newKeywords.filter(w => existingKeywords.includes(w));

    if (similarity >= 0.3 && commonWords.length >= 2) {
      conflicts.push({
        id: fact.id,
        entity: fact.entityPath,
        fact: fact.fact,
        category: fact.category,
        similarity: parseFloat(similarity.toFixed(2)),
        commonKeywords: commonWords,
      });
    }
  }
  return conflicts.sort((a, b) => b.similarity - a.similarity);
}

// Cross-entity: QMD discovery → read items.json → Jaccard
async function discoverEntitiesViaQmd(queryText) {
  try {
    // qmd query (BM25 + vectors + rerank) для лучшего качества
    // Формируем аргументы с множественными коллекциями
    const qmdArgs = [QMD, "query", queryText, "--json"];
    for (const col of collections) {
      qmdArgs.push("-c", col);
    }
    const proc = Bun.spawn(qmdArgs, {
      cwd: WORKSPACE,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    // Извлечь entity paths из JSON вывода QMD
    // Формат: [{ file: "qmd://life/people/sergey/summary.md", ... }]
    const entityPaths = new Set();
    let results = [];
    try {
      results = JSON.parse(output);
    } catch {
      // fallback: пустой результат
    }

    for (const r of results) {
      if (!r.file) continue;
      // qmd://life/people/sergey/summary.md → people/sergey
      const match = r.file.match(/qmd:\/\/life\/((?:projects|areas|resources)\/[\w\-\/]+?)\/summary\.md/);
      if (match) {
        entityPaths.add(match[1]);
      }
    }

    return [...entityPaths];
  } catch (e) {
    console.error(`❌ Ошибка QMD: ${e.message}`);
    return [];
  }
}

// === Main ===

const newKeywords = extractKeywords(factText);

// 1. Intra-entity (всегда)
const localFacts = await loadEntityFacts(entity);
const localConflicts = findConflicts(newKeywords, localFacts);

// 2. Cross-entity (опционально)
let crossConflicts = [];
let discoveredPaths = [];
if (crossEntity) {
  discoveredPaths = await discoverEntitiesViaQmd(factText);

  // Загрузить факты из найденных entities (кроме текущей)
  const crossFacts = [];
  for (const ep of discoveredPaths) {
    if (ep !== entity) {
      const facts = await loadEntityFacts(ep);
      crossFacts.push(...facts);
    }
  }

  crossConflicts = findConflicts(newKeywords, crossFacts);
}

// Вывод
const result = {
  conflicts: localConflicts,
};
if (crossEntity) {
  result.crossEntityConflicts = crossConflicts;
  result.entitiesSearched = discoveredPaths.length;
}

console.log(JSON.stringify(result, null, 2));
