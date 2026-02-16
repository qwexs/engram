#!/usr/bin/env bun
// engram/scripts/add-domain.js
// РЎРѕР·РґР°С‚СЊ РЅРѕРІС‹Р№ РґРѕРјРµРЅ РґР»СЏ СЃСѓР±Р°РіРµРЅС‚Р° СЃ persistent memory
// Usage: bun skills/engram/scripts/add-domain.js --domain monitoring [--description "РћРїРёСЃР°РЅРёРµ"]

import { parseArgs } from 'node:util';
import { mkdirSync, readdirSync } from 'node:fs';
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
add-domain вЂ” РЎРѕР·РґР°С‚СЊ РґРѕРјРµРЅ РґР»СЏ СЃСѓР±Р°РіРµРЅС‚Р° СЃ persistent memory

Usage:
  bun skills/engram/scripts/add-domain.js --domain <name> [options]

Options:
  --domain <name>         РРјСЏ РґРѕРјРµРЅР° (Р»Р°С‚РёРЅРёС†Р°, РґРµС„РёСЃС‹)
  --description <text>    РћРїРёСЃР°РЅРёРµ РґРѕРјРµРЅР°
  -h, --help              РџРѕРєР°Р·Р°С‚СЊ СЃРїСЂР°РІРєСѓ

Examples:
  bun skills/engram/scripts/add-domain.js --domain monitoring
  bun skills/engram/scripts/add-domain.js --domain monitoring --description "РњРѕРЅРёС‚РѕСЂРёРЅРі РёРЅС„СЂР°СЃС‚СЂСѓРєС‚СѓСЂС‹"
`);
  process.exit(args.help ? 0 : 1);
}

const domain = args.domain;
const description = args.description || domain;
const WORKSPACE = process.cwd();
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const SKILL_DIR = process.env.ENGRAM_SKILL_DIR || resolve(SCRIPT_DIR, '..');
const TEMPLATES = join(SKILL_DIR, 'templates', 'domain');

// Р’Р°Р»РёРґР°С†РёСЏ РёРјРµРЅРё РґРѕРјРµРЅР°
if (!/^[a-z][a-z0-9-]*$/.test(domain)) {
  console.error('вќЊ РРјСЏ РґРѕРјРµРЅР° РґРѕР»Р¶РЅРѕ РЅР°С‡РёРЅР°С‚СЊСЃСЏ СЃ Р±СѓРєРІС‹ Рё СЃРѕРґРµСЂР¶Р°С‚СЊ С‚РѕР»СЊРєРѕ a-z, 0-9, РґРµС„РёСЃ');
  process.exit(1);
}

const domainsDir = join(WORKSPACE, 'memory', 'domains');
const domainDir = join(domainsDir, domain);

// РџСЂРѕРІРµСЂРєР°: РґРѕРјРµРЅ СѓР¶Рµ СЃСѓС‰РµСЃС‚РІСѓРµС‚
if (await Bun.file(join(domainDir, 'README.md')).exists()) {
  console.error(`вќЊ Р”РѕРјРµРЅ СѓР¶Рµ СЃСѓС‰РµСЃС‚РІСѓРµС‚: memory/domains/${domain}/`);
  process.exit(1);
}

// РџСЂРµРґСѓРїСЂРµР¶РґРµРЅРёРµ РїСЂРё >20 РґРѕРјРµРЅР°С…
try {
  const existing = readdirSync(domainsDir, { withFileTypes: true })
    .filter(e => e.isDirectory()).length;
  if (existing >= 20) {
    console.warn(`вљ пёЏ  РЈР¶Рµ ${existing} РґРѕРјРµРЅРѕРІ. Р РµРєРѕРјРµРЅРґСѓРµС‚СЃСЏ РЅРµ Р±РѕР»РµРµ 20.`);
  }
} catch { /* РґРёСЂРµРєС‚РѕСЂРёРё РµС‰С‘ РЅРµС‚ */ }

// РЎРѕР·РґР°РЅРёРµ РґРёСЂРµРєС‚РѕСЂРёРё
mkdirSync(join(domainDir, 'archives'), { recursive: true });
console.log(`рџ“Ѓ РЎРѕР·РґР°РЅ: memory/domains/${domain}/`);

// РљРѕРїРёСЂРѕРІР°РЅРёРµ С€Р°Р±Р»РѕРЅРѕРІ СЃ РїРѕРґСЃС‚Р°РЅРѕРІРєР°РјРё
const today = new Date().toISOString().split('T')[0];
const replacements = { DOMAIN: domain, DESCRIPTION: description, DATE: today };

const templates = ['decisions.md', 'status.md', 'changelog.md', 'README.md'];
for (const tmpl of templates) {
  const src = join(TEMPLATES, tmpl);
  const srcFile = Bun.file(src);
  if (!await srcFile.exists()) {
    console.error(`вќЊ РЁР°Р±Р»РѕРЅ РЅРµ РЅР°Р№РґРµРЅ: templates/domain/${tmpl}`);
    process.exit(1);
  }
  let content = await srcFile.text();
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  await Bun.write(join(domainDir, tmpl), content);
  console.log(`  вњ… ${tmpl}`);
}

// Р РµРіРёСЃС‚СЂР°С†РёСЏ QMD РєРѕР»Р»РµРєС†РёРё domains (РѕРґРЅР° РЅР° РІСЃРµ РґРѕРјРµРЅС‹)
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
    // РџСЂРѕР±СѓРµРј РґРѕР±Р°РІРёС‚СЊ РєРѕР»Р»РµРєС†РёСЋ вЂ” РµСЃР»Рё СѓР¶Рµ РµСЃС‚СЊ, Р±СѓРґРµС‚ РѕС€РёР±РєР° (OK)
    execSync(`qmd collection add "${join(WORKSPACE, 'memory', 'domains')}" --name domains --mask "**/*.md"`, { stdio: 'pipe' });
    console.log('рџ”Ќ QMD РєРѕР»Р»РµРєС†РёСЏ `domains` СЃРѕР·РґР°РЅР°');
  } catch {
    console.log('рџ”Ќ QMD РєРѕР»Р»РµРєС†РёСЏ `domains` СѓР¶Рµ СЃСѓС‰РµСЃС‚РІСѓРµС‚');
  }

  try {
    execSync('qmd update', { stdio: 'pipe' });
    console.log('рџ“Љ QMD РёРЅРґРµРєСЃ РѕР±РЅРѕРІР»С‘РЅ');
  } catch {
    console.warn('вљ пёЏ  qmd update РЅРµ СѓРґР°Р»СЃСЏ вЂ” Р·Р°РїСѓСЃС‚РёС‚Рµ РІСЂСѓС‡РЅСѓСЋ');
  }
} else {
  console.log('вљ пёЏ  QMD РЅРµ РЅР°Р№РґРµРЅ. Р”РѕР±Р°РІСЊС‚Рµ РєРѕР»Р»РµРєС†РёСЋ РІСЂСѓС‡РЅСѓСЋ:');
  console.log(`   qmd collection add "${join(WORKSPACE, 'memory', 'domains')}" --name domains --mask "**/*.md"`);
}

console.log(`
вњ… Р”РѕРјРµРЅ СЃРѕР·РґР°РЅ!
   Р”РѕРјРµРЅ:        ${domain}
   РћРїРёСЃР°РЅРёРµ:     ${description}
   РџСѓС‚СЊ:         memory/domains/${domain}/
   QMD:          qmd query "Р·Р°РїСЂРѕСЃ" -c domains

РСЃРїРѕР»СЊР·РѕРІР°РЅРёРµ:
  1. РќР°СЃС‚СЂРѕР№С‚Рµ РїСЂР°РІРёР»Р° РІ decisions.md
  2. Р—Р°РїСѓСЃС‚РёС‚Рµ СЃСѓР±Р°РіРµРЅС‚ СЃ РїСЂРѕРјРїС‚РѕРј РёР· templates/spawn-prompt.md
  3. РЎСѓР±Р°РіРµРЅС‚ РѕР±РЅРѕРІРёС‚ status.md Рё changelog.md
`);
