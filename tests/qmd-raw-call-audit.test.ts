import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

// This is intentional, temporary debt while legacy scripts are migrated to the
// CLI. Keep each entry at the raw execution line: additions are architecture
// changes and must be reviewed rather than silently becoming more debt.
const BASELINE_RAW_QMD_CALLS = [
  "scripts/_lib/workspace-watchdog.js:410:: runCommand(qmd, qmdCollectionListArgs(engram), workspace, 30000);",
  "scripts/_lib/workspace-watchdog.js:432:: runCommand(qmd, qmdCapabilitiesArgs(), workspace, 30000);",
  "scripts/add-domain.js:590:execSync(`${QMD} --help`, { stdio: 'pipe' });",
  "scripts/add-domain.js:601:execSync(`${QMD} collection add \"${join(WORKSPACE, 'memory', 'domains')}\" --name domains --mask \"**/*.md\"`, { stdio: 'pipe' });",
  "scripts/add-domain.js:610:execSync(`${QMD} collection add \"${join(WORKSPACE, 'memory', 'domains', domain)}\" --name \"domain-${domain}\" --mask \"**/*.md\"`, { stdio: 'pipe' });",
  "scripts/add-domain.js:623:execSync(`${QMD} collection add \"${entityPath}\" --name \"life-projects-${domain}\" --mask \"**/*.md\"`, { stdio: 'pipe' });",
  "scripts/add-domain.js:634:execSync(`${QMD} update`, { stdio: 'pipe' });",
  "scripts/add-session.js:96:execSync(`${QMD} collection add \"${sessionPath}\" --name ${collectionName} --mask \"**/*.md\"`, { stdio: 'pipe' });",
  "scripts/add-session.js:98:execSync(`${QMD} update`, { stdio: 'pipe' });",
  "scripts/init.js:159:execSync(`${QMD} --help`, { stdio: 'pipe' });",
  "scripts/init.js:651:execSync(`${QMD} collection show \"${collectionName}\"`, { stdio: 'pipe' });",
  "scripts/init.js:659:execSync(`${QMD} collection add \"${sessionPath}\" --name ${collectionName} --mask \"**/*.md\"`, { stdio: 'pipe' });",
  "scripts/init.js:1122:execSync(`${QMD} collection add \"${join(WORKSPACE, col.path)}\" --name ${col.name} --mask \"${col.mask}\"`, { stdio: 'pipe' });",
  "scripts/init.js:1132:execSync(`${QMD} update`, { stdio: 'inherit' });",
  "scripts/install-qmd.js:71:execSync(`${QMD_CMD} --help`, { stdio: 'pipe' });",
  "scripts/install-qmd.js:105:const version = execSync(`${QMD_CMD} --version`, { encoding: 'utf-8' }).trim();",
  "scripts/install-qmd.js:341:const version = execSync(`${QMD_CMD} --version`, { encoding: 'utf-8' }).trim();",
  "scripts/promote-domain.js:192:execSync(`${QMD} collection add \"${domainDir}\" --name \"domain-${domain}\" --mask \"**/*.md\"`, { stdio: 'pipe' });",
  "scripts/promote-domain.js:201:execSync(`${QMD} collection add \"${entityPath}\" --name \"life-projects-${domain}\" --mask \"**/*.md\"`, { stdio: 'pipe' });",
  "scripts/promote-domain.js:209:execSync(`${QMD} update`, { stdio: 'pipe' });",
].sort();

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
