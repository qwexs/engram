#!/usr/bin/env bun
// engram/scripts/promote-domain.js
// Снять флаг pending: true с домена после верификации.
// Используется после auto-bind flow: пользователь подтвердил в чате,
// домен создан в статусе pending, оператор (или сам пользователь)
// промоутит его до полноценного.
//
// Usage:
//   bun skills/engram/scripts/promote-domain.js --domain <slug>
//   bun skills/engram/scripts/promote-domain.js --domain <slug> --refresh-templates
//   bun skills/engram/scripts/promote-domain.js --domain <slug> --refresh-qmd
//
// Options:
//   --domain <slug>     Имя домена (обязательно)
//   --refresh-templates Перезаписать шаблоны (decisions/status/changelog/agents.md)
//                       из templates/domain/. По умолчанию НЕ трогает файлы (защита
//                       от перезаписи пользовательских правок).
//   --refresh-qmd       Пересоздать QMD collections (domain-<slug>, life-projects-<slug>)
//   --force             Промоутить даже если pending: true не выставлен (идемпотентный режим)
//   -h, --help          Показать справку

import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { addQmdCollection } from './_lib/qmd-provision.js';

const { values: args } = parseArgs({
  options: {
    'domain': { type: 'string' },
    'refresh-templates': { type: 'boolean', default: false },
    'refresh-qmd': { type: 'boolean', default: false },
    'force': { type: 'boolean', default: false },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help || !args.domain) {
  console.log(`
promote-domain — Снять флаг pending с домена

Usage:
  bun skills/engram/scripts/promote-domain.js --domain <slug> [options]

Options:
  --domain <slug>     Имя домена (обязательно)
  --refresh-templates Перезаписать шаблоны (decisions/status/changelog/agents.md)
                      из templates/domain/. По умолчанию НЕ трогает файлы.
  --refresh-qmd       Пересоздать QMD collections (domain-<slug>, life-projects-<slug>)
  --force             Промоутить даже если pending: true не выставлен
  -h, --help          Показать справку

Examples:
  # Базовый промоут (только снять pending флаг)
  bun skills/engram/scripts/promote-domain.js --domain foo

  # Промоут + подтянуть свежие шаблоны
  bun skills/engram/scripts/promote-domain.js --domain foo --refresh-templates

  # Полный ресет структуры
  bun skills/engram/scripts/promote-domain.js --domain foo --refresh-templates --refresh-qmd
`);
  process.exit(args.help ? 0 : 1);
}

const domain = args.domain;
const refreshTemplates = args['refresh-templates'];
const refreshQmd = args['refresh-qmd'];
const force = args.force;

const WORKSPACE = process.cwd();

// Валидация имени домена
if (!/^[a-z][a-z0-9-]*$/.test(domain)) {
  console.error('❌ Имя домена должно начинаться с буквы и содержать только a-z, 0-9, дефис');
  process.exit(1);
}

const domainsDir = join(WORKSPACE, 'memory', 'domains');
const domainDir = join(domainsDir, domain);
const registryPath = join(domainsDir, 'registry.json');

// Проверка: домен существует
if (!existsSync(domainDir) || !existsSync(join(domainDir, 'README.md'))) {
  console.error(`❌ Домен не найден: memory/domains/${domain}/`);
  process.exit(1);
}

// Читаем registry
let registry;
try {
  registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
} catch (e) {
  console.error(`❌ Не удалось прочитать registry.json: ${e.message}`);
  process.exit(1);
}

if (!registry.domains || typeof registry.domains !== 'object' || Array.isArray(registry.domains)) {
  console.error('❌ registry.json повреждён (domains должен быть объектом)');
  process.exit(1);
}

const entry = registry.domains[domain];
if (!entry) {
  console.error(`❌ Домен "${domain}" не найден в registry.json`);
  process.exit(1);
}

// Проверяем pending статус
const wasPending = entry.pending === true;
if (!wasPending && !force) {
  console.error(`❌ Домен "${domain}" не в статусе pending (pending=${entry.pending || 'false'}).`);
  console.error('   Используй --force для идемпотентного промоута.');
  process.exit(1);
}

// Снимаем флаг
delete entry.pending;
entry.promotedAt = new Date().toISOString().split('T')[0];

writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
console.log(`✅ registry.json: pending снят${wasPending ? '' : ' (force)'}, promotedAt = ${entry.promotedAt}`);

// Опционально: перезаписать шаблоны
if (refreshTemplates) {
  console.log('🔄 Перезаписываю шаблоны...');
  const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
  const SKILL_DIR = process.env.ENGRAM_SKILL_DIR || resolve(SCRIPT_DIR, '..');
  const TYPE_TEMPLATES = join(SKILL_DIR, 'templates', 'domain', entry.type);
  const TEMPLATES = join(SKILL_DIR, 'templates', 'domain');
  const baseDir = existsSync(join(TYPE_TEMPLATES, 'decisions.md')) ? TYPE_TEMPLATES : TEMPLATES;

  // Re-read engram config to get template substitutions
  const engramConfigPath = join(WORKSPACE, 'engram.json');
  let engramConfig = {};
  if (existsSync(engramConfigPath)) {
    try { engramConfig = JSON.parse(readFileSync(engramConfigPath, 'utf-8')); } catch {}
  }
  const agentIdRaw = engramConfig.agent || engramConfig.agentId || 'agent-main';
  const agentId = agentIdRaw.replace(/^agent-/, '');
  const workspaceName = engramConfig.workspace?.name || basename(WORKSPACE);
  const operator = engramConfig.operator || 'Operator (см. workspace AGENTS.md)';
  const qmdIndex = engramConfig.qmd?.index || 'default';
  const workspaceKgCollection = engramConfig.qmd?.workspaceKgCollection || 'life';

  const replacements = {
    DOMAIN: domain,
    DESCRIPTION: entry.description || domain,
    DATE: new Date().toISOString().split('T')[0],
    WORKSPACE: workspaceName,
    OPERATOR: operator,
    QMD_INDEX: qmdIndex,
    AGENT_ID: agentId,
    WORKSPACE_KG_COLLECTION: workspaceKgCollection,
  };
  if (entry.topic) {
    const sessionChatId = String(entry.topic.chatId).replace(/^-/, '');
    replacements.CHAT_ID = entry.topic.chatId;
    replacements.TOPIC_ID = entry.topic.topicId;
    replacements.SESSION_KEY = `telegram-group--${sessionChatId}-topic-${entry.topic.topicId}`;
  }
  if (entry.kgEntity) {
    replacements.KG_ENTITY_PATH = entry.kgEntity;
    replacements.KG_ENTITY_DISPLAY = `\`${entry.kgEntity}\` (QMD collection: \`life-projects-${domain}\`, FS: \`life/${entry.kgEntity}/\`)`;
  }

  const templates = ['decisions.md', 'status.md', 'changelog.md', 'README.md'];
  if (entry.type !== 'topic-thread') templates.push('workflow.md');
  if (entry.type === 'topic-thread') templates.push('agents.md');

  for (const tmpl of templates) {
    const src = join(baseDir, tmpl);
    if (!existsSync(src)) {
      console.warn(`   ⚠️  Шаблон не найден: ${src} — пропускаю`);
      continue;
    }
    let content = readFileSync(src, 'utf-8');
    for (const [key, value] of Object.entries(replacements)) {
      content = content.replaceAll(`{{${key}}}`, value);
    }
    writeFileSync(join(domainDir, tmpl), content);
    console.log(`   ✅ ${tmpl}`);
  }
}

// Опционально: пересоздать QMD collections
if (refreshQmd) {
  console.log('🔄 Регистрирую QMD collections через Engram core...');
  try {
    const provision = await addQmdCollection({
      workspace: WORKSPACE,
      collection: `domain-${domain}`,
      path: domainDir,
      mask: '**/*.md',
    });
    if (!provision.ok) throw new Error(provision.stderr.trim() || `QMD exited ${provision.exitCode}`);
    console.log(`   ✅ domain-${domain} зарегистрирована`);
  } catch (error) {
    console.log(`   ℹ️  domain-${domain} не зарегистрирована: ${error.message}`);
  }
  if (entry.kgEntity) {
    const entityPath = join(WORKSPACE, 'life', entry.kgEntity);
    if (existsSync(entityPath)) {
      try {
        const provision = await addQmdCollection({
          workspace: WORKSPACE,
          collection: `life-projects-${domain}`,
          path: entityPath,
          mask: '**/*.md',
        });
        if (!provision.ok) throw new Error(provision.stderr.trim() || `QMD exited ${provision.exitCode}`);
        console.log(`   ✅ life-projects-${domain} зарегистрирована`);
      } catch (error) {
        console.log(`   ℹ️  life-projects-${domain} не зарегистрирована: ${error.message}`);
      }
    }
  }
  console.log('   ℹ️  QMD freshness is delegated to the maintenance coordinator.');
}

console.log(`
✅ Домен "${domain}" промоутнут.${wasPending ? ' pending снят.' : ' (force, pending не было).'}${entry.topic ? ` Топик: ${entry.topic.chatId}:${entry.topic.topicId}.` : ''}
`);
