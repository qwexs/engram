#!/usr/bin/env bun
// engram/scripts/install-hooks.js
// Install OpenClaw workspace hooks from the engram skill into the gateway
// hooks directory (managedHooksDir = `~/clawd/hooks/`).
//
// Why regular copy (default) and not junction?
//   The skill is the source of truth (lives in git at qwexs/engram/hooks/).
//   OpenClaw loads hooks from `~/clawd/hooks/` (see `openclaw hooks info
//   <name>` — the reported Handler path is the runtime source). Junctions
//   are a great idea in theory (zero copy, single source of truth) but
//   OpenClaw 2026.6.6 fails to load hook entries that are NTFS junctions on
//   Windows — the loader scans the directory, sees the reparse point, but
//   `handler.js` resolution and import-url cache-busting do not follow the
//   reparse as expected. Result: zero engram hooks load, even though
//   `openclaw hooks list` shows them as "registered".
//
//   Empirically verified: copying `handler.js + handler.ts + HOOK.md` from
//   `clawd/skills/engram/hooks/engram-*/` into `~/clawd/hooks/engram-*/` as
//   regular directories makes OpenClaw load all 8 hooks as
//   `openclaw-workspace` source. After `openclaw gateway restart`:
//     Hooks (11/13 ready) — 5 bundled + 8 engram.
//
//   The drift concern that motivated junctions ("edit in skill, re-pull, need
//   to re-copy") is real but bounded: re-running this script after a `git
//   pull` that adds or modifies a hook rebuilds and re-copies the affected
//   entry. Old entries are backed up to `_pre-install-{ts}/` before overwrite.
//   For the `engram-*` skill, this is a 30-second manual step after every
//   `git pull` in the skill repo — acceptable for the controlled cohort.
//
// Why --link exists at all?
//   If a future OpenClaw release fixes junction loading, --link re-enables
//   the zero-copy mode. Today (2026-06) it's a known-broken mode and the
//   help text flags it as EXPERIMENTAL.
//
// Usage:
//   bun skills/engram/scripts/install-hooks.js                       # copy all engram-* hooks to managedHooksDir
//   bun skills/engram/scripts/install-hooks.js --dry-run             # preview only, no changes
//   bun skills/engram/scripts/install-hooks.js --force               # overwrite existing entries (after backup)
//   bun skills/engram/scripts/install-hooks.js --hooks-dir <path>    # override gateway hooks dir
//   bun skills/engram/scripts/install-hooks.js --no-backup           # skip backup (dangerous)
//   bun skills/engram/scripts/install-hooks.js --link                # experimental: NTFS junctions (do not use on OpenClaw 2026.6.6)
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
  cpSync,
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
    'link': { type: 'boolean', default: false },
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
  --link                 Use NTFS junctions (or symlinks on POSIX) instead of
                         regular copies. EXPERIMENTAL: OpenClaw 2026.6.6 loads
                         regular copies from managedHooksDir but does NOT load
                         junction entries. Keep this off unless you know you
                         need a live-mirror (and verified OpenClaw supports it
                         in your version).
  -h, --help             Show this help

What it does:
  1. Locates engram-* hook directories under <skill-dir>/hooks/
  2. Builds handler.js for any hook with handler.ts but no handler.js
  3. Backs up any existing entries in <hooks-dir>/ to a timestamped
     _pre-install-*/ subdir (skipped with --no-backup)
  4. Installs each hook into <hooks-dir>/<name>:
       - default: regular recursive copy (cp -r semantics)
       - with --link: NTFS junction (Windows) / symlink (POSIX)
  5. Reports created / already-current / failed / orphan counts

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
      // Lazy-match the prefix up to "/hooks/engram-daily-note/HOOK.md" so we
      // can reattach "hooks" and get the gateway hooks dir directly without
      // relying on dirname (which would give us the per-hook dir, not the
      // gateway hooks dir, when given the full path).
      const m = r.stdout.match(/Path:\s+(.*?[/\\])hooks[/\\]engram-daily-note[/\\]HOOK\.md/);
      if (m) {
        const prefix = m[1].replace(/^~/, process.env.USERPROFILE || process.env.HOME || '');
        const candidate = prefix + 'hooks';
        if (existsSync(candidate)) return candidate;
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
console.log(`  install:    ${args.link ? 'link/junction (EXPERIMENTAL)' : 'copy (default)'}`);
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
    if (entry.name.startsWith('_pre-install-')) continue; // backup directories are intentional
    if (entry.name.startsWith('_pre-junction-')) continue; // legacy backup prefix from previous default
    if (entry.name.startsWith('_archived-')) continue;
    if (!hookNames.includes(entry.name)) {
      orphans.push(entry.name);
    }
  }
}

// --- Step 4: backup existing entries before install ---
const toReplace = plan.filter((p) => p.action === 'replace');
if (toReplace.length > 0 && !args['dry-run']) {
  if (args['no-backup']) {
    console.error(`install-hooks: --no-backup set, refusing to replace ${toReplace.length} entries without backup`);
    process.exit(2);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19);
  const backupDir = join(GATEWAY_HOOKS, `_pre-install-${ts}`);
  console.log(`  backing up ${toReplace.length} existing entries to ${backupDir}`);
  mkdirSync(backupDir, { recursive: true });
  for (const p of toReplace) {
    const dstPath = join(GATEWAY_HOOKS, p.name);
    const backupPath = join(backupDir, p.name);
    try {
      renameSync(dstPath, backupPath);
      console.log(`    backed up: ${p.name}`);
    } catch (e) {
      console.error(`    failed to back up ${p.name}: ${e.message}`);
      process.exit(1);
    }
  }
  console.log();
}

// --- Step 5: install (default = copy, --link = junction/symlink) ---
let created = 0;
let kept = 0;
let failed = 0;
const installMode = args.link ? (process.platform === 'win32' ? 'junction' : 'symlink') : 'copy';

for (const p of plan) {
  if (p.action === 'keep') {
    kept++;
    if (!args['dry-run']) console.log(`  ✓ ${p.name} (already current)`);
    continue;
  }

  if (p.action === 'replace' && !args.force) {
    console.log(`  ⚠️  ${p.name}: existing entry points to '${p.existingTarget}', use --force to replace`);
    failed++;
    continue;
  }

  const target = join(SOURCE_HOOKS, p.name);
  const dstPath = join(GATEWAY_HOOKS, p.name);

  if (args['dry-run']) {
    console.log(`  [dry-run] would ${installMode}: ${p.name} <- ${target}`);
    created++;
    continue;
  }

  try {
    if (installMode === 'copy') {
      // Regular recursive copy. OpenClaw 2026.6.6 loader reliably reads
      // handler.js from regular copies under managedHooksDir; junction
      // entries (the previous default) failed to load on Windows. Keep
      // this as the safe default.
      cpSync(target, dstPath, { recursive: true, force: true });
    } else {
      // 'junction' on Windows = NTFS reparse point (no admin); falls back
      // to a regular symlink on POSIX. EXPERIMENTAL — see --link docs.
      symlinkSync(target, dstPath, installMode);
    }
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
