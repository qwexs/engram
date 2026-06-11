#!/usr/bin/env bun
// engram/scripts/add-domain.js
// Создать новый домен для субагента с persistent memory
// Usage: bun skills/engram/scripts/add-domain.js --domain monitoring [--description "Описание"] [--type dev-project] [--kg-entity projects/engram]

import { parseArgs } from 'node:util';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { resolveQmdCommand } from './config.js';

const { values: args } = parseArgs({
  options: {
    'domain': { type: 'string' },
    'description': { type: 'string', default: '' },
    'type': { type: 'string', default: 'dev-project' },
    'kg-entity': { type: 'string', default: '' },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help || !args.domain) {
  console.log(`
add-domain — Создать домен для субагента с persistent memory

Usage:
  bun skills/engram/scripts/add-domain.js --domain <name> [options]

Options:
  --domain <name>         Имя домена (латиница, дефисы)
  --description <text>    Описание домена
  --type <type>           Тип домена: dev-project | cron-task (default: dev-project)
  --kg-entity <path>      Путь к KG entity (например "projects/engram")
  -h, --help              Показать справку

Examples:
  bun skills/engram/scripts/add-domain.js --domain monitoring
  bun skills/engram/scripts/add-domain.js --domain monitoring --description "Мониторинг инфраструктуры"
  bun skills/engram/scripts/add-domain.js --domain engram --type dev-project --kg-entity projects/engram --description "Memory architecture skill"
`);
  process.exit(args.help ? 0 : 1);
}

const domain = args.domain;
const description = args.description || domain;
const domainType = args.type;
const kgEntity = args['kg-entity'];
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
if (!['dev-project', 'cron-task'].includes(domainType)) {
  console.error('❌ Тип домена должен быть dev-project или cron-task');
  process.exit(1);
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
const replacements = { DOMAIN: domain, DESCRIPTION: description, DATE: today };

const templates = ['decisions.md', 'status.md', 'changelog.md', 'README.md', 'workflow.md'];
for (const tmpl of templates) {
  const src = join(TEMPLATES, tmpl);
  const srcFile = Bun.file(src);
  if (!await srcFile.exists()) {
    console.error(`❌ Шаблон не найден: templates/domain/${tmpl}`);
    process.exit(1);
  }
  let content = await srcFile.text();
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  await Bun.write(join(domainDir, tmpl), content);
  console.log(`  ✅ ${tmpl}`);
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

registry.domains[domain] = {
  type: domainType,
  ...(kgEntity ? { kgEntity } : {}),
  description,
  created: today,
};

await Bun.write(registryPath, JSON.stringify(registry, null, 2) + '\n');
console.log(`  ✅ registry.json (тип: ${domainType}${kgEntity ? `, KG: ${kgEntity}` : ''})`);

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
  try {
    // Пробуем добавить коллекцию — если уже есть, будет ошибка (OK)
    execSync(`${QMD} collection add "${join(WORKSPACE, 'memory', 'domains')}" --name domains --mask "**/*.md"`, { stdio: 'pipe' });
    console.log('📝 QMD коллекция `domains` создана');
  } catch {
    console.log('📝 QMD коллекция `domains` уже существует');
  }

  try {
    execSync(`${QMD} update`, { stdio: 'pipe' });
    console.log('📊 QMD индекс обновлён');
  } catch {
    console.warn('⚠️  qmd update не удался — запустите вручную');
  }
} else {
  console.log('⚠️  QMD не найден. Добавьте коллекцию вручную:');
  console.log(`   qmd collection add "${join(WORKSPACE, 'memory', 'domains')}" --name domains --mask "**/*.md"`);
}

console.log(`
✅ Домен создан!
   Домен:        ${domain}
   Тип:          ${domainType}${kgEntity ? `\n   KG Entity:    ${kgEntity}` : ''}
   Описание:     ${description}
   Путь:         memory/domains/${domain}/
   QMD:          qmd query "запрос" -c domains

Использование:
  1. Настройте правила в decisions.md
  2. Запустите субагент с промптом из templates/spawn-prompt.md
  3. Субагент обновит status.md и changelog.md
`);
