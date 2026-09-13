import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { legacyKgMutationState } from './_lib/kg-v3-authority.ts';

const roots: string[] = [];
const script = resolve(import.meta.dir, 'validate.js');
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(cron = false) {
  const root = mkdtempSync(join(tmpdir(), 'engram-validation-')); roots.push(root);
  for (const dir of ['memory/agent-main/main', 'memory/templates/group-knowledge', 'life/projects/example', 'life/areas', 'life/archives', 'bin']) mkdirSync(join(root, dir), { recursive: true });
  for (const path of ['MEMORY.md', 'life/README.md', 'life/index.md']) writeFileSync(join(root, path), '# fixture\n');
  writeFileSync(join(root, 'memory/heartbeat-state.json'), JSON.stringify({ lastDailyNoteCreated: { main: '2026-09-08' } }));
  writeFileSync(join(root, 'memory/weekly-synthesis-tracker.json'), '{}');
  writeFileSync(join(root, 'engram.json'), JSON.stringify({ agent: 'main', ...(cron ? { cron: { expectedJobName: 'heartbeat', expectedSchedule: { kind: 'cron', expr: '20 * * * *' } } } : {}) }));
  const fixtureScript = join(root, 'bin', 'openclaw.mjs');
  writeFileSync(fixtureScript, `import { readFileSync } from 'node:fs';\nconsole.log(readFileSync(${JSON.stringify(join(root, 'bin', 'inventory.json'))}, 'utf8'));\n`);
  writeFileSync(join(root, 'bin', 'openclaw.cmd'), `@echo off\r\n"${process.execPath}" "${fixtureScript}" %*\r\n`);
  if (process.platform !== 'win32') writeFileSync(join(root, 'bin/openclaw'), `#!/bin/sh\nexec "${process.execPath}" "${fixtureScript}" "$@"\n`, { mode: 0o755 });
  return root;
}
function run(root: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [script, '--json', ...args], { cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ENGRAM_SKIP_HOOK_INSTALL: '1', PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}` } });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  return { status: result.status, report: JSON.parse(result.stdout) };
}
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  function visit(dir: string) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) visit(path); else out[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex'); } }
  visit(root); return out;
}
function job(root: string, payload?: any) {
  return { id: 'heartbeat-id', name: 'heartbeat', agentId: 'main', enabled: true, schedule: { kind: 'cron', expr: '20 * * * *', tz: 'UTC' }, state: { lastRunAtMs: Date.now(), lastRunStatus: 'ok' }, payload: payload ?? { kind: 'command', cwd: root, argv: ['bun', 'skills/engram/scripts/heartbeat-runner.js', '--workspace', '.', '--agent-id', 'main', '--all-active-sessions'] } };
}

describe('read-only validator JSON contract', () => {
  for (const marker of ['absent', 'malformed', 'valid', 'legacy-contained']) test(`--fix cannot mutate archive with ${marker} authority marker`, () => {
    const root = fixture();
    if (marker !== 'absent') { mkdirSync(join(root, 'memory-state/kg-v3'), { recursive: true }); writeFileSync(join(root, 'memory-state/kg-v3/authority.json'), marker === 'malformed' ? '{bad' : JSON.stringify({ schema: 'engram.kg-v3-authority.v1', mode: marker === 'legacy-contained' ? marker : 'v3-primary' })); }
    writeFileSync(join(root, 'life/projects/example/items.json'), '\ufeff' + JSON.stringify([{ id: 'old', text: 'archive text', category: 'technical', abstractionLevel: 'episodic', status: 'active', accessCount: 2, lastAccessed: '2020-01-01', timestamp: '2020-01-01' }, null]));
    mkdirSync(join(root, 'memory/domains/demo'), { recursive: true });
    const before = snapshot(root);
    expect(legacyKgMutationState(root).allowed).toBe(false);
    const { report } = run(root, ['--fix', '--quality']);
    expect(snapshot(root)).toEqual(before);
    expect(report.schema).toBe('engram.validate.v1');
    expect(report.summary).toMatchObject({ readOnly: true, fixed: 0 });
    expect(report.summary.archiveErrors).toBeGreaterThan(0);
    expect(report.findings.some((f: any) => f.code === 'VALIDATE-FIX-DEPRECATED')).toBe(true);
    expect(report.findings.every((f: any) => f.code && ['error', 'warn', 'info'].includes(f.level) && typeof f.message === 'string')).toBe(true);
  });
  test('historical malformed archive does not fail live health, but missing memory does', () => {
    const root = fixture(); writeFileSync(join(root, 'life/projects/example/items.json'), '{broken');
    const result = run(root); expect(result.status).toBe(0); expect(result.report.summary.errors).toBe(0); expect(result.report.summary.archiveErrors).toBe(1);
    rmSync(join(root, 'memory/heartbeat-state.json'));
    expect(run(root).status).toBe(1);
  });
  test('invalid configuration is visible in JSON output', () => {
    const root = fixture(); writeFileSync(join(root, 'engram.json'), '{broken');
    expect(run(root).report.findings.some((f: any) => f.code === 'VALIDATE-CONFIG-INVALID')).toBe(true);
  });
});

describe('cron visibility and payload contracts', () => {
  for (const shape of ['array', 'object']) test(`accepts ${shape} inventory and command argv/cwd`, () => {
    const root = fixture(true), jobs = [job(root)];
    writeFileSync(join(root, 'bin/inventory.json'), JSON.stringify(shape === 'array' ? jobs : { jobs }));
    const result = run(root); expect(result.report.summary.errors).toBe(0);
    expect(result.report.findings.filter((f: any) => f.code.startsWith('VALIDATE-CRON') && f.level !== 'info')).toEqual([]);
  });
  for (const value of [{ result: [] }, { jobs: [], hasMore: true }, { jobs: [], total: 5 }, { jobs: [] }, null]) test(`unseen inventory ${JSON.stringify(value)} is unverified, not missing`, () => {
    const root = fixture(true); writeFileSync(join(root, 'bin/inventory.json'), JSON.stringify(value));
    const result = run(root); expect(result.report.summary.errors).toBe(0); expect(result.report.summary.skipped).toBeGreaterThan(0);
    expect(result.report.findings.some((f: any) => f.code === 'VALIDATE-CRON-UNVERIFIED')).toBe(true);
  });
  for (const key of ['script', 'source', 'message']) test(`reads ${key} payload`, () => {
    const root = fixture(true);
    const payload = { kind: key === 'message' ? 'agentTurn' : 'script', lightContext: true, [key]: `bun heartbeat-runner.js --workspace '${root}' --agent-id main --all-active-sessions\nStep 4 — Final reply (CONCISE, NO ECHO)` };
    writeFileSync(join(root, 'bin/inventory.json'), JSON.stringify({ jobs: [job(root, payload)] }));
    expect(run(root).report.summary.errors).toBe(0);
  });
  test('inspects JSON-encoded command literals in deterministic script payloads', () => {
    const root = fixture(true);
    const command = `bun heartbeat-runner.js --workspace "${root}" --agent-id "main" --all-active-sessions`;
    const payload = { kind: 'script', source: `// Generated by install-deterministic-heartbeat-cron.js.\nconst output = await execText(${JSON.stringify(command)}, 1000);` };
    writeFileSync(join(root, 'bin/inventory.json'), JSON.stringify({ jobs: [job(root, payload)] }));
    expect(run(root).report.summary.errors).toBe(0);
  });
  test('workspace and agent prefix collisions cannot pass target checks', () => {
    const root = fixture(true); const j = job(root); j.payload.argv = ['bun', 'heartbeat-runner.js', '--workspace', `${root}-other`, '--agent-id', 'main-other', '--all-active-sessions'];
    writeFileSync(join(root, 'bin/inventory.json'), JSON.stringify({ jobs: [j] }));
    const result = run(root); expect(result.report.summary.errors).toBe(2);
  });
  test('prose command ending in an unquoted argument does not include the closing quote/comma in its value', () => {
    const root = fixture(true);
    const message = `Call exec with command="bun spawn-claim.js --workspace ${root} --agent-id main", workdir="${root}".\nRun command="bun heartbeat-runner.js --workspace ${root} --agent-id main --all-active-sessions".`;
    writeFileSync(join(root, 'bin/inventory.json'), JSON.stringify({ jobs: [job(root, { kind: 'agentTurn', message })] }));
    expect(run(root).report.summary.errors).toBe(0);
  });
});

describe('zero legacy static guard', () => {
  test('rejects restored validator writes and heartbeat fix flag', () => {
    const root = fixture(); mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/validate.js'), 'import { writeFileSync as write } from "node:fs";\nwrite(path, bytes);');
    writeFileSync(join(root, 'scripts/heartbeat-runner.js'), 'validateArgs.push("--fix");');
    const result = spawnSync(process.execPath, [resolve(import.meta.dir, 'kg-v3-zero-legacy-watchdog.ts'), '--repository', root], { encoding: 'utf8' });
    const report = JSON.parse(result.stdout); expect(result.status).toBe(1);
    expect(report.violations).toContain('validator write capability: writeFileSync');
    expect(report.violations).toContain('heartbeat automatic validator fix argument remains reachable');
  });
});
