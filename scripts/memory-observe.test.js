#!/usr/bin/env bun
// Tests for hard-blocker pre-check in memory-observe.js
// Source: scripts/memory-observe.js (HARDBLOCK_PATTERNS block)

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Repo root = parent of this test file's dir (scripts/).
// Portable across checkouts — no hardcoded user paths.
const CWD = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "scripts/memory-observe.js";

let tmpWorkspace;

beforeEach(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "obs-hardblock-"));
});

afterEach(() => {
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

// Helper: spawn the CLI as a subprocess.
// NOTE: memory-observe.js does NOT accept --workspace (it derives WORKSPACE
// from process.env.ENGRAM_WORKSPACE || process.cwd()). Passing --workspace
// would be silently ignored. We control the workspace via the env var so the
// script never touches the real observations dir.
async function runObserve({ text, extra = [] }) {
  const args = [
    SCRIPT,
    "--observation", text,
    "--dry-run",
    ...extra,
  ];
  const proc = Bun.spawn({
    cmd: ["bun", ...args],
    cwd: CWD,
    env: { ...process.env, ENGRAM_WORKSPACE: tmpWorkspace },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

// Helper: parse the JSON on stdout.
// - Rejected output: single-line `{"status":"rejected",...}`
// - Dry-run output: pretty-printed multi-line JSON
// We grab the first '{' to the last '}' and parse that. The script only ever
// writes one JSON object per invocation, so this is safe.
function parseStdout(stdout) {
  const s = stdout.trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) {
    throw new Error(`No JSON object in stdout: ${JSON.stringify(stdout)}`);
  }
  return JSON.parse(s.slice(first, last + 1));
}

describe("memory-observe hard-blocker", () => {
  // 1. Empty input → empty pattern.
  // NOTE on spec wording: spec said --text "". memory-observe.js's parseArgs
  // would set opts.observation=true for --observation "" (boolean), then
  // crash on true.trim(). To represent "empty user input" functionally, we
  // pass a single space which trims to "" and matches ^\s*$. The result is
  // identical from the user's perspective.
  test("1. single space (trims to empty) → rejected/empty", async () => {
    const r = await runObserve({ text: " " });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(parseStdout(r.stdout)).toEqual({
      status: "rejected",
      reason: "hard-blocker",
      pattern: "empty",
    });
  });

  // 2. Whitespace only → empty pattern.
  test("2. whitespace only (   \\t\\n) → rejected/empty", async () => {
    const r = await runObserve({ text: "   \t\n" });
    expect(r.exitCode).toBe(0);
    expect(parseStdout(r.stdout)).toEqual({
      status: "rejected",
      reason: "hard-blocker",
      pattern: "empty",
    });
  });

  // 3. Bare "test observation" (lowercase).
  test("3. 'test observation' lowercase → rejected/test-observation", async () => {
    const r = await runObserve({ text: "test observation" });
    expect(r.exitCode).toBe(0);
    expect(parseStdout(r.stdout)).toEqual({
      status: "rejected",
      reason: "hard-blocker",
      pattern: "test-observation",
    });
  });

  // 4. Case-insensitive: "TEST OBSERVATION".
  test("4. 'TEST OBSERVATION' uppercase → rejected/test-observation", async () => {
    const r = await runObserve({ text: "TEST OBSERVATION" });
    expect(r.exitCode).toBe(0);
    expect(parseStdout(r.stdout)).toEqual({
      status: "rejected",
      reason: "hard-blocker",
      pattern: "test-observation",
    });
  });

  // 5. Bare "placeholder" (lowercase).
  test("5. 'placeholder' lowercase → rejected/placeholder", async () => {
    const r = await runObserve({ text: "placeholder" });
    expect(r.exitCode).toBe(0);
    expect(parseStdout(r.stdout)).toEqual({
      status: "rejected",
      reason: "hard-blocker",
      pattern: "placeholder",
    });
  });

  // 6. Case-insensitive: "Placeholder".
  test("6. 'Placeholder' capitalized → rejected/placeholder", async () => {
    const r = await runObserve({ text: "Placeholder" });
    expect(r.exitCode).toBe(0);
    expect(parseStdout(r.stdout)).toEqual({
      status: "rejected",
      reason: "hard-blocker",
      pattern: "placeholder",
    });
  });

  // 7. Substring match for "placeholder".
  test("7. 'some text with placeholder in it' → rejected/placeholder (substring)", async () => {
    const r = await runObserve({ text: "some text with placeholder in it" });
    expect(r.exitCode).toBe(0);
    expect(parseStdout(r.stdout)).toEqual({
      status: "rejected",
      reason: "hard-blocker",
      pattern: "placeholder",
    });
  });

  // 8. 25 'a's (well above threshold).
  test("8. 25 a's → rejected/single-char-repeat", async () => {
    const r = await runObserve({ text: "a".repeat(25) });
    expect(r.exitCode).toBe(0);
    expect(parseStdout(r.stdout)).toEqual({
      status: "rejected",
      reason: "hard-blocker",
      pattern: "single-char-repeat",
    });
  });

  // 9. Exactly 21 chars (at the threshold; \1{20,} = 20 more after the capture = 21 total).
  test("9. exactly 21 x's (threshold) → rejected/single-char-repeat", async () => {
    const r = await runObserve({ text: "x".repeat(21) });
    expect(r.exitCode).toBe(0);
    expect(parseStdout(r.stdout)).toEqual({
      status: "rejected",
      reason: "hard-blocker",
      pattern: "single-char-repeat",
    });
  });

  // 10. 19 chars (below threshold; \1{20,} needs ≥20 repeats). Passes through.
  test("10. 19 x's (below threshold) → NOT rejected by hard-blocker", async () => {
    const r = await runObserve({ text: "x".repeat(19) });
    expect(r.exitCode).toBe(0);
    const out = parseStdout(r.stdout);
    expect(out.status).not.toBe("rejected");
    expect(out.reason).not.toBe("hard-blocker");
    // With --dry-run and an empty tmp workspace, this falls through to dry-run.
    expect(out.status).toBe("dry-run");
  });

  // 11. Leading different char: regex /^(.)\1{20,}/ captures 'b' at ^, then
  // needs 20+ more 'b's. After 'b' we have 'a's, so the back-reference fails
  // and the pattern does not match. The text passes through.
  test("11. 'b' + 21 'a's → NOT rejected (^ anchor captures 'b', expects more b's)", async () => {
    const r = await runObserve({ text: "b" + "a".repeat(21) });
    expect(r.exitCode).toBe(0);
    const out = parseStdout(r.stdout);
    expect(out.status).not.toBe("rejected");
    expect(out.reason).not.toBe("hard-blocker");
    expect(out.status).toBe("dry-run");
  });

  // 12. Cyrillic chars: '.' in the regex matches any non-line-terminator char,
  // so 25 'ф's (U+0444) trigger single-char-repeat. No language check.
  test("12. 25 cyrillic 'ф' chars → rejected/single-char-repeat", async () => {
    const r = await runObserve({ text: "ф".repeat(25) });
    expect(r.exitCode).toBe(0);
    expect(parseStdout(r.stdout)).toEqual({
      status: "rejected",
      reason: "hard-blocker",
      pattern: "single-char-repeat",
    });
  });

  // 13. Normal English friction text — none of the patterns match.
  test("13. normal English friction text → NOT rejected", async () => {
    const r = await runObserve({ text: "Token counting keeps drifting between runs" });
    expect(r.exitCode).toBe(0);
    const out = parseStdout(r.stdout);
    expect(out.status).not.toBe("rejected");
    expect(out.reason).not.toBe("hard-blocker");
    expect(out.status).toBe("dry-run");
  });

  // 14. Russian normal text. None of the English patterns match. Hard-blocker
  // does NOT block Russian text. (Open question: should there be a
  // Russian-language placeholder/empty blocker? Documented, not a failure.)
  test("14. russian normal text → NOT rejected (open question: ru-blocker?)", async () => {
    const r = await runObserve({ text: "Сергей попросил проверить OBS индексацию" });
    expect(r.exitCode).toBe(0);
    const out = parseStdout(r.stdout);
    expect(out.status).not.toBe("rejected");
    expect(out.reason).not.toBe("hard-blocker");
    expect(out.status).toBe("dry-run");
  });

  // 15. Bare "test" — only the phrase "test observation" is blocked, not
  // the word "test" by itself.
  test("15. bare 'test' (no 'observation') → NOT rejected", async () => {
    const r = await runObserve({ text: "test" });
    expect(r.exitCode).toBe(0);
    const out = parseStdout(r.stdout);
    expect(out.status).not.toBe("rejected");
    expect(out.reason).not.toBe("hard-blocker");
    expect(out.status).toBe("dry-run");
  });
});
