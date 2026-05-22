import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, rmSync, mkdirSync, writeFileSync, mkdtempSync } from "fs";
import { extractKeywords, jaccardSimilarity } from "../scripts/utils.js";

const SCRIPTS_DIR = join(import.meta.dir, "..", "scripts");
const ENGRAM_DIR = join(import.meta.dir, "..");

function createTestWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "engram-memory-contradict-"));
  mkdirSync(join(workspace, "workspace", "memory-state"), { recursive: true });
  writeFileSync(join(workspace, "workspace", "memory-state", "fact-hashes.json"), "{}");
  return workspace;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Replicate the JSON-parsing logic from memory-write.js (semantic-check block).
 * Returns semanticWarnings array.
 */
function parseQmdSearchJson(jsonOutput, factText, threshold = 0.3) {
  function extractKw(text) {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .split(/\s+/)
      .filter(w => w.length > 3);
  }
  function jaccard(w1, w2) {
    const s1 = new Set(w1), s2 = new Set(w2);
    const inter = [...s1].filter(w => s2.has(w));
    const union = new Set([...s1, ...s2]);
    return union.size > 0 ? inter.length / union.size : 0;
  }

  const warnings = [];
  const newKeywords = extractKw(factText);
  let results = [];
  try {
    results = JSON.parse(jsonOutput);
  } catch {
    return warnings; // invalid JSON → empty
  }
  for (const r of results) {
    const textPart = (r.snippet || r.body || "").replace(/```[\s\S]*?```/g, "").trim();
    if (!textPart || textPart.length < 5) continue;
    const lineKeywords = extractKw(textPart);
    const sim = jaccard(newKeywords, lineKeywords);
    if (sim >= threshold) {
      warnings.push({
        similarText: textPart.slice(0, 200),
        similarity: parseFloat(sim.toFixed(2)),
        source: r.file || "unknown",
      });
    }
  }
  return warnings;
}

/**
 * Replicate the entity-path extraction logic from memory-contradict.js
 * (discoverEntitiesViaQmd — JSON branch).
 */
function extractEntityPathsFromJson(jsonOutput) {
  const entityPaths = new Set();
  let results = [];
  try {
    results = JSON.parse(jsonOutput);
  } catch {
    return [];
  }
  for (const r of results) {
    if (!r.file) continue;
    const match = r.file.match(
      /qmd:\/\/life\/((?:projects|areas|resources)\/[\w\-\/]+?)\/summary\.md/
    );
    if (match) entityPaths.add(match[1]);
  }
  return [...entityPaths];
}

// ─────────────────────────────────────────────────────────────
// Unit: memory-write.js — semantic-check JSON parsing
// ─────────────────────────────────────────────────────────────

describe("memory-write — semantic-check JSON parsing", () => {
  test("detects similar fact via snippet field", () => {
    const qmdJson = JSON.stringify([
      {
        file: "qmd://life/areas/people/sergey/summary.md",
        score: 0.85,
        snippet: "Sergey prefers TypeScript over JavaScript for all projects",
      },
    ]);
    const warnings = parseQmdSearchJson(qmdJson, "Sergey prefers TypeScript for new projects");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].similarity).toBeGreaterThanOrEqual(0.3);
    expect(warnings[0].source).toBe("qmd://life/areas/people/sergey/summary.md");
  });

  test("uses body field when snippet is absent", () => {
    const qmdJson = JSON.stringify([
      {
        file: "qmd://life/areas/people/sergey/summary.md",
        score: 0.7,
        // Use words that cleanly match after toLowerCase + remove punctuation
        body: "Prefers using TypeScript over JavaScript for backend projects always",
      },
    ]);
    const warnings = parseQmdSearchJson(qmdJson, "TypeScript preferred over JavaScript for backend");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].similarity).toBeGreaterThanOrEqual(0.3);
  });

  test("returns empty on invalid JSON (graceful fallback)", () => {
    const warnings = parseQmdSearchJson("not json at all", "some fact");
    expect(warnings).toEqual([]);
  });

  test("returns empty on empty JSON array", () => {
    const warnings = parseQmdSearchJson("[]", "some fact");
    expect(warnings).toEqual([]);
  });

  test("skips results with no snippet or body", () => {
    const qmdJson = JSON.stringify([
      { file: "qmd://life/areas/tools/qmd/summary.md", score: 0.9 },
    ]);
    const warnings = parseQmdSearchJson(qmdJson, "qmd reranking bug");
    expect(warnings).toEqual([]);
  });

  test("skips results with textPart shorter than 5 chars", () => {
    const qmdJson = JSON.stringify([
      { file: "qmd://life/areas/tools/qmd/summary.md", score: 0.9, snippet: "ok" },
    ]);
    const warnings = parseQmdSearchJson(qmdJson, "qmd reranking bug");
    expect(warnings).toEqual([]);
  });

  test("strips code blocks before Jaccard comparison", () => {
    const qmdJson = JSON.stringify([
      {
        file: "qmd://life/areas/tools/qmd/summary.md",
        score: 0.7,
        snippet: "```bash\nqmd search --json\n```",
      },
    ]);
    // After stripping the code block, textPart should be empty → no warning
    const warnings = parseQmdSearchJson(qmdJson, "qmd reranking");
    expect(warnings).toEqual([]);
  });

  test("does not match when Jaccard below threshold", () => {
    const qmdJson = JSON.stringify([
      {
        file: "qmd://life/projects/telemax/summary.md",
        score: 0.3,
        snippet: "Telemax uses RabbitMQ and PostgreSQL for messaging infrastructure",
      },
    ]);
    // Completely unrelated fact
    const warnings = parseQmdSearchJson(qmdJson, "Sergey prefers TypeScript");
    expect(warnings).toEqual([]);
  });

  test("truncates similarText to 200 chars", () => {
    const longText = "word ".repeat(100); // 500 chars
    const qmdJson = JSON.stringify([
      {
        file: "qmd://life/areas/people/sergey/summary.md",
        score: 0.9,
        snippet: `Sergey always uses TypeScript and ${longText}`,
      },
    ]);
    const warnings = parseQmdSearchJson(qmdJson, "Sergey TypeScript always prefers");
    if (warnings.length > 0) {
      expect(warnings[0].similarText.length).toBeLessThanOrEqual(200);
    }
  });

  test("source defaults to 'unknown' when file is absent", () => {
    const qmdJson = JSON.stringify([
      {
        score: 0.9,
        snippet: "Sergey prefers TypeScript for all backend projects",
      },
    ]);
    const warnings = parseQmdSearchJson(qmdJson, "Sergey TypeScript backend");
    if (warnings.length > 0) {
      expect(warnings[0].source).toBe("unknown");
    }
  });

  test("processes multiple results and returns all above threshold", () => {
    const qmdJson = JSON.stringify([
      {
        file: "qmd://life/areas/people/sergey/summary.md",
        score: 0.9,
        snippet: "Sergey uses Bun runtime for TypeScript projects",
      },
      {
        file: "qmd://life/projects/telemax/summary.md",
        score: 0.7,
        snippet: "Telemax project uses Bun and TypeScript with Hono framework",
      },
      {
        file: "qmd://life/projects/iboard/summary.md",
        score: 0.3,
        snippet: "iBoard React frontend uses TanStack Query",
      },
    ]);
    const warnings = parseQmdSearchJson(qmdJson, "Bun TypeScript project runtime");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    // All returned warnings must be above threshold
    for (const w of warnings) {
      expect(w.similarity).toBeGreaterThanOrEqual(0.3);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Unit: memory-contradict.js — entity path extraction from JSON
// ─────────────────────────────────────────────────────────────

describe("memory-contradict — entity path extraction from qmd JSON", () => {
  test("extracts entity path from slash-format file URL", () => {
    const qmdJson = JSON.stringify([
      { file: "qmd://life/areas/people/sergey/summary.md", score: 0.9 },
    ]);
    const paths = extractEntityPathsFromJson(qmdJson);
    expect(paths).toContain("areas/people/sergey");
  });

  test("extracts multiple unique entity paths", () => {
    const qmdJson = JSON.stringify([
      { file: "qmd://life/areas/people/sergey/summary.md", score: 0.9 },
      { file: "qmd://life/projects/engram/summary.md", score: 0.7 },
      { file: "qmd://life/resources/tools/qmd/summary.md", score: 0.6 },
    ]);
    const paths = extractEntityPathsFromJson(qmdJson);
    expect(paths).toContain("areas/people/sergey");
    expect(paths).toContain("projects/engram");
    expect(paths).toContain("resources/tools/qmd");
    expect(paths.length).toBe(3);
  });

  test("deduplicates repeated entity paths", () => {
    const qmdJson = JSON.stringify([
      { file: "qmd://life/areas/people/sergey/summary.md", score: 0.9 },
      { file: "qmd://life/areas/people/sergey/summary.md", score: 0.7 },
    ]);
    const paths = extractEntityPathsFromJson(qmdJson);
    expect(paths.length).toBe(1);
    expect(paths[0]).toBe("areas/people/sergey");
  });

  test("returns empty array on invalid JSON (graceful fallback)", () => {
    const paths = extractEntityPathsFromJson("not valid json");
    expect(paths).toEqual([]);
  });

  test("returns empty array on empty JSON array", () => {
    const paths = extractEntityPathsFromJson("[]");
    expect(paths).toEqual([]);
  });

  test("ignores results without file field", () => {
    const qmdJson = JSON.stringify([
      { score: 0.9, snippet: "some text" },
      { file: "qmd://life/projects/engram/summary.md", score: 0.7 },
    ]);
    const paths = extractEntityPathsFromJson(qmdJson);
    expect(paths.length).toBe(1);
    expect(paths[0]).toBe("projects/engram");
  });

  test("ignores items.json and non-summary paths", () => {
    const qmdJson = JSON.stringify([
      { file: "qmd://life/areas/people/sergey/items.json", score: 0.9 },
      { file: "qmd://life/readme.md", score: 0.8 },
      { file: "qmd://life/areas/people/sergey/summary.md", score: 0.7 },
    ]);
    const paths = extractEntityPathsFromJson(qmdJson);
    expect(paths.length).toBe(1);
    expect(paths[0]).toBe("areas/people/sergey");
  });

  test("ignores system/ and other non-PARA paths", () => {
    const qmdJson = JSON.stringify([
      { file: "qmd://life/system/heartbeat/summary.md", score: 0.9 },
      { file: "qmd://life/areas/tools/qmd/summary.md", score: 0.8 },
    ]);
    const paths = extractEntityPathsFromJson(qmdJson);
    // system/ is not matched by regex (only projects/areas/resources)
    expect(paths).toContain("areas/tools/qmd");
    expect(paths).not.toContain("system/heartbeat");
  });

  test("handles hyphenated entity names correctly", () => {
    const qmdJson = JSON.stringify([
      { file: "qmd://life/areas/people/aleksandr-cypher2080/summary.md", score: 0.8 },
    ]);
    const paths = extractEntityPathsFromJson(qmdJson);
    expect(paths).toContain("areas/people/aleksandr-cypher2080");
  });
});

// ─────────────────────────────────────────────────────────────
// Integration: memory-write.js CLI
// ─────────────────────────────────────────────────────────────

describe("memory-write — CLI integration", () => {
  const TEST_ENTITY = "areas/people/__test_write__";
  let TEST_WORKSPACE;
  let TEST_ENTITY_DIR;
  let TEST_ENV;

  beforeEach(() => {
    TEST_WORKSPACE = createTestWorkspace();
    TEST_ENTITY_DIR = join(TEST_WORKSPACE, "life", TEST_ENTITY);
    TEST_ENV = { ...process.env, ENGRAM_WORKSPACE: TEST_WORKSPACE };
    mkdirSync(TEST_ENTITY_DIR, { recursive: true });
    writeFileSync(join(TEST_ENTITY_DIR, "items.json"), JSON.stringify({
      entityId: TEST_ENTITY,
      entityType: "area",
      facts: [],
    }, null, 2));
    writeFileSync(join(TEST_ENTITY_DIR, "summary.md"), "# Test\n\n_Created automatically._\n");
  });

  afterEach(() => {
    if (TEST_WORKSPACE && existsSync(TEST_WORKSPACE)) rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  });

  test("writes a new fact and returns created status", async () => {
    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-write.js"),
      "--entity", TEST_ENTITY,
      "--fact", "Prefers TypeScript over JavaScript for all new projects " + Date.now(),
      "--category", "preference",
      "--confidence", "0.9",
      "--abstraction", "pattern",
    ], { cwd: ENGRAM_DIR, stdout: "pipe", stderr: "pipe", env: TEST_ENV });

    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const result = JSON.parse(out);
    expect(result.status).toBe("created");
    expect(result.fact.fact).toContain("Prefers TypeScript over JavaScript for all new projects");
    expect(result.fact.category).toBe("preference");
    expect(result.fact.confidence).toBe(0.9);
  });

  test("skips duplicate fact on second write", async () => {
    const factText = "Always uses Bun instead of NodeJS for new projects " + Date.now();
    const args = [
      "bun", join(SCRIPTS_DIR, "memory-write.js"),
      "--entity", TEST_ENTITY,
      "--fact", factText,
      "--category", "preference",
    ];

    // First write
    const p1 = Bun.spawn(args, { cwd: ENGRAM_DIR, stdout: "pipe", stderr: "pipe", env: TEST_ENV });
    await new Response(p1.stdout).text();
    await p1.exited;

    // Second write — same fact → should be skipped
    const p2 = Bun.spawn(args, { cwd: ENGRAM_DIR, stdout: "pipe", stderr: "pipe", env: TEST_ENV });
    const out2 = await new Response(p2.stdout).text();
    await p2.exited;
    const result2 = JSON.parse(out2);
    expect(result2.status).toBe("skipped");
  });

  test("errors without required --entity", async () => {
    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-write.js"),
      "--fact", "Some fact",
      "--category", "preference",
    ], { cwd: ENGRAM_DIR, stdout: "pipe", stderr: "pipe", env: TEST_ENV });
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);
  });

  test("access tracking mode increments accessCount", async () => {
    // First: write a fact to get its ID
    const writeProc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-write.js"),
      "--entity", TEST_ENTITY,
      "--fact", "Fact for access tracking test " + Date.now(),
      "--category", "context",
    ], { cwd: ENGRAM_DIR, stdout: "pipe", stderr: "pipe", env: TEST_ENV });
    const writeOut = await new Response(writeProc.stdout).text();
    await writeProc.exited;
    const written = JSON.parse(writeOut);
    const factId = written.fact.id;

    // Then: access tracking
    const accessProc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-write.js"),
      "--access",
      "--entity", TEST_ENTITY,
      "--id", factId,
    ], { cwd: ENGRAM_DIR, stdout: "pipe", stderr: "pipe", env: TEST_ENV });
    const accessOut = await new Response(accessProc.stdout).text();
    await accessProc.exited;
    const result = JSON.parse(accessOut);
    expect(result.status).toBe("accessed");
    expect(result.accessCount).toBe(2); // started at 1, now 2
  });
});

// ─────────────────────────────────────────────────────────────
// Integration: memory-contradict.js CLI
// ─────────────────────────────────────────────────────────────

describe("memory-contradict — CLI integration", () => {
  const TEST_ENTITY = "areas/people/__test_contradict__";
  let TEST_WORKSPACE;
  let TEST_ENTITY_DIR;
  let TEST_ENV;
  const CWD = ENGRAM_DIR;

  beforeEach(() => {
    TEST_WORKSPACE = createTestWorkspace();
    TEST_ENTITY_DIR = join(TEST_WORKSPACE, "life", TEST_ENTITY);
    TEST_ENV = { ...process.env, ENGRAM_WORKSPACE: TEST_WORKSPACE };
    mkdirSync(TEST_ENTITY_DIR, { recursive: true });
    writeFileSync(join(TEST_ENTITY_DIR, "items.json"), JSON.stringify({
      entityId: TEST_ENTITY,
      entityType: "area",
      facts: [
        {
          id: "t001",
          fact: "Prefers TypeScript over JavaScript for all backend projects",
          category: "preference",
          status: "active",
          confidence: 0.9,
          abstractionLevel: "pattern",
          tags: [],
          timestamp: "2026-02-01",
          source: "2026-02-01",
          supersededBy: null,
          relatedEntities: [],
          lastAccessed: "2026-02-01",
          accessCount: 1,
        },
        {
          id: "t002",
          fact: "Uses Docker for all production deployments",
          category: "preference",
          status: "active",
          confidence: 0.9,
          abstractionLevel: "pattern",
          tags: [],
          timestamp: "2026-02-01",
          source: "2026-02-01",
          supersededBy: null,
          relatedEntities: [],
          lastAccessed: "2026-02-01",
          accessCount: 1,
        },
      ],
    }, null, 2));
    writeFileSync(join(TEST_ENTITY_DIR, "summary.md"), "# Test\n");
  });

  afterEach(() => {
    if (TEST_WORKSPACE && existsSync(TEST_WORKSPACE)) rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  });

  test("detects intra-entity contradiction by keyword overlap", async () => {
    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-contradict.js"),
      "--fact", "Dislikes TypeScript and prefers JavaScript for backend projects",
      "--entity", TEST_ENTITY,
    ], { cwd: CWD, stdout: "pipe", stderr: "pipe", env: TEST_ENV });

    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const result = JSON.parse(out);

    expect(Array.isArray(result.conflicts)).toBe(true);
    expect(result.conflicts.length).toBeGreaterThan(0);
    const conflict = result.conflicts[0];
    expect(conflict.id).toBe("t001");
    expect(conflict.similarity).toBeGreaterThanOrEqual(0.3);
    expect(conflict.commonKeywords.length).toBeGreaterThanOrEqual(2);
  });

  test("returns no conflicts for unrelated fact", async () => {
    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-contradict.js"),
      "--fact", "Enjoys hiking and outdoor activities on weekends",
      "--entity", TEST_ENTITY,
    ], { cwd: CWD, stdout: "pipe", stderr: "pipe", env: TEST_ENV });

    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const result = JSON.parse(out);
    expect(result.conflicts).toEqual([]);
  });

  test("exits with error when --fact is missing", async () => {
    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-contradict.js"),
      "--entity", TEST_ENTITY,
    ], { cwd: CWD, stdout: "pipe", stderr: "pipe", env: TEST_ENV });
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);
  });

  test("exits with error when --entity is missing", async () => {
    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-contradict.js"),
      "--fact", "Some fact",
    ], { cwd: CWD, stdout: "pipe", stderr: "pipe", env: TEST_ENV });
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);
  });

  test("handles entity with old text-field facts (backward compat)", async () => {
    // Simulate old schema with "text" field instead of "fact"
    writeFileSync(join(TEST_ENTITY_DIR, "items.json"), JSON.stringify({
      entityId: TEST_ENTITY,
      entityType: "area",
      facts: [
        {
          id: "old001",
          text: "Prefers TypeScript for all projects", // old schema
          category: "preference",
          status: "active",
          confidence: 0.9,
          abstractionLevel: "pattern",
          tags: [],
          timestamp: "2026-01-01",
          source: "2026-01-01",
          supersededBy: null,
          relatedEntities: [],
          lastAccessed: "2026-01-01",
          accessCount: 1,
        },
      ],
    }, null, 2));

    const proc = Bun.spawn([
      "bun", join(SCRIPTS_DIR, "memory-contradict.js"),
      "--fact", "Dislikes TypeScript and prefers JavaScript for all projects",
      "--entity", TEST_ENTITY,
    ], { cwd: CWD, stdout: "pipe", stderr: "pipe", env: TEST_ENV });

    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const result = JSON.parse(out);
    // Should still find conflict via f.text fallback in loadEntityFacts
    expect(Array.isArray(result.conflicts)).toBe(true);
    expect(result.conflicts.length).toBeGreaterThan(0);
  });
});
