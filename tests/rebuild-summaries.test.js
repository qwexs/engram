import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ENGRAM_DIR = join(import.meta.dir, "..");
const SCRIPT = join(ENGRAM_DIR, "scripts", "rebuild-summaries.js");

let root;

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function fact(overrides) {
  return {
    id: "fact-001",
    fact: "Durable memory fact",
    category: "context",
    confidence: 0.8,
    abstractionLevel: "episode",
    tags: [],
    timestamp: "2026-05-22",
    source: "2026-05-22",
    status: "active",
    supersededBy: null,
    relatedEntities: [],
    lastAccessed: "2026-05-22",
    accessCount: 1,
    ...overrides,
  };
}

function runRebuild(extraArgs = []) {
  const proc = Bun.spawnSync([
    "bun",
    SCRIPT,
    "--apply-decay",
    "--json",
    ...extraArgs,
  ], {
    cwd: ENGRAM_DIR,
    env: { ...process.env, ENGRAM_WORKSPACE: root, ENGRAM_TZ: "Europe/Moscow" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  expect(proc.exitCode, stderr || stdout).toBe(0);
  return JSON.parse(stdout);
}

describe("rebuild-summaries semantic priority", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "engram-rebuild-"));
    mkdirSync(join(root, "life"), { recursive: true });
  });

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test("omits operational hot facts but keeps durable decisions", () => {
    writeJson(join(root, "life", "projects", "engram", "items.json"), {
      entityId: "projects/engram",
      entityType: "project",
      facts: [
        fact({
          id: "engram-001",
          fact: "Manually ran weekly synthesis via rebuild-summaries --apply-decay --json: 110 scanned, 0 errors, 11 hot, 1005 coldExcluded.",
          category: "milestone",
          tags: ["heartbeat", "extraction", "daily"],
        }),
        fact({
          id: "engram-002",
          fact: "Engram extraction quality gates reject assistant status text and tool log noise before writing session facts.",
          category: "decision",
          abstractionLevel: "pattern",
          tags: ["heartbeat", "quality"],
        }),
        fact({
          id: "engram-003",
          fact: "Knowledge Graph facts are never deleted; corrections supersede prior facts.",
          category: "decision",
          abstractionLevel: "principle",
          source: "2020-01-01",
          timestamp: "2020-01-01",
          lastAccessed: "2020-01-01",
        }),
      ],
    });

    const stats = runRebuild();
    const summary = readFileSync(join(root, "life", "projects", "engram", "summary.md"), "utf8");

    expect(summary).not.toContain("Manually ran weekly synthesis");
    expect(summary).toContain("quality gates reject assistant status text");
    expect(summary).toContain("facts are never deleted");
    expect(stats.omittedOperational).toBeGreaterThanOrEqual(1);
    expect(stats.includedByPriority).toBeGreaterThanOrEqual(1);
  });

  test("replaces test artifact entity summaries with a tombstone", () => {
    writeJson(join(root, "life", "people", "test-cli", "items.json"), {
      entityId: "people/test-cli",
      entityType: "person",
      facts: [
        fact({
          id: "test-cli-001",
          fact: "CLI integration fact test",
          category: "context",
          tags: ["test"],
        }),
      ],
    });

    const stats = runRebuild();
    const summary = readFileSync(join(root, "life", "people", "test-cli", "summary.md"), "utf8");

    expect(summary).toContain("Excluded from weekly synthesis");
    expect(summary).not.toContain("## Current (Hot)");
    expect(stats.omittedTestArtifacts).toBe(1);
  });

  test("replaces a stale summary when decay excludes every active fact", () => {
    const entityDir = join(root, "life", "clients", "ivanych");
    writeJson(join(entityDir, "items.json"), {
      entityId: "clients/ivanych",
      entityType: "area",
      facts: [fact({
        id: "ivanych-001",
        fact: "Cold client context that must not remain in the summary",
        abstractionLevel: "pattern",
        timestamp: "2020-01-01",
        source: "2020-01-01",
        lastAccessed: "2020-01-01",
      })],
    });
    writeFileSync(join(entityDir, "summary.md"), "# Ivanych\n\n## Background (Warm)\n\n- Stale fact\n");

    const stats = runRebuild();
    const summary = readFileSync(join(entityDir, "summary.md"), "utf8");

    expect(summary).toContain("No facts are currently included in this summary projection");
    expect(summary).toContain("1 active facts, 0 included in summary");
    expect(summary).toContain("1 cold excluded");
    expect(summary).not.toContain("Stale fact");
    expect(stats.updated).toBe(1);
    expect(stats.coldExcluded).toBe(1);
  });

  test("limits cold principles in summary while keeping the highest priority facts", () => {
    const facts = [];
    for (let i = 1; i <= 15; i++) {
      facts.push(fact({
        id: `engram-${String(i).padStart(3, "0")}`,
        fact: `Cold principle ${i}`,
        category: "context",
        confidence: i === 15 ? 1 : 0.8,
        abstractionLevel: "principle",
        timestamp: "2020-01-01",
        source: "2020-01-01",
        lastAccessed: "2020-01-01",
        accessCount: i === 15 ? 5 : 1,
      }));
    }
    writeJson(join(root, "life", "projects", "engram", "items.json"), {
      entityId: "projects/engram",
      entityType: "project",
      facts,
    });

    const stats = runRebuild(["--max-cold-principles", "5"]);
    const summary = readFileSync(join(root, "life", "projects", "engram", "summary.md"), "utf8");
    const includedPrinciples = (summary.match(/Cold principle/g) || []).length;

    expect(includedPrinciples).toBe(5);
    expect(summary).toContain("Cold principle 15");
    expect(summary).toContain("10 lower-priority principles omitted from summary");
    expect(stats.includedByPriority).toBe(5);
    expect(stats.limitedPrinciples).toBe(10);
  });
});
