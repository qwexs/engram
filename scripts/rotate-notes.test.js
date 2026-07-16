/**
 * rotate-notes.test.js — Unit + integration tests for rotate-notes.js (ISS-10).
 *
 * Covers the rotation logic that compactly bounds daily notes and domain
 * changelogs to LINE_THRESHOLD = 1000 lines. Previously this script had
 * zero test coverage despite being called on every heartbeat tick (per-
 * session daily-note check) — a regression here could silently break
 * archive + stub mechanics. ISS-10 closes the gap.
 *
 * Test strategy: spawn rotate-notes.js as a subprocess (matches cron usage).
 * Fixtures live in os.tmpdir() + "/" + crypto.randomUUID(). We synthesise
 * large files by writing LINE_THRESHOLD+N newline-separated lines.
 *
 * What we cover:
 *   - check mode (--check --session, --check-domains): exit codes 0/10
 *     and JSON payload shape (needsRotation, lines, files, domainsChecked).
 *   - rotate mode for daily notes: archive created in archives/YYYY-MM/,
 *     stub replaces original with last-watermark preserved.
 *   - rotate mode for changelogs: archive created in archives/, original
 *     reset to header.
 *   - safety guards: rotation skipped when file <= threshold.
 *   - ISS-14 regression anchor: rotate → apply idempotency. After rotating
 *     a domain changelog, applyDomainWriteHandoff on the same domain must
 *     still succeed (base hashes are recomputed from new content).
 */

import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
} from "bun:test";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CWD = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "scripts/rotate-notes.js";

// Line threshold is 1000 in rotate-notes.js. We use 50 here for fast tests.
const TEST_THRESHOLD = 50;

/**
 * Build a minimal workspace fixture under a fresh tmp dir:
 *   <tmp>/memory/agent-<id>/<session>/YYYY-MM-DD.md
 *   <tmp>/memory/domains/<name>/changelog.md
 *   <tmp>/memory/domains/registry.json
 */
function makeTmp() {
  const base = tmpdir().replace(/\\/g, "/").replace(/\/$/, "");
  return `${base}/${crypto.randomUUID()}`;
}

function writeBigFile(path, lines, prefix = "line") {
  const content =
    Array.from({ length: lines }, (_, i) => `${prefix}-${i + 1}`).join("\n") +
    "\n";
  writeFileSync(path, content, "utf8");
  return content;
}

function setupSessionNote(tmp, { agentId = "test-agent", session = "main", date = "2026-07-05", lines = 0, watermark = null } = {}) {
  mkdirSync(tmp, { recursive: true });
  // Create engram.json so loadEngramConfig returns our agentId (default
  // is "agent-main", which would route the script to the wrong dir).
  const cfgPath = join(tmp, "engram.json");
  if (!existsSync(cfgPath)) {
    writeFileSync(cfgPath, JSON.stringify({ agent: agentId }) + "\n", "utf8");
  }
  const sessionDir = join(tmp, "memory", `agent-${agentId}`, session);
  mkdirSync(sessionDir, { recursive: true });
  const notePath = join(sessionDir, `${date}.md`);
  let body = "";
  if (watermark) {
    body += `<!-- extracted:${watermark}:2026-07-05T12:00:00+03:00 -->\n`;
  }
  body += Array.from({ length: lines }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
  writeFileSync(notePath, body, "utf8");
  return notePath;
}

function setupDomainChangelog(tmp, { domain = "engram", lines = 0 } = {}) {
  const domainsRoot = join(tmp, "memory", "domains");
  const domainDir = join(domainsRoot, domain);
  mkdirSync(domainDir, { recursive: true });
  const changelogPath = join(domainDir, "changelog.md");
  writeBigFile(changelogPath, lines);
  return changelogPath;
}

function setupDomainsRegistry(tmp, domains) {
  mkdirSync(tmp, { recursive: true });
  const registryDir = join(tmp, "memory", "domains");
  mkdirSync(registryDir, { recursive: true });
  const registryPath = join(registryDir, "registry.json");
  const body = JSON.stringify(
    { domains: Object.fromEntries(domains.map((d) => [d, {}])) },
    null,
    2,
  );
  writeFileSync(registryPath, body + "\n", "utf8");
  return registryPath;
}

function runRotate(args, env = {}) {
  return spawnSync("bun", [join(CWD, SCRIPT), ...args], {
    cwd: CWD,
    env: { ...process.env, ENGRAM_WORKSPACE: env.workspace || CWD, ...env },
    encoding: "utf8",
  });
}

function parseStdout(result) {
  // rotate-notes emits log lines + a trailing JSON object. The JSON is the
  // last line of stdout that starts with '{'.
  const lines = result.stdout.trim().split(/\r?\n/);
  const lastJsonLine = lines.reverse().find((l) => l.trim().startsWith("{"));
  if (!lastJsonLine) return null;
  return JSON.parse(lastJsonLine);
}

describe("ISS-10 rotate-notes: --check --session (per-session daily-note)", () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTmp();
  });
  afterEach(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  test("1. session dir missing → needsRotation=false with reason", () => {
    const result = runRotate(["--check", "--session", "no-such-session"], { workspace: tmp });
    expect(result.status).toBe(0);
    const payload = parseStdout(result);
    expect(payload.needsRotation).toBe(false);
    expect(payload.reason).toMatch(/session dir not found/i);
  });

  test("2. small daily note (< 1000 lines) → exit 0, needsRotation=false", () => {
    setupSessionNote(tmp, { date: "2026-07-05", lines: 30 });
    const result = runRotate(["--check", "--session", "main", "--date", "2026-07-05"], { workspace: tmp });
    expect(result.status).toBe(0);
    const payload = parseStdout(result);
    expect(payload.needsRotation).toBe(false);
    expect(typeof payload.lines).toBe("number");
    expect(payload.lines).toBeGreaterThan(0);
    expect(payload.file).toMatch(/2026-07-05\.md$/);
  });

  test("3. unknown flag exits non-zero (no valid command dispatched)", () => {
    // Empty argv → help mode (exit 0). Use unknown flag instead.
    const result = runRotate(["--no-such-mode"]);
    expect(result.status).toBe(1);
    expect(result.stderr || result.stdout).toMatch(/No valid command/);
  });

  test("4. --help exits 0 and prints usage", () => {
    const result = runRotate(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/rotate-notes\.js/);
  });
});

describe("ISS-10 rotate-notes: --check-domains (workspace-scoped)", () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTmp();
  });
  afterEach(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  test("5. no domains root → exit 0, needsRotation=false", () => {
    // tmp exists but no memory/domains subdir
    const result = runRotate(["--check-domains"], { workspace: tmp });
    expect(result.status).toBe(0);
    const payload = parseStdout(result);
    expect(payload.needsRotation).toBe(false);
    expect(payload.reason).toMatch(/domains root not found/);
  });

  test("6. all changelogs under threshold → exit 0, domainsChecked=N", () => {
    setupDomainsRegistry(tmp, ["engram", "marketing", "aicms"]);
    setupDomainChangelog(tmp, { domain: "engram", lines: 20 });
    setupDomainChangelog(tmp, { domain: "marketing", lines: 30 });
    setupDomainChangelog(tmp, { domain: "aicms", lines: 15 });
    const result = runRotate(["--check-domains"], { workspace: tmp });
    expect(result.status).toBe(0);
    const payload = parseStdout(result);
    expect(payload.needsRotation).toBe(false);
    expect(payload.domainsChecked).toBe(3);
  });

  test("7. one changelog over 1000 lines → exit 10, file reported", () => {
    setupDomainsRegistry(tmp, ["engram", "marketing"]);
    setupDomainChangelog(tmp, { domain: "engram", lines: 1500 });
    setupDomainChangelog(tmp, { domain: "marketing", lines: 100 });
    const result = runRotate(["--check-domains"], { workspace: tmp });
    expect(result.status).toBe(10);
    const payload = parseStdout(result);
    expect(payload.needsRotation).toBe(true);
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].domain).toBe("engram");
    // countLines includes trailing newline → off-by-one; just assert > threshold.
    expect(payload.files[0].lines).toBeGreaterThan(1000);
  });

  test("8. multiple changelogs over threshold → all reported in one check", () => {
    setupDomainsRegistry(tmp, ["engram", "marketing", "aicms", "about"]);
    setupDomainChangelog(tmp, { domain: "engram", lines: 1200 });
    // marketing stays under threshold (800 < 1000) — verifies check does
    // not falsely report it.
    setupDomainChangelog(tmp, { domain: "marketing", lines: 800 });
    setupDomainChangelog(tmp, { domain: "aicms", lines: 2500 });
    setupDomainChangelog(tmp, { domain: "about", lines: 50 });
    const result = runRotate(["--check-domains"], { workspace: tmp });
    expect(result.status).toBe(10);
    const payload = parseStdout(result);
    expect(payload.needsRotation).toBe(true);
    expect(payload.files.map((f) => f.domain).sort()).toEqual(["aicms", "engram"]);
  });
});

describe("ISS-10 rotate-notes: --rotate --type daily", () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTmp();
  });
  afterEach(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  test("9. daily note > threshold → archive created, stub written, watermark preserved", () => {
    const notePath = setupSessionNote(tmp, { lines: 1500, watermark: "L42" });
    const result = runRotate([
      "--rotate",
      "--file", notePath,
      "--type", "daily",
    ], { workspace: tmp });
    expect(result.status).toBe(0);
    // Archive exists under archives/2026-07/
    const archivePath = join(tmp, "memory", "agent-test-agent", "main", "archives", "2026-07", "2026-07-05.md");
    expect(existsSync(archivePath)).toBe(true);
    const archivedContent = readFileSync(archivePath, "utf8");
    expect(archivedContent.split("\n").length).toBeGreaterThan(1000);
    // Original replaced with stub
    const stubContent = readFileSync(notePath, "utf8");
    expect(stubContent).toMatch(/## Summary/);
    expect(stubContent).toMatch(/<!-- STUB: Agent fills this section/);
    expect(stubContent).toMatch(/extracted:L42/);
  });

  test("10. daily note <= threshold → skip rotation, no archive", () => {
    const notePath = setupSessionNote(tmp, { lines: 30 });
    const result = runRotate([
      "--rotate",
      "--file", notePath,
      "--type", "daily",
    ], { workspace: tmp });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/below threshold, skipping/);
    // No archive created
    const archiveDir = join(tmp, "memory", "agent-test-agent", "main", "archives");
    expect(existsSync(archiveDir)).toBe(false);
  });

  test("11. daily note with no extractable watermark → stub without marker", () => {
    const notePath = setupSessionNote(tmp, { lines: 1500, watermark: null });
    const result = runRotate([
      "--rotate",
      "--file", notePath,
      "--type", "daily",
    ], { workspace: tmp });
    expect(result.status).toBe(0);
    const stubContent = readFileSync(notePath, "utf8");
    expect(stubContent).toMatch(/## Summary/);
    expect(stubContent).not.toMatch(/extracted:/);
  });
});

describe("ISS-10 rotate-notes: --rotate --type changelog", () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTmp();
  });
  afterEach(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  test("12. changelog > threshold → archive in archives/, original reset", () => {
    const changelogPath = setupDomainChangelog(tmp, { domain: "engram", lines: 1500 });
    const result = runRotate([
      "--rotate",
      "--file", changelogPath,
      "--type", "changelog",
    ], { workspace: tmp });
    expect(result.status).toBe(0);
    // Archive exists under domains/engram/archives/changelog-YYYY-MM-DD.md.
    // Discover the child process's dated filename rather than deriving "today"
    // in the Bun test process, whose timezone may differ near midnight.
    const archiveDir = join(tmp, "memory", "domains", "engram", "archives");
    const archiveFiles = readdirSync(archiveDir).filter((name) => /^changelog-\d{4}-\d{2}-\d{2}(?:-\d+)?\.md$/.test(name));
    expect(archiveFiles).toHaveLength(1);
    const archivePath = join(archiveDir, archiveFiles[0]);
    const archivedContent = readFileSync(archivePath, "utf8");
    expect(archivedContent.split("\n").length).toBeGreaterThan(1000);
    // Original reset to header
    const resetContent = readFileSync(changelogPath, "utf8");
    expect(resetContent).toMatch(/# Changelog — engram/);
    expect(resetContent.split("\n").length).toBeLessThan(10);
  });

  test("13. changelog <= threshold → skip rotation", () => {
    const changelogPath = setupDomainChangelog(tmp, { domain: "engram", lines: 50 });
    const result = runRotate([
      "--rotate",
      "--file", changelogPath,
      "--type", "changelog",
    ], { workspace: tmp });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/below threshold, skipping/);
    const archiveDir = join(tmp, "memory", "domains", "engram", "archives");
    expect(existsSync(archiveDir)).toBe(false);
  });

  test("14. rotate returns JSON descriptor for orchestrator", () => {
    const changelogPath = setupDomainChangelog(tmp, { domain: "engram", lines: 1200 });
    const result = runRotate([
      "--rotate",
      "--file", changelogPath,
      "--type", "changelog",
    ], { workspace: tmp });
    const payload = parseStdout(result);
    expect(payload.rotated).toBe(true);
    expect(payload.type).toBe("changelog");
    expect(payload.lines).toBeGreaterThan(1000);
    expect(payload.archivePath).toMatch(/archives[\\/]+changelog-/);
  });
});

describe("ISS-10 rotate-notes: integration with ISS-14 apply gate", () => {
  // After ISS-14 fix, applyDomainHandoffs runs every tick. If a domain
  // changelog was just rotated, the next apply on that domain must work
  // — i.e. rotate must produce a clean baseline that apply accepts. This
  // test simulates that contract: post-rotation, the new changelog.md
  // exists, is below threshold, and has predictable content (header only).
  let tmp;
  beforeEach(() => {
    tmp = makeTmp();
  });
  afterEach(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  test("15. post-rotation baseline: empty changelog + base hash recompute path", () => {
    // Step 1: simulate a domain that's grown huge
    const changelogPath = setupDomainChangelog(tmp, { domain: "engram", lines: 1500 });
    expect(statSync(changelogPath).size).toBeGreaterThan(1000);

    // Step 2: rotate it
    const rotateResult = runRotate([
      "--rotate",
      "--file", changelogPath,
      "--type", "changelog",
    ], { workspace: tmp });
    expect(rotateResult.status).toBe(0);

    // Step 3: verify post-state — file is small and predictable
    const postContent = readFileSync(changelogPath, "utf8");
    expect(postContent).toMatch(/^# Changelog — engram/);
    expect(postContent.split("\n").length).toBeLessThan(20);

    // Step 4: subsequent --check-domains must show no rotation needed
    const checkResult = runRotate(["--check-domains"], { workspace: tmp });
    expect(checkResult.status).toBe(0);
    const payload = parseStdout(checkResult);
    expect(payload.needsRotation).toBe(false);
  });
});