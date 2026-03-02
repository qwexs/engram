#!/usr/bin/env bun
/**
 * rotate-notes.js — Rotate large files (daily notes, changelogs) to archives
 *
 * Three-Layer Rotation for daily notes (>1000 lines):
 *   1. Archive — full file moved to archives/YYYY-MM/
 *   2. Stub — placeholder with link to archive (agent fills summary later)
 *   3. QMD — archive indexed for search
 *
 * Changelog rotation (>1000 lines):
 *   1. Archive — full file moved to archives/YYYY-MM-DD.md
 *   2. Reset — fresh changelog.md with header
 *
 * Usage:
 *   bun scripts/rotate-notes.js --check --session main [--date YYYY-MM-DD]
 *   bun scripts/rotate-notes.js --rotate --file <path> [--type daily|changelog]
 *   bun scripts/rotate-notes.js --check-domains --domains-root <path>
 *
 * Exit codes:
 *   0 — nothing to rotate (or rotation complete)
 *   10 — files need rotation (--check mode), details in stdout JSON
 */

import { join, dirname, basename } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "fs";
import { execSync } from "child_process";

const WORKSPACE = process.env.ENGRAM_WORKSPACE || join(import.meta.dir, "..", "..", "..");
const LINE_THRESHOLD = 1000;

// --- Arg parsing ---
const argv = process.argv.slice(2);
function getArg(name) {
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
  return null;
}
const hasFlag = (name) => argv.includes(`--${name}`);

// --- Helpers ---
function countLines(filePath) {
  if (!existsSync(filePath)) return 0;
  const content = readFileSync(filePath, "utf-8");
  return content.split("\n").length;
}

function getArchiveDir(filePath, type) {
  const dir = dirname(filePath);
  if (type === "changelog") {
    return join(dir, "archives");
  }
  // daily notes: archives/YYYY-MM/
  return join(dir, "archives");
}

function extractWatermarks(content) {
  const matches = [...content.matchAll(/<!--\s*extracted:(L\d+):([^>]*?)-->/g)];
  return matches.map(m => ({ watermark: m[1], timestamp: m[2].trim() }));
}

// ============================================================
// CHECK MODE — scan for files needing rotation
// ============================================================
function checkDailyNotes(session, date) {
  const sessionDir = join(WORKSPACE, "memory", "agent-main", session);
  if (!existsSync(sessionDir)) {
    console.log(JSON.stringify({ needsRotation: false, reason: "session dir not found" }));
    return false;
  }

  const targetDate = date ?? new Date().toLocaleDateString("sv-SE");
  const notePath = join(sessionDir, `${targetDate}.md`);
  const lines = countLines(notePath);

  if (lines > LINE_THRESHOLD) {
    console.log(JSON.stringify({
      needsRotation: true,
      file: notePath,
      lines,
      type: "daily",
      date: targetDate,
    }));
    return true;
  }

  console.log(JSON.stringify({ needsRotation: false, file: notePath, lines }));
  return false;
}

function checkDomains(domainsRoot) {
  const root = domainsRoot ?? join(WORKSPACE, "memory", "domains");
  if (!existsSync(root)) {
    console.log(JSON.stringify({ needsRotation: false, reason: "domains root not found" }));
    return false;
  }

  const registryPath = join(root, "registry.json");
  if (!existsSync(registryPath)) {
    console.log(JSON.stringify({ needsRotation: false, reason: "no registry.json" }));
    return false;
  }

  const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
  const domains = registry.domains ?? {};
  const results = [];

  for (const [name, config] of Object.entries(domains)) {
    const changelogPath = join(root, name, "changelog.md");
    const lines = countLines(changelogPath);
    if (lines > LINE_THRESHOLD) {
      results.push({ domain: name, file: changelogPath, lines, type: "changelog" });
    }
  }

  if (results.length > 0) {
    console.log(JSON.stringify({ needsRotation: true, files: results }));
    return true;
  }

  console.log(JSON.stringify({ needsRotation: false, domainsChecked: Object.keys(domains).length }));
  return false;
}

// ============================================================
// ROTATE MODE — actually perform rotation
// ============================================================
function rotateDailyNote(filePath) {
  if (!existsSync(filePath)) {
    console.error(`[rotate] File not found: ${filePath}`);
    process.exit(1);
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").length;

  if (lines <= LINE_THRESHOLD) {
    console.log(`[rotate] ${filePath} has ${lines} lines — below threshold, skipping`);
    return;
  }

  const dateMatch = basename(filePath).match(/(\d{4}-\d{2}-\d{2})\.md$/);
  if (!dateMatch) {
    console.error(`[rotate] Cannot extract date from filename: ${filePath}`);
    process.exit(1);
  }

  const fileDate = dateMatch[1];
  const yearMonth = fileDate.slice(0, 7); // YYYY-MM

  // 1. Create archive directory
  const archiveDir = join(dirname(filePath), "archives", yearMonth);
  mkdirSync(archiveDir, { recursive: true });

  // 2. Copy to archive (preserve original until stub is written)
  const archivePath = join(archiveDir, basename(filePath));
  copyFileSync(filePath, archivePath);

  // 3. Extract watermarks from the content (preserve last one)
  const watermarks = extractWatermarks(content);
  const lastWatermark = watermarks.length > 0 ? watermarks[watermarks.length - 1] : null;

  // 4. Write stub (agent will fill the summary later via HB-ROTATE)
  const stub = [
    `# ${fileDate}`,
    ``,
    `> **Archived**: ${lines} lines → \`archives/${yearMonth}/${basename(filePath)}\``,
    `> **Rotated at**: ${new Date().toISOString()}`,
    ``,
    `## Summary`,
    ``,
    `<!-- STUB: Agent fills this section with 10-20 line summary -->`,
    `<!-- Archive: archives/${yearMonth}/${basename(filePath)} -->`,
    ``,
    lastWatermark ? `<!-- extracted:${lastWatermark.watermark}:${lastWatermark.timestamp} -->` : ``,
  ].filter(Boolean).join("\n") + "\n";

  writeFileSync(filePath, stub, "utf-8");

  console.log(`[rotate] ✅ Daily note rotated:`);
  console.log(`  Archive: ${archivePath} (${lines} lines)`);
  console.log(`  Stub: ${filePath}`);
  if (lastWatermark) console.log(`  Watermark preserved: ${lastWatermark.watermark}`);

  // 5. Output JSON for the orchestrator
  console.log(JSON.stringify({
    rotated: true,
    type: "daily",
    archivePath,
    stubPath: filePath,
    lines,
    needsSummary: true, // Agent must fill the STUB section
  }));
}

function rotateChangelog(filePath) {
  if (!existsSync(filePath)) {
    console.error(`[rotate] File not found: ${filePath}`);
    process.exit(1);
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").length;

  if (lines <= LINE_THRESHOLD) {
    console.log(`[rotate] ${filePath} has ${lines} lines — below threshold, skipping`);
    return;
  }

  const today = new Date().toLocaleDateString("sv-SE");

  // 1. Create archive directory
  const archiveDir = join(dirname(filePath), "archives");
  mkdirSync(archiveDir, { recursive: true });

  // 2. Move to archive with date stamp
  const archiveName = `changelog-${today}.md`;
  const archivePath = join(archiveDir, archiveName);

  // Avoid overwriting if already rotated today
  if (existsSync(archivePath)) {
    const suffix = Date.now();
    const fallbackPath = join(archiveDir, `changelog-${today}-${suffix}.md`);
    copyFileSync(filePath, fallbackPath);
    console.log(`[rotate] Archive already exists, using: ${fallbackPath}`);
  } else {
    copyFileSync(filePath, archivePath);
  }

  // 3. Reset changelog with header
  const domainName = basename(dirname(filePath));
  const newContent = [
    `# Changelog — ${domainName}`,
    ``,
    `> Previous entries archived to \`archives/${archiveName}\` (${lines} lines)`,
    `> Rotated at: ${new Date().toISOString()}`,
    ``,
  ].join("\n");

  writeFileSync(filePath, newContent, "utf-8");

  console.log(`[rotate] ✅ Changelog rotated:`);
  console.log(`  Archive: ${archivePath} (${lines} lines)`);
  console.log(`  Reset: ${filePath}`);

  console.log(JSON.stringify({
    rotated: true,
    type: "changelog",
    archivePath,
    lines,
    needsSummary: false,
  }));
}

// ============================================================
// Dispatch
// ============================================================
if (hasFlag("help") || argv.length === 0) {
  console.log(`rotate-notes.js — Rotate large files to archives

Usage:
  --check --session <name> [--date YYYY-MM-DD]   Check if daily note needs rotation
  --check-domains [--domains-root <path>]         Check all domain changelogs
  --rotate --file <path> --type <daily|changelog> Perform rotation

Exit codes:
  0  — nothing to rotate / rotation done
  10 — files need rotation (--check mode)
  1  — error`);
  process.exit(0);
}

if (hasFlag("check") && !hasFlag("check-domains")) {
  const session = getArg("session") ?? "main";
  const date = getArg("date");
  const needs = checkDailyNotes(session, date);
  process.exit(needs ? 10 : 0);
}

if (hasFlag("check-domains")) {
  const domainsRoot = getArg("domains-root");
  const needs = checkDomains(domainsRoot);
  process.exit(needs ? 10 : 0);
}

if (hasFlag("rotate")) {
  const file = getArg("file");
  const type = getArg("type") ?? "daily";

  if (!file) {
    console.error("Missing --file");
    process.exit(1);
  }

  if (type === "daily") {
    rotateDailyNote(file);
  } else if (type === "changelog") {
    rotateChangelog(file);
  } else {
    console.error(`Unknown type: ${type}. Use 'daily' or 'changelog'.`);
    process.exit(1);
  }
  process.exit(0);
}

console.error("No valid command. Use --help.");
process.exit(1);
