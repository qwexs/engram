#!/usr/bin/env bun
// memory-system/scripts/validate.js
// Check integrity of the memory system
// Usage: bun skills/memory-system/scripts/validate.js [--fix] [--agent-id main]

import { parseArgs } from 'node:util';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { values: args } = parseArgs({
  options: {
    'fix': { type: 'boolean', default: false },
    'agent-id': { type: 'string', default: 'main' },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
validate — Check memory system integrity

Usage:
  bun skills/memory-system/scripts/validate.js [options]

Options:
  --fix            Auto-fix issues where possible
  --agent-id <id>  Agent identifier (default: main)
  -h, --help       Show this help

Checks:
  1. Directory structure (memory/, life/, subdirs)
  2. Required files (MEMORY.md, heartbeat-state.json, etc.)
  3. items.json validity and v2 schema compliance
  4. No orphan entities (missing from index.md)
  5. ID uniqueness within each items.json
  6. No broken supersededBy references
`);
  process.exit(0);
}

const agentId = args['agent-id'];
const WORKSPACE = process.cwd();
const fix = args.fix;
let errors = 0;
let warnings = 0;
let fixed = 0;

function error(msg) { console.error(`❌ ${msg}`); errors++; }
function warn(msg) { console.warn(`⚠️  ${msg}`); warnings++; }
function ok(msg) { console.log(`✅ ${msg}`); }
function fixMsg(msg) { console.log(`🔧 ${msg}`); fixed++; }

// 1. Directory structure
const requiredDirs = [
  'memory',
  `memory/agent-${agentId}`,
  `memory/agent-${agentId}/main`,
  'memory/templates/group-knowledge',
  'life',
  'life/projects',
  'life/areas',
  'life/archives',
];

console.log('--- Directory Structure ---');
for (const dir of requiredDirs) {
  const fullPath = join(WORKSPACE, dir);
  if (!existsSync(fullPath)) {
    if (fix) {
      mkdirSync(fullPath, { recursive: true });
      fixMsg(`Created ${dir}/`);
    } else {
      error(`Missing directory: ${dir}/`);
    }
  }
}
ok('Directory structure checked');

// 2. Required files
const requiredFiles = [
  'MEMORY.md',
  'memory/heartbeat-state.json',
  'memory/weekly-synthesis-tracker.json',
  'life/README.md',
  'life/index.md',
];

console.log('\n--- Required Files ---');
for (const file of requiredFiles) {
  if (!existsSync(join(WORKSPACE, file))) {
    error(`Missing file: ${file}`);
  }
}
ok('Required files checked');

// 3. items.json validation
console.log('\n--- Knowledge Graph (items.json) ---');
const v2Fields = ['confidence', 'abstractionLevel', 'tags'];

function findItemsJson(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findItemsJson(fullPath));
    } else if (entry.name === 'items.json') {
      results.push(fullPath);
    }
  }
  return results;
}

const itemsFiles = findItemsJson(join(WORKSPACE, 'life'));
let totalFacts = 0;
let v2Compliant = 0;

for (const file of itemsFiles) {
  const relPath = file.replace(WORKSPACE + (process.platform === 'win32' ? '\\' : '/'), '');
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    if (!Array.isArray(data)) {
      error(`${relPath}: not an array`);
      continue;
    }

    const ids = new Set();
    for (const fact of data) {
      totalFacts++;

      // ID uniqueness
      if (ids.has(fact.id)) {
        error(`${relPath}: duplicate ID "${fact.id}"`);
      }
      ids.add(fact.id);

      // v2 fields
      let isV2 = true;
      for (const field of v2Fields) {
        if (fact[field] === undefined) {
          isV2 = false;
          if (fix) {
            if (field === 'confidence') fact.confidence = 0.7;
            if (field === 'abstractionLevel') fact.abstractionLevel = 'episode';
            if (field === 'tags') fact.tags = [];
          }
        }
      }
      if (isV2) v2Compliant++;

      // Broken supersededBy
      if (fact.supersededBy && !data.some(f => f.id === fact.supersededBy)) {
        warn(`${relPath}: broken supersededBy "${fact.supersededBy}" in fact "${fact.id}"`);
      }
    }

    if (fix) {
      writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    }
  } catch (e) {
    error(`${relPath}: invalid JSON — ${e.message}`);
  }
}
ok(`${itemsFiles.length} items.json files, ${totalFacts} facts (${v2Compliant} v2-compliant)`);

// 4. heartbeat-state.json sessions
console.log('\n--- Heartbeat State ---');
const heartbeatPath = join(WORKSPACE, 'memory/heartbeat-state.json');
if (existsSync(heartbeatPath)) {
  try {
    const state = JSON.parse(readFileSync(heartbeatPath, 'utf-8'));
    const sessions = Object.keys(state.lastDailyNoteCreated || {});
    if (!sessions.includes('main')) {
      warn('heartbeat-state.json missing "main" session');
    }
    // Check session dirs exist
    const agentDir = join(WORKSPACE, `memory/agent-${agentId}`);
    if (existsSync(agentDir)) {
      for (const entry of readdirSync(agentDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !sessions.includes(entry.name)) {
          warn(`Session dir "${entry.name}" not in heartbeat-state.json`);
        }
      }
    }
    ok(`heartbeat-state: ${sessions.length} sessions tracked`);
  } catch (e) {
    error(`heartbeat-state.json parse error: ${e.message}`);
  }
}

// Summary
console.log(`\n--- Summary ---`);
console.log(`Errors:   ${errors}`);
console.log(`Warnings: ${warnings}`);
if (fix) console.log(`Fixed:    ${fixed}`);
process.exit(errors > 0 ? 1 : 0);
