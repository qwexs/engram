// engram/scripts/_lib/auto-derive-status.js
// Shared helpers для cold-start (add-domain.js) и heartbeat maintenance
// (heartbeat-runner.js). Возвращает чистые функции без побочных эффектов;
// I/O делает вызывающий код.
//
// Используется для:
//   - Layer 1 (cold-start): при создании topic-thread домена заполнить
//     status.md реальным handover'ом из последней daily note
//   - Layer 2 (maintenance): для auto-derived status.md (с маркером) —
//     перегенерить если daily note свежее status.md
//
// Маркер `<!-- auto-derived from YYYY-MM-DD.md at YYYY-MM-DD -->` в начале
// файла — это сигнал «можно перегенерить». Curated версии (без маркера)
// никогда не затираются.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Найти последнюю daily note в sessionDir с контентом (>200 байт).
 * Приоритет: archived full file (sessionDir/YYYY-MM-DD/YYYY-MM-DD.md) > top-level stub.
 * Empty template stubs (~129 байт: "# date\n## Events\n..." с пустыми секциями) — skip.
 *
 * @param {string} sessionDir - путь к memory/agent-{id}/{sessionKey}/
 * @returns {{date: string, path: string, size: number} | null}
 */
export function findLatestDailyNoteWithContent(sessionDir) {
  if (!existsSync(sessionDir)) return null;
  let best = null;
  try {
    const entries = readdirSync(sessionDir);
    for (const entry of entries) {
      const m = entry.match(/^(\d{4}-\d{2}-\d{2})(\.md)?$/);
      if (!m) continue;
      const date = m[1];
      const archivePath = join(sessionDir, date, `${date}.md`);
      const topPath = join(sessionDir, entry);
      let candidatePath = null;
      let candidateSize = 0;
      if (existsSync(archivePath)) {
        candidatePath = archivePath;
        candidateSize = statSync(archivePath).size;
      } else if (existsSync(topPath)) {
        candidateSize = statSync(topPath).size;
        if (candidateSize > 200) candidatePath = topPath;
      }
      if (candidatePath && (!best || date > best.date)) {
        best = { date, path: candidatePath, size: candidateSize };
      }
    }
  } catch {
    return null;
  }
  return best;
}

/**
 * Парсит markdown-секции (## header) в плоский map {sectionName: body}.
 * CRLF-safe, не теряет содержимое между секциями.
 *
 * @param {string} content
 * @returns {Object<string, string>}
 */
export function parseMarkdownSections(content) {
  const sections = {};
  const lines = content.split(/\r?\n/);
  let current = null;
  let buf = [];
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (current) sections[current] = buf.join("\n").trim();
      current = m[1].trim();
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  if (current) sections[current] = buf.join("\n").trim();
  return sections;
}

/**
 * Собирает auto-derived status.md в template-структуре (## Где сейчас разговор /
 * ## Активные гипотезы / ## Решено (кратко) / ## Next), копируя содержимое
 * секций из daily note.
 *
 * @param {string} slug - имя домена
 * @param {string} sourceDate - YYYY-MM-DD исходной daily note
 * @param {string} today - YYYY-MM-DD для timestamp в маркере
 * @param {Object<string, string>} sections - результат parseMarkdownSections
 * @returns {string} полный текст status.md с маркером auto-derived
 */
export function buildAutoDerivedStatus(slug, sourceDate, today, sections) {
  const header = `# Статус: ${slug}\n\n> Текущее состояние разговора. **Auto-derived from \`${sourceDate}.md\`** в ${today} — перепиши curated-версией если есть свежий контекст.\n`;
  const parts = [header];

  const activeThreads = (sections["Active Threads"] || "").trim();
  const decisions = (sections["Decisions"] || "").trim();
  const next = (sections["Next"] || "").trim();

  if (activeThreads) {
    parts.push(`## Где сейчас разговор\n\n${activeThreads}`);
  } else {
    parts.push(`## Где сейчас разговор\n\n_(нет Active Threads в ${sourceDate}.md — тред только что стартовал)_`);
  }

  parts.push(`## Активные гипотезы / варианты\n\n<!-- Что обсуждается, но ещё не решено — заполни по ходу -->`);

  if (decisions) {
    parts.push(`## Решено (кратко)\n\n${decisions}`);
  } else {
    parts.push(`## Решено (кратко)\n\n<!-- Нет принятых решений в ${sourceDate}.md — указатели на decisions.md по мере появления -->`);
  }

  if (next) {
    parts.push(`## Next\n\n${next}`);
  }

  // Маркер в начале файла — для grep-detect и для heartbeat-runner'а (Layer 2).
  return `<!-- auto-derived from ${sourceDate}.md at ${today} -->\n` + parts.join("\n\n") + "\n";
}

/**
 * Детектит маркер auto-derived в начале status.md.
 *
 * @param {string} content
 * @returns {boolean}
 */
export function hasAutoDerivedMarker(content) {
  return /<!--\s*auto-derived from \d{4}-\d{2}-\d{2}\.md at \d{4}-\d{2}-\d{2}\s*-->/.test(content);
}