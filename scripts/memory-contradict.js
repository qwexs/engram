#!/usr/bin/env bun
// Детектор противоречий в фактах через QMD + keyword overlap
// Использование: bun scripts/memory-contradict.js --fact "Prefers JavaScript" --entity "areas/people/sergey"

import { join } from "path";

const WORKSPACE = join(import.meta.dir, "..");

// Парсинг аргументов
const args = process.argv.slice(2);
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

const factText = args[factIdx + 1];
const entity = args[entityIdx + 1];

// Извлечь ключевые слова из текста
function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(w => w.length > 3);
}

// Вычислить similarity по keyword overlap (Jaccard)
function keywordSimilarity(words1, words2) {
  const set1 = new Set(words1);
  const set2 = new Set(words2);
  const intersection = [...set1].filter(w => set2.has(w));
  const union = new Set([...set1, ...set2]);
  return union.size > 0 ? intersection.length / union.size : 0;
}

// 1. Прочитать facts из entity
const entityItemsPath = join(WORKSPACE, "life", entity, "items.json");
let entityFacts = [];
try {
  const data = await Bun.file(entityItemsPath).json();
  entityFacts = (data.facts || []).filter(f => f.status === "active");
} catch {
  // Entity не существует или пустой
}

// 2. Найти конфликты через keyword overlap
const newKeywords = extractKeywords(factText);
const conflicts = [];

for (const existingFact of entityFacts) {
  const existingKeywords = extractKeywords(existingFact.fact);
  const similarity = keywordSimilarity(newKeywords, existingKeywords);

  // Порог: ≥0.3 similarity + хотя бы 2 общих слова
  const commonWords = newKeywords.filter(w => existingKeywords.includes(w));
  if (similarity >= 0.3 && commonWords.length >= 2) {
    conflicts.push({
      id: existingFact.id,
      fact: existingFact.fact,
      category: existingFact.category,
      similarity: parseFloat(similarity.toFixed(2)),
      commonKeywords: commonWords,
    });
  }
}

// Сортировать по similarity (desc)
conflicts.sort((a, b) => b.similarity - a.similarity);

console.log(JSON.stringify({ conflicts }, null, 2));
