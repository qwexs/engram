#!/usr/bin/env bun
// engram/scripts/add-domain.js
// Создать новый домен (субагент, cron-задача или Telegram-топик) с persistent memory
// Usage: bun skills/engram/scripts/add-domain.js --domain <name> [options]

import { parseArgs } from 'node:util';
import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { resolveQmdCommand } from './config.js';

const { values: args } = parseArgs({
  options: {
    'domain': { type: 'string' },
    'description': { type: 'string', default: '' },
    'type': { type: 'string', default: 'dev-project' },
    'kg-entity': { type: 'string', default: '' },
    'topic': { type: 'string', default: '' },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help || !args.domain) {
  console.log(`
add-domain — Создать домен для субагента, cron-задачи или Telegram-топика

Usage:
  bun skills/engram/scripts/add-domain.js --domain <name> [options]

Options:
  --domain <name>            Имя домена (латиница, дефисы)
  --description <text>       Описание домена
  --type <type>              Тип домена:
                               dev-project   — development project (default)
                               cron-task     — periodic task
                               topic-thread  — Telegram topic as memory contour
  --kg-entity <path>         Путь к KG entity (например "projects/engram")
  --topic <chatId:topicId>   Привязка к Telegram-топику (только для type=topic-thread).
                             Формат: "-1001234567890:42"
  -h, --help                 Показать справку

Examples:
  # Субагент-домен (как раньше)
  bun skills/engram/scripts/add-domain.js --domain monitoring
  bun skills/engram/scripts/add-domain.js --domain engram --type dev-project --kg-entity projects/engram

  # Telegram-топик как домен
  bun skills/engram/scripts/add-domain.js --domain engram \\
    --type topic-thread \\
    --topic -1001234567890:42 \\
    --kg-entity projects/engram \\
    --description "Engram memory architecture — дизайн, RFC, решения"
`);
  process.exit(args.help ? 0 : 1);
}

const domain = args.domain;
const description = args.description || domain;
const domainType = args.type;
const kgEntity = args['kg-entity'];
const topicArg = args.topic;
const WORKSPACE = process.cwd();
const QMD = resolveQmdCommand(WORKSPACE);
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const SKILL_DIR = process.env.ENGRAM_SKILL_DIR || resolve(SCRIPT_DIR, '..');
const TEMPLATES = join(SKILL_DIR, 'templates', 'domain');

// Валидация имени домена
if (!/^[a-z][a-z0-9-]*$/.test(domain)) {
  console.error('❌ Имя домена должно начинаться с буквы и содержать только a-z, 0-9, дефис');
  process.exit(1);
}

// Валидация типа домена
if (!['dev-project', 'cron-task', 'topic-thread'].includes(domainType)) {
  console.error('❌ Тип домена должен быть dev-project, cron-task или topic-thread');
  process.exit(1);
}

// Парсинг и валидация --topic для topic-thread
let topicBinding = null;
if (domainType === 'topic-thread') {
  if (!topicArg) {
    console.error('❌ Для type=topic-thread обязателен --topic <chatId:topicId>');
    console.error('   Пример: --topic -1001234567890:42');
    process.exit(1);
  }
  const m = topicArg.match(/^(-?\d+):(\d+)$/);
  if (!m) {
    console.error(`❌ --topic должен быть в формате <chatId:topicId>, например "-1001234567890:42"`);
    console.error(`   Получено: "${topicArg}"`);
    process.exit(1);
  }
  topicBinding = { chatId: m[1], topicId: m[2] };
} else if (topicArg) {
  console.warn(`⚠️  --topic указан, но тип домена ${domainType} (не topic-thread). Игнорирую.`);
}

const domainsDir = join(WORKSPACE, 'memory', 'domains');
const domainDir = join(domainsDir, domain);

// Проверка: домен уже существует
if (await Bun.file(join(domainDir, 'README.md')).exists()) {
  console.error(`❌ Домен уже существует: memory/domains/${domain}/`);
  process.exit(1);
}

// Предупреждение при >20 доменах
try {
  const existing = readdirSync(domainsDir, { withFileTypes: true })
    .filter(e => e.isDirectory()).length;
  if (existing >= 20) {
    console.warn(`⚠️  Уже ${existing} доменов. Рекомендуется не более 20.`);
  }
} catch { /* директории ещё нет */ }

// Создание директории
mkdirSync(join(domainDir, 'archives'), { recursive: true });
console.log(`📁 Создан: memory/domains/${domain}/`);

// Копирование шаблонов с подстановками
const today = new Date().toISOString().split('T')[0];
const replacements = {
  DOMAIN: domain,
  DESCRIPTION: description,
  DATE: today,
  ...(topicBinding ? { CHAT_ID: topicBinding.chatId, TOPIC_ID: topicBinding.topicId } : {}),
};

// Приоритет у type-specific папки, фолбэк на defaults
const TYPE_TEMPLATES = join(SKILL_DIR, 'templates', 'domain', domainType);
const hasTypeTemplates = await Bun.file(join(TYPE_TEMPLATES, 'decisions.md')).exists();
const baseDir = hasTypeTemplates ? TYPE_TEMPLATES : TEMPLATES;
if (hasTypeTemplates) {
  console.log(`  📂 Шаблоны: templates/domain/${domainType}/`);
}

const templates = ['decisions.md', 'status.md', 'changelog.md', 'README.md'];
// workflow.md — только для типов с инфраструктурой (не для topic-thread)
if (domainType !== 'topic-thread') {
  templates.push('workflow.md');
}

for (const tmpl of templates) {
  const src = join(baseDir, tmpl);
  const srcFile = Bun.file(src);
  if (!await srcFile.exists()) {
    console.error(`❌ Шаблон не найден: ${src}`);
    process.exit(1);
  }
  let content = await srcFile.text();
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  await Bun.write(join(domainDir, tmpl), content);
  console.log(`  ✅ ${tmpl}`);
}

// Для topic-thread дописываем секцию привязки в README
if (domainType === 'topic-thread' && topicBinding) {
  const readmePath = join(domainDir, 'README.md');
  let readme = await Bun.file(readmePath).text();
  // Session: chatId в OpenClaw хранится с ведущим минусом для групп; в session key используется абсолютное значение
  const sessionChatId = topicBinding.chatId.startsWith('-') ? topicBinding.chatId.slice(1) : topicBinding.chatId;
  const topicBlock = `\n## Привязка к топику\n\n- **Chat ID**: \`${topicBinding.chatId}\`\n- **Topic ID**: \`${topicBinding.topicId}\`\n- **Session**: \`telegram-group--${sessionChatId}-topic-${topicBinding.topicId}\`\n`;
  if (!readme.includes('## Привязка к топику')) {
    await Bun.write(readmePath, readme.trimEnd() + topicBlock);
  }
}

// Запись в registry.json
const registryPath = join(domainsDir, 'registry.json');
let registry = { domains: {} };
try {
  const registryFile = Bun.file(registryPath);
  if (await registryFile.exists()) {
    registry = JSON.parse(await registryFile.text());
  }
} catch { /* файла нет или невалидный JSON — создадим новый */ }

// Нормализация: domains всегда должен быть объектом, не массивом.
// Старые placeholder-файлы могут иметь {"domains": []}; в массив нельзя
// положить именованный ключ — JSON.stringify молча отбросит.
if (Array.isArray(registry.domains)) {
  registry.domains = {};
} else if (typeof registry.domains !== 'object' || registry.domains === null) {
  registry.domains = {};
}

// Проверка дублей topic-привязки: один топик = один домен
if (topicBinding) {
  for (const [name, entry] of Object.entries(registry.domains || {})) {
    if (entry.topic && entry.topic.chatId === topicBinding.chatId && entry.topic.topicId === topicBinding.topicId) {
      console.error(`❌ Топик ${topicBinding.chatId}:${topicBinding.topicId} уже привязан к домену "${name}"`);
      process.exit(1);
    }
  }
}

registry.domains[domain] = {
  type: domainType,
  ...(kgEntity ? { kgEntity } : {}),
  ...(topicBinding ? { topic: topicBinding } : {}),
  description,
  created: today,
};

await Bun.write(registryPath, JSON.stringify(registry, null, 2) + '\n');

const registryBits = [`тип: ${domainType}`];
if (kgEntity) registryBits.push(`KG: ${kgEntity}`);
if (topicBinding) registryBits.push(`топик: ${topicBinding.chatId}:${topicBinding.topicId}`);
console.log(`  ✅ registry.json (${registryBits.join(', ')})`);

// Регистрация QMD коллекции domains (одна на все домены)
function qmdAvailable() {
  try {
    execSync(`${QMD} --help`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

if (qmdAvailable()) {
  // Shared 'domains' collection: indexes all domains together.
  // Used by main-agent and topic-agent for explicit cross-topic queries.
  try {
    execSync(`${QMD} collection add "${join(WORKSPACE, 'memory', 'domains')}" --name domains --mask "**/*.md"`, { stdio: 'pipe' });
    console.log('QMD shared domains collection created');
  } catch {
    console.log('QMD shared domains collection already exists');
  }

  // Per-domain 'domain-{slug}' collection: indexes one domain only.
  // Default for topic-agents (matches their contour, smaller search space).
  try {
    execSync(`${QMD} collection add "${join(WORKSPACE, 'memory', 'domains', domain)}" --name "domain-${domain}" --mask "**/*.md"`, { stdio: 'pipe' });
    console.log(`QMD per-domain domain-${domain} collection created`);
  } catch {
    console.log(`QMD per-domain domain-${domain} collection already exists`);
  }

  // Per-KG-entity 'life-projects-{slug}' collection (opt-in, only if --kg-entity given).
  // Lets topic-agents run semantic search over their own KG entity without leaking
  // into the broader apriori-life collection.
  if (kgEntity) {
    const entityPath = join(WORKSPACE, 'life', kgEntity);
    if (existsSync(entityPath)) {
      try {
        execSync(`${QMD} collection add "${entityPath}" --name "life-projects-${domain}" --mask "**/*.md"`, { stdio: 'pipe' });
        console.log(`QMD per-entity life-projects-${domain} collection created (KG: ${kgEntity})`);
      } catch {
        console.log(`QMD per-entity life-projects-${domain} collection already exists`);
      }
    } else {
      console.log(`Note: KG entity '${kgEntity}' does not exist yet — collection skipped. Create life/${kgEntity}/ and re-run add-domain to populate.`);
    }
  }

  try {
    execSync(`${QMD} update`, { stdio: 'pipe' });
    console.log('QMD index updated');
  } catch {
    console.warn('qmd update failed — run manually');
  }
} else {
  console.log('QMD not found. Add collections manually:');
  console.log(`   qmd collection add "${join(WORKSPACE, 'memory', 'domains', domain)}" --name "domain-${domain}" --mask "**/*.md"`);
}

console.log(`
✅ Домен создан!
   Домен:        ${domain}
   Тип:          ${domainType}${kgEntity ? `\n   KG Entity:    ${kgEntity}` : ''}${topicBinding ? `\n   Топик:        ${topicBinding.chatId}:${topicBinding.topicId}` : ''}
   Описание:     ${description}
   Путь:         memory/domains/${domain}/
   QMD:          qmd query "запрос" -c domains

Использование:
${domainType === 'topic-thread'
  ? `  1. Решения и pinned-факты → decisions.md (агент обновляет по «решили X» в чате)
  2. Текущее состояние разговора → status.md (обновляется агентом при завершении тематического блока)
  3. Лог значимых обменов → changelog.md
  4. Хук engram-topic-domain-load автоматически подгружает контекст в daily note при заходе в топик
  5. Heartbeat: liveness, changelog rotation, KG extraction`
  : `  1. Настрой правила в decisions.md
  2. Запусти субагент с промптом из templates/spawn-prompt.md
  3. Субагент обновит status.md и changelog.md`}
`);
