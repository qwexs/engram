#!/usr/bin/env bun
// engram/scripts/list-pending.js
// Показать все домены в статусе pending (auto-created, ожидают промоушна).
// Используется для аудита auto-bind flow.
//
// Usage:
//   bun skills/engram/scripts/list-pending.js
//   bun skills/engram/scripts/list-pending.js --json
//   bun skills/engram/scripts/list-pending.js --all       # include non-pending
//   bun skills/engram/scripts/list-pending.js --type topic-thread

import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const { values: args } = parseArgs({
  options: {
    'all': { type: 'boolean', default: false },
    'type': { type: 'string', default: '' },
    'json': { type: 'boolean', default: false },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
list-pending — Показать домены в статусе pending (auto-bind audit)

Usage:
  bun skills/engram/scripts/list-pending.js [options]

Options:
  --all           Показать все домены (включая не pending)
  --type <type>   Фильтр по типу (dev-project, cron-task, topic-thread)
  --json          Машино-читаемый JSON output
  -h, --help      Показать справку

Examples:
  # Все pending-домены
  bun skills/engram/scripts/list-pending.js

  # Все topic-thread домены (включая active)
  bun skills/engram/scripts/list-pending.js --all --type topic-thread

  # JSON для автоматизации
  bun skills/engram/scripts/list-pending.js --json | jq '.[] | select(.pending)'
`);
  process.exit(0);
}

const WORKSPACE = process.cwd();
const registryPath = join(WORKSPACE, 'memory', 'domains', 'registry.json');

if (!existsSync(registryPath)) {
  console.log('(registry.json не найден — нет доменов)');
  process.exit(0);
}

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

const today = new Date().toISOString().split('T')[0];
const allEntries = Object.entries(registry.domains);
const filtered = allEntries.filter(([name, entry]) => {
  if (!args.all && entry.pending !== true) return false;
  if (args.type && entry.type !== args.type) return false;
  return true;
});

if (args.json) {
  const out = filtered.map(([name, entry]) => {
    const ageDays = entry.created ? Math.max(0, Math.floor((Date.now() - new Date(entry.created).getTime()) / 86400000)) : null;
    return {
      name,
      pending: entry.pending === true,
      type: entry.type,
      topic: entry.topic ? `${entry.topic.chatId}:${entry.topic.topicId}` : null,
      kgEntity: entry.kgEntity || null,
      created: entry.created || null,
      ageDays,
      description: entry.description || null,
    };
  });
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

if (filtered.length === 0) {
  console.log(args.all ? '(нет доменов)' : '(нет pending доменов)');
  process.exit(0);
}

console.log(`${filtered.length} ${args.all ? 'домен' : 'pending-домен'}${filtered.length === 1 ? '' : (filtered.length < 5 ? 'а' : 'ов')}:`);
console.log();
for (const [name, entry] of filtered) {
  const status = entry.pending === true ? '🟡 pending' : '🟢 active';
  const ageDays = entry.created ? Math.max(0, Math.floor((Date.now() - new Date(entry.created).getTime()) / 86400000)) : null;
  const ageStr = ageDays !== null ? `, ${ageDays}d` : '';
  const topicStr = entry.topic ? `, topic=${entry.topic.chatId}:${entry.topic.topicId}` : '';
  const kgStr = entry.kgEntity ? `, kg=${entry.kgEntity}` : '';
  console.log(`  ${status}  ${name}  (${entry.type}${topicStr}${kgStr}${ageStr})`);
  if (entry.description) {
    console.log(`           ${entry.description}`);
  }
}

if (!args.all) {
  console.log(`\nПромоут: bun skills/engram/scripts/promote-domain.js --domain <slug>`);
}
