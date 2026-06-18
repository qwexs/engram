#!/usr/bin/env bun
// engram/scripts/install-hooks.js
// Install OpenClaw workspace hooks via per-hook junctions from the engram skill.
//
// Why junctions (not copies)?
//   The skill is the source of truth (lives in git at qwexs/engram/hooks/).
//   OpenClaw loads hooks from `~/clawd/hooks/` (see `openclaw hooks info
//   <name>` — the reported Handler path is the runtime source). Copying the
//   files into `~/clawd/hooks/` produces a silent drift: any edit in the
//   skill after init is invisible until someone re-copies by hand. That is
//   exactly the bug that hid engram-topic-domain-load for every workspace
//   in 2026-06 — the hook was in the skill, but not in the runtime loader.
//
//   Junctions make the skill the single source of truth: every OpenClaw
//   startup resolves `~/clawd/hooks/engram-*` to `skills/engram/hooks/engram-*`
//   through the reparse point. Drift disappears as a class. Adding a new hook
//   to the skill only requires running this script again to create the
//   junction — `openclaw gateway restart` picks it up.
//
// Usage:
//   bun skills/engram/scripts/install-hooks.js                       # install all engram-* hooks
//   bun skills/engram/scripts/install-hooks.js --dry-run             # preview only, no changes
//   bun skills/engram/scripts/install-hooks.js --force               # replace wrong junctions
//   bun skills/engram/scripts/install-hooks.js --hooks-dir <path>    # override gateway hooks dir
//   bun skills/engram/scripts/install-hooks.js --no-backup           # skip backup (dangerous)
//
// Idempotent: running it twice with the same inputs is a no-op.

import { parseArgs } from 'node:util';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
  readlinkSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

const { values: args } = parseArgs({
  options: {
    'skill-dir': { type: 'string' },
    'hooks-dir': { type: 'string' },
    'force': { type: 'boolean', default: false },
    'no-backup': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'build': { type: 'boolean', default: true },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
engram install-hooks — install OpenClaw workspace hooks via junctions

Usage:
  bun skills/engram/scripts/install-hooks.js [options]

Options:
  --skill-dir <path>     Skill directory (default: derived from this script)
  --hooks-dir <path>     OpenClaw hooks directory (default: auto-detect or ~/clawd/hooks)
  --force                Replace existing entries that point elsewhere
  --no-backup            Skip backup of non-junction entries (dangerous)
  --dry-run              Preview only, no filesystem changes
  --no-build             Skip handler.js build step
  -h, --help             Show this help

What it does:
  1. Locates engram-* hook directories under <skill-dir>/hooks/
  2. Builds handler.js for any hook with handler.ts but no handler.js
  3. Backs up any existing non-junction entries in <hooks-dir>/ to a
     timestamped _pre-junction-*/ subdir (skipped with --no-backup)
  4. Creates a junction (or symlink on non-Windows) for each hook
     pointing at <skill-dir>/hooks/<name>
  5. Reports created / already-correct / failed counts

After running, restart OpenClaw gateway:
  openclaw gateway restart

Example workflow:
  # After git pull adds a new hook to skills/engram/hooks/
  bun skills/engram/scripts/install-hooks.js
  openclaw gateway restart
`);
  process.exit(0);
}

// --- Resolve paths ---
const SCRIPT_DIR = dirname(
  new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
);
const SKILL_DIR = args['skill-dir']
  || process.env.ENGRAM_SKILL_DIR
  || resolve(SCRIPT_DIR, '..');
const SOURCE_HOOKS = join(SKILL_DIR, 'hooks');

const GATEWAY_HOOKS = args['hooks-dir'] || discoverOpenclawHooksDir();

function discoverOpenclawHooksDir() {
  // Strategy 1: ask OpenClaw CLI. Works while gateway is running and any
  // working hook (engram-daily-note) is registered. Capture the directory
  // by stripping the trailing hook name.
  try {
    const r = spawnSync('openclaw', ['hooks', 'info', 'engram-daily-note'], {
      encoding: 'utf-8',
      shell: true,
    });
    if (r.status === 0) {
      // Accept either Windows (C:\…\hooks\engram-daily-note\HOOK.md) or POSIX
      // (/…/hooks/engram-daily-note/HOOK.md) output, and both / and \ separators.
      const m = r.stdout.match(/Path:\s+(~?[^\s]+[/\\]hooks[/\\]engram-daily-note[/\\]HOOK\.md)/);
      if (m) {
        const path = m[1].replace(/^~/, process.env.USERPROFILE || process.env.HOME || '');
        const parent = dirname(path);
        if (existsSync(parent)) return parent;
      }
    }
  } catch {
    // fall through
  }
  // Strategy 2: convention. The workspace charter documents this:
  // workspace-level hooks/ is symlinked to skills/engram/hooks/, but
  // OpenClaw loads from a sibling location — historically ~/clawd/hooks/.
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    join(home, 'clawd', 'hooks'),
    join(home, '.openclaw', 'hooks'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Last resort: create the conventional path.
  return join(home, 'clawd', 'hooks');
}

// --- Validate source ---
if (!existsSync(SOURCE_HOOKS)) {
  console.error(`install-hooks: source ${SOURCE_HOOKS} does not exist`);
  process.exit(1);
}

const hookNames = readdirSync(SOURCE_HOOKS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith('engram-'))
  .map((e) => e.name)
  .sort();

if (hookNames.length === 0) {
  console.error(`install-hooks: no engram-* hook directories found in ${SOURCE_HOOKS}`);
  process.exit(1);
}

console.log(`install-hooks:`);
console.log(`  skill-dir:  ${SKILL_DIR}`);
console.log(`  source:     ${SOURCE_HOOKS} (${hookNames.length} hooks)`);
console.log(`  target:     ${GATEWAY_HOOKS}`);
console.log(`  mode:       ${args['dry-run'] ? 'dry-run' : args.force ? 'force' : 'safe'}`);
console.log();

// --- Step 1: build handler.js if missing ---
if (args.build !== false) {
  const needsBuild = hookNames.some((name) => {
    const dir = join(SOURCE_HOOKS, name);
    return existsSync(join(dir, 'handler.ts')) && !existsSync(join(dir, 'handler.js'));
  });

  if (needsBuild) {
    if (args['dry-run']) {
      console.log('  [dry-run] would run build-hook-bundles.ts (missing handler.js detected)');
    } else {
      console.log('  building missing handler.js bundles...');
      const buildScript = join(SKILL_DIR, 'scripts', 'build-hook-bundles.ts');
      const r = spawnSync('bun', ['run', buildScript], { stdio: 'inherit' });
      if (r.status !== 0) {
        console.error(`install-hooks: build failed (exit ${r.status})`);
        process.exit(r.status ?? 1);
      }
    }
  }
}

// --- Step 2: ensure gateway hooks directory exists ---
if (!args['dry-run']) {
  mkdirSync(GATEWAY_HOOKS, { recursive: true });
}

// --- Step 3: classify existing entries ---
// For each hook in source, check if target entry already exists, and if so,
// whether it's a junction to the right place. Build a plan.
const plan = []; // [{ name, action, existingTarget?, isJunction? }]
const orphans = []; // entries in target dir that are not in source (informational)

for (const name of hookNames) {
  const target = join(SOURCE_HOOKS, name);
  const link = join(GATEWAY_HOOKS, name);

  if (!existsSync(link)) {
    plan.push({ name, action: 'create' });
    continue;
  }

  let isSymlink = false;
  let existingTarget = null;
  try {
    existingTarget = readlinkSync(link);
    isSymlink = true;
  } catch {
    isSymlink = false;
  }

  if (isSymlink) {
    const resolved = resolve(dirname(link), existingTarget);
    const expected = target;
    if (process.platform === 'win32') {
      if (resolved.toLowerCase() === expected.toLowerCase()) {
        plan.push({ name, action: 'keep' });
        continue;
      }
    } else if (resolved === expected) {
      plan.push({ name, action: 'keep' });
      continue;
    }
    plan.push({ name, action: 'replace', existingTarget, isJunction: true });
  } else {
    plan.push({ name, action: 'replace', existingTarget: '(regular directory)', isJunction: false });
  }
}

// Detect orphan entries (in target but not in source)
if (existsSync(GATEWAY_HOOKS)) {
  for (const entry of readdirSync(GATEWAY_HOOKS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_pre-junction-')) continue; // backup directories are intentional
    if (entry.name.startsWith('_archived-')) continue;
    if (!hookNames.includes(entry.name)) {
      orphans.push(entry.name);
    }
  }
}

// --- Step 4: backup existing non-junction entries ---
const toReplace = plan.filter((p) => p.action === 'replace');
if (toReplace.length > 0 && !args['dry-run']) {
  if (args['no-backup']) {
    console.error(`install-hooks: --no-backup set, refusing to replace ${toReplace.length} entries without backup`);
    process.exit(2);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19);
  const backupDir = join(GATEWAY_HOOKS, `_pre-junction-${ts}`);
  console.log(`  backing up ${toReplace.length} existing entries to ${backupDir}`);
  mkdirSync(backupDir, { recursive: true });
  for (const p of toReplace) {
    const link = join(GATEWAY_HOOKS, p.name);
    const backupPath = join(backupDir, p.name);
    try {
      renameSync(link, backupPath);
      console.log(`    backed up: ${p.name}`);
    } catch (e) {
      console.error(`    failed to back up ${p.name}: ${e.message}`);
      process.exit(1);
    }
  }
  console.log();
}

// --- Step 5: create junctions ---
let created = 0;
let kept = 0;
let failed = 0;

for (const p of plan) {
  if (p.action === 'keep') {
    kept++;
    if (!args['dry-run']) console.log(`  ✓ ${p.name} (junction already current)`);
    continue;
  }

  if (p.action === 'replace' && !args.force) {
    console.log(`  ⚠️  ${p.name}: existing entry points to '${p.existingTarget}', use --force to replace`);
    failed++;
    continue;
  }

  const target = join(SOURCE_HOOKS, p.name);
  const link = join(GATEWAY_HOOKS, p.name);

  if (args['dry-run']) {
    console.log(`  [dry-run] would create junction: ${p.name} -> ${target}`);
    created++;
    continue;
  }

  try {
    // On Windows, type 'junction' creates an NTFS reparse point (no admin
    // required). On other platforms it falls back to a regular symlink,
    // which still serves the same purpose.
    symlinkSync(target, link, 'junction');
    console.log(`  ✅ ${p.name}`);
    created++;
  } catch (e) {
    console.error(`  ❌ ${p.name}: ${e.message}`);
    failed++;
  }
}

// --- Step 6: report ---
console.log();
console.log(`install-hooks summary:`);
console.log(`  created:  ${created}`);
console.log(`  kept:     ${kept}`);
console.log(`  failed:   ${failed}`);
if (orphans.length > 0) {
  console.log(`  orphans:  ${orphans.length} (in target dir but not in skill; review manually)`);
  for (const o of orphans) console.log(`    - ${o}`);
}

if (failed === 0 && !args['dry-run']) {
  console.log(`\nNext: openclaw gateway restart`);
}

process.exit(failed > 0 ? 1 : 0);
