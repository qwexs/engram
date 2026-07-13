#!/usr/bin/env bun
// engram/scripts/install-hooks.js
// Install OpenClaw workspace hooks from the engram skill into the gateway
// hooks directory (managedHooksDir — auto-detected from `openclaw hooks list --json`).
//
// Why regular copy (default) and not junction?
//   The skill is the source of truth (lives in git at qwexs/engram/hooks/).
//   OpenClaw loads hooks from managedHooksDir (see `openclaw hooks list --json` —
//   <name>` — the reported Handler path is the runtime source). Junctions
//   are a great idea in theory (zero copy, single source of truth) but
//   OpenClaw 2026.6.6 fails to load hook entries that are NTFS junctions on
//   Windows — the loader scans the directory, sees the reparse point, but
//   `handler.js` resolution and import-url cache-busting do not follow the
//   reparse as expected. Result: zero engram hooks load, even though
//   `openclaw hooks list` shows them as "registered".
//
//   Empirically verified: copying `handler.js + handler.ts + HOOK.md` from
//   `skills/engram/hooks/engram-*/` into managedHooksDir/engram-*/ as
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
// Why --link is gone:
//   The previous experimental `--link` mode used NTFS junctions (Windows)
//   or symlinks (POSIX) to point the runtime hooks dir at the source tree
//   directly — no copy, no build. As of OpenClaw 2026.6.6 this is broken:
//   the loader scans the directory, sees the reparse point, but `handler.js`
//   resolution and import-url cache-busting do not follow the reparse as
//   expected. Result: zero engram hooks load, even though
//   `openclaw hooks list` shows them as "registered". The fallback --copy
//   mode (regular recursive copy) is the only working option today and is
//   the new default and only mode.
//
//   With the refactor (source is .ts-only, runtime is .js-only), --link is
//   additionally broken because the source no longer contains handler.js.
//   A symlink/junction pointing at a .ts-only source makes the runtime
//   .js-only, and OpenClaw loads nothing. So --link is not just broken in
//   OC66 — it's incompatible with the new source layout. Removed.
//
// Usage:
//   bun skills/engram/scripts/install-hooks.js                       # copy all engram-* hooks to managedHooksDir
//   bun skills/engram/scripts/install-hooks.js --dry-run             # preview only, no changes
//   bun skills/engram/scripts/install-hooks.js --force               # overwrite existing entries (after backup)
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
  renameSync,
  rmSync,
  mkdtempSync,
  copyFileSync,
} from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
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
engram install-hooks — build and install OpenClaw workspace hooks

Usage:
  bun skills/engram/scripts/install-hooks.js [options]

Options:
  --skill-dir <path>     Skill directory (default: derived from this script)
  --hooks-dir <path>     OpenClaw hooks directory (default: auto-detect via openclaw hooks list --json)
  --force                Replace existing entries that point elsewhere
  --no-backup            Skip backup of non-junction entries (dangerous)
  --dry-run              Preview only, no filesystem changes
  --no-build             Skip handler.js build step
  -h, --help             Show this help

What it does:
  1. Locates engram-* hook directories under <skill-dir>/hooks/
  2. Builds handler.js for any hook with handler.ts but no handler.js
  3. Backs up any existing entries in <hooks-dir>/ to a timestamped
     _pre-install-*/ subdir (skipped with --no-backup)
  4. Installs each hook into <hooks-dir>/<name> as a regular directory
     containing only handler.js (built from source handler.ts) and HOOK.md.
     The runtime is .js-only; source .ts files are not copied.
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

// Resolve the OpenClaw-managed hooks directory using a layered strategy.
//
// Designed for three deployment scenarios on a single machine:
//   1. Existing instance with managedHooksDir populated — use it. Canonical,
//      shared across ALL gateway processes on this machine (each gateway
//      shares the same OpenClaw state dir, so they all scan CONFIG_DIR/hooks).
//   2. Existing instance with workspace-local hooks (legacy, pre-managed
//      install) — keep using those so existing setups don't break. Migrate
//      to managed on next reinstall by deleting the workspace-local entries.
//   3. Fresh instance (gateway not yet running, or no hooks registered yet) —
//      compute OpenClaw's canonical default (CONFIG_DIR/hooks, mirroring
//      resolveConfigDir in dist/utils-BTODJbcN.js) and CREATE it. This is
//      the same path OpenClaw uses internally as its managedHooksDir default.
//
// Reference: dist/workspace-Bgbs2XIH.js discoverWorkspaceHookEntries(workspaceDir, opts)
// scans BOTH managedHooksDir AND workspaceHooksDir (path.join(workspaceDir, "hooks")).
// resolveHookEntries() ignores the workspace entry when names collide with managed
// (workspace cannot override managed code). So putting hooks in managed is
// always safe even if workspace-local exists with the same names.
//
// Removed: `~/.openclaw/hooks` convention candidate. It was the source of the
// "hooks copied to the wrong place" bug — on machines where workspaceDir is
// not `~/.openclaw`, the script silently created a fresh `~/.openclaw/hooks` directory
// that the gateway never scanned.
function discoverOpenclawHooksDir() {
  // Strategy 0: query OpenClaw gateway via `hooks list --json` (authoritative).
  try {
    const r = spawnSync('openclaw', ['hooks', 'list', '--json'], {
      encoding: 'utf-8',
      shell: true,
    });
    if (r.status === 0) {
      const data = JSON.parse(r.stdout);
      const managed = typeof data?.managedHooksDir === 'string' ? data.managedHooksDir : null;
      const workspace = typeof data?.workspaceDir === 'string' ? data.workspaceDir : null;

      // (a) managedHooksDir exists — canonical, shared by every gateway on this machine.
      if (managed && existsSync(managed)) return managed;

      // (b) workspaceDir/hooks exists — legacy workspace-local install. Keep working.
      if (workspace) {
        const wsHooks = join(workspace, 'hooks');
        if (existsSync(wsHooks)) return wsHooks;
      }

      // (c) Bootstrap: neither exists. Create managed so every future gateway on
      //     this machine finds hooks here after restart.
      if (managed) {
        try { mkdirSync(managed, { recursive: true }); return managed; } catch {}
      }
    }
  } catch {
    // gateway probably down — fall through to env-based defaults
  }

  // Strategy 1: gateway not running. Compute CONFIG_DIR/hooks the same way
  // OpenClaw does (resolveConfigDir in dist/utils-BTODJbcN.js), then create it.
  const computed = computeDefaultManagedHooksDir();
  if (computed) {
    if (existsSync(computed)) return computed;
    try { mkdirSync(computed, { recursive: true }); return computed; } catch {}
  }

  // Strategy 2: legacy `openclaw hooks info <name>` regex. Safety net for edge
  // cases where Strategy 0 returns malformed JSON but `hooks info` still works.
  try {
    const r = spawnSync('openclaw', ['hooks', 'info', 'engram-daily-note'], {
      encoding: 'utf-8',
      shell: true,
    });
    if (r.status === 0) {
      const m = r.stdout.match(/Path:\s+(.*?[/\\])hooks[/\\]engram-daily-note[/\\]HOOK\.md/);
      if (m) {
        const prefix = m[1].replace(/^~/, process.env.USERPROFILE || process.env.HOME || '');
        const candidate = prefix + 'hooks';
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {}

  // Strategy 3: last-resort convention candidates (no creation). Reached only on
  // truly broken setups where gateway is down AND env vars yielded no path.
  const home = process.env.USERPROFILE || process.env.HOME || '';
  for (const c of [join(home, '.openclaw', 'state', 'hooks')]) {
    if (existsSync(c)) return c;
  }
  // Absolute last resort. Caller will mkdirSync(this, { recursive: true }) later.
  return computed || join(home, '.openclaw', 'hooks');
}

// Mirror OpenClaw's resolveConfigDir(env, homedir) from dist/utils-BTODJbcN.js:
//   1. env.OPENCLAW_STATE_DIR (full state dir override)
//   2. dirname(env.OPENCLAW_CONFIG_PATH)
//   3. ~/.openclaw (or %USERPROFILE%/.openclaw on Windows)
// Returns absolute path to <state-dir>/hooks, or null if home is undetermined.
function computeDefaultManagedHooksDir() {
  const env = process.env;
  let home;
  try { home = homedir(); } catch {}
  home = home || env.USERPROFILE || env.HOME || '';
  if (!home) return null;
  const stateDir = env.OPENCLAW_STATE_DIR?.trim()
    || (env.OPENCLAW_CONFIG_PATH?.trim()
      ? dirname(env.OPENCLAW_CONFIG_PATH.trim())
      : null)
    || join(home, '.openclaw');
  return join(stateDir, 'hooks');
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
console.log(`  install:    copy (default; --link removed — see header)`);
console.log(`  mode:       ${args['dry-run'] ? 'dry-run' : args.force ? 'force' : 'safe'}`);
console.log();

// --- Step 1: build handler.js bundles into per-hook temp dirs ---
// The source repo (skills/engram/hooks/) holds only handler.ts. The runtime
// (managedHooksDir) holds only handler.js. The .js bundle is a derived
// artifact that lives in a temp dir for the duration of the install, so
// nothing derived is ever written to source or committed to git.
const builtBundles = new Map(); // hookName -> absolute path of built handler.js
if (args.build !== false) {
  for (const name of hookNames) {
    const sourceDir = join(SOURCE_HOOKS, name);
    const ts = join(sourceDir, 'handler.ts');
    if (!existsSync(ts)) continue;
    const tmpDir = mkdtempSync(join(tmpdir(), 'engram-hook-bundle-'));
    const tmpJs = join(tmpDir, 'handler.js');
    if (args['dry-run']) {
      console.log(`  [dry-run] would build ${ts} -> ${tmpJs}`);
      builtBundles.set(name, tmpJs);
      continue;
    }
    const r = spawnSync('bun', [
      'build', ts,
      '--target=node',
      '--format=esm',
      '--outfile', tmpJs,
    ], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`install-hooks: build ${ts} failed (exit ${r.status})`);
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      process.exit(r.status ?? 1);
    }
    builtBundles.set(name, tmpJs);
  }
  if (builtBundles.size > 0) {
    console.log(`  built ${builtBundles.size} handler.js bundle(s) into temp`);
  }
}

// --- Step 2: ensure gateway hooks directory exists ---
if (!args['dry-run']) {
  mkdirSync(GATEWAY_HOOKS, { recursive: true });
}

// --- Step 3: classify existing entries ---
// With --link removed, every existing entry (regular dir, leftover junction,
// or anything else) is treated as something to replace. The plan only
// distinguishes between "create" (no entry yet) and "replace" (entry exists).
const plan = []; // [{ name, action }]
const orphans = []; // entries in target dir that are not in source (informational)

for (const name of hookNames) {
  const link = join(GATEWAY_HOOKS, name);
  if (!existsSync(link)) {
    plan.push({ name, action: 'create' });
  } else {
    plan.push({ name, action: 'replace' });
  }
}

// Detect orphan entries (in target but not in source)
if (existsSync(GATEWAY_HOOKS)) {
  for (const entry of readdirSync(GATEWAY_HOOKS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_pre-install-')) continue; // backup directories are intentional
    if (entry.name.startsWith('_pre-junction-')) continue; // legacy backup prefix from before --link removal
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

// --- Step 5: install (only mode = copy/regular-dir, --link removed) ---
let created = 0;
let failed = 0;

for (const p of plan) {
  if (p.action === 'replace' && !args.force) {
    console.log(`  ⚠️  ${p.name}: existing entry present, use --force to replace (it will be backed up first)`);
    failed++;
    continue;
  }

  const target = join(SOURCE_HOOKS, p.name);
  const dstPath = join(GATEWAY_HOOKS, p.name);

  if (args['dry-run']) {
    console.log(`  [dry-run] would copy: ${p.name} <- ${target}`);
    created++;
    continue;
  }

  try {
    // Runtime hook dir is .js-only. We materialize the built bundle
    // (handler.js) + HOOK.md from source, and clean up any leftover
    // .ts files left over from the old .ts+.js-in-one-folder layout.
    mkdirSync(dstPath, { recursive: true });
    const builtJs = builtBundles.get(p.name);
    if (builtJs && existsSync(builtJs)) {
      copyFileSync(builtJs, join(dstPath, 'handler.js'));
    }
    const hookMd = join(target, 'HOOK.md');
    if (existsSync(hookMd)) {
      copyFileSync(hookMd, join(dstPath, 'HOOK.md'));
    }
    // Cleanup: drop any .ts left over from the previous layout. Safe
    // because runtime hooks must not contain source files anyway.
    for (const entry of readdirSync(dstPath)) {
      if (entry.endsWith('.ts')) {
        rmSync(join(dstPath, entry), { force: true });
      }
    }
    console.log(`  ✅ ${p.name}`);
    created++;
  } catch (e) {
    console.error(`  ❌ ${p.name}: ${e.message}`);
    failed++;
  }
}

// --- Step 5b: cleanup temp build dirs ---
for (const builtJs of builtBundles.values()) {
  try { rmSync(dirname(builtJs), { recursive: true, force: true }); } catch {}
}

// --- Step 6: report ---
console.log();
console.log(`install-hooks summary:`);
console.log(`  created:  ${created}`);
console.log(`  failed:   ${failed}`);
if (orphans.length > 0) {
  console.log(`  orphans:  ${orphans.length} (in target dir but not in skill; review manually)`);
  for (const o of orphans) console.log(`    - ${o}`);
}

if (failed === 0 && !args['dry-run']) {
  console.log(`\nNext: openclaw gateway restart`);
}

process.exit(failed > 0 ? 1 : 0);
