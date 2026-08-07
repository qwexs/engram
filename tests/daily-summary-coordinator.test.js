import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ENGRAM_DIR = join(import.meta.dir, "..");
const SCRIPT = join(ENGRAM_DIR, "scripts", "daily-summary-coordinator.js");
let root;

function workspace(name) {
  const dir = join(root, name);
  mkdirSync(join(dir, "life", "people", name), { recursive: true });
  writeFileSync(join(dir, "engram.json"), "{}\n");
  writeFileSync(join(dir, "life", "people", name, "items.json"), JSON.stringify({
    entityId: `people/${name}`,
    facts: [{
      id: `${name}-001`, fact: `${name} prefers concise summaries`, category: "preference",
      confidence: 1, abstractionLevel: "pattern", tags: [], timestamp: "2026-08-07",
      source: "2026-08-07", status: "active", supersededBy: null, relatedEntities: [],
      lastAccessed: "2026-08-07", accessCount: 1,
    }],
  }, null, 2));
  return dir;
}

afterEach(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("daily-summary-coordinator", () => {
  test("rebuilds explicit workspaces sequentially", () => {
    root = mkdtempSync(join(tmpdir(), "engram-summary-coordinator-"));
    const first = workspace("first");
    const second = workspace("second");
    const proc = Bun.spawnSync(["bun", SCRIPT, "--workspace", first, "--workspace", second, "--json"], {
      cwd: ENGRAM_DIR,
      env: { ...process.env, ENGRAM_TZ: "Europe/Moscow" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString();
    expect(proc.exitCode, proc.stderr.toString() || stdout).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.sequential).toBe(true);
    expect(report.errors).toBe(0);
    expect(report.workspaces.map((item) => item.workspace)).toEqual([first, second]);
    expect(readFileSync(join(first, "life", "people", "first", "summary.md"), "utf8")).toContain("first prefers concise summaries");
    expect(readFileSync(join(second, "life", "people", "second", "summary.md"), "utf8")).toContain("second prefers concise summaries");
  });
});
