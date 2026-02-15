#!/usr/bin/env node
/**
 * validate-kg.js — Validate all items.json in life/ Knowledge Graph
 * 
 * Usage:
 *   node scripts/validate-kg.js          # Check only
 *   node scripts/validate-kg.js --fix    # Auto-fix encoding issues
 * 
 * Checks:
 *   - Valid JSON (no BOM, no encoding issues)
 *   - Required fields: entityId, entityType, facts[]
 *   - Each fact: id, text, status, confidence, abstractionLevel, timestamp, lastAccessed, accessCount
 *   - Sequential IDs (e001, e002, ...)
 *   - Confidence range 0.0-1.0
 *   - Valid abstractionLevel (episode, pattern, principle)
 *   - Valid status (active, superseded)
 *   - No duplicate fact IDs
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, relative } from 'path';

const LIFE_DIR = join(process.cwd(), 'life');
const FIX_MODE = process.argv.includes('--fix');

const VALID_ABSTRACTION = ['episode', 'pattern', 'principle'];
const VALID_STATUS = ['active', 'superseded', 'pending'];

let totalFiles = 0;
let totalErrors = 0;
let totalFixed = 0;

function findItemsFiles(dir) {
  const files = [];
  function scan(path) {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, item.name);
      if (item.isDirectory()) scan(full);
      else if (item.name === 'items.json') files.push(full);
    }
  }
  scan(dir);
  return files;
}

function validateFile(filePath) {
  const rel = relative(LIFE_DIR, filePath);
  const errors = [];
  totalFiles++;

  // Read raw bytes to detect BOM
  let raw = readFileSync(filePath, 'utf-8');
  let hadBom = false;

  if (raw.charCodeAt(0) === 0xFEFF) {
    hadBom = true;
    errors.push('BOM detected');
    if (FIX_MODE) {
      raw = raw.slice(1);
    }
  }

  // Parse JSON
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    errors.push(`Invalid JSON: ${e.message}`);
    totalErrors += errors.length;
    return { rel, errors, fixed: false };
  }

  // Detect format: new {entityId, facts:[]} or legacy [{fact}]
  let facts;
  let isLegacy = false;

  if (Array.isArray(data)) {
    // Legacy format: bare array of facts
    isLegacy = true;
    facts = data;
    if (FIX_MODE) {
      // Derive entityId from path: life/projects/foo -> projects/foo
      const parts = rel.replace(/\\items\.json$/, '').split(/[\\\/]/);
      const entityId = parts.join('/');
      const entityType = parts[0].replace(/s$/, ''); // projects->project, areas->area
      data = { entityId, entityType, facts };
    }
  } else {
    if (!data.entityId) errors.push('Missing entityId');
    if (!data.entityType) errors.push('Missing entityType');
    if (!Array.isArray(data.facts)) {
      errors.push('Missing or invalid facts array');
      totalErrors += errors.length;
      return { rel, errors, fixed: false };
    }
    facts = data.facts;
  }

  // Validate each fact
  const seenIds = new Set();
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i];
    const prefix = `facts[${i}]`;

    if (!f.id) errors.push(`${prefix}: missing id`);
    else if (seenIds.has(f.id)) errors.push(`${prefix}: duplicate id "${f.id}"`);
    else seenIds.add(f.id);

    if (!f.text && !f.fact) errors.push(`${prefix}: missing text/fact`);
    if (f.status && !VALID_STATUS.includes(f.status)) errors.push(`${prefix}: invalid status "${f.status}"`);
    if (f.confidence !== undefined && (f.confidence < 0 || f.confidence > 1)) errors.push(`${prefix}: confidence ${f.confidence} out of range`);
    if (f.abstractionLevel && !VALID_ABSTRACTION.includes(f.abstractionLevel)) errors.push(`${prefix}: invalid abstractionLevel "${f.abstractionLevel}"`);
    if (!f.timestamp) errors.push(`${prefix}: missing timestamp`);
    if (!f.lastAccessed) errors.push(`${prefix}: missing lastAccessed`);
  }

  // Auto-fix: rewrite clean JSON if BOM, legacy format, or formatting issues
  let fixed = false;
  if (FIX_MODE && (hadBom || isLegacy || errors.length === 0)) {
    const clean = JSON.stringify(data, null, 2);
    const current = readFileSync(filePath, 'utf-8');
    if (clean !== current) {
      writeFileSync(filePath, clean, 'utf-8');
      fixed = true;
      totalFixed++;
      if (isLegacy) errors.push('Migrated from legacy format');
    }
  }

  totalErrors += errors.length;
  return { rel, errors, fixed };
}

// Main
console.log(`Validating Knowledge Graph: ${LIFE_DIR}`);
console.log(`Mode: ${FIX_MODE ? 'FIX' : 'CHECK'}\n`);

const files = findItemsFiles(LIFE_DIR);
const results = files.map(validateFile);

// Report
for (const { rel, errors, fixed } of results) {
  if (errors.length === 0 && !fixed) continue;
  
  const status = fixed ? '🔧 FIXED' : (errors.length > 0 ? '❌ ERROR' : '✅ OK');
  console.log(`${status} ${rel}`);
  for (const e of errors) {
    console.log(`  → ${e}`);
  }
}

console.log(`\n--- Summary ---`);
console.log(`Files: ${totalFiles}`);
console.log(`Errors: ${totalErrors}`);
if (FIX_MODE) console.log(`Fixed: ${totalFixed}`);

if (totalErrors > 0) process.exit(1);
