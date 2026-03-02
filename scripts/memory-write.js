#!/usr/bin/env bun
// Запись фактов в Knowledge Graph с дедупликацией
// Использование: bun scripts/memory-write.js --entity "areas/people/sergey" --fact "Факт" --category preference --confidence 0.9 --abstraction pattern --tags "tag1,tag2" --source "2026-02-15" [--description "Почему этот факт важен (max 150 chars)"]

import { join } from "path";
import { isDuplicate, registerHash } from "./memory-dedup.js";

const WORKSPACE = process.env.ENGRAM_WORKSPACE || join(import.meta.dir, "..", "..", "..");

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

// 0. Access tracking mode: --access --entity <entity> --id <fact-id>
if (opts.access) {
  if (!opts.entity || !opts.id) {
    console.error("❌ --access требует --entity и --id");
    process.exit(1);
  }
  const entity = opts.entity.replace(/\\/g, "/");
  const itemsPath = join(WORKSPACE, "life", entity, "items.json");
  const TZ = process.env.ENGRAM_TZ || process.env.TZ || "Europe/Moscow";
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  try {
    const data = await Bun.file(itemsPath).json();
    const fact = data.facts.find(f => f.id === opts.id);
    if (!fact) {
      console.error(`❌ Факт ${opts.id} не найден в ${entity}`);
      process.exit(1);
    }
    fact.accessCount = (fact.accessCount || 0) + 1;
    fact.lastAccessed = today;
    await Bun.write(itemsPath, JSON.stringify(data, null, 2));
    console.log(JSON.stringify({ status: "accessed", id: opts.id, accessCount: fact.accessCount, lastAccessed: today }));
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
  process.exit(0);
}

// Валидация обязательных полей
const required = ["entity", "fact", "category"];
for (const r of required) {
  if (!opts[r]) {
    console.error(`❌ Требуется --${r}`);
    process.exit(1);
  }
}

const VALID_CATEGORIES = ["relationship", "milestone", "status", "preference", "context", "decision", "correction"];
if (!VALID_CATEGORIES.includes(opts.category)) {
  console.error(`❌ Неверная категория "${opts.category}". Допустимые: ${VALID_CATEGORIES.join(", ")}`);
  process.exit(1);
}

const entity = opts.entity.replace(/\\/g, "/");
const entityDir = join(WORKSPACE, "life", entity);
const itemsPath = join(entityDir, "items.json");
const TZ = process.env.ENGRAM_TZ || process.env.TZ || "Europe/Moscow";
const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });

// 1. Дедупликация (read-only check, регистрация после записи)
const dedupResult = await isDuplicate(opts.fact);
if (dedupResult.duplicate) {
  console.log(JSON.stringify({ status: "skipped", reason: "Duplicate fact, skipping", existingEntity: dedupResult.existingEntity }));
  process.exit(0);
}
const factHash = dedupResult.hash;

// 1.5. Семантическая проверка по множественным коллекциям (опционально)
let semanticWarnings = [];
if (opts["semantic-check"]) {
  const searchCollections = opts["search-collections"]
    ? opts["search-collections"].split(",").map(c => c.trim()).filter(Boolean)
    : ["life"];

  // Извлечение ключевых слов (аналогично memory-contradict.js)
  function extractKeywords(text) {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .split(/\s+/)
      .filter(w => w.length > 3);
  }

  function jaccardSimilarity(words1, words2) {
    const set1 = new Set(words1);
    const set2 = new Set(words2);
    const intersection = [...set1].filter(w => set2.has(w));
    const union = new Set([...set1, ...set2]);
    return union.size > 0 ? intersection.length / union.size : 0;
  }

  try {
    // qmd query --json (BM25 + vectors + rerank) для лучшего качества dedup
    const qmdArgs = ["qmd", "query", opts.fact, "--json"];
    for (const col of searchCollections) {
      qmdArgs.push("-c", col);
    }
    const proc = Bun.spawn(qmdArgs, { cwd: WORKSPACE, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    // Парсинг JSON вывода QMD
    // Формат: [{ file: "qmd://...", score: 0.85, snippet: "...", body: "..." }]
    const newKeywords = extractKeywords(opts.fact);
    let results = [];
    try {
      results = JSON.parse(output);
    } catch {
      // fallback: пустой результат при невалидном JSON
    }

    for (const r of results) {
      const textPart = (r.snippet || r.body || "").replace(/```[\s\S]*?```/g, "").trim();
      if (!textPart || textPart.length < 5) continue;

      const lineKeywords = extractKeywords(textPart);
      const sim = jaccardSimilarity(newKeywords, lineKeywords);
      if (sim >= 0.5) {
        // Block semantic duplicates (high similarity)
        console.log(JSON.stringify({
          status: "skipped",
          reason: "Semantic duplicate (Jaccard " + sim.toFixed(2) + ")",
          similarText: textPart.slice(0, 200),
          source: r.file || "unknown",
        }));
        process.exit(0);
      } else if (sim >= 0.3) {
        semanticWarnings.push({
          similarText: textPart.slice(0, 200),
          similarity: parseFloat(sim.toFixed(2)),
          source: r.file || "unknown",
        });
      }
    }
  } catch (e) {
    console.error(`⚠️ Semantic check ошибка: ${e.message}`);
  }
}

// 2. Проверить/создать entity
const entityFile = Bun.file(itemsPath);
let data;

if (await entityFile.exists()) {
  data = await entityFile.json();
} else if (opts["entity-create"]) {
  // Создать entity
  const summaryPath = join(entityDir, "summary.md");
  const entityName = entity.split("/").pop();
  await Bun.write(summaryPath, `# ${entityName}\n\n_Created automatically._\n`);
  const typeMap = { projects: "project", areas: "area", resources: "resource", archives: "archive" };
  const entityType = typeMap[entity.split("/")[0]] || "area";
  data = { entityId: entity, entityType, facts: [] };
  await Bun.write(itemsPath, JSON.stringify(data, null, 2));

  // Обновить life/index.md
  const indexPath = join(WORKSPACE, "life", "index.md");
  try {
    const indexContent = await Bun.file(indexPath).text();
    if (!indexContent.includes(entity)) {
      const line = `- [${entityName}](${entity}/summary.md)\n`;
      await Bun.write(indexPath, indexContent.trimEnd() + "\n" + line);
    }
  } catch {}

  console.error(`✅ Создана сущность: ${entity}`);
} else {
  console.error(`❌ Entity не существует: ${entity}. Используйте --entity-create для автоматического создания.`);
  process.exit(1);
}

// 3. Определить ID
const slug = entity.split("/").pop();
const existingIds = data.facts.map(f => {
  const match = f.id.match(/(\d+)$/);
  return match ? parseInt(match[1]) : 0;
});
const nextNum = (existingIds.length > 0 ? Math.max(...existingIds) : 0) + 1;
const newId = `${slug}-${String(nextNum).padStart(3, "0")}`;

// 4. Создать факт
const description = opts.description
  ? String(opts.description).slice(0, 150).trim()
  : undefined;

const newFact = {
  id: newId,
  fact: opts.fact,
  ...(description !== undefined && { description }),
  category: opts.category,
  confidence: parseFloat(opts.confidence || "0.8"),
  abstractionLevel: opts.abstraction || "episode",
  tags: opts.tags ? opts.tags.split(",").map(t => t.trim()) : [],
  timestamp: today,
  source: opts.source || today,
  status: "active",
  supersededBy: null,
  relatedEntities: opts.related ? opts.related.split(",").map(r => r.trim()) : [],
  lastAccessed: today,
  accessCount: 1,
};

// 5. Проверка противоречий (опционально)
let contradictions = null;
if (opts["check-contradictions"]) {
  try {
    const crossFlag = opts["cross-entity"] ? "--cross-entity" : "";
    const cmdArgs = ["bun", join(import.meta.dir, "memory-contradict.js"), "--fact", opts.fact, "--entity", entity];
    if (crossFlag) cmdArgs.push(crossFlag);
    const proc = Bun.spawn(cmdArgs, { cwd: WORKSPACE, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    contradictions = JSON.parse(out);
  } catch {}
}

// 6. Записать
data.facts.push(newFact);
await Bun.write(itemsPath, JSON.stringify(data, null, 2));

// 6.1 Зарегистрировать хэш после успешной записи
await registerHash(factHash, entity);

// 7. Валидация KG
try {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "validate.js")], { cwd: WORKSPACE, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
} catch {}

// 8. QMD update
try {
  const proc = Bun.spawn(["qmd", "update"], { cwd: WORKSPACE, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
} catch {}

// 9. Вывод результата
const result = { status: "created", fact: newFact };
if (contradictions) {
  const total = (contradictions.conflicts?.length || 0) + (contradictions.crossEntityConflicts?.length || 0);
  if (total > 0) {
    result.warnings = result.warnings || {};
    result.warnings.contradictions = contradictions;
  }
}
if (semanticWarnings.length > 0) {
  result.warnings = result.warnings || {};
  result.warnings.semanticSimilar = semanticWarnings;
}
console.log(JSON.stringify(result));
