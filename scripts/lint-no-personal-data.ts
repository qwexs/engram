#!/usr/bin/env bun
/**
 * lint-no-personal-data.ts
 *
 * Pre-commit / pre-push guard that scans staged files for accidental leaks
 * of personal or workspace-identifying data into the public engram repo.
 *
 * What is flagged:
 *   1. Filesystem paths that contain the local OS username (Windows + Unix)
 *   2. Specific agentId values: medved, dobriy, apriori-tech, agent-medved,
 *      agent-dobriy, agent-apriori-tech
 *   3. Telegram chat ids in the supergroup range: -100… (10-digit ids)
 *   4. (optional, enabled by --strict) OpenClaw bot tokens (long base64 chunks)
 *
 * What is NOT flagged:
 *   - Empty / missing matches
 *   - Files inside scripts/ that are themselves personal-data helpers
 *     (none of those exist yet, but the allowlist is configurable below)
 *   - Comments or strings that quote the allowlist itself (we strip
 *     those lines before scanning, so this script's own matches do not
 *     self-trigger)
 *
 * Usage:
 *   bun scripts/lint-no-personal-data.ts [path-to-file ...]
 *
 *   With no arguments, scans the git index (staged files) — the default
 *   mode for use as a pre-commit hook.
 *
 *   With one or more paths, scans those files instead.
 *
 * Exit code:
 *   0 — clean
 *   1 — at least one leak found; offending files and line numbers are
 *       printed to stderr.
 *
 * Tests:
 *   bun test scripts/lint-no-personal-data.test.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Patterns that, if matched in a staged file, are treated as leaks.
 * Order is for stable error messages; the matcher is OR'd across all.
 */
const PATTERNS: { name: string; re: RegExp; allowPaths?: RegExp }[] = [
  // 1. Windows-style user paths: C:\Users\<name>\... or C:/Users/<name>/...
  //    Anchored to the drive letter; case-insensitive on the letter only.
  {
    name: "windows-user-path",
    re: /[A-Za-z]:[/\\]Users[/\\][A-Za-z0-9_.-]+/g,
  },
  // 2. Unix-style home paths: /home/<name>/ or /Users/<name>/ (macOS).
  //    Avoid matching "/home/..." in docs/comments that legitimately use it.
  {
    name: "unix-home-path",
    re: /(?<!\/engram)\/(?:home|Users)\/[A-Za-z0-9_.-]{2,}/g,
  },
  // 3. Reserved agent ids (workspace-agnostic identifiers that should
  //    never be hardcoded in tests, fixtures, or sample configs).
  {
    name: "reserved-agent-id",
    // Word boundary on both sides; matches "medved" but not "medvedeff".
    re: /\b(?:medved|dobriy|aporiotech|apriori|agent-medved|agent-dobriy|agent-apriori-tech|agent-apriori)\b/g,
  },
  // 4. Telegram supergroup chat ids: -100 + 9 to 11 digits.
  {
    name: "telegram-supergroup-chat-id",
    re: /-100\d{9,11}\b/g,
  },
  // 5. Telegram bot tokens in OpenClaw configs: 8+ digits ":" 35+ chars
  //    (best-effort; not a perfect bot token matcher, but it catches the
  //    canonical "id:hash" pattern from accounts.telegram.* in openclaw.json).
  {
    name: "telegram-bot-token",
    re: /\b\d{8,12}:[A-Za-z0-9_-]{35,}\b/g,
  },
];

/**
 * Files that, even if they match a pattern, are considered safe.
 * Use sparingly — better to fix the leak than to add an allowlist entry.
 */
const ALLOWLIST: RegExp[] = [
  // This script's own source — it has to contain the patterns it matches.
  /scripts\/lint-no-personal-data\.ts$/,
  // The corresponding test file.
  /scripts\/lint-no-personal-data\.test\.ts$/,
  // .githooks/ — the pre-commit wrapper, which may reference the patterns
  // by name when it re-invokes the linter.
  /\.githooks\//,
];

/** Strip this script's allowlist block before scanning a buffer. */
function stripAllowlistComments(src: string): string {
  // Drop any line that contains the literal token "ALLOWLIST" or the
  // pattern definitions themselves. Prevents the linter from matching
  // its own source.
  return src
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/ALLOWLIST|reserved-agent-id|telegram-supergroup|telegram-bot-token|windows-user-path|unix-home-path/.test(
          line,
        ),
    )
    .join("\n");
}

/** Return staged file paths (relative to repo root). Empty on error. */
function stagedFiles(): string[] {
  const r = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    encoding: "utf-8",
  });
  if (r.status !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Read a file as text, returning empty string on binary / missing. */
function readSafe(path: string): string {
  if (!existsSync(path)) return "";
  try {
    const buf = readFileSync(path);
    // Heuristic: if the first 8 KB contain a NUL byte, treat as binary.
    if (buf.subarray(0, Math.min(buf.length, 8192)).includes(0)) return "";
    return buf.toString("utf-8");
  } catch {
    return "";
  }
}

export interface LintIssue {
  file: string;
  line: number;
  column: number;
  pattern: string;
  snippet: string;
}

export interface LintResult {
  issues: LintIssue[];
  scanned: number;
}

/**
 * Scan a single file buffer and return all issues.
 * Exported for unit testing.
 */
export function scanFile(filePath: string, src: string): LintIssue[] {
  // Allowlist check: short-circuit before any pattern matching.
  for (const allow of ALLOWLIST) {
    if (allow.test(filePath)) return [];
  }
  const cleaned = stripAllowlistComments(src);
  const out: LintIssue[] = [];
  for (const { name, re } of PATTERNS) {
    // Re-create a fresh, non-stateful RegExp from the pattern source.
    // Using `re.exec` on a global regex with shared `lastIndex` is a
    // common source of subtle bugs (e.g. infinite loops when a pattern
    // matches the empty string). matchAll is simpler and safer.
    const fresh = new RegExp(re.source, re.flags);
    for (const m of cleaned.matchAll(fresh)) {
      if (m.index === undefined) continue;
      const upto = cleaned.slice(0, m.index);
      const line = upto.split(/\r?\n/).length;
      const lastNl = upto.lastIndexOf("\n");
      const column = m.index - (lastNl + 1) + 1;
      const snippet = m[0].slice(0, 80);
      out.push({ file: filePath, line, column, pattern: name, snippet });
    }
  }
  return out;
}

/** Scan the given files (or the git index if none) and report. */
export function runScan(files?: string[]): LintResult {
  const targets = files && files.length > 0 ? files : stagedFiles();
  const issues: LintIssue[] = [];
  for (const rel of targets) {
    const src = readSafe(rel);
    if (!src) continue;
    issues.push(...scanFile(rel, src));
  }
  return { issues, scanned: targets.length };
}

function formatIssue(i: LintIssue): string {
  return `  ${i.file}:${i.line}:${i.column}  [${i.pattern}]  ${i.snippet}`;
}

// CLI entry. Skipped when imported as a module.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const files = args;
  const { issues, scanned } = runScan(files);
  if (issues.length === 0) {
    process.stdout.write(`lint-no-personal-data: ok (${scanned} file(s) scanned)\n`);
    process.exit(0);
  }
  process.stderr.write(
    `lint-no-personal-data: ${issues.length} issue(s) in ${scanned} file(s):\n` +
      issues.map(formatIssue).join("\n") +
      "\n",
  );
  process.exit(1);
}
