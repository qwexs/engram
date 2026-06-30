#!/usr/bin/env bun
// engram/scripts/backfill-domain-agents.js
// Backfill `agents.md` для всех topic-thread доменов из шаблона.
// Полезно после:
//   - первичной миграции (все существующие домены получают файл)
//   - обновления шаблона (применяется только к доменам, где файл ещё не правили руками;
//     manual override в agents.md защищён флагом `--force`)
//   - добавления нового поля в шаблон
//
// Usage:
//   bun skills/engram/scripts/backfill-domain-agents.js              # создать только отсутствующие
//   bun skills/engram/scripts/backfill-domain-agents.js --force      # перезаписать все
//   bun skills/engram/scripts/backfill-domain-agents.js --dry-run    # показать план, не писать
//   bun skills/engram/scripts/backfill-domain-agents.js --domain <slug>  # только один домен

import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, renameSync } from 'node:fs';

const { values: args } = parseArgs({
  options: {
    'domain': { type: 'string', default: '' },
    'force': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
backfill-domain-agents — Создать/обновить agents.md для topic-thread доменов

Usage:
  bun skills/engram/scripts/backfill-domain-agents.js [options]

Options:
  --domain <slug>     Только один домен (default: все)
  --force             Перезаписать существующие agents.md (default: skip)
  --dry-run           Показать план, не писать
  -h, --help          Показать справку

Notes:
  • Без --force: создаются только отсутствующие файлы. Ручной override защищён.
  • С --force: перезаписываются ВСЕ указанные домены. Использовать после обновления шаблона.
  • Работает только с type=topic-thread. dev-project / cron-task — skip.
`);
  process.exit(0);
}

const WORKSPACE = process.cwd();
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const SKILL_DIR = process.env.ENGRAM_SKILL_DIR || resolve(SCRIPT_DIR, '..');
const TEMPLATE = join(SKILL_DIR, 'templates', 'domain', 'topic-thread', 'agents.md');
const REGISTRY = join(WORKSPACE, 'memory', 'domains', 'registry.json');

if (!existsSync(TEMPLATE)) {
  console.error(`❌ Шаблон не найден: ${TEMPLATE}`);
  process.exit(1);
}
if (!existsSync(REGISTRY)) {
  console.error(`❌ Registry не найден: ${REGISTRY}`);
  process.exit(1);
}

const registry = JSON.parse(readFileSync(REGISTRY, 'utf-8'));
const domains = registry.domains || {};
const template = readFileSync(TEMPLATE, 'utf-8');

let created = 0, skipped = 0, wouldCreate = 0, wouldSkip = 0, errors = 0;

function renderTemplate(slug, topicBinding, kgEntity) {
  const sessionKey = topicBinding
    ? `telegram-group--${String(topicBinding.chatId).replace(/^-/, '')}-topic-${topicBinding.topicId}`
    : '';
  const kgEntityPath = kgEntity || '';
  const kgEntityDisplay = kgEntity
    ? `\`${kgEntity}\` (QMD collection: \`life-projects-${slug}\`, FS: \`life/${kgEntity}/\`)`
    : 'не задан (домен без KG entity)';
  // Workspace context: read from engram.json if available, else use placeholders.
  // Эти substitutions делают agents.md template generic в public repo, а deployed
  // копии получают workspace-specific values при backfill.
  function readEngramConfig() {
    const p = join(WORKSPACE, 'engram.json');
    if (!existsSync(p)) return {};
    try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return {}; }
  }
  const cfg = readEngramConfig();
  // AGENT_ID — суффикс без "agent-" префикса (например "<agent-id>" в нашем workspace).
  // engram.json хранит полный "agent-<agent-id>"; template использует литерал "agent-"
  // перед {{AGENT_ID}} чтобы собрать правильный QMD collection name.
  const agentIdRaw = cfg.agent || cfg.agentId || process.env.ENGRAM_AGENT_ID || 'agent-main';
  const agentId = agentIdRaw.replace(/^agent-/, '');
  const workspaceName = cfg.workspace?.name || process.env.ENGRAM_WORKSPACE_NAME || basename(WORKSPACE);
  const operator = cfg.operator || process.env.ENGRAM_OPERATOR || 'Operator (см. workspace AGENTS.md)';
  const qmdIndex = cfg.qmd?.index || process.env.ENGRAM_QMD_INDEX || 'default';
  const workspaceKgCollection = cfg.qmd?.workspaceKgCollection || process.env.ENGRAM_WORKSPACE_KG_COLLECTION || 'life';
  return template
    .replaceAll('{{DOMAIN}}', slug)
    .replaceAll('{{SESSION_KEY}}', sessionKey)
    .replaceAll('{{KG_ENTITY_PATH}}', kgEntityPath)
    .replaceAll('{{KG_ENTITY_DISPLAY}}', kgEntityDisplay)
    .replaceAll('{{CHAT_ID}}', topicBinding?.chatId || '')
    .replaceAll('{{TOPIC_ID}}', topicBinding?.topicId || '')
    .replaceAll('{{WORKSPACE}}', workspaceName)
    .replaceAll('{{OPERATOR}}', operator)
    .replaceAll('{{QMD_INDEX}}', qmdIndex)
    .replaceAll('{{AGENT_ID}}', agentId)
    .replaceAll('{{WORKSPACE_KG_COLLECTION}}', workspaceKgCollection);
}

function atomicWrite(path, content) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'engram-backfill-'));
  const tmpPath = join(tmpDir, 'agents.md');
  try {
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, path);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

for (const [slug, entry] of Object.entries(domains)) {
  if (args.domain && args.domain !== slug) continue;
  if (entry.type !== 'topic-thread') {
    console.log(`  ⏭  ${slug}: type=${entry.type}, skip (только topic-thread)`);
    continue;
  }
  if (entry.archived === true && !args.domain) {
    console.log(`  ⏭  ${slug}: archived, skip (явно укажи --domain ${slug} для override)`);
    skipped++;
    continue;
  }

  const domainDir = join(WORKSPACE, 'memory', 'domains', slug);
  const agentsPath = join(domainDir, 'agents.md');
  const exists = existsSync(agentsPath);

  if (exists && !args.force) {
    if (args['dry-run']) {
      console.log(`  would-skip ${slug} (exists, --force не задан)`);
      wouldSkip++;
    } else {
      console.log(`  ⏭  ${slug}: agents.md уже есть, --force не задан — keep manual override`);
      skipped++;
    }
    continue;
  }

  if (!existsSync(domainDir)) {
    console.error(`  ❌ ${slug}: директория ${domainDir} не существует`);
    errors++;
    continue;
  }

  const content = renderTemplate(slug, entry.topic, entry.kgEntity);

  if (args['dry-run']) {
    console.log(`  would-create ${slug} (${content.length} bytes)${args.force && exists ? ' [overwrite]' : ''}`);
    wouldCreate++;
    continue;
  }

  try {
    atomicWrite(agentsPath, content);
    console.log(`  ✅ ${slug}: ${exists ? 'overwritten' : 'created'} (${content.length} bytes)`);
    created++;
  } catch (e) {
    console.error(`  ❌ ${slug}: write failed — ${e.message}`);
    errors++;
  }
}

if (args['dry-run']) {
  console.log(`\n[dry-run] would-create: ${wouldCreate}, would-skip: ${wouldSkip}, errors: ${errors}`);
} else {
  console.log(`\nГотово. Создано: ${created}, пропущено: ${skipped}, ошибок: ${errors}.`);
}

process.exit(errors > 0 ? 1 : 0);
