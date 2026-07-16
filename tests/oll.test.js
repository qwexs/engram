import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, rmSync, mkdirSync, readFileSync, mkdtempSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { extractKeywords, jaccardSimilarity } from "../scripts/utils.js";

const SCRIPTS_DIR = join(import.meta.dir, "..", "scripts");

// Isolate every test in a fresh tmpdir so we never touch the real
// clawd workspace (workspace/ops/observations, life/items.json, ...).
// Each spawned CLI is invoked with ENGRAM_WORKSPACE pointing at the same
// tmp root so the script under test also stays inside the temp tree.
let WORKSPACE_ROOT;
let OBS_DIR;
let TENSION_DIR;
let LIFE_DIR;

function spawnObserve(args, envExtras = {}) {
  return Bun.spawn(["bun", join(SCRIPTS_DIR, "memory-observe.js"), ...args], {
    env: { ...process.env, ENGRAM_WORKSPACE: WORKSPACE_ROOT, ...envExtras },
    stderr: "pipe",
    stdout: "pipe",
  });
}

function spawnTension(args, envExtras = {}) {
  return Bun.spawn(["bun", join(SCRIPTS_DIR, "memory-tension.js"), ...args], {
    env: { ...process.env, ENGRAM_WORKSPACE: WORKSPACE_ROOT, ...envExtras },
    stderr: "pipe",
    stdout: "pipe",
  });
}

function cleanJsonFiles(dir) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".json") && f !== ".gitkeep") {
      rmSync(join(dir, f), { force: true });
    }
  }
}

describe("memory-observe.js - extractKeywords utility", () => {
  test("extracts keywords from text (word length > 3)", () => {
    const text = "This is a very interesting observation about the system workflow";
    const result = extractKeywords(text);
    expect(result).toContain("very");
    expect(result).toContain("interesting");
    expect(result).toContain("observation");
    expect(result.length).toBeGreaterThan(3);
  });

  test("filters out short words (length <= 3)", () => {
    const text = "The cat and dog ran fast";
    const result = extractKeywords(text);
    expect(result).toEqual(["fast"]);
  });

  test("handles unicode characters", () => {
    const text = "работает система наблюдения эффективно";
    const result = extractKeywords(text);
    expect(result).toEqual(["работает", "система", "наблюдения", "эффективно"]);
  });
});

describe("memory-observe.js - jaccardSimilarity utility", () => {
  test("returns 1 for identical sets", () => {
    const set1 = ["word", "test", "data"];
    const set2 = ["word", "test", "data"];
    expect(jaccardSimilarity(set1, set2)).toBe(1);
  });

  test("returns 0 for disjoint sets", () => {
    const set1 = ["aaa", "bbb", "ccc"];
    const set2 = ["ddd", "eee", "fff"];
    expect(jaccardSimilarity(set1, set2)).toBe(0);
  });

  test("returns partial similarity for overlapping sets", () => {
    const set1 = ["aaa", "bbb", "ccc", "ddd"];
    const set2 = ["bbb", "ccc", "eee", "fff"];
    const result = jaccardSimilarity(set1, set2);
    expect(result).toBeCloseTo(0.333, 2);
  });

  test("handles empty sets", () => {
    const set1 = [];
    const set2 = ["aaa", "bbb"];
    expect(jaccardSimilarity(set1, set2)).toBe(0);
  });
});

describe("memory-observe.js - CLI integration", () => {
  beforeEach(() => {
    // Fresh isolated workspace per test.
    WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "engram-oll-test-"));
    OBS_DIR = join(WORKSPACE_ROOT, "workspace", "ops", "observations");
    TENSION_DIR = join(WORKSPACE_ROOT, "workspace", "ops", "tensions");
    LIFE_DIR = join(WORKSPACE_ROOT, "life");
    mkdirSync(OBS_DIR, { recursive: true });
    mkdirSync(TENSION_DIR, { recursive: true });
    mkdirSync(LIFE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (WORKSPACE_ROOT && existsSync(WORKSPACE_ROOT)) {
      rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    }
  });

  test("requires --observation argument", async () => {
    const proc = spawnObserve([]);
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Требуется --observation");
  });

  test("validates category", async () => {
    const proc = spawnObserve([
      "--observation", "agent observed slow qmd query latency on 2026-07-17",
      "--category", "invalid_category",
    ]);
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Категория должна быть");
  });

  test("accepts valid categories", async () => {
    const proc = spawnObserve([
      "--observation", "agent observed slow qmd query latency on 2026-07-17",
      "--category", "friction",
    ]);
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    expect(result.status).toBe("created");
    expect(result.category).toBe("friction");
  });

  test("truncates long observation text to 500 chars", async () => {
    // Use a varied long string (no single-char-repeat) to avoid the hard-blocker.
    const longText = ("engram memory pipeline observed slow qmd query latency 2026-07-17 ").repeat(20);
    expect(longText.length).toBeGreaterThan(500);
    const proc = spawnObserve([
      "--observation", longText,
      "--category", "surprise",
    ]);
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    expect(result.status).toBe("created");
    // And the on-disk observation must be truncated to <= 500 chars.
    const obsPath = join(OBS_DIR, `${result.id}.json`);
    const obsData = JSON.parse(readFileSync(obsPath, "utf-8"));
    expect(obsData.observation.length).toBe(500);
  });

  test("detects duplicates with Jaccard > 0.7", async () => {
    const proc1 = spawnObserve([
      "--observation", "the system has a friction issue with the workflow",
      "--category", "friction",
    ]);
    await new Response(proc1.stdout).text();

    const proc2 = spawnObserve([
      "--observation", "the system has a friction issue with the workflow processes",
      "--category", "friction",
    ]);
    const stdout = await new Response(proc2.stdout).text();
    const result = JSON.parse(stdout);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("Duplicate observation");
    expect(result.similarity).toBeGreaterThan(0.7);
  });

  test("allows non-duplicate observations", async () => {
    await spawnObserve([
      "--observation", "the system has friction issues with workflow processes",
      "--category", "friction",
    ], { stdout: "pipe", stderr: "pipe" });

    const proc = spawnObserve([
      "--observation", "something completely different about surprise quality",
      "--category", "surprise",
    ]);
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    expect(result.status).toBe("created");
    expect(result.category).toBe("surprise");
  });

  test("--dry-run outputs JSON without writing", async () => {
    const proc = spawnObserve([
      "--observation", "dry run check on engram memory pipeline",
      "--category", "friction",
      "--dry-run",
    ]);
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    expect(result.status).toBe("dry-run");
    expect(result.id).toMatch(/^obs-\d{4}$/);
    expect(result.would_write).toBeDefined();
    // Файл не должен быть создан
    expect(existsSync(join(OBS_DIR, `${result.id}.json`))).toBe(false);
  });
});

describe("memory-tension.js - CLI integration", () => {
  beforeEach(() => {
    WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "engram-oll-test-"));
    OBS_DIR = join(WORKSPACE_ROOT, "workspace", "ops", "observations");
    TENSION_DIR = join(WORKSPACE_ROOT, "workspace", "ops", "tensions");
    LIFE_DIR = join(WORKSPACE_ROOT, "life");
    mkdirSync(OBS_DIR, { recursive: true });
    mkdirSync(TENSION_DIR, { recursive: true });
    mkdirSync(LIFE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (WORKSPACE_ROOT && existsSync(WORKSPACE_ROOT)) {
      rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    }
  });

  test("requires --tension argument", async () => {
    const proc = spawnTension([]);
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Требуется --tension");
  });

  test("requires both fact references", async () => {
    const proc = spawnTension([
      "--tension", "fresh tension between two engram facts",
    ]);
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Требуется --fact1 и --fact2");
  });
});

describe("OLL Integration - Observation Storage", () => {
  beforeEach(() => {
    WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "engram-oll-test-"));
    OBS_DIR = join(WORKSPACE_ROOT, "workspace", "ops", "observations");
    TENSION_DIR = join(WORKSPACE_ROOT, "workspace", "ops", "tensions");
    LIFE_DIR = join(WORKSPACE_ROOT, "life");
    mkdirSync(OBS_DIR, { recursive: true });
    mkdirSync(TENSION_DIR, { recursive: true });
    mkdirSync(LIFE_DIR, { recursive: true });
  });

  afterEach(() => {
    // Cleanup the entire temp workspace (includes any observations/tensions written).
    if (WORKSPACE_ROOT && existsSync(WORKSPACE_ROOT)) {
      rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    }
  });

  test("observation ID format is correct", async () => {
    const proc = spawnObserve([
      "--observation", "agent observed slow qmd query latency on 2026-07-17",
      "--category", "pattern",
    ]);

    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    expect(result.id).toMatch(/^obs-\d{4}$/);
  });

  test("observation stores description when provided", async () => {
    const proc = spawnObserve([
      "--observation", "agent observed slow qmd query latency on 2026-07-17",
      "--category", "friction",
      "--description", "my test description",
    ]);

    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);

    const obsPath = join(OBS_DIR, `${result.id}.json`);
    const obsData = JSON.parse(readFileSync(obsPath, "utf-8"));
    expect(obsData.description).toBe("my test description");
  });

  test("observation default category is friction", async () => {
    const proc = spawnObserve([
      "--observation", "agent observed slow qmd query latency on 2026-07-17 without category",
    ]);

    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);

    expect(result.category).toBe("friction");
  });

  test("observation createdAt is valid ISO timestamp", async () => {
    const proc = spawnObserve([
      "--observation", "agent observed slow qmd query latency on 2026-07-17",
      "--category", "surprise",
    ]);

    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);

    const obsPath = join(OBS_DIR, `${result.id}.json`);
    const obsData = JSON.parse(readFileSync(obsPath, "utf-8"));
    expect(new Date(obsData.createdAt).toISOString()).toBe(obsData.createdAt);
  });

  test("observation status is pending by default", async () => {
    const proc = spawnObserve([
      "--observation", "agent observed slow qmd query latency on 2026-07-17",
      "--category", "pattern",
    ]);

    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);

    const obsPath = join(OBS_DIR, `${result.id}.json`);
    const obsData = JSON.parse(readFileSync(obsPath, "utf-8"));
    expect(obsData.status).toBe("pending");
    expect(obsData.promotedAt).toBeNull();
    expect(obsData.archivedAt).toBeNull();
    expect(obsData.accessCount).toBe(0);
  });
});
