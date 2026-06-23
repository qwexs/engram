#!/usr/bin/env node
// engram/scripts/validate.js
// Check integrity of the memory system
// Usage: node scripts/validate.js [--fix] [--agent-id main]

import { parseArgs } from 'node:util';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, lstatSync, readlinkSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
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
      // Build {name -> type} so per-type checks can skip non-applicable rules
      // (e.g. topic-thread does not need workflow.md).
      var registeredDomainTypes = {};
      for (const [n, cfg] of Object.entries(registry.domains || {})) {
        if (cfg && typeof cfg === 'object' && cfg.type) registeredDomainTypes[n] = cfg.type;
      }
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
      // topic-thread domains are bound to a Telegram topic and never spawned,
      // so spawn-prompts/{{workflow}} does not apply to them.
      if (registeredDomainTypes && registeredDomainTypes[entry.name] === 'topic-thread') continue;
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
        if (!entry.isDirectory()) continue;
        // Skip non-session helper directories inside the agent dir.
        if (/^cron-.+-run-.+/.test(entry.name)) continue;
        if (/^_archived-\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue; // soft-archive of leftover session dirs
        if (entry.name === 'archives') continue; // legacy archive layout
        if (!sessions.includes(entry.name)) {
          warn(`Session dir "${entry.name}" not in heartbeat-state.json`);
        }
      }
    }
    ok(`heartbeat-state: ${sessions.length} sessions tracked`);
  } catch (e) {
    error(`heartbeat-state.json parse error: ${e.message}`);
  }
}

// 8. Cron Config drift guard (catches HEARTBEAT.md ↔ gateway drift).
// Generic: reads engram.json -> cron.<expectedJobName|expectedSchedule|requireAllActiveSessions|staleRunMinutes>
// and asserts the heartbeat job is present, enabled, on the expected schedule,
// has `--all-active-sessions` in payload (if required), and ran recently.
// If the CLI is unavailable (sandbox / PATH issue), downgrade to warn.
// Workspaces that don't define engram.json -> cron skip the check cleanly.
console.log('\n--- Cron Config ---');
const cronCfg = _config && _config.cron;
if (!cronCfg || !cronCfg.expectedJobName) {
  ok('Cron drift check skipped (engram.json -> cron.expectedJobName not set for this workspace)');
} else {
  const expectedJobName = cronCfg.expectedJobName;
  const expectedSchedule = cronCfg.expectedSchedule || { kind: 'cron', expr: '*/30 * * * *' };
  const requireAllActive = cronCfg.requireAllActiveSessions !== false; // default true
  const staleMin = Number(cronCfg.staleRunMinutes || 90);
  const cronProbe = spawnSync('openclaw', ['cron', 'list', '--json'], { encoding: 'utf8', shell: false, timeout: 30000 });
  if (cronProbe.error || cronProbe.status !== 0) {
    warn(`openclaw cron list unavailable (${cronProbe.error?.message || 'exit ' + cronProbe.status}) — skipping cron drift check`);
  } else {
    const stdout = cronProbe.stdout || '';
    const jsonStart = stdout.indexOf('{');
    if (jsonStart < 0) {
      warn('openclaw cron list returned no JSON — skipping cron drift check');
    } else {
      let parsed = null;
      try { parsed = JSON.parse(stdout.slice(jsonStart)); }
      catch (e) { warn(`openclaw cron list parse error: ${e.message} — skipping cron drift check`); }
      if (parsed && Array.isArray(parsed.jobs)) {
        const job = parsed.jobs.find(j => j.name === expectedJobName);
        if (!job) {
          error(`Cron job "${expectedJobName}" not found in gateway. Run \`openclaw cron list\` to inspect; see HEARTBEAT.md for the expected id.`);
        } else {
          if (!job.enabled) {
            error(`Cron job "${expectedJobName}" is DISABLED`);
          } else {
            ok(`Cron job present and enabled (id ${job.id}, agent=${job.agentId})`);
          }
          const sched = job.schedule || {};
          if (sched.kind === expectedSchedule.kind && (expectedSchedule.kind !== 'cron' || sched.expr === expectedSchedule.expr)) {
            const schedDesc = sched.kind === 'cron' ? `${sched.expr} ${sched.tz || 'local'}` : `every ${Math.round((sched.everyMs || 0) / 60000)}m`;
            ok(`Schedule: ${schedDesc}`);
          } else {
            warn(`Schedule unexpected: got ${JSON.stringify(sched)}, expected ${JSON.stringify(expectedSchedule)}`);
          }
          const msg = job.payload?.message || '';
          if (!requireAllActive || msg.includes('--all-active-sessions')) {
            if (requireAllActive) ok('Payload contains --all-active-sessions (per-session daily notes enabled)');
          } else {
            error(`Payload missing --all-active-sessions — only "main" daily note will be created. Update via \`openclaw cron update ${job.id} --patch '{"payload":{"message":"<new>"}}'\` or \`bun skills/engram/scripts/heartbeat-runner.js … --all-active-sessions\``);
          }
          if (job.payload?.lightContext !== true) {
            warn(`Payload lightContext is ${job.payload?.lightContext}, expected true (cron should not load full workspace bootstrap)`);
          }
          const last = job.state?.lastRunAtMs;
          if (!last) {
            warn('No lastRunAtMs — cron has not run yet (or state is missing)');
          } else {
            const ageMin = Math.floor((Date.now() - last) / 60000);
            if (ageMin > staleMin) {
              warn(`Last run ${ageMin}m ago (expected ≤${staleMin}m)`);
            } else {
              ok(`Last run ${ageMin}m ago (status=${job.state?.lastRunStatus || '?'})`);
            }
          }
          // 8b. Heartbeat prompt format check. The pre-2026-06-23 prompt
          // required the LLM to echo the full ~38kB runner output into its
          // final reply, which (a) burned ~11k output tokens per tick
          // across all workspaces and (b) frequently clipped at
          // max_tokens=8192, causing NO_REPLY / truncated summaries. The
          // 2026-06-23+ form uses a decision tree keyed on
          // runner.summary.status and warnings, with a ≤512-token reply
          // cap. The check below catches any cron still on the old
          // form so the operator can re-run install-cron.js to upgrade.
          const promptMsg = job.payload?.message || '';
          if (promptMsg.includes('Reply with: the runner output (as text)')) {
            error(`Cron payload uses the pre-2026-06-23 echo prompt (~11k output tokens/tick wasted, frequent max_tokens=8192 clipping). Run \`bun skills/engram/scripts/install-cron.js install\` in this workspace to upgrade to the concise form.`);
          } else if (promptMsg.includes('Step 4 — Final reply (CONCISE, NO ECHO)')) {
            ok('Heartbeat prompt is on the 2026-06-23+ concise format (no echo, ≤512-token reply cap)');
          } else if (promptMsg) {
            warn('Heartbeat prompt format is unrecognized — manual review recommended');
          }
        }
      }
    }
  }
}

// 9. Hooks sync drift guard (catches skill/hooks/ ↔ ~/clawd/hooks/ drift).
// Skill is the source of truth; OpenClaw loads from `~/clawd/hooks/`. If
// `engram-topic-domain-load` and `engram-topic-auto-domain-suggest` are in
// the skill but missing as junctions in the OpenClaw hooks dir, OpenClaw
// silently skips them. install-hooks.js creates the junctions; this check
// surfaces drift before runtime hits it. Idempotent install: this does not
// run install-hooks.js itself, just reports.
console.log('\n--- Hooks Sync ---');
{
  // Skill hooks dir = <skill>/hooks. resolveDir is the workspace-specific
  // junction target (e.g. <workspace>/skills/engram -> clawd/skills/engram);
  // SKILL_DIR is whatever process.env.ENGRAM_SKILL_DIR says, or the actual
  // file location. We follow whatever path install-hooks.js used to install.
  const skillHooksDir = join(SKILL_DIR, 'hooks');
  if (!existsSync(skillHooksDir)) {
    warn(`Skill hooks dir missing: ${skillHooksDir}`);
  } else {
    // Discover gateway hooks dir the same way install-hooks.js does, but
    // locally without shelling out (so the check works even if openclaw
    // CLI is unavailable in this workspace).
    const home = process.env.USERPROFILE || process.env.HOME || '';
    let gatewayHooksDir = null;
    const candidates = [
      join(home, 'clawd', 'hooks'),
      join(home, '.openclaw', 'hooks'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) { gatewayHooksDir = c; break; }
    }
    if (!gatewayHooksDir) {
      warn('Could not locate OpenClaw hooks directory (~/clawd/hooks or ~/.openclaw/hooks). Skipping hook sync check.');
    } else {
      // List hooks in skill
      const skillHooks = readdirSync(skillHooksDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('engram-'))
        .map((e) => e.name)
        .sort();
      // For each, check the corresponding entry in gatewayHooksDir. We
      // accept either a regular recursive copy (current default) or a
      // junction/symlink (legacy / --link mode). The "synced" criterion is:
      //   1. entry exists in gateway hooks dir
      //   2. handler.js exists inside (OpenClaw loads from handler.{js,ts,index.*})
      //   3. (for junctions) target resolves to <skill>/hooks/<name>
      let kept = 0, missing = 0, drifted = 0;
      const entriesToReport = [];
      for (const name of skillHooks) {
        const link = join(gatewayHooksDir, name);
        if (!existsSync(link)) {
          entriesToReport.push({ name, status: 'missing' });
          missing++;
          continue;
        }
        // Check if it's a junction/symlink (lstat doesn't follow reparse)
        let isLink = false;
        let linkTarget = null;
        try {
          const lst = lstatSync(link);
          isLink = lst.isSymbolicLink();
          if (isLink) linkTarget = readlinkSync(link);
        } catch {
          isLink = false;
        }
        if (isLink) {
          // Legacy / --link mode. Verify junction target is correct.
          const expected = join(skillHooksDir, name);
          const resolved = resolve(dirname(link), linkTarget);
          const okMatch = process.platform === 'win32'
            ? resolved.toLowerCase() === expected.toLowerCase()
            : resolved === expected;
          if (okMatch) {
            // Even for correct junctions, handler.js must exist for OpenClaw
            // to import. Probe through the junction.
            const handlerJs = join(link, 'handler.js');
            if (existsSync(handlerJs)) {
              entriesToReport.push({ name, status: 'ok' });
              kept++;
            } else {
              entriesToReport.push({ name, status: 'drifted', detail: 'junction present but handler.js missing' });
              drifted++;
            }
          } else {
            entriesToReport.push({ name, status: 'drifted', detail: `junction points to ${resolved}` });
            drifted++;
          }
          continue;
        }
        // Regular copy. Verify handler.js is present.
        const handlerJs = join(link, 'handler.js');
        if (existsSync(handlerJs)) {
          entriesToReport.push({ name, status: 'ok' });
          kept++;
        } else {
          entriesToReport.push({ name, status: 'drifted', detail: 'regular copy but handler.js missing' });
          drifted++;
        }
      }
      for (const e of entriesToReport) {
        if (e.status === 'ok') continue; // Don't spam OK lines for already-current entries.
        if (e.status === 'missing') {
          warn(`Hook "${e.name}" missing in ${gatewayHooksDir} (run \`bun skills/engram/scripts/install-hooks.js\` to install)`);
        } else {
          warn(`Hook "${e.name}" drifted: ${e.detail}`);
        }
      }
      if (missing === 0 && drifted === 0) {
        ok(`All ${kept} engram hooks installed in ${gatewayHooksDir} (source ${skillHooksDir})`);
      } else {
        warn(`${kept} synced, ${missing} missing, ${drifted} drifted. Run install-hooks.js to reconcile.`);
      }
    }
  }
}

// Summary
console.log(`\n--- Summary ---`);
console.log(`Errors:   ${errors}`);
console.log(`Warnings: ${warnings}`);
if (fix) console.log(`Fixed:    ${fixed}`);
process.exit(errors > 0 ? 1 : 0);
