import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

// Raw QMD subprocesses are forbidden outside the typed core. Keep this list
// empty; any new script-level invocation is an architecture regression.
const BASELINE_RAW_QMD_CALLS: string[] = [];

const RAW_QMD_EXECUTION = [
  /(?:\b\w+\.)?execSync\(\s*(?:["'`]qmd(?:\s|["'`])|`[^`]*\$\{QMD(?:_CMD)?\})/,
  /\bBun\.spawn\(\s*(?:qmdArgs|\[\s*QMD\b|\[\s*\.\.\.qmdPrefix\b|\[\s*["']qmd(?:\.cmd)?["'])/,
  /\brunCommand\(\s*qmd\s*,/,
  /\bspawnSync\(\s*command\s*,\s*\["--index",\s*String\(qmd\.index\),\s*"collection"/,
];

function walk(directory: string, root: string, calls: string[]) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path, root, calls);
      continue;
    }
    if (!/\.(?:js|ts)$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
    for (const [index, line] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
      if (RAW_QMD_EXECUTION.some((pattern) => pattern.test(line))) {
        calls.push(`${relative(root, path)}:${index + 1}:${line.trim()}`);
      }
    }
  }
}

export function collectRawQmdCalls(root = ROOT) {
  const calls: string[] = [];
  for (const directory of ["scripts", "hooks"]) walk(join(root, directory), root, calls);
  return calls.sort();
}

export function assertRawQmdDebtIsFrozen(root = ROOT) {
  expect(collectRawQmdCalls(root)).toEqual(BASELINE_RAW_QMD_CALLS);
}

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("raw QMD architecture boundary", () => {
  test("keeps the explicitly reviewed legacy raw-call debt frozen", () => {
    assertRawQmdDebtIsFrozen();
  });

  test("a newly introduced raw QMD invocation breaks the audit", () => {
    const fixture = mkdtempSync(join(tmpdir(), "engram-raw-qmd-audit-"));
    temporaryDirectories.push(fixture);
    cpSync(join(ROOT, "scripts"), join(fixture, "scripts"), { recursive: true });
    cpSync(join(ROOT, "hooks"), join(fixture, "hooks"), { recursive: true });
    writeFileSync(join(fixture, "scripts", "new-raw-qmd.js"), "execSync(\"qmd query unsafe\");\n");

    expect(() => assertRawQmdDebtIsFrozen(fixture)).toThrow();
  });
});
