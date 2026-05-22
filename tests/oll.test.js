import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { extractKeywords, jaccardSimilarity } from "../scripts/utils.js";

const SCRIPTS_DIR = join(import.meta.dir, "..", "scripts");

// Workspace root — на 3 уровня выше tests/
const WORKSPACE_ROOT = join(import.meta.dir, "..", "..", "..");

// Новые пути: workspace/ops/ (не в submodule)
const OBS_DIR = join(WORKSPACE_ROOT, "workspace", "ops", "observations");
const TENSION_DIR = join(WORKSPACE_ROOT, "workspace", "ops", "tensions");

// KG: жизнь в корне workspace
const LIFE_DIR = join(WORKSPACE_ROOT, "life");

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
    // Очищаем весь индекс и все файлы наблюдений перед каждым тестом
    if (!existsSync(OBS_DIR)) return;
    const { readdirSync } = require("fs");
    for (const f of readdirSync(OBS_DIR)) {
      if (f.endsWith(".json")) rmSync(join(OBS_DIR, f), { force: true });
    }
  });

  test("requires --observation argument", async () => {
    const proc = Bun.spawn(["bun", join(SCRIPTS_DIR, "memory-observe.js")], {
      stderr: "pipe",
      stdout: "pipe"
    });
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Требуется --observation");
  });

  test("validates category", async () => {
    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-observe.js"),
      "--observation", "test observation",
      "--category", "invalid_category"
    ], {
      stderr: "pipe",
      stdout: "pipe"
    });
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Категория должна быть");
  });

  test("accepts valid categories", async () => {
    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-observe.js"),
      "--observation", "test observation text here",
      "--category", "friction"
    ], {
      stderr: "pipe",
      stdout: "pipe"
    });
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    expect(result.status).toBe("created");
    expect(result.category).toBe("friction");
  });

  test("truncates long observation text to 500 chars", async () => {
    const longText = "a".repeat(600);
    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-observe.js"),
      "--observation", longText,
      "--category", "surprise"
    ], {
      stderr: "pipe",
      stdout: "pipe"
    });
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    expect(result.status).toBe("created");
  });

  test("detects duplicates with Jaccard > 0.7", async () => {
    const proc1 = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-observe.js"),
      "--observation", "the system has a friction issue with the workflow",
      "--category", "friction"
    ], {
      stderr: "pipe",
      stdout: "pipe"
    });
    await new Response(proc1.stdout).text();

    const proc2 = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-observe.js"),
      "--observation", "the system has a friction issue with the workflow processes",
      "--category", "friction"
    ], {
      stderr: "pipe",
      stdout: "pipe"
    });
    const stdout = await new Response(proc2.stdout).text();
    const result = JSON.parse(stdout);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("Duplicate observation");
    expect(result.similarity).toBeGreaterThan(0.7);
  });

  test("allows non-duplicate observations", async () => {
    await Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-observe.js"),
      "--observation", "the system has friction issues with workflow processes",
      "--category", "friction"
    ], { stdout: "pipe", stderr: "pipe" });

    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-observe.js"),
      "--observation", "something completely different about surprise quality",
      "--category", "surprise"
    ], {
      stderr: "pipe",
      stdout: "pipe"
    });
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    expect(result.status).toBe("created");
    expect(result.category).toBe("surprise");
  });

  test("--dry-run outputs JSON without writing", async () => {
    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-observe.js"),
      "--observation", "dry run test observation text",
      "--category", "friction",
      "--dry-run"
    ], {
      stderr: "pipe",
      stdout: "pipe"
    });
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
    if (existsSync(join(TENSION_DIR, "index.json"))) {
      rmSync(join(TENSION_DIR, "index.json"));
    }
    if (existsSync(join(LIFE_DIR, "items.json"))) {
      rmSync(join(LIFE_DIR, "items.json"));
    }
  });

  afterEach(() => {
    if (existsSync(join(LIFE_DIR, "items.json"))) {
      rmSync(join(LIFE_DIR, "items.json"));
    }
  });

  test("requires --tension argument", async () => {
    const proc = Bun.spawn(["bun", join(SCRIPTS_DIR, "memory-tension.js")], {
      stderr: "pipe",
      stdout: "pipe"
    });
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Требуется --tension");
  });

  test("requires both fact references", async () => {
    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-tension.js"),
      "--tension", "test tension"
    ], {
      stderr: "pipe",
      stdout: "pipe"
    });
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Требуется --fact1 и --fact2");
  });
});

describe("OLL Integration - Observation Storage", () => {
  beforeEach(() => {
    const cleanup = (dir) => {
      if (!existsSync(dir)) return;
      const files = require("fs").readdirSync(dir);
      for (const f of files) {
        if (f.endsWith(".json") && f !== ".gitkeep") {
          rmSync(join(dir, f), { force: true });
        }
      }
    };
    cleanup(OBS_DIR);
    cleanup(TENSION_DIR);
    if (existsSync(join(LIFE_DIR, "items.json"))) {
      rmSync(join(LIFE_DIR, "items.json"));
    }
  });

  afterEach(() => {
    const cleanup = (dir) => {
      if (!existsSync(dir)) return;
      const files = require("fs").readdirSync(dir);
      for (const f of files) {
        if (f.endsWith(".json") && f !== ".gitkeep") {
          rmSync(join(dir, f), { force: true });
        }
      }
    };
    cleanup(OBS_DIR);
    cleanup(TENSION_DIR);
    if (existsSync(join(LIFE_DIR, "items.json"))) {
      rmSync(join(LIFE_DIR, "items.json"));
    }
  });

  test("observation ID format is correct", async () => {
    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-observe.js"),
      "--observation", "test observation",
      "--category", "pattern"
    ], { stdout: "pipe", stderr: "pipe" });
    
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    expect(result.id).toMatch(/^obs-\d{4}$/);
  });

  test("observation stores description when provided", async () => {
    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-observe.js"),
      "--observation", "test observation",
      "--category", "friction",
      "--description", "my test description"
    ], { stdout: "pipe", stderr: "pipe" });
    
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    
    const obsPath = join(OBS_DIR, `${result.id}.json`);
    const obsData = JSON.parse(readFileSync(obsPath, "utf-8"));
    expect(obsData.description).toBe("my test description");
  });

  test("observation default category is friction", async () => {
    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-observe.js"),
      "--observation", "test observation without category"
    ], { stdout: "pipe", stderr: "pipe" });
    
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    
    expect(result.category).toBe("friction");
  });

  test("observation createdAt is valid ISO timestamp", async () => {
    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-observe.js"),
      "--observation", "test observation",
      "--category", "surprise"
    ], { stdout: "pipe", stderr: "pipe" });
    
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    
    const obsPath = join(OBS_DIR, `${result.id}.json`);
    const obsData = JSON.parse(readFileSync(obsPath, "utf-8"));
    expect(new Date(obsData.createdAt).toISOString()).toBe(obsData.createdAt);
  });

  test("observation status is pending by default", async () => {
    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-observe.js"),
      "--observation", "test observation",
      "--category", "pattern"
    ], { stdout: "pipe", stderr: "pipe" });
    
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
