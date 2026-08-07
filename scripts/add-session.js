#!/usr/bin/env bun
// engram/scripts/add-session.js
// Add a new session (telegram group, discord channel) to the memory system
// Usage: bun skills/engram/scripts/add-session.js --platform telegram --id 3382546134 [--agent-id main]

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { loadEngramConfig } from './config.js';
import { addQmdCollection } from './_lib/qmd-provision.js';

const { values: args } = parseArgs({
  options: {
    'platform': { type: 'string' },
    'id': { type: 'string' },
    'agent-id': { type: 'string' },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help || !args.platform || !args.id) {
  console.log(`
add-session — Add a new group/channel session to the memory system

Usage:
  bun skills/engram/scripts/add-session.js --platform <platform> --id <id> [options]

Options:
  --platform <p>   Platform: telegram, discord, whatsapp, etc.
  --id <id>        Group/channel ID (numeric)
  --agent-id <id>  Agent identifier (default: main)
  -h, --help       Show this help

Examples:
  bun skills/engram/scripts/add-session.js --platform telegram --id 3382546134
  bun skills/engram/scripts/add-session.js --platform discord --id 789012 --agent-id work
`);
  process.exit(args.help ? 0 : 1);
}

const { platform, id } = args;
const WORKSPACE = process.cwd();
const config = loadEngramConfig(WORKSPACE);
const agentId = args['agent-id'] || config.agent.replace(/^agent-/, '') || 'main';
const sessionKey = `${platform}-${id}`;
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const SKILL_DIR = process.env.ENGRAM_SKILL_DIR || resolve(SCRIPT_DIR, '..');
const TEMPLATES = join(SKILL_DIR, 'assets', 'templates');

const sessionPath = join(WORKSPACE, `memory/agent-${agentId}/${sessionKey}`);

// Check if session already exists
if (existsSync(sessionPath)) {
  console.error(`❌ Session already exists: ${sessionPath}`);
  process.exit(1);
}

// 1. Create session directory
mkdirSync(sessionPath, { recursive: true });
console.log(`рџ“Ѓ Created: memory/agent-${agentId}/${sessionKey}/`);

// 2. Copy group-knowledge templates
const knowledgeDest = join(sessionPath, 'knowledge');
const knowledgeSrc = join(TEMPLATES, 'group-knowledge');
if (existsSync(knowledgeSrc)) {
  cpSync(knowledgeSrc, knowledgeDest, { recursive: true });
  console.log(`рџ“‹ Copied group-knowledge templates → knowledge/`);
}

// 3. Create initial daily note
const today = new Date().toISOString().split('T')[0];
const dailyNotePath = join(sessionPath, `${today}.md`);
writeFileSync(dailyNotePath, `# ${today}\n`);
console.log(`рџ“ќ Created daily note: ${today}.md`);

// 4. Update heartbeat-state.json
const heartbeatPath = join(WORKSPACE, 'memory/heartbeat-state.json');
if (existsSync(heartbeatPath)) {
  try {
    const state = JSON.parse(readFileSync(heartbeatPath, 'utf-8'));
    if (!state.lastDailyNoteCreated[sessionKey]) {
      state.lastDailyNoteCreated[sessionKey] = null;
      writeFileSync(heartbeatPath, JSON.stringify(state, null, 2) + '\n');
      console.log(`рџ”„ Updated heartbeat-state.json`);
    }
  } catch (e) {
    console.warn(`⚠️  Could not update heartbeat-state.json: ${e.message}`);
  }
}

// 5. Add QMD collection
const collectionName = `openclaw-memory-agent-${agentId}-${sessionKey}`;
try {
  const provision = await addQmdCollection({
    workspace: WORKSPACE,
    collection: collectionName,
    path: sessionPath,
    mask: "**/*.md",
  });
  if (!provision.ok) throw new Error(provision.stderr.trim() || `QMD exited ${provision.exitCode}`);
  console.log(`рџ”Ќ QMD collection registered: ${collectionName}`);
  console.log(`ℹ️  QMD freshness is delegated to the maintenance coordinator.`);
} catch (error) {
  console.log(`⚠️  QMD collection was not registered: ${error.message}`);
  console.log(`   Retry through Engram provisioning after reviewing the workspace config.`);
}

// 6. Summary
console.log(`
✅ Session added!
   Session key:   agent:${agentId}:${sessionKey}
   Memory path:   memory/agent-${agentId}/${sessionKey}/
   QMD collection: ${collectionName}
   Knowledge:     memory/agent-${agentId}/${sessionKey}/knowledge/
`);
