#!/usr/bin/env bun
// Аудит superseded facts без target (supersededBy == null/empty).
//
// Контекст: в items.json встречаются записи со status="superseded", но без
// supersededBy — "голые" superseded. Это артефакты старых версий pipeline
// (extract-runner до c437e54 никогда не заполнял target) или ручных правок.
//
// Этот скрипт:
//   1. Сканирует life/*/items.json (или один --entity)
//   2. Для каждой голой superseded пытается найти matching active fact через
//      Jaccard similarity (порог 0.8 default)
//   3. Если найден — auto-fix (заполняет supersededBy) — только с --auto-fix
//   4. Если не найден — помечает status="pending" для ручного решения
//      (только с --mark-pending)
//
// По умолчанию dry-run — только отчёт. Без --auto-fix и --mark-pending ничего
// не пишется.
//
// Использование:
//   bun skills/engram/scripts/audit-superseded.js                    # dry-run всех entities
//   bun skills/engram/scripts/audit-superseded.js --entity projects/engram
//   bun skills/engram/scripts/audit-superseded.js --auto-fix
//   bun skills/engram/scripts/audit-superseded.js --mark-pending
//   bun skills/engram/scripts/audit-superseded.js --jaccard-threshold 0.85

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findSimilarFacts } from "./memory-dedup.js";
import { legacyKgMutationState } from "./_lib/kg-v3-authority.ts";

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv);
const WORKSPACE = resolve(opts.workspace || process.env.ENGRAM_WORKSPACE || process.cwd());
const LIFE_DIR = join(WORKSPACE, "life");
if (opts.help || opts.h) {
  console.log([
    "audit-superseded.js",
    "",
    "Scan items.json for superseded facts without supersededBy target.",
    "Tries to resolve them via Jaccard match against active facts.",
    "",
    "Usage:",
    "  bun skills/engram/scripts/audit-superseded.js [options]",
    "",
    "Options:",
    "  --workspace <path>          Workspace root (default: ENGRAM_WORKSPACE or cwd)",
    "  --entity <path>             Only scan one entity (e.g. projects/engram)",
    "  --auto-fix                  Apply auto-fix when a high-Jaccard match is found",
    "                              (sets supersededBy). Default: dry-run.",
    "  --mark-pending              Mark unresolved superseded as status=\"pending\"",
    "                              so they surface in manual review queues.",
    "                              Default: enabled (reporting only, not writing).",
    "  --no-mark-pending           Skip the pending-status step entirely.",
    "  --jaccard-threshold <0-1>   Threshold for considering a match (default 0.8).",
    "                              Stricter than auto-supersede (0.75) on purpose.",
    "  --dry-run                   Force dry-run even if --auto-fix is set.",
    "",
    "Output: JSON report to stdout. Exit 0 if scan succeeded (issues do not",
    "cause non-zero exit; the report carries the counts).",
  ].join("\n"));
  process.exit(0);
}

const DRY_RUN = !opts["auto-fix"] || Boolean(opts["dry-run"]);
const MARK_PENDING = opts["no-mark-pending"] ? false : true; // default ON
const JACCARD_THRESHOLD = parseFloat(opts["jaccard-threshold"] || "0.8");
const SINGLE_ENTITY = opts.entity;

const authority = legacyKgMutationState(WORKSPACE);
if (!DRY_RUN && !authority.allowed) {
  console.error(JSON.stringify({
    status: "rejected",
    reason: "LEGACY_MUTATOR_DISABLED",
    authorityMode: authority.mode,
  }));
  process.exit(1);
}

// Собрать список items.json файлов
function collectItemsPaths() {
  if (SINGLE_ENTITY) {
    const p = join(LIFE_DIR, SINGLE_ENTITY, "items.json");
    return existsSync(p) ? [p] : [];
  }
  if (!existsSync(LIFE_DIR)) return [];
  const out = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "items.json") out.push(full);
    }
  }
  walk(LIFE_DIR);
  return out;
}

// Найти голые superseded в entity
function findOrphanSuperseded(facts) {
  const orphans = [];
  for (const f of facts) {
    if (f.status !== "superseded") continue;
    const target = (f.supersededBy || "").toString().trim();
    if (!target) orphans.push(f);
  }
  return orphans;
}

async function processEntity(itemsPath) {
  const relPath = itemsPath.replace(WORKSPACE + (process.platform === "win32" ? "\\" : "/"), "");
  let data;
  try {
    data = JSON.parse(readFileSync(itemsPath, "utf-8"));
  } catch (e) {
    return { entity: relPath, error: e.message };
  }

  const facts = Array.isArray(data.facts) ? data.facts : [];
  const entityId = data.entityId || relPath.replace(/[\/\\]items\.json$/, "").replace(/\\/g, "/");

  const orphans = findOrphanSuperseded(facts);

  const autoFixed = [];
  const markedPending = [];
  const stillUnresolved = [];

  for (const orphan of orphans) {
    const orphanText = orphan.fact || orphan.text || "";
    if (!orphanText) {
      stillUnresolved.push({
        id: orphan.id,
        reason: "empty fact text — cannot match",
      });
      continue;
    }

    // Один Jaccard scan для orphan — возвращает ВСЕ активные факты entity выше
    // порога, отсортированные по sim DESC. Берём top-1 (highest similarity).
    const matches = await findSimilarFacts({
      workspace: WORKSPACE,
      entity: entityId,
      factText: orphanText,
      threshold: JACCARD_THRESHOLD,
    });
    const match = matches[0] || null;

    if (match) {
      if (!DRY_RUN) {
        orphan.supersededBy = match.id;
        autoFixed.push({
          id: orphan.id,
          target: match.id,
          jaccard: Number(match.sim.toFixed(3)),
          fact: orphanText.slice(0, 100),
        });
      } else {
        autoFixed.push({
          id: orphan.id,
          target: match.id,
          jaccard: Number(match.sim.toFixed(3)),
          fact: orphanText.slice(0, 100),
          dryRun: true,
        });
      }
    } else {
      // Нет matching active. Решаем что делать
      if (MARK_PENDING) {
        if (!DRY_RUN) {
          orphan.status = "pending";
          markedPending.push({
            id: orphan.id,
            fact: orphanText.slice(0, 100),
          });
        } else {
          markedPending.push({
            id: orphan.id,
            fact: orphanText.slice(0, 100),
            dryRun: true,
          });
        }
      } else {
        stillUnresolved.push({
          id: orphan.id,
          fact: orphanText.slice(0, 100),
          reason: `no active match above Jaccard ${JACCARD_THRESHOLD}; --mark-pending disabled`,
        });
      }
    }
  }

  // Записать обратно если были изменения
  if (!DRY_RUN && (autoFixed.length > 0 || markedPending.length > 0)) {
    writeFileSync(itemsPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }

  return {
    entity: entityId,
    facts_total: facts.length,
    superseded_total: facts.filter((f) => f.status === "superseded").length,
    superseded_with_target: facts.filter((f) => f.status === "superseded" && (f.supersededBy || "").toString().trim()).length,
    superseded_orphan_count: orphans.length,
    auto_fixed: autoFixed,
    marked_pending: markedPending,
    still_unresolved: stillUnresolved,
    written: !DRY_RUN && (autoFixed.length > 0 || markedPending.length > 0),
  };
}

async function main() {
  const paths = collectItemsPaths();
  if (paths.length === 0) {
    console.log(JSON.stringify({ scanned: 0, entities: [], note: SINGLE_ENTITY ? `entity "${SINGLE_ENTITY}" not found` : "no items.json files" }));
    return;
  }

  const results = [];
  for (const p of paths) {
    results.push(await processEntity(p));
  }

  // Агрегация
  const totals = {
    entities_scanned: results.length,
    facts_total: results.reduce((s, r) => s + (r.facts_total || 0), 0),
    superseded_total: results.reduce((s, r) => s + (r.superseded_total || 0), 0),
    superseded_with_target: results.reduce((s, r) => s + (r.superseded_with_target || 0), 0),
    superseded_orphan_count: results.reduce((s, r) => s + (r.superseded_orphan_count || 0), 0),
    auto_fixed_count: results.reduce((s, r) => s + (r.auto_fixed?.length || 0), 0),
    marked_pending_count: results.reduce((s, r) => s + (r.marked_pending?.length || 0), 0),
    still_unresolved_count: results.reduce((s, r) => s + (r.still_unresolved?.length || 0), 0),
  };

  const report = {
    mode: DRY_RUN ? "dry-run" : "write",
    jaccard_threshold: JACCARD_THRESHOLD,
    mark_pending: MARK_PENDING,
    ...totals,
    entities: results,
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e.message, stack: e.stack }));
  process.exit(1);
});
