#!/usr/bin/env bun
// engram/scripts/init.js
// Initialize the complete memory system from scratch
// Usage: bun skills/engram/scripts/init.js [--agent-id main] [--qmd-variant auto|local|jina] [--force] [--help]

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const { values: args } = parseArgs({
  options: {
    'agent-id': { type: 'string', default: 'main' },
    'qmd-variant': { type: 'string', default: 'auto' },
    'force': { type: 'boolean', default: false },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
engram init — Initialize complete memory system

Usage:
  bun skills/engram/scripts/init.js [options]

Options:
  --agent-id <id>       Agent identifier (default: main)
  --qmd-variant <v>     QMD variant: auto|local|jina (default: auto)
  --force               Merge with existing dirs (won't overwrite files)
  -h, --help            Show this help

What it does:
  1. Creates memory/ directory structure (session isolation)
  2. Creates life/ directory structure (Knowledge Graph, PARA)
  3. Copies template files (MEMORY.md, heartbeat-state.json, etc.)
  4. Sets up QMD collections for search
  5. Runs initial QMD index

Examples:
  bun skills/engram/scripts/init.js
  bun skills/engram/scripts/init.js --agent-id work --qmd-variant jina
  bun skills/engram/scripts/init.js --force
`);
  process.exit(0);
}

const agentId = args['agent-id'];
const WORKSPACE = process.cwd();
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const SKILL_DIR = process.env.ENGRAM_SKILL_DIR || resolve(SCRIPT_DIR, '..');
const TEMPLATES = join(SKILL_DIR, 'assets', 'templates');

// --- Detect QMD ---
function detectQmdVariant() {
  const explicit = args['qmd-variant'];
  if (explicit !== 'auto') return explicit;
  if (process.env.QMD_LLM_PROVIDER === 'jina') return 'jina';
  if (process.env.JINA_API_KEY) return 'jina';
  return 'local';
}

function qmdAvailable() {
  try {
    execSync('qmd --help', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const qmdVariant = detectQmdVariant();
const hasQmd = qmdAvailable();

// --- Check existing ---
if (!args.force) {
  const conflicts = [];
  if (existsSync(join(WORKSPACE, 'memory'))) conflicts.push('memory/');
  if (existsSync(join(WORKSPACE, 'life'))) conflicts.push('life/');
  if (conflicts.length > 0) {
    console.error('❌ Existing directories found:');
    conflicts.forEach(c => console.error(`   - ${c}`));
    console.error('Use --force to merge (existing files will NOT be overwritten)');
    process.exit(1);
  }
}

// --- Create directories ---
const dirs = [
  'memory',
  `memory/agent-${agentId}`,
  `memory/agent-${agentId}/main`,
  'memory/domains',
  'memory/templates/group-knowledge',
  'life',
  'life/projects',
  'life/areas',
  'life/areas/people',
  'life/areas/groups',
  'life/areas/companies',
  'life/areas/ai-agents',
  'life/resources',
  'life/archives',
];

for (const dir of dirs) {
  mkdirSync(join(WORKSPACE, dir), { recursive: true });
}
console.log(`рџ“Ѓ Created ${dirs.length} directories`);

// --- Copy templates ---
function copyTemplate(templateName, destPath, replacements = {}) {
  const dest = join(WORKSPACE, destPath);
  if (existsSync(dest)) {
    console.log(`  SKIP ${destPath} (exists)`);
    return;
  }
  const templatePath = join(TEMPLATES, templateName);
  if (!existsSync(templatePath)) {
    console.error(`  ⚠️  Template not found: ${templateName}`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  let content = readFileSync(templatePath, 'utf-8');
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  writeFileSync(dest, content);
  console.log(`  ✅ ${destPath}`);
}

const today = new Date().toISOString().split('T')[0];
const replacements = { AGENT_ID: agentId, DATE: today, SESSION_KEY: 'main' };

console.log('\nрџ“„ Copying templates...');
copyTemplate('MEMORY.md', 'MEMORY.md', replacements);
copyTemplate('memory-readme.md', 'memory/README.md', replacements);
copyTemplate('heartbeat-state.json', 'memory/heartbeat-state.json', replacements);
copyTemplate('weekly-synthesis-tracker.json', 'memory/weekly-synthesis-tracker.json', replacements);
copyTemplate('life-readme.md', 'life/README.md', replacements);
copyTemplate('index.md', 'life/index.md', replacements);
copyTemplate('daily-note.md', `memory/agent-${agentId}/main/${today}.md`, { ...replacements, DATE: today });

copyTemplate('agents-snippet.md', 'engram-rules.md', replacements);

// Реестр доменов
copyTemplate('domain/registry.json', 'memory/domains/registry.json', replacements);

// Group knowledge templates
for (const tmpl of ['clients.md', 'contacts.md', 'decisions.md', 'resources.md']) {
  copyTemplate(`group-knowledge/${tmpl}`, `memory/templates/group-knowledge/${tmpl}`, replacements);
}

// --- QMD collections ---
if (hasQmd) {
  console.log('\nрџ”Ќ Setting up QMD collections...');
  const collections = [
    { path: '.', name: 'openclaw-root', mask: '*.md' },
    { path: `memory/agent-${agentId}/main`, name: `openclaw-memory-agent-${agentId}-main`, mask: '**/*.md' },
    { path: 'life', name: 'life', mask: '**/*.md' },
  ];

  for (const col of collections) {
    try {
      execSync(`qmd collection add "${join(WORKSPACE, col.path)}" --name ${col.name} --mask "${col.mask}"`, { stdio: 'pipe' });
      console.log(`  ✅ ${col.name}`);
    } catch {
      console.log(`  ⚠️  ${col.name} (may already exist)`);
    }
  }

  console.log('\nрџ“Љ Running QMD index...');
  try {
    execSync('qmd update', { stdio: 'inherit' });
  } catch {
    console.warn('  ⚠️  qmd update failed — run manually');
  }
} else {
  console.log('\n⚠️  QMD not found. Install:');
  console.log('  Local (GPU):  npm i -g @nicepkg/qmd');
  console.log('  Jina (API):   npm i -g @qwexs/qmd');
  console.log('  Memory structure created without search indexing.');
}

// --- Summary ---
console.log(`
✅ Memory system initialized!
   Agent ID:        ${agentId}
   QMD variant:     ${qmdVariant}${hasQmd ? '' : ' (not installed)'}
   Main session:    memory/agent-${agentId}/main/
   Knowledge graph: life/
   Today's note:    memory/agent-${agentId}/main/${today}.md

Next steps:
  1. Add memory rules to AGENTS.md (copy from engram-rules.md or see SKILL.md)
  2. Configure heartbeat (see references/heartbeat.md)
  3. Add sessions: bun skills/engram/scripts/add-session.js --platform telegram --id <groupId>
  4. Run: qmd embed (for vector search)
`);
