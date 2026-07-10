#!/usr/bin/env bun
// engram/scripts/add-domain.js
// Создать новый домен (субагент, cron-задача или Telegram-топик) с persistent memory
// Usage: bun skills/engram/scripts/add-domain.js --domain <name> [options]

import { parseArgs } from 'node:util';
import { mkdirSync, readdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { findLatestDailyNoteWithContent, parseMarkdownSections, buildAutoDerivedStatus } from './_lib/auto-derive-status.js';
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
    'peer': { type: 'string', default: '' },
    'group': { type: 'string', default: '' },
    'create-telegram-topic': { type: 'boolean', default: false },
    'telegram-chat-id': { type: 'string', default: '' },
    'telegram-icon-color': { type: 'string', default: '0x6FB9F0' },
    'pending': { type: 'boolean', default: false },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

// Helpers findLatestDailyNoteWithContent / parseMarkdownSections /
// buildAutoDerivedStatus / hasAutoDerivedMarker импортируются из
// _lib/auto-derive-status.js — shared между add-domain.js (Layer 1,
// cold-start) и heartbeat-runner.js (Layer 2, maintenance).

if (args.help || !args.domain) {
  console.log(`
add-domain — Создать домен для субагента, cron-задачи или Telegram-топика

Usage:
  bun skills/engram/scripts/add-domain.js --domain <name> [options]

Options:
  --domain <name>            Имя домена (латиница, дефисы)
  --description <text>       Описание домена
  --type <type>              Тип домена:
                               dev-project    — development project (default)
                               cron-task      — periodic task
                               topic-thread   — Telegram topic as memory contour
                               peer-direct    — Telegram DM chat as memory contour
                               group-direct   — Telegram group (no topics) as memory contour
  --kg-entity <path>         Путь к KG entity (например "projects/engram")
  --topic <chatId:topicId>   Привязка к существующему Telegram-топику (только для type=topic-thread).
                             Формат: "-100XXXXXXXXXX:NN"
  --peer <chatId>            Привязка к DM-чату (только для type=peer-direct).
                             Формат: userId (например "205075873")
  --group <chatId>           Привязка к группе без топиков (только для type=group-direct).
                             Формат: "-100XXXXXXXXXX"
  --create-telegram-topic   Создать новый Telegram-топик через Bot API и привязать к домену
                             (только для type=topic-thread, требует --telegram-chat-id).
                             Токен бота: ~/.openclaw/openclaw.json -> channels.telegram.accounts.sergey.botToken
                             (или env TELEGRAM_BOT_TOKEN).
  --telegram-chat-id <id>   Chat ID форум-группы для --create-telegram-topic
                             (например "-100XXXXXXXXXX").
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
    --telegram-chat-id -100XXXXXXXXXX \\
    --kg-entity projects/professional-profile \\
    --description "Professional profile: CV, bio, личный бренд"

  # Telegram-топик как домен (привязать к существующему)
  bun skills/engram/scripts/add-domain.js --domain engram \\
    --type topic-thread \\
    --topic -100XXXXXXXXXX:NN \\
    --kg-entity projects/engram \\
    --description "Engram memory architecture — дизайн, RFC, решения"

  # Pending-режим (после подтверждения пользователя в чате, через хук)
  bun skills/engram/scripts/add-domain.js --domain foo \\
    --type topic-thread \\
    --topic -100XXXXXXXXXX:NN \\
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
if (!['dev-project', 'cron-task', 'topic-thread', 'peer-direct', 'group-direct'].includes(domainType)) {
  console.error('❌ Тип домена должен быть dev-project, cron-task, topic-thread, peer-direct или group-direct');
  process.exit(1);
}

// Парсинг и валидация --topic для topic-thread
let topicBinding = null;
if (domainType === 'topic-thread') {
  if (createTelegramTopic) {
    if (!telegramChatIdArg) {
      console.error('❌ Для --create-telegram-topic обязателен --telegram-chat-id <id>');
      console.error('   Пример: --telegram-chat-id -100XXXXXXXXXX');
      process.exit(1);
    }
    if (!/^-?\d+$/.test(telegramChatIdArg)) {
      console.error(`❌ --telegram-chat-id должен быть числовым ID (например -100XXXXXXXXXX)`);
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
      console.error('   Пример: --topic -100XXXXXXXXXX:NN');
      process.exit(1);
    }
    const m = topicArg.match(/^(-?\d+):(\d+)$/);
    if (!m) {
      console.error(`❌ --topic должен быть в формате <chatId:topicId>, например "-100XXXXXXXXXX:NN"`);
      console.error(`   Получено: "${topicArg}"`);
      process.exit(1);
    }
    topicBinding = { chatId: m[1], topicId: m[2] };
  }
} else if (topicArg) {
  console.warn(`⚠️  --topic указан, но тип домена ${domainType} (не topic-thread). Игнорирую.`);
}

const peerArg = args.peer;
const groupArg = args.group;

// --- peer-direct binding ---
let peerBinding = null;
if (domainType === 'peer-direct') {
  if (!peerArg) {
    console.error('❌ Для type=peer-direct обязателен --peer <chatId>');
    console.error('   Пример: --peer 205075873');
    process.exit(1);
  }
  if (!/^\d+$/.test(peerArg)) {
    console.error(`❌ --peer должен быть числовым userId (например 205075873)`);
    console.error(`   Получено: "${peerArg}"`);
    process.exit(1);
  }
  peerBinding = { chatId: peerArg };
} else if (peerArg) {
  console.warn(`⚠️  --peer указан, но тип домена ${domainType} (не peer-direct). Игнорирую.`);
}

// --- group-direct binding ---
let groupBinding = null;
if (domainType === 'group-direct') {
  if (!groupArg) {
    console.error('❌ Для type=group-direct обязателен --group <chatId>');
    console.error('   Пример: --group -100XXXXXXXXXX');
    process.exit(1);
  }
  if (!/^-?\d+$/.test(groupArg)) {
    console.error(`❌ --group должен быть числовым chat ID (например -100XXXXXXXXXX)`);
    console.error(`   Получено: "${groupArg}"`);
    process.exit(1);
  }
  groupBinding = { chatId: groupArg };
} else if (groupArg) {
  console.warn(`⚠️  --group указан, но тип домена ${domainType} (не group-direct). Игнорирую.`);
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
// Session key для topic-thread/peer-direct/group-direct:
// topic-thread:  telegram-group--{absChatId}-topic-{topicId}
// peer-direct:   telegram-direct--{chatId}
// group-direct:  telegram-group--{absChatId}
const sessionKey = topicBinding
  ? `telegram-group--${topicBinding.chatId.replace(/^-/, '')}-topic-${topicBinding.topicId}`
  : peerBinding
    ? `telegram-direct--${peerBinding.chatId}`
    : groupBinding
      ? `telegram-group--${groupBinding.chatId.replace(/^-/, '')}`
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
// AGENT_ID — суффикс без "agent-" префикса (например "<agent-id>" в нашем workspace).
// engram.json хранит полный "agent-<agent-id>"; template использует литерал "agent-"
// перед {{AGENT_ID}} чтобы собрать правильный QMD collection name
// "openclaw-memory-agent-{agentId}-{sessionKey}".
const agentIdRaw = engramConfig.agent || engramConfig.agentId || process.env.ENGRAM_AGENT_ID || 'agent-main';
const agentId = agentIdRaw.replace(/^agent-/, '');
const workspaceName = engramConfig.workspace?.name || process.env.ENGRAM_WORKSPACE_NAME || basename(WORKSPACE);
const operator = engramConfig.operator || process.env.ENGRAM_OPERATOR || 'Operator (см. workspace AGENTS.md)';
const qmdIndex = engramConfig.qmd?.index || process.env.ENGRAM_QMD_INDEX || 'default';
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
// agents.md — для topic-thread, peer-direct и group-direct.
// Per-domain operational ruleset, инжектится хуком *-domain-load.
if (domainType === 'topic-thread' || domainType === 'peer-direct' || domainType === 'group-direct') {
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

// Для topic-thread / peer-direct / group-direct дописываем секцию привязки в README
if ((domainType === 'topic-thread' || domainType === 'peer-direct' || domainType === 'group-direct') && (topicBinding || peerBinding || groupBinding)) {
  const readmePath = join(domainDir, 'README.md');
  let readme = await Bun.file(readmePath).text();
  let bindingBlock = '';
  if (topicBinding) {
    const sessionChatId = topicBinding.chatId.startsWith('-') ? topicBinding.chatId.slice(1) : topicBinding.chatId;
    bindingBlock = `\n## Привязка к топику\n\n- **Chat ID**: \`${topicBinding.chatId}\`\n- **Topic ID**: \`${topicBinding.topicId}\`\n- **Session**: \`telegram-group--${sessionChatId}-topic-${topicBinding.topicId}\`\n`;
  } else if (peerBinding) {
    bindingBlock = `\n## Привязка к DM-чату\n\n- **User ID**: \`${peerBinding.chatId}\`\n- **Session**: \`telegram-direct--${peerBinding.chatId}\`\n`;
  } else if (groupBinding) {
    const sessionChatId = groupBinding.chatId.startsWith('-') ? groupBinding.chatId.slice(1) : groupBinding.chatId;
    bindingBlock = `\n## Привязка к группе\n\n- **Chat ID**: \`${groupBinding.chatId}\`\n- **Session**: \`telegram-group--${sessionChatId}\`\n`;
  }
  const sectionTitle = topicBinding ? '## Привязка к топику' : peerBinding ? '## Привязка к DM-чату' : '## Привязка к группе';
  if (bindingBlock && !readme.includes(sectionTitle)) {
    await Bun.write(readmePath, readme.trimEnd() + bindingBlock);
  }

  // === Cold-start auto-derive для status.md ===
  // Если в сессии уже есть daily note с контентом (типичный случай для
  // --topic <chatId:topicId> и для auto-bind), заполняем status.md реальным
  // handover'ом вместо пустого placeholder'а. Маркер auto-derived даёт
  // heartbeat-runner'у (Layer 2, опционально) право перегенерить.
  const sessionDir = join(WORKSPACE, 'memory', `agent-${agentId}`, sessionKey);
  const latest = findLatestDailyNoteWithContent(sessionDir);
  if (latest) {
    try {
      const content = readFileSync(latest.path, 'utf-8');
      const sections = parseMarkdownSections(content);
      const derived = buildAutoDerivedStatus(domain, latest.date, today, sections);
      const statusPath = join(domainDir, 'status.md');
      writeFileSync(statusPath, derived);
      console.log(`  🔄 status.md auto-derived from ${latest.date}.md (${latest.size} bytes)`);
    } catch (e) {
      console.warn(`  ⚠️  status.md auto-derive failed: ${e.message}`);
    }
  } else {
    console.log(`  ℹ️  status.md: empty template (нет prior daily notes в ${sessionDir})`);
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
// Проверка дублей peer-привязки: один DM = один домен
if (peerBinding) {
  for (const [name, entry] of Object.entries(registry.domains || {})) {
    if (entry.peer && String(entry.peer.chatId).replace(/^-/, '') === String(peerBinding.chatId).replace(/^-/, '')) {
      console.error(`❌ DM ${peerBinding.chatId} уже привязан к домену "${name}"`);
      process.exit(1);
    }
  }
}
// Проверка дублей group-привязки: одна группа = один домен
if (groupBinding) {
  for (const [name, entry] of Object.entries(registry.domains || {})) {
    if (entry.group && String(entry.group.chatId).replace(/^-/, '') === String(groupBinding.chatId).replace(/^-/, '')) {
      console.error(`❌ Группа ${groupBinding.chatId} уже привязан к домену "${name}"`);
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
// ISS-9 A7 (topic-thread-only): cadenceAdaptive defaults ON for topic-thread
// (the only type with a `topic` binding — computeAdaptiveCadence consumes
// event density from the bound-session daily note). dev-project / cron-task
// do NOT get the flag by default: they have no chat session by design, so
// adaptive is a permanent no-op there. Operators can flip it manually in
// registry.json if a non-topic domain ever gains a topic binding.
// Window defaults to 7 days and is overridable per-domain in registry.json.
const DEFAULT_CADENCE_ADAPTIVE_WINDOW_DAYS = 7;
const DEFAULTS_BY_TYPE = {
  "topic-thread": { cadenceDays: 2, staleAfterDays: 60, cadenceAdaptive: true, cadenceAdaptiveWindowDays: DEFAULT_CADENCE_ADAPTIVE_WINDOW_DAYS },
  "dev-project":  { cadenceDays: 3, staleAfterDays: 60 },
  "cron-task":    { cadenceDays: 1, staleAfterDays: 30 },
  "peer-direct":  { cadenceDays: 2, staleAfterDays: 90 },
  "group-direct": { cadenceDays: 2, staleAfterDays: 90 },
};
const typeDefaults = DEFAULTS_BY_TYPE[domainType] ?? {
  cadenceDays: 3,
  staleAfterDays: 60,
};

registry.domains[domain] = {
  type: domainType,
  cadenceDays: typeDefaults.cadenceDays,
  staleAfterDays: typeDefaults.staleAfterDays,
  ...(typeDefaults.cadenceAdaptive != null ? { cadenceAdaptive: typeDefaults.cadenceAdaptive, cadenceAdaptiveWindowDays: typeDefaults.cadenceAdaptiveWindowDays } : {}),
  ...(kgEntity ? { kgEntity } : {}),
  ...(topicBinding ? { topic: topicBinding } : {}),
  ...(peerBinding ? { peer: peerBinding } : {}),
  ...(groupBinding ? { group: groupBinding } : {}),
  ...(pending ? { pending: true } : {}),
  description,
  created: today,
};

await Bun.write(registryPath, JSON.stringify(registry, null, 2) + '\n');

const registryBits = [`тип: ${domainType}`];
if (kgEntity) registryBits.push(`KG: ${kgEntity}`);
if (topicBinding) registryBits.push(`топик: ${topicBinding.chatId}:${topicBinding.topicId}`);
if (peerBinding) registryBits.push(`DM: ${peerBinding.chatId}`);
if (groupBinding) registryBits.push(`группа: ${groupBinding.chatId}`);
if (pending) registryBits.push('pending: true');
if (typeDefaults.cadenceAdaptive) {
  registryBits.push(`cadenceAdaptive=${typeDefaults.cadenceAdaptiveWindowDays}d`);
}
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
  // into the broader workspace-life collection.
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
   Тип:          ${domainType}${kgEntity ? `\n   KG Entity:    ${kgEntity}` : ''}${topicBinding ? `\n   Топик:        ${topicBinding.chatId}:${topicBinding.topicId}` : ''}${peerBinding ? `\n   DM:           ${peerBinding.chatId}` : ''}${groupBinding ? `\n   Группа:       ${groupBinding.chatId}` : ''}
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
  : (domainType === 'peer-direct' || domainType === 'group-direct')
    ? `  1. Решения и pinned-факты → decisions.md (агент обновляет по «решили X» в чате)
  2. Текущее состояние → status.md (обновляется агентом при завершении блока)
  3. Лог значимых событий → changelog.md
  4. Операционные правила → agents.md (auto-inject через system-event, ручной override)
  5. Хук engram-peer-domain-load автоматически подгружает контекст при каждом новом сообщении`
  : `  1. Настрой правила в decisions.md
  2. Запусти субагент с промптом из templates/spawn-prompt.md
  3. Субагент обновит status.md и changelog.md`}
`);
