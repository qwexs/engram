#!/usr/bin/env bun
// engram/scripts/migrate-v2.js
// Migrate items.json files from v1 to v2 schema (add confidence, abstractionLevel, tags)
// Usage: bun skills/engram/scripts/migrate-v2.js [--dry-run]

import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
migrate-v2 — Migrate items.json files to v2 schema

Usage:
  bun skills/engram/scripts/migrate-v2.js [options]

Options:
  --dry-run    Show changes without writing
  -h, --help   Show this help

Adds missing v2 fields:
  - confidence: 0.7 (default, indirect inference)
  - abstractionLevel: inferred from category
  - tags: [] (empty default)
`);
  process.exit(0);
}

const WORKSPACE = process.cwd();
const dryRun = args['dry-run'];

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

function inferAbstraction(category) {
  switch (category) {
    case 'milestone': return 'episode';
    case 'status': return 'episode';
    case 'preference': return 'pattern';
    case 'relationship': return 'pattern';
    case 'context': return 'episode';
    default: return 'episode';
  }
}

const files = findItemsJson(join(WORKSPACE, 'life'));
let totalFiles = 0;
let totalFacts = 0;
let migratedFacts = 0;

for (const file of files) {
  const relPath = file.replace(WORKSPACE + (process.platform === 'win32' ? '\\' : '/'), '');

  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    if (!Array.isArray(data)) continue;

    let changed = false;
    for (const fact of data) {
      totalFacts++;
      let factChanged = false;

      if (fact.confidence === undefined) {
        fact.confidence = 0.7;
        factChanged = true;
      }
      if (fact.abstractionLevel === undefined) {
        fact.abstractionLevel = inferAbstraction(fact.category);
        factChanged = true;
      }
      if (fact.tags === undefined) {
        fact.tags = [];
        factChanged = true;
      }

      if (factChanged) {
        migratedFacts++;
        changed = true;
        if (dryRun) {
          console.log(`  ${relPath} → ${fact.id}: +confidence=${fact.confidence}, +abstractionLevel=${fact.abstractionLevel}, +tags=[]`);
        }
      }
    }

    if (changed) {
      totalFiles++;
      if (!dryRun) {
        writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
        console.log(`✅ ${relPath}: ${data.filter((_, i) => true).length} facts`);
      }
    }
  } catch (e) {
    console.error(`❌ ${relPath}: ${e.message}`);
  }
}

console.log(`\n--- Migration ${dryRun ? '(DRY RUN) ' : ''}Summary ---`);
console.log(`Files scanned:  ${files.length}`);
console.log(`Files modified: ${totalFiles}`);
console.log(`Facts total:    ${totalFacts}`);
console.log(`Facts migrated: ${migratedFacts}`);
if (dryRun && migratedFacts > 0) {
  console.log(`\nRun without --dry-run to apply changes.`);
}
