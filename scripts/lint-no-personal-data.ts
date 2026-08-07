#!/usr/bin/env bun
/**
 * lint-no-personal-data.ts
 *
 * Pre-commit / commit-msg guard that scans staged files (and, when invoked
 * with --text-file, the commit message itself) for accidental leaks of
 * personal or workspace-identifying data into the public engram repo.
 *
 * What is flagged:
 *   1. Filesystem paths that contain the local OS username (Windows + Unix)
 *   2. Deployment identifiers supplied via `ENGRAM_LINT_IDENTIFIERS`
 *   3. Telegram chat ids in the supergroup range: -100… (10-digit ids)
 *   4. Telegram user IDs in explicit user/peer fields and direct-session keys
 *   5. OpenClaw bot tokens (long base64 chunks)
 *   6. Workspace-specific FQDNs supplied via env
 *      `ENGRAM_LINT_HOSTS=host1.tld,host2.tld`.
 *
 * What is NOT flagged:
 *   - Empty / missing matches
 *   - Files inside scripts/ that are themselves personal-data helpers
 *     (none of those exist yet, but the allowlist is configurable below)
 *   - Comments or strings that quote the allowlist itself (we strip
 *     those lines before scanning, so this script's own matches do not
 *     self-trigger)
 *   - Identifiers and hosts not configured by the local deployment
 *
 * Usage:
 *   bun scripts/lint-no-personal-data.ts [path-to-file ...]
 *
 *   With no arguments, scans the git index (staged files) — the default
 *   mode for use as a pre-commit hook.
 *
 *   With one or more paths, scans those files instead.
 *
 *   With --text-file <path>, scans a single text file as a "message" and
 *   reports issues keyed to that file path. This is how the commit-msg
 *   hook invokes the linter.
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

// Hosts flagged by the workspace-host rule. Configure at runtime via
// the ENGRAM_LINT_HOSTS env var (comma-separated, e.g.
// `ENGRAM_LINT_HOSTS=foo.example.com,bar.io`).
const DEFAULT_WORKSPACE_HOSTS: string[] = [];

/** Build a regex matching any FQDN whose apex is one of the given hosts. */
export function workspaceHostRegex(): RegExp {
  const envHosts = (process.env.ENGRAM_LINT_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const hosts = [...DEFAULT_WORKSPACE_HOSTS, ...envHosts].map((h) =>
    h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  if (hosts.length === 0) {
    // Match nothing — a placeholder that never matches a real input.
    return /^\bNO_WORKSPACE_HOSTS_CONFIGURED\b$/gi;
  }
  // Match `(<sub>.)*<host>` with a word boundary on the right so we
  // don't accidentally match a longer, unrelated hostname. Word
  // boundary on the left is implicit in `\b(?:[a-z0-9-]+\.)*`.
  return new RegExp(`\\b(?:[a-z0-9-]+\\.)*(?:${hosts.join("|")})\\b`, "gi");
}

/** Build a Unicode-safe matcher for deployment-private names and slugs. */
export function deploymentIdentifierRegex(): RegExp {
  const identifiers = (process.env.ENGRAM_LINT_IDENTIFIERS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (identifiers.length === 0) return /^\bNO_DEPLOYMENT_IDENTIFIERS_CONFIGURED\b$/gi;
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${identifiers.join("|")})(?![\\p{L}\\p{N}_])`,
    "giu",
  );
}

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
  // 3. Deployment-private names and slugs. The public repository stores
  //    only the mechanism; each installation supplies its private list.
  {
    name: "deployment-identifier",
    re: deploymentIdentifierRegex(),
  },
  // 4. Telegram supergroup chat ids: -100 + 9 to 11 digits.
  {
    name: "telegram-supergroup-chat-id",
    re: /-100\d{9,11}\b/g,
  },
  // 5. Ordinary Telegram user ids when their context is explicit. A bare
  //    8-12 digit number is intentionally not flagged because timestamps,
  //    byte counts, and hashes commonly share that shape. 100000001 is the
  //    documented synthetic fixture used throughout this public repository.
  {
    name: "telegram-user-id",
    re: /(?:\b(?:telegram[_ -]?user[_ -]?id|user[_ -]?id|peer[_ -]?id)["']?\s*[:=]\s*["']?(?!100000001\b)[1-9]\d{7,11}\b|\btelegram-[a-z0-9._-]+-direct-(?!100000001\b)[1-9]\d{7,11}\b)/gi,
  },
  // 6. Telegram bot tokens in OpenClaw configs: 8+ digits ":" 35+ chars
  //    (best-effort; not a perfect bot token matcher, but it catches the
  //    canonical "id:hash" pattern from accounts.telegram.* in openclaw.json).
  {
    name: "telegram-bot-token",
    re: /\b\d{8,12}:[A-Za-z0-9_-]{35,}\b/g,
  },
  // 7. Workspace-specific FQDNs supplied by the local deployment.
  {
    name: "workspace-host",
    re: workspaceHostRegex(),
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
  // .githooks/ — the pre-commit/commit-msg wrappers, which may reference
  // the patterns by name when they re-invoke the linter.
  /\.githooks\//,
];

/** Strip this script's allowlist block before scanning a buffer. */
function stripAllowlistComments(src: string): string {
  // Drop any line that contains the literal token "ALLOWLIST", any of the
  // pattern names, or any of the workspace-host code tokens. The linter's
  // own source is short-circuited by the ALLOWLIST path check in `scanFile`.
  return src
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/ALLOWLIST|deployment-identifier|deploymentIdentifierRegex|ENGRAM_LINT_IDENTIFIERS|telegram-supergroup|telegram-user-id|telegram-bot-token|windows-user-path|unix-home-path|workspace-host|workspaceHostRegex|DEFAULT_WORKSPACE_HOSTS|ENGRAM_LINT_HOSTS/.test(
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
 * Run all configured patterns against a single text buffer and return
 * matching issues keyed to `sourceLabel`. This is the pure pattern-matcher
 * — no filesystem I/O. `scanFile` calls this internally; the commit-msg
 * hook calls it directly on the commit message text.
 *
 * Exported for unit testing.
 */
export function scanText(text: string, sourceLabel: string): LintIssue[] {
  const cleaned = stripAllowlistComments(text);
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
      out.push({ file: sourceLabel, line, column, pattern: name, snippet });
    }
  }
  return out;
}

/**
 * Scan a single file buffer and return all issues.
 * Exported for unit testing. Wraps `scanText` with an allowlist check on
 * the file path (so the linter's own source and the githooks wrappers
 * don't self-trigger).
 */
export function scanFile(filePath: string, src: string): LintIssue[] {
  // Allowlist check: short-circuit before any pattern matching.
  for (const allow of ALLOWLIST) {
    if (allow.test(filePath)) return [];
  }
  return scanText(src, filePath);
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
  let textFile: string | null = null;
  const fileArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--text-file" && i + 1 < args.length) {
      textFile = args[++i];
    } else {
      fileArgs.push(args[i]);
    }
  }
  if (textFile) {
    // Single-file "message" mode — used by the commit-msg hook to scan
    // the commit message text without indexing the whole repo.
    const src = readSafe(textFile);
    if (!src) {
      process.stdout.write(
        `lint-no-personal-data: ok (no content in ${textFile})\n`,
      );
      process.exit(0);
    }
    const issues = scanFile(textFile, src);
    if (issues.length === 0) {
      process.stdout.write(
        `lint-no-personal-data: ok (1 message file scanned: ${textFile})\n`,
      );
      process.exit(0);
    }
    process.stderr.write(
      `lint-no-personal-data: ${issues.length} issue(s) in ${textFile}:\n` +
        issues.map(formatIssue).join("\n") +
        "\n",
    );
    process.exit(1);
  }
  const { issues, scanned } = runScan(fileArgs);
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
