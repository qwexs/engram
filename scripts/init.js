#!/usr/bin/env bun
// engram/scripts/init.js
// Initialize the complete memory system from scratch
// Usage: bun skills/engram/scripts/init.js [--agent-id main] [--qmd-variant auto|local|jina] [--force] [--help]

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { loadEngramConfig, resolveQmdCommand } from './config.js';

const { values: args } = parseArgs({
  options: {
    'agent-id': { type: 'string' },
    'qmd-variant': { type: 'string', default: 'auto' },
    'force': { type: 'boolean', default: false },
    'with-cron': { type: 'boolean', default: false },
    'cron-schedule': { type: 'string' },
    'auto-detect-sessions': { type: 'boolean' },
    'with-sample-domain': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'skip-gateway-restart': { type: 'boolean', default: false },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
engram init - Initialize complete memory system

Usage:
  bun skills/engram/scripts/init.js [options]

Options:
  --agent-id <id>           Agent identifier (default: main)
  --qmd-variant <v>         QMD variant: auto|local|jina (default: auto)
  --force                   Merge with existing dirs (won't overwrite files)
  --with-cron               Also install the heartbeat cron job (idempotent)
  --cron-schedule <e>       Schedule for the cron job: "30m" (default), "5m", "1h", or cron expr
                             Derived from engram.json -> cron.schedule, cron.expectedSchedule.expr,
                             or cron.staggerMinutes (in that order) when this flag is omitted.
  --auto-detect-sessions     Scan openclaw.json for Telegram group/forum sessions and auto-create them
                             (default: true when --with-cron is set, false otherwise)
  --with-sample-domain       Create a sample 'getting-started' domain via add-domain.js
  --dry-run                  Print the full plan without executing
  --skip-gateway-restart      Do not run 'openclaw gateway restart' (CI / test env)
  -h, --help                Show this help

What it does:
  1. Creates memory/ directory structure (session isolation)
  2. Creates life/ directory structure (Knowledge Graph)
  3. Copies template files (MEMORY.md, heartbeat-state.json, etc.)
  4. Sets up QMD collections for search
  5. Auto-detects Telegram sessions from openclaw.json (optional)
  6. Runs initial QMD index
  7. Installs OpenClaw hooks
  8. Installs cron job (optional)
  9. Runs backfill-domain-agents for topic-thread domains (optional)
  10. Runs validate.js --quality to verify integrity

Examples:
  bun skills/engram/scripts/init.js
  bun skills/engram/scripts/init.js --agent-id work --qmd-variant jina
  bun skills/engram/scripts/init.js --force
  bun skills/engram/scripts/init.js --with-cron
  bun skills/engram/scripts/init.js --with-cron --cron-schedule 5m
  bun skills/engram/scripts/init.js --with-cron --auto-detect-sessions
  bun skills/engram/scripts/init.js --with-sample-domain
  bun skills/engram/scripts/init.js --dry-run
`);
  process.exit(0);
}

const WORKSPACE = process.cwd();
const config = loadEngramConfig(WORKSPACE);
const QMD = resolveQmdCommand(WORKSPACE);
const agentId = args['agent-id'] || config.agent.replace(/^agent-/, '') || 'main';
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const SKILL_DIR = process.env.ENGRAM_SKILL_DIR || resolve(SCRIPT_DIR, '..');
const TEMPLATES = join(SKILL_DIR, 'assets', 'templates');

// --- Dry-run mode tracking ---
const dryRun = !!args['dry-run'];
const plan = { created: [], skipped: [], warnings: [], errors: [] };
function recordCreate(action, item) { plan.created.push(`${action}: ${item}`); }
function recordSkip(action, item, reason) { plan.skipped.push(`${action}: ${item} (${reason})`); }
function recordWarn(item) { plan.warnings.push(item); }
function recordError(item) { plan.errors.push(item); }

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
    execSync(`${QMD} --help`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const qmdVariant = detectQmdVariant();
const hasQmd = qmdAvailable();

// --- AC5: Determine cron schedule from engram.json ---
// Priority:
//   1. --cron-schedule flag (explicit override)
//   2. engram.json -> cron.schedule  (string cron expr, e.g. "2,32 * * * *")
//   3. engram.json -> cron.expectedSchedule.expr  (object form, e.g. { expr, tz })
//   4. engram.json -> cron.expectedSchedule  (full schedule object with .expr / .every)
//   5. engram.json -> cron.staggerMinutes  (numeric minutes, e.g. 30 -> "*/30 * * * *")
//   6. fallback: "30m" (interval, generic)
// Note: engram.json -> models.subagents_default is unrelated (model id, not schedule).
let _cronScheduleWarned = false;
function getCronSchedule() {
  if (args['cron-schedule']) return args['cron-schedule'];
  const cronCfg = config?.cron;
  if (cronCfg?.schedule) {
    recordCreate('cron-schedule-source', `engram.json cron.schedule = ${cronCfg.schedule}`);
    return cronCfg.schedule;
  }
  if (cronCfg?.expectedSchedule) {
    const es = cronCfg.expectedSchedule;
    if (typeof es === 'string') {
      recordCreate('cron-schedule-source', `engram.json cron.expectedSchedule = ${es}`);
      return es;
    }
    if (typeof es === 'object') {
      if (es.expr) {
        recordCreate('cron-schedule-source', `engram.json cron.expectedSchedule.expr = ${es.expr}${es.tz ? ` (tz ${es.tz})` : ''}`);
        return es.expr;
      }
      if (es.kind === 'every' && typeof es.everyMs === 'number') {
        const mins = Math.round(es.everyMs / 60000);
        const expr = `*/${mins} * * * *`;
        recordCreate('cron-schedule-source', `engram.json cron.expectedSchedule.everyMs = ${es.everyMs} -> ${expr}`);
        return expr;
      }
    }
  }
  if (typeof cronCfg?.staggerMinutes === 'number' && cronCfg.staggerMinutes > 0) {
    const expr = cronCfg.staggerMinutes === 30 ? '*/30 * * * *' : `*/${cronCfg.staggerMinutes} * * * *`;
    recordCreate('cron-schedule-source', `engram.json cron.staggerMinutes = ${cronCfg.staggerMinutes} -> ${expr}`);
    return expr;
  }
  if (!_cronScheduleWarned) {
    recordWarn('cron schedule not in engram.json (set cron.schedule, cron.expectedSchedule.expr, cron.staggerMinutes, or --cron-schedule) — using default "30m"');
    _cronScheduleWarned = true;
  }
  return '30m';
}

// --- AC2: Auto-detect sessions from openclaw.json bindings ---
// Reads openclaw.json -> bindings[] filtered by current agentId, builds
// canonical engram sessionKeys:
//   group:           telegram-group-${chatId}
//   forum (parent):  telegram-group-${chatId}   (always when any topic binding exists)
//   forum topic:     telegram-group-${chatId}-topic-${topicId}
//   direct:          telegram-${accountId}-direct-${userId}
// Bot accounts are NOT auto-created here (a bot is typically one per workspace
// and is created manually via add-session --platform telegram --id bot-${botId}).
function autoDetectSessions() {
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  if (!homeDir) {
    recordWarn('USERPROFILE or HOME not set, skipping auto-detect-sessions');
    return [];
  }
  const openclawConfigPath = join(homeDir, '.openclaw', 'openclaw.json');
  if (!existsSync(openclawConfigPath)) {
    recordWarn('openclaw.json not found, skipping auto-detect-sessions');
    return [];
  }

  let openclawConfig;
  try {
    openclawConfig = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
  } catch (e) {
    recordWarn(`failed to parse openclaw.json: ${e.message}`);
    return [];
  }

  const bindings = openclawConfig?.bindings;
  if (!Array.isArray(bindings)) {
    recordWarn('openclaw.json has no bindings[] array, skipping auto-detect-sessions');
    return [];
  }

  // Match either 'agent-${agentId}' or bare '${agentId}' — config.js normalizes
  // both forms. Strip prefix for the comparison so --agent-id main matches
  // bindings[].agentId === 'agent-main'.
  const fullAgentId = `agent-${agentId}`;
  const defaultAccount = openclawConfig?.channels?.telegram?.defaultAccount || 'default';

  const sessionsByKey = new Map(); // dedupe parent + topic for forums

  for (const binding of bindings) {
    const aId = binding?.agentId;
    if (aId !== agentId && aId !== fullAgentId) continue;

    const match = binding?.match || {};
    if (match.channel !== 'telegram') continue;

    const accountId = match.accountId || defaultAccount;
    const peer = match.peer || {};
    const rawId = String(peer.id || '');
    if (!rawId) continue;

    if (peer.kind === 'group') {
      // Forum topics carry ":topic:NN" suffix in their peer.id.
      const topicMatch = rawId.match(/^(.+?):topic:(\d+)$/);
      if (topicMatch) {
        const chatId = topicMatch[1];
        const topicId = topicMatch[2];
        const parentKey = `telegram-group-${chatId}`;
        if (!sessionsByKey.has(parentKey)) {
          sessionsByKey.set(parentKey, {
            platform: 'telegram',
            chatId,
            kind: 'group',
            sessionKey: parentKey,
          });
        }
        const topicKey = `telegram-group-${chatId}-topic-${topicId}`;
        sessionsByKey.set(topicKey, {
          platform: 'telegram',
          chatId: rawId,
          kind: 'group-topic',
          sessionKey: topicKey,
        });
      } else {
        const sessionKey = `telegram-group-${rawId}`;
        sessionsByKey.set(sessionKey, {
          platform: 'telegram',
          chatId: rawId,
          kind: 'group',
          sessionKey,
        });
      }
    } else if (peer.kind === 'direct') {
      const sessionKey = `telegram-${accountId}-direct-${rawId}`;
      sessionsByKey.set(sessionKey, {
        platform: 'telegram',
        chatId: rawId,
        kind: 'direct',
        accountId,
        sessionKey,
      });
    }
  }

  return Array.from(sessionsByKey.values());
}

function createSessionDir(sessionKey, platform, chatId) {
  const sessionPath = join(WORKSPACE, `memory/agent-${agentId}/${sessionKey}`);
  const knowledgeDest = join(sessionPath, 'knowledge');
  const knowledgeSrc = join(TEMPLATES, 'group-knowledge');

  if (existsSync(sessionPath)) {
    recordSkip('session', sessionKey, 'exists');
    return false;
  }

  if (dryRun) {
    recordCreate('session', sessionKey);
    return true;
  }

  mkdirSync(sessionPath, { recursive: true });
  if (existsSync(knowledgeSrc)) {
    cpSync(knowledgeSrc, knowledgeDest, { recursive: true });
  }
  const today = new Date().toISOString().split('T')[0];
  writeFileSync(join(sessionPath, `${today}.md`), `# ${today}\n`);
  recordCreate('session', sessionKey);
  return true;
}

function addSessionQmdCollection(sessionKey) {
  if (!hasQmd) return;
  const sessionPath = join(WORKSPACE, `memory/agent-${agentId}/${sessionKey}`);
  const collectionName = `openclaw-memory-agent-${agentId}-${sessionKey}`;

  if (dryRun) {
    recordCreate('qmd-collection', collectionName);
    return;
  }

  try {
    execSync(`${QMD} collection add "${sessionPath}" --name ${collectionName} --mask "**/*.md"`, { stdio: 'pipe' });
    recordCreate('qmd-collection', collectionName);
  } catch {
    recordSkip('qmd-collection', collectionName, 'may already exist');
  }
}

// --- AC4: Batched activeSessions update ---
// Reads heartbeat-state.json ONCE, accumulates all sessionKeys, writes ONCE.
// Replaces the previous per-session read-modify-write (M4 from senior review)
// and the dead populateActiveSessions() wrapper that was defined but never
// called (C2).
function updateHeartbeatStateForSessions(sessionKeys) {
  if (!Array.isArray(sessionKeys) || sessionKeys.length === 0) return;
  const heartbeatPath = join(WORKSPACE, 'memory/heartbeat-state.json');
  if (!existsSync(heartbeatPath)) {
    recordWarn('heartbeat-state.json not found, skipping activeSessions update');
    return;
  }

  if (dryRun) {
    for (const key of sessionKeys) recordCreate('heartbeat-state-update', key);
    return;
  }

  try {
    const state = JSON.parse(readFileSync(heartbeatPath, 'utf-8'));
    if (!state.lastDailyNoteCreated) state.lastDailyNoteCreated = {};
    if (!state.activeSessions) state.activeSessions = [];
    let added = 0;
    for (const key of sessionKeys) {
      if (!state.lastDailyNoteCreated[key]) {
        state.lastDailyNoteCreated[key] = null;
      }
      if (!state.activeSessions.includes(key)) {
        state.activeSessions.push(key);
        added++;
      }
    }
    writeFileSync(heartbeatPath, JSON.stringify(state, null, 2) + '\n');
    if (added > 0) {
      recordCreate('heartbeat-state-update', `${added} session(s) added to activeSessions`);
    } else {
      recordSkip('heartbeat-state-update', 'no new sessions', 'all already in activeSessions');
    }
  } catch (e) {
    recordWarn(`failed to update heartbeat-state: ${e.message}`);
  }
}

// --- AC6: Create sample domain ---
function createSampleDomain() {
  const domainName = 'getting-started';
  const domainDir = join(WORKSPACE, 'memory', 'domains', domainName);

  if (existsSync(join(domainDir, 'README.md'))) {
    recordSkip('sample-domain', domainName, 'exists');
    return false;
  }

  if (dryRun) {
    recordCreate('sample-domain', domainName);
    return true;
  }

  try {
    execSync(
      `bun ${join(SKILL_DIR, 'scripts', 'add-domain.js')} --domain ${domainName} --type dev-project --description "Sample domain for onboarding"`,
      { stdio: 'pipe', cwd: WORKSPACE }
    );
    recordCreate('sample-domain', domainName);
    return true;
  } catch (e) {
    recordWarn(`add-domain.js failed: ${e.message}`);
    return false;
  }
}

// --- AC9: Backfill domain agents ---
function runBackfillDomainAgents() {
  const registryPath = join(WORKSPACE, 'memory', 'domains', 'registry.json');
  if (!existsSync(registryPath)) {
    recordWarn('registry.json not found, skipping backfill-domain-agents');
    return;
  }

  if (dryRun) {
    recordCreate('backfill-domain-agents', 'all topic-thread domains');
    return;
  }

  try {
    execSync(
      `bun ${join(SKILL_DIR, 'scripts', 'backfill-domain-agents.js')}`,
      { stdio: 'pipe', cwd: WORKSPACE }
    );
    recordCreate('backfill-domain-agents', 'completed');
  } catch (e) {
    recordWarn(`backfill-domain-agents.js failed: ${e.message}`);
  }
}

// --- AC7: Run validate.js --quality ---
function runValidate() {
  if (dryRun) {
    recordCreate('validate', 'validate.js --quality');
    return { errors: 0, warnings: 0 };
  }

  const result = spawnSync(
    'bun',
    [join(SKILL_DIR, 'scripts', 'validate.js'), '--quality', '--agent-id', agentId],
    { encoding: 'utf-8', cwd: WORKSPACE }
  );

  const output = result.stdout + result.stderr;
  console.log(output);

  let errors = 0, warnings = 0;
  const errMatch = output.match(/^Errors:\s*(\d+)/m);
  const warnMatch = output.match(/^Warnings:\s*(\d+)/m);
  if (errMatch) errors = parseInt(errMatch[1], 10);
  if (warnMatch) warnings = parseInt(warnMatch[1], 10);

  return { errors, warnings };
}

// --- AC8: Restart gateway idempotent ---
// Skips automatically when:
//   - --dry-run is set
//   - --skip-gateway-restart is set
//   - `openclaw` binary is not on PATH (CI / fresh test env)
//   - `openclaw` binary is on PATH but `gateway restart` is not running (timeout 10s)
function restartGateway() {
  if (dryRun) {
    recordCreate('gateway-restart', 'openclaw gateway restart');
    return;
  }
  if (args['skip-gateway-restart']) {
    recordSkip('gateway-restart', 'skipped', '--skip-gateway-restart');
    return;
  }
  // Detect openclaw binary presence first to avoid hanging in test/CI env.
  let openclawOnPath = false;
  try {
    execSync('openclaw --version', { stdio: 'pipe', timeout: 5000 });
    openclawOnPath = true;
  } catch {
    recordSkip('gateway-restart', 'skipped', 'openclaw binary not on PATH');
    return;
  }
  if (!openclawOnPath) return;

  try {
    execSync('openclaw gateway restart', { stdio: 'pipe', timeout: 10000 });
    recordCreate('gateway-restart', 'completed');
  } catch (e) {
    recordWarn(`gateway restart failed (timeout or non-zero exit): ${e.message?.slice(0, 200) ?? 'unknown'}`);
  }
}

// --- Check existing ---
if (!args.force) {
  const conflicts = [];
  if (existsSync(join(WORKSPACE, 'memory'))) conflicts.push('memory/');
  if (existsSync(join(WORKSPACE, 'life'))) conflicts.push('life/');
  if (conflicts.length > 0) {
    console.error('Existing directories found:');
    conflicts.forEach(c => console.error(`   - ${c}`));
    console.error('Use --force to merge (existing files will NOT be overwritten)');
    process.exit(1);
  }
}

// --- Auto-detect sessions early to know if we need them ---
const autoDetectSessionsEnabled = args['auto-detect-sessions'] ?? args['with-cron'];
const detectedSessions = autoDetectSessionsEnabled ? autoDetectSessions() : [];

if (dryRun) {
  console.log('=== DRY RUN - Plan ===');
  console.log(`Agent: ${agentId}`);
  console.log(`Auto-detect sessions: ${autoDetectSessionsEnabled} (${detectedSessions.length} found)`);
  console.log(`With cron: ${args['with-cron']}`);
  console.log(`Cron schedule: ${getCronSchedule()}`);
  console.log(`With sample domain: ${args['with-sample-domain']}`);
  console.log();
}

// --- Create directories ---
const dirs = [
  'memory',
  `memory/agent-${agentId}`,
  `memory/agent-${agentId}/main`,
  'memory/domains',
  'memory/templates/group-knowledge',
  'life',
  'life/people',
  'life/projects',
  'life/archives',
  'life/areas',
];

if (!dryRun) {
  for (const dir of dirs) {
    mkdirSync(join(WORKSPACE, dir), { recursive: true });
  }
}
console.log(`Created: ${dirs.length} directories`);

// --- OLL (Operational Learning Loop) directories ---
const ollDirs = [
  'ops',
  'ops/observations',
  'ops/tensions',
];

if (!dryRun) {
  for (const dir of ollDirs) {
    mkdirSync(join(WORKSPACE, dir), { recursive: true });
  }

  const obsIndex = join(WORKSPACE, 'ops', 'observations', 'index.json');
  if (!existsSync(obsIndex)) {
    writeFileSync(obsIndex, JSON.stringify({ observations: [], lastId: 0 }, null, 2));
  }
  const tensionsIndex = join(WORKSPACE, 'ops', 'tensions', 'index.json');
  if (!existsSync(tensionsIndex)) {
    writeFileSync(tensionsIndex, JSON.stringify({ tensions: [], lastId: 0 }, null, 2));
  }

  for (const gk of [
    join(WORKSPACE, 'ops', 'observations', '.gitkeep'),
    join(WORKSPACE, 'ops', 'tensions', '.gitkeep'),
  ]) {
    if (!existsSync(gk)) writeFileSync(gk, '');
  }
}
console.log('OLL directories created (ops/observations/, ops/tensions/)');

// --- Copy templates ---
function copyTemplate(templateName, destPath, replacements = {}) {
  const dest = join(WORKSPACE, destPath);
  if (existsSync(dest)) {
    if (!dryRun) console.log(`  SKIP ${destPath} (exists)`);
    recordSkip('template', destPath, 'exists');
    return;
  }
  const templatePath = join(TEMPLATES, templateName);
  if (!existsSync(templatePath)) {
    console.error(`  Template not found: ${templateName}`);
    recordError(`template not found: ${templateName}`);
    return;
  }

  if (dryRun) {
    recordCreate('template', destPath);
    return;
  }

  mkdirSync(dirname(dest), { recursive: true });
  let content = readFileSync(templatePath, 'utf-8');
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  writeFileSync(dest, content);
  recordCreate('template', destPath);
}

const today = new Date().toISOString().split('T')[0];
const replacements = { AGENT_ID: agentId, DATE: today, SESSION_KEY: 'main' };

console.log('\nCopying templates...');
copyTemplate('MEMORY.md', 'MEMORY.md', replacements);
copyTemplate('memory-readme.md', 'memory/README.md', replacements);
copyTemplate('heartbeat-state.json', 'memory/heartbeat-state.json', replacements);
copyTemplate('weekly-synthesis-tracker.json', 'memory/weekly-synthesis-tracker.json', replacements);
copyTemplate('life-readme.md', 'life/README.md', replacements);
copyTemplate('index.md', 'life/index.md', replacements);
copyTemplate('daily-note.md', `memory/agent-${agentId}/main/${today}.md`, { ...replacements, DATE: today });

// --- Inject engram rules into AGENTS.md ---
{
  const snippetPath = join(TEMPLATES, 'agents-snippet.md');
  const agentsPath = join(WORKSPACE, 'AGENTS.md');
  const START_MARKER = '<!-- engram:rules:start -->';
  const END_MARKER = '<!-- engram:rules:end -->';

  if (existsSync(snippetPath)) {
    let snippet = readFileSync(snippetPath, 'utf-8');
    for (const [key, value] of Object.entries(replacements)) {
      snippet = snippet.replaceAll(`{{${key}}}`, value);
    }

    if (existsSync(agentsPath)) {
      let agents = readFileSync(agentsPath, 'utf-8');
      const startIdx = agents.indexOf(START_MARKER);
      const endIdx = agents.indexOf(END_MARKER);

      if (startIdx !== -1 && endIdx !== -1) {
        agents = agents.slice(0, startIdx) + snippet + agents.slice(endIdx + END_MARKER.length);
        if (!dryRun) writeFileSync(agentsPath, agents);
        recordCreate('AGENTS.md', 'engram rules updated (replaced existing block)');
      } else {
        agents = agents.trimEnd() + '\n\n' + snippet + '\n';
        if (!dryRun) writeFileSync(agentsPath, agents);
        recordCreate('AGENTS.md', 'engram rules appended');
      }
    } else {
      if (!dryRun) writeFileSync(agentsPath, snippet + '\n');
      recordCreate('AGENTS.md', 'created with engram rules');
    }
  } else {
    console.error('  agents-snippet.md template not found');
    recordError('template not found: agents-snippet.md');
  }
}

// --- Domain registry ---
copyTemplate('domain/registry.json', 'memory/domains/registry.json', replacements);

// --- Group knowledge templates ---
for (const tmpl of ['clients.md', 'contacts.md', 'decisions.md', 'resources.md']) {
  copyTemplate(`group-knowledge/${tmpl}`, `memory/templates/group-knowledge/${tmpl}`, replacements);
}

// --- Auto-detected sessions ---
if (detectedSessions.length > 0) {
  console.log(`\nAuto-detected ${detectedSessions.length} session(s):`);
  for (const session of detectedSessions) {
    console.log(`  ${session.platform}:${session.chatId} (kind: ${session.kind || 'unknown'})`);
    createSessionDir(session.sessionKey, session.platform, session.chatId);
    addSessionQmdCollection(session.sessionKey);
  }
  // Batched update of heartbeat-state.json:activeSessions (AC4 fix C2).
  updateHeartbeatStateForSessions(detectedSessions.map(s => s.sessionKey));
}

// --- QMD collections ---
if (hasQmd) {
  console.log('\nSetting up QMD collections...');
  const collections = [
    { path: '.', name: 'openclaw-root', mask: '*.md' },
    { path: `memory/agent-${agentId}/main`, name: `openclaw-memory-agent-${agentId}-main`, mask: '**/*.md' },
    { path: 'life', name: 'life', mask: '**/*.md' },
  ];

  for (const col of collections) {
    if (dryRun) {
      recordCreate('qmd-collection', col.name);
      continue;
    }
    try {
      execSync(`${QMD} collection add "${join(WORKSPACE, col.path)}" --name ${col.name} --mask "${col.mask}"`, { stdio: 'pipe' });
      recordCreate('qmd-collection', col.name);
    } catch {
      recordSkip('qmd-collection', col.name, 'may already exist');
    }
  }

  console.log('\nRunning QMD index...');
  if (!dryRun) {
    try {
      execSync(`${QMD} update`, { stdio: 'inherit' });
    } catch {
      console.warn('  qmd update failed - run manually');
      recordWarn('qmd update failed');
    }
  }
} else {
  console.log('\nQMD not found. Install:');
  console.log('  Local (GPU):  npm i -g @nicepkg/qmd');
  console.log('  Jina (API):   npm i -g @qwexs/qmd');
  console.log('  Memory structure created without search indexing.');
  recordWarn('QMD not installed');
}

// --- Install hooks ---
console.log('\nInstalling OpenClaw hooks (copy-based)...');
if (!dryRun) {
  // Detect if hooks already exist on this workspace. If so, pass --force to
  // install-hooks.js so it can overwrite (after backup). Without --force,
  // install-hooks refuses to touch existing entries — see install-hooks.js.
  const gatewayHooksDir = process.env.OPENCLAW_HOOKS_DIR || join(process.env.USERPROFILE || process.env.HOME || '.', 'clawd', 'hooks');
  const anyHookExists = existsSync(join(gatewayHooksDir, 'engram-bootstrap-qmd')) ||
    existsSync(join(gatewayHooksDir, 'engram-daily-note'));
  const forceFlag = anyHookExists ? ' --force' : '';
  try {
    execSync(
      `bun ${join(SKILL_DIR, 'scripts', 'install-hooks.js')} --skill-dir ${SKILL_DIR}${forceFlag}`,
      { stdio: 'inherit' }
    );
    recordCreate('hooks', anyHookExists ? 'installed (force-overwrite)' : 'installed');
  } catch (e) {
    console.log(`  install-hooks.js failed (exit ${e.status ?? '?'})`);
    recordWarn(`install-hooks.js failed: exit ${e.status ?? '?'}`);
  }
} else {
  recordCreate('hooks', 'install via install-hooks.js');
}

// --- Cron install (optional) ---
if (args['with-cron']) {
  console.log('\nInstalling heartbeat cron job...');
  const schedule = getCronSchedule();
  if (!dryRun) {
    try {
      execSync(
        `bun skills/engram/scripts/install-cron.js install --agent-id ${agentId} --workspace ${WORKSPACE} --schedule ${schedule}`,
        { stdio: 'inherit' }
      );
      recordCreate('cron', `installed with schedule ${schedule}`);
    } catch (e) {
      console.log(`  Cron install failed (exit ${e.status ?? '?'})`);
      recordWarn(`cron install failed: exit ${e.status ?? '?'}`);
    }
  } else {
    recordCreate('cron', `install with schedule ${schedule}`);
  }
}

// --- AC6: Sample domain ---
if (args['with-sample-domain']) {
  console.log('\nCreating sample domain...');
  createSampleDomain();
}

// --- AC9: Backfill domain agents ---
if (existsSync(join(WORKSPACE, 'memory', 'domains', 'registry.json'))) {
  console.log('\nRunning backfill-domain-agents...');
  runBackfillDomainAgents();
}

// --- AC7: Validate ---
console.log('\nRunning validate.js --quality...');
const validateResult = runValidate();
if (validateResult.errors > 0) {
  recordError(`validate: ${validateResult.errors} error(s)`);
}
if (validateResult.warnings > 0) {
  recordWarn(`validate: ${validateResult.warnings} warning(s)`);
}

// --- AC8: Gateway restart (always after hooks/cron install) ---
// C3 fix: hooks install runs unconditionally above; if we only restart when
// --with-cron or --with-sample-domain is set, hooks-only runs leave new hook
// entries un-picked-up until a manual gateway restart. Restart is idempotent
// and respects --skip-gateway-restart / --dry-run / no-openclaw-on-PATH.
console.log('\nRestarting gateway...');
restartGateway();

// --- Summary (AC11) ---
console.log('\n=== Summary ===');
console.log(`Created: ${plan.created.length}`);
console.log(`Skipped: ${plan.skipped.length}`);
console.log(`Warnings: ${plan.warnings.length + validateResult.warnings}`);
console.log(`Errors: ${plan.errors.length + validateResult.errors}`);

if (dryRun) {
  console.log('\n--- Created items ---');
  plan.created.forEach(c => console.log(`  + ${c}`));
  console.log('\n--- Skipped items ---');
  plan.skipped.forEach(s => console.log(`  o ${s}`));
  console.log('\n--- Warnings ---');
  [...plan.warnings, ...(validateResult.warnings > 0 ? [`validate: ${validateResult.warnings} warning(s)`] : [])].forEach(w => console.log(`  ⚠ ${w}`));
  console.log('\n--- Errors ---');
  [...plan.errors, ...(validateResult.errors > 0 ? [`validate: ${validateResult.errors} error(s)`] : [])].forEach(e => console.log(`  ❌ ${e}`));
  console.log('\n(Dry run complete — no changes made)');
  process.exit(0);
}

if (plan.errors.length > 0 || validateResult.errors > 0) {
  console.error('\nInit completed with errors. Please review the output above.');
  process.exit(1);
}
