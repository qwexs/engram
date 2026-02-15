#!/usr/bin/env bun
// memory-system/scripts/add-session.js
// Add a new session (telegram group, discord channel) to the memory system
// Usage: bun skills/memory-system/scripts/add-session.js --platform telegram --id 3382546134 [--agent-id main]

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const { values: args } = parseArgs({
  options: {
    'platform': { type: 'string' },
    'id': { type: 'string' },
    'agent-id': { type: 'string', default: 'main' },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help || !args.platform || !args.id) {
  console.log(`
add-session — Add a new group/channel session to the memory system

Usage:
  bun skills/memory-system/scripts/add-session.js --platform <platform> --id <id> [options]

Options:
  --platform <p>   Platform: telegram, discord, whatsapp, etc.
  --id <id>        Group/channel ID (numeric)
  --agent-id <id>  Agent identifier (default: main)
  -h, --help       Show this help

Examples:
  bun skills/memory-system/scripts/add-session.js --platform telegram --id 3382546134
  bun skills/memory-system/scripts/add-session.js --platform discord --id 789012 --agent-id work
`);
  process.exit(args.help ? 0 : 1);
}

const { platform, id } = args;
const agentId = args['agent-id'];
const sessionKey = `${platform}-${id}`;
const WORKSPACE = process.cwd();
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const SKILL_DIR = resolve(SCRIPT_DIR, '..');
const TEMPLATES = join(SKILL_DIR, 'assets', 'templates');

const sessionPath = join(WORKSPACE, `memory/agent-${agentId}/${sessionKey}`);

// Check if session already exists
if (existsSync(sessionPath)) {
  console.error(`❌ Session already exists: ${sessionPath}`);
  process.exit(1);
}

// 1. Create session directory
mkdirSync(sessionPath, { recursive: true });
console.log(`📁 Created: memory/agent-${agentId}/${sessionKey}/`);

// 2. Copy group-knowledge templates
const knowledgeDest = join(sessionPath, 'knowledge');
const knowledgeSrc = join(TEMPLATES, 'group-knowledge');
if (existsSync(knowledgeSrc)) {
  cpSync(knowledgeSrc, knowledgeDest, { recursive: true });
  console.log(`📋 Copied group-knowledge templates → knowledge/`);
}

// 3. Create initial daily note
const today = new Date().toISOString().split('T')[0];
const dailyNotePath = join(sessionPath, `${today}.md`);
writeFileSync(dailyNotePath, `# ${today}\n`);
console.log(`📝 Created daily note: ${today}.md`);

// 4. Update heartbeat-state.json
const heartbeatPath = join(WORKSPACE, 'memory/heartbeat-state.json');
if (existsSync(heartbeatPath)) {
  try {
    const state = JSON.parse(readFileSync(heartbeatPath, 'utf-8'));
    if (!state.lastDailyNoteCreated[sessionKey]) {
      state.lastDailyNoteCreated[sessionKey] = null;
      writeFileSync(heartbeatPath, JSON.stringify(state, null, 2) + '\n');
      console.log(`🔄 Updated heartbeat-state.json`);
    }
  } catch (e) {
    console.warn(`⚠️  Could not update heartbeat-state.json: ${e.message}`);
  }
}

// 5. Add QMD collection
const collectionName = `openclaw-memory-agent-${agentId}-${sessionKey}`;
try {
  execSync(`qmd collection add "${sessionPath}" --name ${collectionName} --mask "**/*.md"`, { stdio: 'pipe' });
  console.log(`🔍 QMD collection: ${collectionName}`);
  execSync('qmd update', { stdio: 'pipe' });
  console.log(`📊 QMD index updated`);
} catch {
  console.log(`⚠️  QMD not available — add collection manually:`);
  console.log(`   qmd collection add "${sessionPath}" --name ${collectionName} --mask "**/*.md"`);
}

// 6. Summary
console.log(`
✅ Session added!
   Session key:   agent:${agentId}:${sessionKey}
   Memory path:   memory/agent-${agentId}/${sessionKey}/
   QMD collection: ${collectionName}
   Knowledge:     memory/agent-${agentId}/${sessionKey}/knowledge/
`);
