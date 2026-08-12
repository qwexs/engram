#!/usr/bin/env bun
// Запись фактов в Knowledge Graph с дедупликацией
// Использование: bun scripts/memory-write.js --entity "people/alice" --fact "Факт" --category preference --confidence 0.9 --abstraction pattern --tags "tag1,tag2" --source "2026-02-15" [--description "Почему этот факт важен (max 150 chars)"]

import { join } from "path";
import { isDuplicate, registerHash, extractKeywordsJaccard, jaccardSimilarity } from "./memory-dedup.js";
import { markWorkspaceQmdDirty } from "../src/qmd/maintenance-integration.ts";

const WORKSPACE = process.env.ENGRAM_WORKSPACE || process.cwd() || join(import.meta.dir, "..", "..", "..");

// Extraction artifacts from heartbeat daily-note text that must never become KG facts.
const BOILERPLATE_DENYLIST = [
  /^Поправил\.\s*\*\*Скажи Сергею:/i,
  /^Поправил\.\s*$/i,
  /^Скажи Сергею:/i,
  /^Fixed:/i,
  /^\*\*Default query\*\*/i,
  /^\*\*Topic-agent домена/i,
  /^Operator\s*\(см\./i,
  /^❌\s*\*\*Telegram-сообщения/i,
  /^✅\s*\*\*Своя daily note/i,
  /^✅\s*\*\*Daily note/i,
  /^✅\s*Писать:/i,
  /^❌\s*Не писать:/i,
  /^⚠️\s*`memory/i,
  /^❌\s*`life\//i,
  /^❌\s*\*\*`life\//i,
  /^❌\s*\*\*Workspace-уровень/i,
  /^❌\s*\*\*`memory\/domains/i,
  /^Полный контракт топик-агента/i,
  /^Domain structure и lifecycle/i,
  /^Hook mechanics:/i,
  /^Better делегировать/i,
  /^Пустые `Events`/i,
  /^Heartbeat-runner триггерит/i,
  /^\*\*Свой KG entity/i,
  /^`-c domains`/i,
  /^`-c life`/i,
  /^✅ `memory\/domains\/engram/i,
  /^✅ `life\/projects\/engram/i,
];

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

    // An accessed Cold/Warm fact must become visible to the next prompt right
    // away, not only after the nightly fleet reconciliation.
    let summaryUpdated = false;
    try {
      const proc = Bun.spawn(
        ["bun", join(import.meta.dir, "rebuild-summaries.js"), "--entity", entity, "--apply-decay", "--json"],
        { cwd: WORKSPACE, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      if (proc.exitCode !== 0) throw new Error(stderr || `summary rebuild exited ${proc.exitCode}`);
      summaryUpdated = Boolean(JSON.parse(stdout).updated);
    } catch (summaryError) {
      console.error(`⚠️ summary rebuild after access failed: ${summaryError.message?.slice(0, 200) || summaryError}`);
    }

    // A write only marks the index dirty. QMD maintenance belongs exclusively
    // to the coordinator after the workspace cutover; this path must not
    // launch a legacy index-wide update.
    const qmdDirty = await markWorkspaceQmdDirty({
      workspace: WORKSPACE,
      collectionRole: "knowledge-graph",
      reason: "memory-write:access",
    });

    console.log(JSON.stringify({
      status: "accessed",
      id: opts.id,
      accessCount: fact.accessCount,
      lastAccessed: today,
      summaryUpdated,
      qmdDirty,
    }));
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
  process.exit(0);
}

// KG v3 cutover makes the typed writer the sole canonical mutator. Missing
// marker keeps the pre-cutover explicit v2 writer available; once a marker is
// present, malformed/unknown state fails closed and canary|enabled always
// blocks this legacy mutation entrypoint.
{
  const authorityPath = join(WORKSPACE, "memory-state", "kg-v3", "authority.json");
  const authorityFile = Bun.file(authorityPath);
  if (await authorityFile.exists()) {
    let marker = null;
    try { marker = await authorityFile.json(); } catch {}
    const legacyStillAllowed = marker?.schema === "engram.kg-v3-authority.v1"
      && marker?.mode === "legacy-contained";
    if (!legacyStillAllowed) {
      console.error(JSON.stringify({
        status: "rejected",
        reason: "LEGACY_WRITER_DISABLED",
        message: "Typed KG v3 writer is the sole canonical mutator after cutover.",
      }));
      process.exit(1);
    }
  }
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

const VALID_ABSTRACTIONS = ["episode", "pattern", "principle"];
const abstractionLevel = opts.abstraction === undefined ? "episode" : opts.abstraction;
if (typeof abstractionLevel !== "string" || !VALID_ABSTRACTIONS.includes(abstractionLevel)) {
  console.error(`❌ Неверный --abstraction "${String(abstractionLevel)}". Допустимые: ${VALID_ABSTRACTIONS.join(", ")}`);
  process.exit(1);
}

const confidence = opts.confidence === undefined ? 0.8 : Number(opts.confidence);
if (typeof opts.confidence === "boolean" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
  console.error("❌ --confidence должен быть числом от 0 до 1");
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

// 1.2. In-entity Jaccard dedup (always-on, no QMD required)
// Catches paraphrases and cross-language duplicates within same entity
//
// Skip when --supersedes is explicitly provided: the caller has already decided
// this new fact replaces an existing one, so implicit skip-on-similar would
// conflict with explicit supersede intent. Hash dedup and semantic check below
// still apply as safety nets.
{
  const JACCARD_BLOCK = parseFloat(opts["jaccard-threshold"] || "0.65");
  const explicitSupersede = Boolean(opts.supersedes);
  if (!explicitSupersede) {
    const entityFileCheck = Bun.file(join(entityDir, "items.json"));
    if (await entityFileCheck.exists()) {
      const existingData = await entityFileCheck.json();
      const newKw = extractKeywordsJaccard(opts.fact);
      for (const ef of (existingData.facts || [])) {
        if (ef.status === "superseded") continue;
        const efText = ef.fact || ef.text;
        if (!efText) continue;
        const efKw = extractKeywordsJaccard(efText);
        const sim = jaccardSimilarity(newKw, efKw);
        if (sim >= JACCARD_BLOCK) {
          console.log(JSON.stringify({
            status: "skipped",
            reason: `In-entity Jaccard duplicate (${sim.toFixed(2)} ≥ ${JACCARD_BLOCK})`,
            existingId: ef.id,
            existingFact: efText.slice(0, 150),
          }));
          process.exit(0);
        }
      }
    }
  }
}

// Boilerplate filter — skip extraction artifacts
const factText = String(opts.fact).trim();
for (const pattern of BOILERPLATE_DENYLIST) {
  if (pattern.test(factText)) {
    console.log(JSON.stringify({ status: "skipped", reason: "Boilerplate denylist match", pattern: pattern.source }));
    process.exit(0);
  }
}

// 1.5. Semantic cross-collection dedup is intentionally deferred. Running a
// QMD query from the write path makes writer latency and index topology depend
// on a legacy subprocess. The coordinator/observe queue owns it after cutover.
let semanticWarnings = [];
let semanticCheckWarnings = [];
if (opts["semantic-check"]) {
  semanticCheckWarnings.push({
    type: "deferred",
    message: "Cross-collection semantic dedup is deferred until the QMD coordinator cutover.",
    ...(opts["search-collections"] ? { requestedCollections: opts["search-collections"] } : {}),
  });
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
  confidence,
  abstractionLevel,
  tags: opts.tags ? opts.tags.split(",").map(t => t.trim()) : [],
  timestamp: today,
  source: opts.source || today,
  status: "active",
  supersededBy: null,
  relatedEntities: opts.related ? opts.related.split(",").map(r => r.trim()) : [],
  lastAccessed: today,
  accessCount: 1,
};

const supersededIds = opts.supersedes
  ? opts.supersedes.split(",").map(id => id.trim()).filter(Boolean)
  : [];
for (const oldId of supersededIds) {
  const oldFact = data.facts.find(f => f.id === oldId);
  if (!oldFact) {
    console.error(`❌ Superseded fact ${oldId} не найден в ${entity}`);
    process.exit(1);
  }
  if (oldFact.status === "superseded") {
    console.error(`❌ Superseded fact ${oldId} уже superseded`);
    process.exit(1);
  }
}

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
for (const oldId of supersededIds) {
  const oldFact = data.facts.find(f => f.id === oldId);
  oldFact.status = "superseded";
  oldFact.supersededBy = newFact.id;
}
await Bun.write(itemsPath, JSON.stringify(data, null, 2));

// 6.1 Зарегистрировать хэш после успешной записи
await registerHash(factHash, entity);

// 6.2 Авто-создать tensions из высококонфидентных противоречий
// Условие: --check-contradictions передан + Jaccard ≥0.65 + ≥3 общих ключевых слова
const autoTensions = [];
if (contradictions && opts["check-contradictions"]) {
  const highConf = (contradictions.conflicts || []).filter(
    c => c.similarity >= 0.65 && (c.commonKeywords || []).length >= 3
  );
  for (const conflict of highConf) {
    const tensionText = `Possible contradiction: new fact vs existing "${conflict.fact.slice(0, 100)}"`;
    const desc = `Auto-detected (Jaccard ${conflict.similarity.toFixed(2)}, ${(conflict.commonKeywords || []).length} common words)`;
    try {
      const tArgs = [
        "bun", join(import.meta.dir, "memory-tension.js"),
        "--tension", tensionText,
        "--fact1", newFact.id,
        "--fact2", conflict.id,
        "--type", "factual",
        "--confidence", String(conflict.similarity),
        "--description", desc,
      ];
      const tp = Bun.spawn(tArgs, { cwd: WORKSPACE, stdout: "pipe", stderr: "pipe" });
      const tout = await new Response(tp.stdout).text();
      await tp.exited;
      try {
        const tres = JSON.parse(tout);
        if (tres.status === "created") autoTensions.push(tres.id);
      } catch {}
    } catch {}
  }
}

// 7. Валидация KG
try {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "validate.js")], { cwd: WORKSPACE, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
} catch {}

// 8. Regenerate derived facts-active.md before the coordinator observes the
// dirty generation, so the next maintenance pass indexes the derived view.
//    Только для режима записи нового факта — в --access режиме accessCount/lastAccessed
//    не попадают в derived, поэтому пересборка не нужна.
if (!opts.access) {
  try {
    const proc = Bun.spawn(
      ["node", join(import.meta.dir, "derive-facts.js")],
      { cwd: WORKSPACE, stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;
  } catch (e) {
    console.error(`⚠️ derive-facts.js failed: ${e.message?.slice(0, 200) || e}`);
  }
}

// Keep the prompt-facing materialized summary fresh for the entity that just
// changed. Weekly synthesis remains the fleet-wide reconciliation, but waiting
// for it leaves new preferences and decisions absent from bootstrap context.
if (!opts.access) {
  try {
    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "rebuild-summaries.js"), "--entity", entity, "--apply-decay", "--json"],
      { cwd: WORKSPACE, stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    if (proc.exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      console.error(`⚠️ summary rebuild failed: ${err.slice(0, 200)}`);
    }
  } catch (e) {
    console.error(`⚠️ summary rebuild failed: ${e.message?.slice(0, 200) || e}`);
  }
}

// Shadow/coordinated modes record the successful KG write for the shared
// maintenance coordinator. Legacy mode remains a true no-op: writers never
// run raw QMD maintenance themselves.
await markWorkspaceQmdDirty({
  workspace: WORKSPACE,
  collectionRole: "knowledge-graph",
  reason: "memory-write:fact",
});

// 9. Вывод результата
const result = { status: "created", fact: newFact };
if (autoTensions.length > 0) {
  result.tensions = autoTensions;
}
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
if (semanticCheckWarnings.length > 0) {
  result.warnings = result.warnings || {};
  result.warnings.semanticCheck = semanticCheckWarnings;
}
console.log(JSON.stringify(result));
