#!/usr/bin/env bun
// memory-system/scripts/add-domain.js
// Создать новый домен для субагента с persistent memory
// Usage: bun skills/memory-system/scripts/add-domain.js --domain monitoring [--description "Описание"]

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const { values: args } = parseArgs({
  options: {
    'domain': { type: 'string' },
    'description': { type: 'string', default: '' },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help || !args.domain) {
  console.log(`
add-domain — Создать домен для субагента с persistent memory

Usage:
  bun skills/memory-system/scripts/add-domain.js --domain <name> [options]

Options:
  --domain <name>         Имя домена (латиница, дефисы)
  --description <text>    Описание домена
  -h, --help              Показать справку

Examples:
  bun skills/memory-system/scripts/add-domain.js --domain monitoring
  bun skills/memory-system/scripts/add-domain.js --domain monitoring --description "Мониторинг инфраструктуры"
`);
  process.exit(args.help ? 0 : 1);
}

const domain = args.domain;
const description = args.description || domain;
const WORKSPACE = process.cwd();
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const SKILL_DIR = resolve(SCRIPT_DIR, '..');
const TEMPLATES = join(SKILL_DIR, 'templates', 'domain');

// Валидация имени домена
if (!/^[a-z][a-z0-9-]*$/.test(domain)) {
  console.error('❌ Имя домена должно начинаться с буквы и содержать только a-z, 0-9, дефис');
  process.exit(1);
}

const domainsDir = join(WORKSPACE, 'memory', 'domains');
const domainDir = join(domainsDir, domain);

// Проверка: домен уже существует
if (existsSync(domainDir)) {
  console.error(`❌ Домен уже существует: memory/domains/${domain}/`);
  process.exit(1);
}

// Предупреждение при >20 доменах
if (existsSync(domainsDir)) {
  const existing = readdirSync(domainsDir, { withFileTypes: true })
    .filter(e => e.isDirectory()).length;
  if (existing >= 20) {
    console.warn(`⚠️  Уже ${existing} доменов. Рекомендуется не более 20.`);
  }
}

// Создание директории
mkdirSync(join(domainDir, 'archives'), { recursive: true });
console.log(`📁 Создан: memory/domains/${domain}/`);

// Копирование шаблонов с подстановками
const today = new Date().toISOString().split('T')[0];
const replacements = { DOMAIN: domain, DESCRIPTION: description, DATE: today };

const templates = ['decisions.md', 'status.md', 'changelog.md', 'README.md'];
for (const tmpl of templates) {
  const src = join(TEMPLATES, tmpl);
  if (!existsSync(src)) {
    console.error(`❌ Шаблон не найден: templates/domain/${tmpl}`);
    process.exit(1);
  }
  let content = readFileSync(src, 'utf-8');
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  writeFileSync(join(domainDir, tmpl), content);
  console.log(`  ✅ ${tmpl}`);
}

// Регистрация QMD коллекции domains (одна на все домены)
function qmdAvailable() {
  try {
    execSync('qmd --help', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

if (qmdAvailable()) {
  try {
    // Пробуем добавить коллекцию — если уже есть, будет ошибка (OK)
    execSync(`qmd collection add "${join(WORKSPACE, 'memory', 'domains')}" --name domains --mask "**/*.md"`, { stdio: 'pipe' });
    console.log('🔍 QMD коллекция `domains` создана');
  } catch {
    console.log('🔍 QMD коллекция `domains` уже существует');
  }

  try {
    execSync('qmd update', { stdio: 'pipe' });
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
   Описание:     ${description}
   Путь:         memory/domains/${domain}/
   QMD:          qmd query "запрос" -c domains

Использование:
  1. Настройте правила в decisions.md
  2. Запустите субагент с промптом из templates/spawn-prompt.md
  3. Субагент обновит status.md и changelog.md
`);
