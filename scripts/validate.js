#!/usr/bin/env node
// engram/scripts/validate.js
// Check integrity of the memory system
// Usage: node scripts/validate.js [--fix] [--agent-id main]

import { parseArgs } from 'node:util';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { loadEngramConfig } from './config.js';

const SKILL_DIR = process.env.ENGRAM_SKILL_DIR || dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')).replace(/[\\\/]scripts$/, '');

const { values: args } = parseArgs({
  options: {
    'fix': { type: 'boolean', default: false },
    'quality': { type: 'boolean', default: false },
    'agent-id': { type: 'string' },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
validate — Check memory system integrity

Usage:
  node scripts/validate.js [options]

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
  7. BOM encoding detection and fix
  8. Legacy format migration (bare array → v2 wrapper)
`);
  process.exit(0);
}

const WORKSPACE = process.cwd();
const _config = loadEngramConfig(WORKSPACE);
const agentId = args['agent-id'] || _config.agent.replace(/^agent-/, '') || 'main';
const LIFE_DIR = join(WORKSPACE, 'life');
const fix = args.fix;
const quality = args.quality;
let errors = 0;
let warnings = 0;
let fixed = 0;

const VALID_ABSTRACTION = ['episode', 'pattern', 'principle'];
const VALID_STATUS = ['active', 'superseded', 'pending'];
const VALID_CATEGORIES = ['relationship', 'milestone', 'status', 'preference', 'context', 'decision', 'correction'];
const CATEGORY_MAP = {
  undefined: 'context',
  technical: 'context',
  features: 'context',
  integration: 'context',
  testing: 'context',
  process: 'context',
  'project-status': 'status',
  instruction: 'preference',
  infrastructure: 'context',
  configuration: 'context',
  pattern: 'context',
  fact: 'context',
  event: 'milestone',
  verification: 'status',
  observation: 'context',
  system: 'context',
  goal: 'status',
  principle: 'context',
  architecture: 'context',
  security: 'context',
  learning: 'context',
  credential: 'context',
  resource: 'context',
};

const TEST_ARTIFACT_RE = /(^|[\\/]|[-_])(test|tests|fixture|fixtures|dummy|sample)([-_]|$|[\\/])|(^|[\\/])__[^\\/]*__($|[\\/])/i;
const TEST_TAGS = new Set(['test', 'fixture', 'fixtures', 'dummy', 'sample']);

function tagsOf(fact) {
  return Array.isArray(fact.tags) ? fact.tags.map(tag => String(tag).toLowerCase()) : [];
}

function hasTag(fact, tagSet) {
  return tagsOf(fact).some(tag => tagSet.has(tag));
}

function isTestArtifactPath(relPath) {
  return TEST_ARTIFACT_RE.test(relPath.replace(/\\/g, '/'));
}

function isCleanupMarker(fact) {
  const factText = String(fact.fact || fact.text || '');
  return /should be ignored as user memory|test artifact/i.test(factText) && tagsOf(fact).includes('cleanup');
}

function error(msg) { console.error(`❌ ${msg}`); errors++; }
function warn(msg) { console.warn(`⚠️  ${msg}`); warnings++; }
function ok(msg) { console.log(`✅ ${msg}`); }
function fixMsg(msg) { console.log(`рџ”§ ${msg}`); fixed++; }

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

// 3. items.json validation (v2 format with BOM detection)
console.log('\n--- Knowledge Graph (items.json) ---');

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

const itemsFiles = findItemsJson(LIFE_DIR);
let totalFacts = 0;
let v2Compliant = 0;
let legacyMigrated = 0;
let bomFixed = 0;

for (const file of itemsFiles) {
  const relPath = relative(WORKSPACE, file);
  
  // Read raw bytes to detect BOM (0xEF 0xBB 0xBF)
  let raw = readFileSync(file, 'utf-8');
  let hadBom = false;

  if (raw.charCodeAt(0) === 0xFEFF) {
    hadBom = true;
    warn(`${relPath}: BOM detected`);
    if (fix) {
      raw = raw.slice(1);
      bomFixed++;
      fixMsg(`${relPath}: removed BOM`);
    }
  }

  // Parse JSON
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    error(`${relPath}: invalid JSON — ${e.message}`);
    continue;
  }

  // Detect format: v2 {entityId, entityType, facts:[]} or legacy [{fact}]
  let facts;
  let isLegacy = false;
  let needsRewrite = false;

  if (Array.isArray(data)) {
    // Legacy format: bare array of facts
    isLegacy = true;
    facts = data;
    warn(`${relPath}: legacy format (bare array)`);
    
    if (fix) {
      // Derive entityId from path: life/projects/foo/items.json -> projects/foo
      const parts = relPath.replace(/\\items\.json$/, '').replace(/^life[\\\/]/, '').split(/[\\\/]/);
      const entityId = parts.join('/');
      const entityType = parts[0].replace(/s$/, ''); // projects->project, areas->area
      
      data = {
        entityId,
        entityType,
        facts
      };
      
      legacyMigrated++;
      fixMsg(`${relPath}: migrated to v2 (entityId="${entityId}", entityType="${entityType}")`);
      needsRewrite = true;
    }
  } else {
    // v2 format validation
    if (!data.entityId) {
      error(`${relPath}: missing entityId`);
    }
    if (!data.entityType) {
      error(`${relPath}: missing entityType`);
    }
    if (!Array.isArray(data.facts)) {
      error(`${relPath}: missing or invalid facts array`);
      continue;
    }
    facts = data.facts;
    v2Compliant++;
  }

  // Validate each fact
  const seenIds = new Set();
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i];
    const prefix = `${relPath}:facts[${i}]`;
    totalFacts++;

    // ID uniqueness
    if (!f.id) {
      error(`${prefix}: missing id`);
    } else if (seenIds.has(f.id)) {
      error(`${prefix}: duplicate id "${f.id}"`);
    } else {
      seenIds.add(f.id);
    }

    // Required fields
    if (!f.text && !f.fact) {
      error(`${prefix}: missing text/fact`);
    }
    if (f.text && !f.fact) {
      if (fix) {
        f.fact = f.text;
        delete f.text;
        needsRewrite = true;
        fixMsg(`${prefix}: migrated legacy text → fact`);
      } else {
        warn(`${prefix}: legacy text field without fact`);
      }
    }
    if (f.fact && f.text && f.fact === f.text && fix) {
      delete f.text;
      needsRewrite = true;
      fixMsg(`${prefix}: removed duplicate legacy text field`);
    }
    if (!VALID_CATEGORIES.includes(f.category)) {
      const categoryKey = f.category === undefined || f.category === null ? 'undefined' : String(f.category).toLowerCase();
      const mapped = CATEGORY_MAP[categoryKey];
      if (fix && mapped) {
        fixMsg(`${prefix}: normalized category "${f.category}" → "${mapped}"`);
        f.category = mapped;
        needsRewrite = true;
      } else {
        const message = `${prefix}: non-canonical category "${f.category}" (must be: ${VALID_CATEGORIES.join(', ')})`;
        if (quality) error(message);
        else warn(message);
      }
    }
    if (quality && f.status !== 'superseded') {
      const factText = String(f.fact || f.text || '');
      if (/^(Готово|Ок|Да,|Сделал|Проверил)[.!,:\s]/.test(factText)) {
        warn(`${prefix}: fact looks like assistant status text, not durable knowledge`);
      }
      if (/\b(Exec completed|remote: !|deploy lock|Now let me|tool call|stdout|stderr)\b/i.test(factText)) {
        warn(`${prefix}: fact looks like tool/session log noise`);
      }
      if (isTestArtifactPath(relPath) && !isCleanupMarker(f)) {
        warn(`${prefix}: active fact belongs to test/fixture artifact entity`);
      }
      if (!isTestArtifactPath(relPath) && hasTag(f, TEST_TAGS)) {
        warn(`${prefix}: active production fact has test/fixture tag`);
      }
    }
    if (!f.timestamp) {
      error(`${prefix}: missing timestamp`);
    }
    if (!f.lastAccessed) {
      error(`${prefix}: missing lastAccessed`);
    }
    if (f.accessCount === undefined) {
      error(`${prefix}: missing accessCount`);
    }

    // Validate status
    if (f.status && !VALID_STATUS.includes(f.status)) {
      error(`${prefix}: invalid status "${f.status}" (must be: ${VALID_STATUS.join(', ')})`);
    }

    // Validate confidence (0.0-1.0)
    if (f.confidence !== undefined) {
      if (typeof f.confidence !== 'number' || f.confidence < 0 || f.confidence > 1) {
        error(`${prefix}: confidence ${f.confidence} out of range (must be 0.0-1.0)`);
      }
    }

    // Validate abstractionLevel
    if (f.abstractionLevel && !VALID_ABSTRACTION.includes(f.abstractionLevel)) {
      if (fix && f.abstractionLevel === 'episodic') {
        f.abstractionLevel = 'episode';
        needsRewrite = true;
        fixMsg(`${prefix}: normalized abstractionLevel "episodic" → "episode"`);
      } else {
        error(`${prefix}: invalid abstractionLevel "${f.abstractionLevel}" (must be: ${VALID_ABSTRACTION.join(', ')})`);
      }
    }

    // Broken supersededBy reference
    if (f.supersededBy && !facts.some(fact => fact.id === f.supersededBy)) {
      warn(`${prefix}: broken supersededBy "${f.supersededBy}"`);
    }
  }

  // Auto-fix: rewrite clean JSON if BOM, legacy format, or formatting issues
  if (fix && (hadBom || isLegacy || needsRewrite)) {
    const clean = JSON.stringify(data, null, 2) + '\n';
    writeFileSync(file, clean, 'utf-8');
  }
}

ok(`${itemsFiles.length} items.json files, ${totalFacts} facts`);
if (v2Compliant > 0) ok(`${v2Compliant} files v2-compliant`);
if (legacyMigrated > 0) fixMsg(`${legacyMigrated} files migrated from legacy format`);
if (bomFixed > 0) fixMsg(`${bomFixed} BOM encodings fixed`);

// 4. Domain validation
console.log('\n--- Domains ---');
const domainsDir = join(WORKSPACE, 'memory', 'domains');
if (existsSync(domainsDir)) {
  const allDomainEntries = readdirSync(domainsDir, { withFileTypes: true })
    .filter(e => e.isDirectory());
  const registryPath = join(domainsDir, 'registry.json');
  let registeredDomainNames = null;
  if (existsSync(registryPath)) {
    try {
      const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
      registeredDomainNames = new Set(Object.keys(registry.domains || {}));
    } catch (e) {
      warn(`domains/registry.json parse error: ${e.message}`);
    }
  }
  const domainEntries = registeredDomainNames
    ? allDomainEntries.filter(e => registeredDomainNames.has(e.name))
    : allDomainEntries;

  if (allDomainEntries.length > 20) {
    warn(`${allDomainEntries.length} доменов (рекомендуется ≤20)`);
  }

  const requiredDomainFiles = ['decisions.md', 'status.md', 'changelog.md'];
  for (const entry of domainEntries) {
    const domainPath = join(domainsDir, entry.name);
    for (const reqFile of requiredDomainFiles) {
      const filePath = join(domainPath, reqFile);
      if (!existsSync(filePath)) {
        if (fix) {
          writeFileSync(filePath, `# ${reqFile.replace('.md', '')}: ${entry.name}\n`);
          fixMsg(`Created domains/${entry.name}/${reqFile}`);
        } else {
          error(`Domain "${entry.name}" missing: ${reqFile}`);
        }
      }
    }
  }
  // Check: if spawn-prompts use {{workflow}} but workflow.md is missing → warning
  const spawnPromptsDir = join(SKILL_DIR, 'templates', 'spawn-prompts');
  const spawnPromptsUseWorkflow = new Set();
  if (existsSync(spawnPromptsDir)) {
    for (const f of readdirSync(spawnPromptsDir)) {
      if (f.endsWith('.md')) {
        const content = readFileSync(join(spawnPromptsDir, f), 'utf-8');
        if (content.includes('{{workflow}}')) {
          spawnPromptsUseWorkflow.add(f);
        }
      }
    }
  }
  if (spawnPromptsUseWorkflow.size > 0) {
    for (const entry of domainEntries) {
      const workflowPath = join(domainsDir, entry.name, 'workflow.md');
      if (!existsSync(workflowPath)) {
        warn(`Domain "${entry.name}" has no workflow.md (used by spawn-prompts: ${[...spawnPromptsUseWorkflow].join(', ')})`);
      }
    }
  }

  ok(registeredDomainNames
    ? `${domainEntries.length} registered domain(s) checked`
    : `${domainEntries.length} domain(s) checked`);
} else {
  ok('No domains directory (optional)');
}

// 5. heartbeat-state.json sessions
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
        if (entry.isDirectory() && /^cron-.+-run-.+/.test(entry.name)) {
          continue;
        }
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
