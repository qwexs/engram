#!/usr/bin/env bun
// Дедупликация фактов через content-hash (SHA-256)
// Использование: bun scripts/memory-dedup.js --fact "текст" --entity "people/alice"
//               bun scripts/memory-dedup.js --seed

import { join } from "path";

const WORKSPACE = process.env.ENGRAM_WORKSPACE || process.cwd() || join(import.meta.dir, "..", "..", "..");
const HASH_FILE = join(WORKSPACE, "workspace", "memory-state", "fact-hashes.json");

// Нормализация текста для хэширования
export function normalizeFact(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "") // убрать пунктуацию
    .replace(/\s+/g, " ")              // collapse whitespace
    .trim();
}

// SHA-256 хэш
export async function hashFact(text) {
  const normalized = normalizeFact(text);
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(normalized);
  return hash.digest("hex");
}

// Загрузить индекс хэшей
export async function loadHashes() {
  try {
    const file = Bun.file(HASH_FILE);
    if (await file.exists()) {
      return await file.json();
    }
  } catch {}
  return {};
}

// Сохранить индекс хэшей
export async function saveHashes(hashes) {
  await Bun.write(HASH_FILE, JSON.stringify(hashes, null, 2));
}

// Проверить дубликат (read-only, не регистрирует хэш)
export async function isDuplicate(fact) {
  const h = await hashFact(fact);
  const hashes = await loadHashes();
  if (hashes[h]) {
    return { duplicate: true, existingEntity: hashes[h], hash: h };
  }
  return { duplicate: false, hash: h };
}

// Зарегистрировать хэш после успешной записи факта
export async function registerHash(hash, entity) {
  const hashes = await loadHashes();
  hashes[hash] = entity;
  await saveHashes(hashes);
}

// Обратная совместимость: check + register в одном вызове
export async function checkDedup(fact, entity) {
  const result = await isDuplicate(fact);
  if (result.duplicate) return result;
  await registerHash(result.hash, entity);
  return { duplicate: false };
}

// ============================================================================
// Jaccard-based similarity helpers (shared by memory-write skip + extract-runner
// auto-supersede). Pure functions — no I/O side effects, no early exit.
// ============================================================================

// Извлечение ключевых слов для Jaccard (нормализация: lower, strip punctuation,
// drop tokens ≤3 chars). Используется и для skip, и для supersede.
export function extractKeywordsJaccard(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter((w) => w.length > 3);
}

// Jaccard similarity по keyword overlap. Returns 0..1.
export function jaccardSimilarity(words1, words2) {
  const set1 = new Set(words1);
  const set2 = new Set(words2);
  const intersection = [...set1].filter((w) => set2.has(w));
  const union = new Set([...set1, ...set2]);
  return union.size > 0 ? intersection.length / union.size : 0;
}

// Найти похожие active facts в entity по Jaccard ≥ threshold.
// Возвращает [{ id, fact, sim, category }], отсортировано по sim DESC.
// Read-only: не пишет в items.json, не вызывает exit.
// Используется:
//   - memory-write.js для in-entity skip (threshold=0.65)
//   - extract-runner.js для auto-supersede (threshold=0.75)
export async function findSimilarFacts({ workspace, entity, factText, threshold = 0.65 }) {
  const itemsPath = join(workspace, "life", entity, "items.json");
  const file = Bun.file(itemsPath);
  if (!(await file.exists())) return [];

  let data;
  try {
    data = await file.json();
  } catch {
    return [];
  }

  const newKw = extractKeywordsJaccard(factText);
  const matches = [];

  for (const ef of data.facts || []) {
    if (ef.status !== "active") continue;
    const efText = ef.fact || ef.text;
    if (!efText) continue;

    const efKw = extractKeywordsJaccard(efText);
    const sim = jaccardSimilarity(newKw, efKw);
    if (sim >= threshold) {
      matches.push({
        id: ef.id,
        fact: efText,
        sim,
        category: ef.category,
      });
    }
  }

  matches.sort((a, b) => b.sim - a.sim);
  return matches;
}

// Seed — построить индекс из всех items.json в life/
async function seed() {
  const { Glob } = await import("bun");
  const glob = new Glob("**/items.json");
  const lifeDir = join(WORKSPACE, "life");
  const hashes = {};
  let count = 0;

  for await (const path of glob.scan({ cwd: lifeDir })) {
    try {
      const fullPath = join(lifeDir, path);
      const data = await Bun.file(fullPath).json();
      const entityId = data.entityId || path.replace(/[\/\\]items\.json$/, "").replace(/\\/g, "/");

      for (const fact of (data.facts || [])) {
        const text = fact.fact || fact.text; // support both schema variants
        if (text && fact.status !== "superseded") {
          const h = await hashFact(text);
          hashes[h] = entityId;
          count++;
        }
      }
    } catch (e) {
      console.error(`❌ Ошибка чтения ${path}: ${e.message}`);
    }
  }

  await saveHashes(hashes);
  console.log(JSON.stringify({ seeded: count, entities: new Set(Object.values(hashes)).size }));
}

// CLI — только при прямом запуске (не при импорте)
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--seed")) {
    await seed();
  } else {
    const factIdx = args.indexOf("--fact");
    const entityIdx = args.indexOf("--entity");

    if (factIdx === -1 || !args[factIdx + 1]) {
      console.error("❌ Требуется --fact \"текст факта\"");
      process.exit(1);
    }
    if (entityIdx === -1 || !args[entityIdx + 1]) {
      console.error("❌ Требуется --entity \"путь/к/сущности\"");
      process.exit(1);
    }

    const result = await checkDedup(args[factIdx + 1], args[entityIdx + 1]);
    console.log(JSON.stringify(result, null, 2));
  }
}
