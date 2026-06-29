#!/usr/bin/env bun
// engram/scripts/add-domain.js
// Создать новый домен (субагент, cron-задача или Telegram-топик) с persistent memory
// Usage: bun skills/engram/scripts/add-domain.js --domain <name> [options]

import { parseArgs } from 'node:util';
import { mkdirSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { resolveQmdCommand } from './config.js';

const { values: args } = parseArgs({
  options: {
    'domain': { type: 'string' },
    'description': { type: 'string', default: '' },
    'type': { type: 'string', default: 'dev-project' },
    'kg-entity': { type: 'string', default: '' },
    'topic': { type: 'string', default: '' },
    'create-telegram-topic': { type: 'boolean', default: false },
    'telegram-chat-id': { type: 'string', default: '' },
    'telegram-icon-color': { type: 'string', default: '0x6FB9F0' },
    'pending': { type: 'boolean', default: false },
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
  --topic <chatId:topicId>   Привязка к существующему Telegram-топику (только для type=topic-thread).
                             Формат: "-1001234567890:42"
  --create-telegram-topic   Создать новый Telegram-топик через Bot API и привязать к домену
                             (только для type=topic-thread, требует --telegram-chat-id).
                             Токен бота: ~/.openclaw/openclaw.json -> channels.telegram.accounts.sergey.botToken
                             (или env TELEGRAM_BOT_TOKEN).
  --telegram-chat-id <id>   Chat ID форум-группы для --create-telegram-topic
                             (например "-1001234567890").
  --telegram-icon-color <h> Цвет иконки топика в hex (по умолчанию 0x6FB9F0 - синий).
                             Telegram: 0x6FB9F0 blue, 0xFFD67E yellow, 0xCB86DB purple,
                             0x8EEE98 green, 0xFF93B2 pink, 0xFB6F5F red.
  --pending                  Создать домен в статусе pending (только для type=topic-thread).
                             pending: true в registry.json. Используется хуком
                             engram-topic-auto-domain-suggest после подтверждения
                             пользователя в чате. Идемпотентно: если для этого
                             (chatId, topicId) уже есть домен — exit 0 no-op.
  -h, --help                 Показать справку

Examples:
  # Субагент-домен (как раньше)
  bun skills/engram/scripts/add-domain.js --domain monitoring
  bun skills/engram/scripts/add-domain.js --domain engram --type dev-project --kg-entity projects/engram

  # Telegram-топик как домен (создать новый)
  bun skills/engram/scripts/add-domain.js --domain about \\
    --type topic-thread \\
    --create-telegram-topic \\
    --telegram-chat-id -1001234567890 \\
    --kg-entity projects/professional-profile \\
    --description "Professional profile: CV, bio, личный бренд"

  # Telegram-топик как домен (привязать к существующему)
  bun skills/engram/scripts/add-domain.js --domain engram \\
    --type topic-thread \\
    --topic -1001234567890:42 \\
    --kg-entity projects/engram \\
    --description "Engram memory architecture — дизайн, RFC, решения"

  # Pending-режим (после подтверждения пользователя в чате, через хук)
  bun skills/engram/scripts/add-domain.js --domain foo \\
    --type topic-thread \\
    --topic -1001234567890:42 \\
    --pending \\
    --description "Топик создан пользователем, ожидает промоушна"
`);
  process.exit(args.help ? 0 : 1);
}

const domain = args.domain;
const description = args.description || domain;
const domainType = args.type;
const kgEntity = args['kg-entity'];
const topicArg = args.topic;
const createTelegramTopic = args['create-telegram-topic'];
const telegramChatIdArg = args['telegram-chat-id'];
const telegramIconColor = args['telegram-icon-color'];
const pending = args.pending;
const WORKSPACE = process.cwd();
const QMD = resolveQmdCommand(WORKSPACE);
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const SKILL_DIR = process.env.ENGRAM_SKILL_DIR || resolve(SCRIPT_DIR, '..');
const TEMPLATES = join(SKILL_DIR, 'templates', 'domain');

// Конфликт: --topic и --create-telegram-topic взаимоисключающие
if (topicArg && createTelegramTopic) {
  console.error('❌ --topic и --create-telegram-topic взаимоисключающие.');
  console.error('   --topic — привязать к существующему топику.');
  console.error('   --create-telegram-topic — создать новый топик через Bot API.');
  process.exit(1);
}

// --create-telegram-topic требует type=topic-thread
if (createTelegramTopic && domainType !== 'topic-thread') {
  console.error('❌ --create-telegram-topic работает только с --type topic-thread');
  process.exit(1);
}

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
  if (createTelegramTopic) {
    if (!telegramChatIdArg) {
      console.error('❌ Для --create-telegram-topic обязателен --telegram-chat-id <id>');
      console.error('   Пример: --telegram-chat-id -1001234567890');
      process.exit(1);
    }
    if (!/^-?\d+$/.test(telegramChatIdArg)) {
      console.error(`❌ --telegram-chat-id должен быть числовым ID (например -1001234567890)`);
      console.error(`   Получено: "${telegramChatIdArg}"`);
      process.exit(1);
    }

    let botToken = process.env.TELEGRAM_BOT_TOKEN || '';
    if (!botToken) {
      try {
        const oc = JSON.parse(await Bun.file(join(process.env.USERPROFILE || process.env.HOME, '.openclaw', 'openclaw.json')).text());
        botToken = oc?.channels?.telegram?.accounts?.sergey?.botToken || '';
      } catch (e) {
        console.error('❌ Не удалось прочитать ~/.openclaw/openclaw.json. Установите TELEGRAM_BOT_TOKEN или проверьте config.');
        process.exit(1);
      }
    }
    if (!botToken) {
      console.error('❌ Токен бота не найден ни в TELEGRAM_BOT_TOKEN, ни в openclaw.json:channels.telegram.accounts.sergey.botToken');
      process.exit(1);
    }

    if (!/^0x[0-9A-Fa-f]{6}$/.test(telegramIconColor)) {
      console.error(`❌ --telegram-icon-color должен быть в формате 0xRRGGBB, например 0x6FB9F0`);
      console.error(`   Получено: "${telegramIconColor}"`);
      process.exit(1);
    }

    console.log(`🤖 Создаю Telegram-топик "${domain}" в chat_id=${telegramChatIdArg} (icon ${telegramIconColor})...`);
    const url = `https://api.telegram.org/bot${botToken}/createForumTopic`;
    // Telegram Bot API ожидает icon_color как Integer (RGB24), не hex-строку.
    // Парсим "0xRRGGBB" (после валидации) в integer.
    const iconColorInt = parseInt(telegramIconColor, 16);
    const formData = new URLSearchParams({
      chat_id: telegramChatIdArg,
      name: domain,
      icon_color: String(iconColorInt),
    });
    let response;
    try {
      response = await fetch(url, { method: 'POST', body: formData });
    } catch (e) {
      console.error(`❌ Не удалось вызвать Telegram Bot API: ${e.message}`);
      console.error('   Проверьте сетевое соединение и токен бота.');
      process.exit(1);
    }
    const result = await response.json();
    if (!result.ok) {
      console.error(`❌ Telegram Bot API вернул ошибку: ${result.error_code} — ${result.description}`);
      console.error('   Частые причины: бот не админ форума (can_manage_topics=false), чат не форум, неверный chat_id.');
      process.exit(1);
    }
    const newTopicId = String(result.result.message_thread_id);
    console.log(`✅ Топик создан: ${telegramChatIdArg}:${newTopicId} (icon_color=0x${result.result.icon_color.toString(16).toUpperCase()})`);
    topicBinding = { chatId: telegramChatIdArg, topicId: newTopicId };
  } else {
    if (!topicArg) {
      console.error('❌ Для type=topic-thread обязателен --topic <chatId:topicId> или --create-telegram-topic');
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
  }
} else if (topicArg) {
  console.warn(`⚠️  --topic указан, но тип домена ${domainType} (не topic-thread). Игнорирую.`);
}

const domainsDir = join(WORKSPACE, 'memory', 'domains');
const domainDir = join(domainsDir, domain);

// --pending идемпотентность: если для этого (chatId, topicId) уже есть домен —
// no-op. Это критично для auto-bind flow, где хук может вызвать add-domain
// несколько раз (service-message + первый user message, fast-track). Проверяем
// ДО README.md check, чтобы повторный вызов с тем же именем и тем же
// (chatId, topicId) не падал на name conflict.
if (pending && topicBinding) {
  // registryPath declared further down; reconstruct locally to keep this
  // idempotency check self-contained at the top of the validation pipeline.
  const earlyRegistryPath = join(domainsDir, 'registry.json');
  try {
    const earlyRegistryFile = Bun.file(earlyRegistryPath);
    if (await earlyRegistryFile.exists()) {
      const earlyRegistry = JSON.parse(await earlyRegistryFile.text());
      const existingDomains = earlyRegistry?.domains && typeof earlyRegistry.domains === 'object' && !Array.isArray(earlyRegistry.domains)
        ? earlyRegistry.domains
        : {};
      for (const [name, entry] of Object.entries(existingDomains)) {
        if (entry?.topic &&
            String(entry.topic.chatId).replace(/^-/, '') === String(topicBinding.chatId).replace(/^-/, '') &&
            String(entry.topic.topicId) === String(topicBinding.topicId)) {
          const isPending = entry.pending === true ? ' (pending)' : '';
          console.log(`✅ Домен "${name}" уже привязан к ${topicBinding.chatId}:${topicBinding.topicId}${isPending} — no-op.`);
          process.exit(0);
        }
      }
    }
  } catch { /* best-effort, fall through to normal create */ }
}

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
// Session key для topic-thread: OpenClaw хранит chatId с ведущим минусом для групп;
// в session key используется абсолютное значение (без минуса).
const sessionKey = topicBinding
  ? `telegram-group--${topicBinding.chatId.replace(/^-/, '')}-topic-${topicBinding.topicId}`
  : '';
const kgEntityPath = kgEntity || '';
const kgEntityDisplay = kgEntity
  ? `\`${kgEntity}\` (QMD collection: \`life-projects-${domain}\`, FS: \`life/${kgEntity}/\`)`
  : 'не задан (домен без KG entity)';

// Workspace context: read from engram.json if available, else use placeholders.
// Эти substitutions делают agents.md template generic в public repo, а deployed
// копии получают workspace-specific values при backfill/add-domain.
function readEngramConfig() {
  const p = join(WORKSPACE, 'engram.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return {}; }
}
const engramConfig = readEngramConfig();
// AGENT_ID — суффикс без "agent-" префикса (например "apriori-tech" в нашем workspace).
// engram.json хранит полный "agent-apriori-tech"; template использует литерал "agent-"
// перед {{AGENT_ID}} чтобы собрать правильный QMD collection name
// "openclaw-memory-agent-{agentId}-{sessionKey}".
const agentIdRaw = engramConfig.agent || engramConfig.agentId || process.env.ENGRAM_AGENT_ID || 'agent-main';
const agentId = agentIdRaw.replace(/^agent-/, '');
const workspaceName = engramConfig.workspace?.name || process.env.ENGRAM_WORKSPACE_NAME || basename(WORKSPACE);
const operator = engramConfig.operator || process.env.ENGRAM_OPERATOR || 'Operator (см. workspace AGENTS.md)';
const qmdIndex = engramConfig.qmd?.index || process.env.ENGRAM_QMD_INDEX || 'apriori';
const workspaceKgCollection = engramConfig.qmd?.workspaceKgCollection || process.env.ENGRAM_WORKSPACE_KG_COLLECTION || 'life';

const replacements = {
  DOMAIN: domain,
  DESCRIPTION: description,
  DATE: today,
  WORKSPACE: workspaceName,
  OPERATOR: operator,
  QMD_INDEX: qmdIndex,
  AGENT_ID: agentId,
  WORKSPACE_KG_COLLECTION: workspaceKgCollection,
  ...(topicBinding ? { CHAT_ID: topicBinding.chatId, TOPIC_ID: topicBinding.topicId, SESSION_KEY: sessionKey } : {}),
  ...(kgEntity ? { KG_ENTITY_PATH: kgEntityPath, KG_ENTITY_DISPLAY: kgEntityDisplay } : {}),
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
// agents.md — для topic-thread. Per-domain operational ruleset, инжектится хуком
// engram-topic-domain-load вторым блоком в daily note.
if (domainType === 'topic-thread') {
  templates.push('agents.md');
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

// Per-type defaults: cadenceDays (when hb-domains-write should fire) and
// staleAfterDays (when the domain is flagged as stale and eligible for archive).
// Per-type reasoning:
//   topic-thread: reactive to chat activity; 2d catches work-day gaps without spam.
//     60d archive threshold matches "dormant topic" lifetime.
//   dev-project: longer natural cycles; 3d gap is enough to notice quiet periods.
//   cron-task: schedule-driven; 1d ensures status is fresh; 30d archive (most aggressive).
const DEFAULTS_BY_TYPE = {
  "topic-thread": { cadenceDays: 2, staleAfterDays: 60 },
  "dev-project":  { cadenceDays: 3, staleAfterDays: 60 },
  "cron-task":    { cadenceDays: 1, staleAfterDays: 30 },
};
const typeDefaults = DEFAULTS_BY_TYPE[domainType] ?? { cadenceDays: 3, staleAfterDays: 60 };

registry.domains[domain] = {
  type: domainType,
  cadenceDays: typeDefaults.cadenceDays,
  staleAfterDays: typeDefaults.staleAfterDays,
  ...(kgEntity ? { kgEntity } : {}),
  ...(topicBinding ? { topic: topicBinding } : {}),
  ...(pending ? { pending: true } : {}),
  description,
  created: today,
};

await Bun.write(registryPath, JSON.stringify(registry, null, 2) + '\n');

const registryBits = [`тип: ${domainType}`];
if (kgEntity) registryBits.push(`KG: ${kgEntity}`);
if (topicBinding) registryBits.push(`топик: ${topicBinding.chatId}:${topicBinding.topicId}`);
if (pending) registryBits.push('pending: true');
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
✅ Домен создан!${pending ? ' (pending — требует promote для активации)' : ''}
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
  4. Операционные правила топик-агента → agents.md (auto-inject в daily note, ручной override)
  5. Хук engram-topic-domain-load автоматически подгружает контекст в daily note при заходе в топик
  6. Heartbeat: liveness, changelog rotation, KG extraction`
  : `  1. Настрой правила в decisions.md
  2. Запусти субагент с промптом из templates/spawn-prompt.md
  3. Субагент обновит status.md и changelog.md`}
`);
