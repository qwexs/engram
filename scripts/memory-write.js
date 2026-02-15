#!/usr/bin/env bun
// Запись фактов в Knowledge Graph с дедупликацией
// Использование: bun scripts/memory-write.js --entity "areas/people/sergey" --fact "Факт" --category preference --confidence 0.9 --abstraction pattern --tags "tag1,tag2" --source "2026-02-15"

import { join } from "path";
import { isDuplicate, registerHash } from "./memory-dedup.js";

const WORKSPACE = join(import.meta.dir, "..");

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

// Валидация обязательных полей
const required = ["entity", "fact", "category"];
for (const r of required) {
  if (!opts[r]) {
    console.error(`❌ Требуется --${r}`);
    process.exit(1);
  }
}

const entity = opts.entity;
const entityDir = join(WORKSPACE, "life", entity);
const itemsPath = join(entityDir, "items.json");

// 1. Дедупликация (read-only check, регистрация после записи)
const dedupResult = await isDuplicate(opts.fact);
if (dedupResult.duplicate) {
  console.log(JSON.stringify({ status: "skipped", reason: "Duplicate fact, skipping", existingEntity: dedupResult.existingEntity }));
  process.exit(0);
}
const factHash = dedupResult.hash;

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
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
const newFact = {
  id: newId,
  fact: opts.fact,
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

// 5. Записать
data.facts.push(newFact);
await Bun.write(itemsPath, JSON.stringify(data, null, 2));

// 5.1 Зарегистрировать хэш после успешной записи
await registerHash(factHash, entity);

// 6. Валидация KG
try {
  const proc = Bun.spawn(["bun", "scripts/validate-kg.js"], { cwd: WORKSPACE, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
} catch {}

// 7. QMD update
try {
  const proc = Bun.spawn(["qmd", "update"], { cwd: WORKSPACE, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
} catch {}

// 8. Вывод результата
console.log(JSON.stringify({ status: "created", fact: newFact }));
