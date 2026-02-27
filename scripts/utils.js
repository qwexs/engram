#!/usr/bin/env bun
// Общие утилиты для OLL (Operational Learning Loop)
// Используются в memory-observe.js, memory-tension.js и тестах

/**
 * Извлекает ключевые слова из текста.
 * Фильтрует слова длиной <= 3 символа.
 * @param {string} text
 * @returns {string[]}
 */
export function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(w => w.length > 3);
}

/**
 * Вычисляет коэффициент сходства Жаккара между двумя массивами слов.
 * Возвращает 0 если оба массива пусты.
 * @param {string[]} words1
 * @param {string[]} words2
 * @returns {number} значение от 0 до 1
 */
export function jaccardSimilarity(words1, words2) {
  const set1 = new Set(words1);
  const set2 = new Set(words2);
  const intersection = [...set1].filter(w => set2.has(w));
  const union = new Set([...set1, ...set2]);
  return union.size > 0 ? intersection.length / union.size : 0;
}
