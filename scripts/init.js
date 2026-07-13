#!/usr/bin/env bun
// engram/scripts/init.js
// Initialize the complete memory system from scratch
// Usage: bun skills/engram/scripts/init.js [--agent-id main] [--qmd-variant auto|local|jina|ollama] [--force] [--help]

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
    'bootstrap-from-forum': { type: 'boolean', default: false },
    'bootstrap-chat': { type: 'string', default: '' },
    'bootstrap-yes': { type: 'boolean', default: false },
    'yes': { type: 'boolean', default: false },
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
  --qmd-variant <v>         QMD variant: auto|local|jina|ollama (default: auto)
  --force                   Merge with existing dirs (won't overwrite files)
  --with-cron               Also install the heartbeat cron job (idempotent)
  --cron-schedule <e>       Schedule for the cron job: "30m" (default), "5m", "1h", or cron expr
                             Derived from engram.json -> cron.schedule, cron.expectedSchedule.expr,
                             or cron.staggerMinutes (in that order) when this flag is omitted.
  --auto-detect-sessions     Scan openclaw.json for Telegram group/forum sessions and auto-create them
                             (default: true when --with-cron is set, false otherwise)
  --with-sample-domain       Create a sample 'getting-started' domain via add-domain.js
  --bootstrap-from-forum     Find unbound Telegram topics via openclaw state-cache and create
                             pending domains for them (one-shot operator confirmation).
                             Reads ~/.openclaw/state/openclaw.sqlite -> plugin_state_entries
                             namespace 'telegram.topic-name-cache.*'. Skips topics already
                             bound (registry.json hit or session dir exists). Spawns
                             add-domain --pending for each (idempotent on (chatId, topicId)).
                             Complements engram-session-start ISS-10 piggy-back for topics
                             that existed before the bot saw them.
  --bootstrap-chat <id>      With --bootstrap-from-forum, limit to one chat ID
                             (e.g. "-100XXXXXXXXXX"). Default: all forum groups in cache.
  --bootstrap-yes            Skip interactive confirmation for --bootstrap-from-forum (assume yes).
  --yes                      Skip the global confirmation prompt (run non-interactively).
                             Without --yes, init prints a summary of what it will do and
                             waits for a single y/N before proceeding.
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
  bun skills/engram/scripts/init.js --bootstrap-from-forum
  bun skills/engram/scripts/init.js --bootstrap-from-forum --bootstrap-chat -100XXXXXXXXXX
  bun skills/engram/scripts/init.js --bootstrap-from-forum --bootstrap-yes
  bun skills/engram/scripts/init.js --yes
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
const OSS_FALLBACK_MODEL = 'sonnet-4-6';

// --- Dry-run mode tracking ---
const dryRun = !!args['dry-run'];
const plan = { created: [], skipped: [], warnings: [], errors: [] };
function recordCreate(action, item) { plan.created.push(`${action}: ${item}`); }
function recordSkip(action, item, reason) { plan.skipped.push(`${action}: ${item} (${reason})`); }
function recordWarn(item) { plan.warnings.push(item); }
function recordError(item) { plan.errors.push(item); }

// --- Global confirmation gate ---
// init.js is a destructive operation: it creates directories, installs hooks,
// re-indexes QMD, disables built-in hooks, and restarts the gateway.
// Require explicit --yes (or --dry-run) to proceed without prompting.
// This prevents accidental damage from running init.js for "testing".
if (!dryRun && !args['yes'] && !args['force']) {
  console.log(`\nengram init — this will:`);
  console.log(`  • create memory/ and life/ directories in: ${WORKSPACE}`);
  console.log(`  • set up QMD collections and run initial index`);
  console.log(`  • install/overwrite engram hooks (with backup)`);
  console.log(`  • disable the built-in session-memory hook`);
  if (args['with-cron']) console.log(`  • install heartbeat cron job`);
  console.log(`  • restart the OpenClaw gateway`);
  console.log(`\nRun with --dry-run to preview without changes.`);
  console.log(`Proceed? [y/N]`);

  let answer = '';
  try {
    const buf = Buffer.alloc(16);
    const n = require('node:fs').readSync(0, buf, 0, 16, null);
    if (n > 0) answer = buf.slice(0, n).toString('utf8').trim().toLowerCase();
  } catch (e) {
    console.log(`\nCould not read confirmation from stdin (${e.message}).`);
    console.log(`Use --yes to skip the prompt for non-interactive use.`);
    process.exit(1);
  }
  if (answer !== 'y' && answer !== 'yes') {
    console.log('Cancelled.');
    process.exit(0);
  }
}

// --- Detect QMD ---
function detectQmdVariant() {
  const explicit = args['qmd-variant'];
  if (explicit !== 'auto') return explicit;
  if (process.env.QMD_LLM_PROVIDER === 'jina') return 'jina';
  if (process.env.JINA_API_KEY) return 'jina';
  if (process.env.QMD_LLM_PROVIDER === 'ollama') return 'ollama';
  if (process.env.OLLAMA_API_KEY || process.env.OLLAMA_BASE_URL) return 'ollama';
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

// --- AC11: Bootstrap pending domains for unbound Telegram topics ---
// Reads openclaw state SQLite (plugin_state_entries, telegram.topic-name-cache.*)
// to enumerate topics the bot has seen, filters out already-bound ones
// (registry.json hit or session dir exists), previews the proposed bind for
// operator confirmation, then spawns add-domain --pending for each.
//
// This complements engram-session-start ISS-10 piggy-back (which handles
// topics created AFTER the hook is installed). Bootstrap covers topics that
// already exist at install time — the same gap as "no retroactive auto-bind".
//
// Etalon-clean: no per-workspace config, no new hook, no new script
// (reuses add-domain --pending). One-shot operator flow.
async function bootstrapFromForum() {
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  if (!homeDir) {
    recordWarn('USERPROFILE or HOME not set, skipping --bootstrap-from-forum');
    return;
  }

  const sqlitePath = join(homeDir, '.openclaw', 'state', 'openclaw.sqlite');
  if (!existsSync(sqlitePath)) {
    recordWarn(`openclaw state sqlite not found at ${sqlitePath}, skipping --bootstrap-from-forum`);
    return;
  }

  // Openclaw state lives in sqlite. We prefer Bun's native bun:sqlite (which
  // is what `bun` runs against); fall back to node:sqlite on Node v22+. If
  // neither is available, --bootstrap-from-forum is a no-op with a warning.
  let DatabaseSync;
  let sqliteImportError = null;
  if (typeof Bun !== 'undefined') {
    try {
      ({ Database: DatabaseSync } = require('bun:sqlite'));
    } catch (e) {
      sqliteImportError = `bun:sqlite failed: ${e.message}`;
    }
  }
  if (!DatabaseSync) {
    try {
      ({ DatabaseSync } = require('node:sqlite'));
    } catch (e) {
      sqliteImportError = `node:sqlite failed: ${e.message}`;
    }
  }
  if (!DatabaseSync) {
    recordWarn(`no sqlite driver available (Bun + Node < 22?); cannot --bootstrap-from-forum: ${sqliteImportError}`);
    return;
  }

  let db;
  let topics;
  try {
    // bun:sqlite takes options differently; node:sqlite uses {readOnly:true}.
    if (typeof Bun !== 'undefined') {
      db = new DatabaseSync(sqlitePath, { readonly: true });
    } else {
      db = new DatabaseSync(sqlitePath, { readOnly: true });
    }
    topics = readTopicNameCacheEntries(db);
  } catch (e) {
    recordError(`failed to read openclaw state sqlite: ${e.message}`);
    return;
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }

  const chatFilter = args['bootstrap-chat'] ? String(args['bootstrap-chat']).replace(/^-/, '') : '';
  const filtered = chatFilter
    ? topics.filter(t => String(t.chatId).replace(/^-/, '') === chatFilter)
    : topics;

  if (filtered.length === 0) {
    recordSkip('bootstrap-from-forum', 'no topics in topic-name-cache', chatFilter ? `chat=${chatFilter}` : 'cache empty');
    return;
  }

  // Filter out topics that are already bound (registry.json hit or session
  // dir exists). add-domain --pending is also idempotent but skipping here
  // keeps the preview clean and avoids re-spawning for no reason.
  const domainsDir = join(WORKSPACE, 'memory', 'domains');
  const registryPath = join(domainsDir, 'registry.json');
  let registry = { domains: {} };
  if (existsSync(registryPath)) {
    try {
      registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
      if (!registry.domains || typeof registry.domains !== 'object' || Array.isArray(registry.domains)) {
        registry.domains = {};
      }
    } catch {
      registry = { domains: {} };
    }
  }

  const agentRoot = join(WORKSPACE, `memory/agent-${agentId}`);
  const bound = new Set(); // key = `${chatId}:${topicId}`
  for (const [name, entry] of Object.entries(registry.domains)) {
    if (entry?.topic?.chatId && entry?.topic?.topicId) {
      const key = `${String(entry.topic.chatId).replace(/^-/, '')}:${entry.topic.topicId}`;
      bound.add(key);
    }
  }
  // Also check session-dir existence (covers domains bound before registry
  // tracking, or external/manual creation paths).
  if (existsSync(agentRoot)) {
    try {
      const sessionDirs = readdirSync(agentRoot, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
      const sessionRe = /^telegram-group--(\d+)-topic-(\d+)$/;
      for (const d of sessionDirs) {
        const m = d.match(sessionRe);
        if (m) bound.add(`${m[1]}:${m[2]}`);
      }
    } catch { /* best-effort */ }
  }

  // Skip General topic (threadId === '1' in Telegram forums is the General
  // pseudo-topic; not a real domain candidate).
  const candidates = [];
  const skippedBound = [];
  const skippedGeneral = [];
  for (const t of filtered) {
    if (t.threadId === '1' || t.name.toLowerCase() === 'general') {
      skippedGeneral.push(t);
      continue;
    }
    const key = `${t.chatId}:${t.threadId}`;
    if (bound.has(key)) {
      skippedBound.push(t);
      continue;
    }
    candidates.push(t);
  }

  // Build proposed slug per candidate. We do NOT call the hook lib (TypeScript)
  // from a JS script — we re-implement the same algorithm here. Keeping them
  // in sync is documented; the algorithm is small and stable.
  const proposed = candidates.map(t => ({
    ...t,
    proposedSlug: computeTopicSlug(t.name, t.chatId, t.threadId),
  }));

  // Detect slug collisions in this batch (very rare; would happen if two
  // topics collapse to the same slug, e.g. duplicate topic-name entries).
  const slugCounts = new Map();
  for (const p of proposed) {
    slugCounts.set(p.proposedSlug, (slugCounts.get(p.proposedSlug) || 0) + 1);
  }
  const collisions = proposed.filter(p => (slugCounts.get(p.proposedSlug) || 0) > 1);

  console.log(`\n=== Bootstrap preview (--bootstrap-from-forum) ===`);
  console.log(`Agent: ${agentId}`);
  console.log(`Source: ${sqlitePath}`);
  console.log(`Total topics in cache: ${topics.length}`);
  if (chatFilter) console.log(`Filter chat: ${chatFilter}`);
  console.log(`  Bound (skip): ${skippedBound.length}`);
  console.log(`  General (skip): ${skippedGeneral.length}`);
  console.log(`  Will create pending: ${proposed.length}`);
  if (collisions.length > 0) {
    console.log(`  ⚠ Slug collisions in batch: ${collisions.map(c => c.proposedSlug).join(', ')}`);
  }

  if (proposed.length === 0) {
    recordSkip('bootstrap-from-forum', 'no unbound topics', `${skippedBound.length} bound, ${skippedGeneral.length} general`);
    return;
  }

  for (const p of proposed) {
    console.log(`  • [${p.name}] ${p.chatId}:${p.threadId} → ${p.proposedSlug}${collisions.includes(p) ? '  ⚠ slug collision' : ''}`);
  }

  if (dryRun) {
    recordCreate('bootstrap-from-forum', `${proposed.length} pending domain(s) (dry-run)`);
    return;
  }

  // Confirmation gate. --bootstrap-yes skips the prompt for non-interactive
  // / scripted use (CI, install hooks, etc.). Without it, init waits for a
  // single y/N — no per-topic questions, by design (etalon: keep it simple).
  if (!args['bootstrap-yes']) {
    console.log(`\nCreate ${proposed.length} pending domain(s) via add-domain --pending? [y/N]`);
    let answer = '';
    try {
      // Read from stdin synchronously. Use the script's own stdin if available;
      // fall back to a no-op if piped to /dev/null or similar.
      const buf = Buffer.alloc(16);
      const fd = 0;
      const n = require('node:fs').readSync(fd, buf, 0, 16, null);
      if (n > 0) answer = buf.slice(0, n).toString('utf8').trim().toLowerCase();
    } catch (e) {
      recordWarn(`could not read confirmation from stdin (${e.message}); skipping --bootstrap-from-forum`);
      return;
    }
    if (answer !== 'y' && answer !== 'yes') {
      recordSkip('bootstrap-from-forum', 'cancelled by operator', `answer="${answer}"`);
      return;
    }
  }

  // Spawn add-domain --pending per topic. Sequential (not parallel) to keep
  // logs readable and registry writes deterministic. Each call is idempotent
  // on (chatId, topicId) — safe to re-run on retry.
  let created = 0;
  let failed = 0;
  for (const p of proposed) {
    const args = [
      join(SKILL_DIR, 'scripts', 'add-domain.js'),
      '--domain', p.proposedSlug,
      '--type', 'topic-thread',
      '--topic', `${p.chatId}:${p.threadId}`,
      '--pending',
      '--description', `Telegram topic "${p.name}" (auto-bound via --bootstrap-from-forum)`,
    ];
    const result = spawnSync('bun', args, { encoding: 'utf-8', cwd: WORKSPACE });
    const stdout = (result.stdout || '').trim();
    if (result.status === 0) {
      console.log(`  ✓ ${p.proposedSlug} (${p.chatId}:${p.threadId})`);
      if (stdout) console.log(`    ${stdout.split('\n').slice(-1)[0]}`);
      created++;
    } else {
      const stderr = (result.stderr || '').trim().split('\n').slice(-2).join(' | ');
      console.error(`  ✗ ${p.proposedSlug} (${p.chatId}:${p.threadId}): ${stderr || 'add-domain failed'}`);
      failed++;
    }
  }

  if (failed === 0) {
    recordCreate('bootstrap-from-forum', `${created} pending domain(s) created`);
  } else {
    recordWarn(`bootstrap-from-forum: ${created} created, ${failed} failed`);
  }
}

// Helper: read all telegram.topic-name-cache.* entries from openclaw state
// sqlite. Returns [{chatId, threadId, name, updatedAt, ...}]. Pure read.
// Works with both bun:sqlite and node:sqlite — the .prepare(...).all()
// surface is compatible.
function readTopicNameCacheEntries(db) {
  const rows = db.prepare(
    "SELECT namespace, entry_key, value_json FROM plugin_state_entries WHERE plugin_id='telegram' AND namespace LIKE 'telegram.topic-name-cache.%' ORDER BY namespace, entry_key"
  ).all();
  // Multiple bot accounts (default, sergey, etc.) maintain separate
  // topic-name-cache namespaces and can record the same topic. Dedupe by
  // (chatId, threadId), keeping the most-recent entry.
  const byKey = new Map();
  for (const r of rows) {
    const m = String(r.entry_key).match(/^(-?\d+):(\d+)$/);
    if (!m) continue;
    let value;
    try {
      value = JSON.parse(r.value_json);
    } catch {
      continue;
    }
    if (!value || typeof value.name !== 'string') continue;
    const key = `${m[1].replace(/^-/, '')}:${m[2]}`;
    const existing = byKey.get(key);
    const updatedAt = value.updatedAt ?? 0;
    if (!existing || (existing.updatedAt ?? 0) < updatedAt) {
      byKey.set(key, {
        chatId: m[1].replace(/^-/, ''),
        threadId: m[2],
        name: value.name,
        updatedAt,
        iconColor: value.iconColor ?? null,
        raw: value,
      });
    }
  }
  return Array.from(byKey.values());
}

// Helper: pure-JS topic-name slugifier. Mirrors hooks/_lib/slugify.ts.
// Kept in sync manually (no TS->JS build step for init.js).
// Algorithm:
//   1. Lowercase, replace [^\w-] with '-', collapse runs.
//   2. If empty OR starts with non-[a-z] (cyrillic etc.) — fallback to
//      `topic-${chatId}-${threadId}` (no transliteration lib; safe).
//      Already includes the suffix, so don't append it again.
//   3. Truncate at 50 chars (before suffix).
//   4. Always append `-{chatId}-{threadId}` for cross-workspace uniqueness.
function computeTopicSlug(name, chatId, threadId) {
  let base = String(name || '').toLowerCase();
  base = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const startsLatin = /^[a-z]/.test(base);
  if (!base || !startsLatin) {
    // Fallback: prefix-only slug; suffix is already part of the name for
    // uniqueness, so we do NOT append it again (avoid `topic-X-X` collision).
    return `topic-${chatId}-${threadId}`;
  }
  if (base.length > 50) {
    base = base.slice(0, 50).replace(/-+$/, '');
  }
  return `${base}-${chatId}-${threadId}`;
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

  // Idempotent: skip if collection already exists (qmd rejects re-add with non-zero exit).
  try {
    execSync(`${QMD} collection show "${collectionName}"`, { stdio: 'pipe' });
    recordSkip('qmd-collection', collectionName, 'already exists');
    return;
  } catch {
    // Collection does not exist yet — proceed to add.
  }

  try {
    execSync(`${QMD} collection add "${sessionPath}" --name ${collectionName} --mask "**/*.md"`, { stdio: 'pipe' });
    recordCreate('qmd-collection', collectionName);
  } catch (e) {
    // Real failure (permission, broken qmd binary, full disk, etc.). Surface it
    // as an error rather than silently masking it as "may already exist".
    const stderr = (e.stderr ? e.stderr.toString() : '').trim().split('\n').slice(-3).join(' | ');
    recordError(`qmd collection add failed for ${collectionName}${stderr ? `: ${stderr}` : ''}`);
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

// --- AC11 short-circuit: --bootstrap-from-forum runs standalone ---
// Bootstrap is a one-shot operator flow that makes sense on populated
// workspaces (it specifically targets topics that pre-date the bot binding).
// It needs `memory/domains/` to exist (add-domain requires it), so we ensure
// the minimal skeleton before running, then exit before the strict init
// pipeline that requires empty workspaces without --force.
if (args['bootstrap-from-forum']) {
  const minimalDirs = [
    'memory',
    `memory/agent-${agentId}`,
    'memory/domains',
  ];
  if (!dryRun) {
    for (const dir of minimalDirs) {
      mkdirSync(join(WORKSPACE, dir), { recursive: true });
    }
  }
  await bootstrapFromForum();

  console.log('\n=== Summary ===');
  console.log(`Created: ${plan.created.length}`);
  console.log(`Skipped: ${plan.skipped.length}`);
  console.log(`Warnings: ${plan.warnings.length}`);
  console.log(`Errors: ${plan.errors.length}`);

  if (plan.errors.length > 0) {
    console.error('\nBootstrap completed with errors. Please review the output above.');
    process.exit(1);
  }
  process.exit(0);
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

// --- Detect default model from openclaw.json (agents.defaults.model.primary) ---
function detectDefaultModel() {
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  if (!homeDir) return null;
  const openclawConfigPath = join(homeDir, '.openclaw', 'openclaw.json');
  if (!existsSync(openclawConfigPath)) return null;
  try {
    const ocConfig = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    const model = ocConfig?.agents?.defaults?.model;
    if (typeof model === 'string') return model;
    if (typeof model === 'object' && model?.primary) return String(model.primary);
  } catch {
    // best-effort
  }
  return null;
}

// --- Ensure engram.json exists (copy from template, with auto-detected model) ---
{
  const engramJsonPath = join(WORKSPACE, 'engram.json');
  const engramTemplatePath = join(TEMPLATES, 'engram.json');
  if (!existsSync(engramJsonPath)) {
    if (existsSync(engramTemplatePath)) {
      let tpl = readFileSync(engramTemplatePath, 'utf-8');
      // Replace template placeholders
      tpl = tpl.replaceAll('{AGENT_ID}', agentId);
      tpl = tpl.replaceAll('{COLLECTION_NAME}', `${agentId}-memory`);
      
      // Auto-detect model from openclaw.json and replace {MODEL_ID} placeholder
      const detectedModel = detectDefaultModel();
      if (detectedModel) {
        tpl = tpl.replaceAll('"{MODEL_ID}"', `"${detectedModel}"`);
        recordCreate('engram.json', `created from template (agent=${agentId}, collection=${agentId}-memory, model=${detectedModel})`);
        console.log(`  ✓ engram.json created from template — model auto-detected: ${detectedModel}`);
      } else {
        // No model detected — replace {MODEL_ID} with OSS fallback so file is valid
        tpl = tpl.replaceAll('"{MODEL_ID}"', `"${OSS_FALLBACK_MODEL}"`);
        recordCreate('engram.json', `created from template (agent=${agentId}, collection=${agentId}-memory) — using OSS fallback ${OSS_FALLBACK_MODEL}`);
        console.log(`  ✓ engram.json created from template — edit models.* to match your deployment`);
        console.log(`  ⚠ No model found in openclaw.json (agents.defaults.model.primary) — using ${OSS_FALLBACK_MODEL} fallback`);
      }
      
      if (!dryRun) writeFileSync(engramJsonPath, tpl);
    } else {
      recordWarn('engram.json template not found in assets/templates/ — skipping creation');
    }
  } else {
    recordSkip('template', 'engram.json', 'exists');
  }
}

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

// --- Reconcile orphan session dirs ---
// Sessions whose dir exists in memory/agent-{id}/ but are not in openclaw.json
// bindings (typically forum topics whose parent group is bound but the topic
// itself has no explicit binding). Back-fill their QMD collections so daily
// notes get indexed. Closes the gap that produced the topic-60
// daily-note-not-indexed issue (2026-06-26).
if (hasQmd) {
  const memoryRoot = join(WORKSPACE, `memory/agent-${agentId}`);
  if (existsSync(memoryRoot)) {
    const detectedKeys = new Set(detectedSessions.map(s => s.sessionKey));
    const orphanKeys = readdirSync(memoryRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'main')
      .map(d => d.name)
      .filter(name => !detectedKeys.has(name));
    if (orphanKeys.length > 0) {
      console.log(`\nReconciling ${orphanKeys.length} orphan session dir(s):`);
      for (const key of orphanKeys) {
        console.log(`  ${key}`);
        addSessionQmdCollection(key);
      }
    }
  }
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
  console.log('  Local (GPU):         npm i -g @nicepkg/qmd');
  console.log('  Jina (Cloud):        npm i -g @qwexs/qmd');
  console.log('  Ollama (Cloud/local): npm i -g @qwexs/qmd  (then set QMD_LLM_PROVIDER=ollama');
  console.log('                        + OLLAMA_API_KEY or OLLAMA_BASE_URL=http://localhost:11434)');
  console.log('  Memory structure created without search indexing.');
  recordWarn('QMD not installed');
}

// --- Install hooks ---
console.log('\nInstalling OpenClaw hooks (copy-based)...');
if (!dryRun) {
  // Detect if hooks already exist on this workspace. If so, pass --force to
  // install-hooks.js so it can overwrite (after backup). Without --force,
  // install-hooks refuses to touch existing entries — see install-hooks.js.
  const gatewayHooksDir = process.env.OPENCLAW_HOOKS_DIR || join(process.env.USERPROFILE || process.env.HOME || '.', '.openclaw', 'hooks');
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

// --- Disable built-in session-memory hook (replaced by engram-session-memory) ---
// The built-in session-memory hook writes session context to workspace/memory/YYYY-MM-DD-HHMM.md
// engram-session-memory does the same job but writes to the structured engram memory tree.
// Running both creates duplicate files. We disable the built-in by writing
// hooks.internal.entries.session-memory.enabled = false in openclaw.json.
// Gateway API cannot do this (protected path), so we edit the file directly.
if (!dryRun) {
  disableBuiltinSessionMemory();
} else {
  console.log('  [dry-run] would disable built-in session-memory hook in openclaw.json');
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

// --- Disable built-in session-memory hook in openclaw.json ---
// Replaced by engram-session-memory which writes to the structured memory tree.
// Uses `openclaw config set` CLI (the gateway API protects this path, but CLI does not).
function disableBuiltinSessionMemory() {
  // Check current value first to stay idempotent.
  let alreadyDisabled = false;
  try {
    const r = spawnSync('openclaw', ['config', 'get', 'hooks.internal.entries.session-memory.enabled'], {
      encoding: 'utf-8',
      shell: true,
    });
    if (r.status === 0) {
      const val = r.stdout.trim();
      alreadyDisabled = val === 'false' || val === '"false"';
    }
  } catch {}

  if (alreadyDisabled) {
    console.log('  built-in session-memory already disabled, skipping');
    return;
  }

  try {
    const r = spawnSync('openclaw', [
      'config', 'set',
      'hooks.internal.entries.session-memory.enabled',
      'false',
      '--strict-json',
    ], { encoding: 'utf-8', shell: true });

    if (r.status === 0) {
      console.log('  ✅ disabled built-in session-memory hook (replaced by engram-session-memory)');
      recordCreate('session-memory-disabled', 'built-in session-memory replaced by engram-session-memory');
    } else {
      const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ');
      recordWarn(`openclaw config set failed (exit ${r.status}): ${tail}`);
    }
  } catch (e) {
    recordWarn(`failed to run openclaw config set: ${e.message}`);
  }
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
