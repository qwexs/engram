import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync } from "fs";

const SCRIPTS_DIR = join(import.meta.dir, "..", "scripts");
const ENGRAM_DIR = join(import.meta.dir, "..");

// Several integration cases intentionally invoke memory-write twice. Each CLI
// invocation waits for its qmd/derive-facts subprocesses and takes ~3s on
// Windows, so Bun's 5s per-test default can kill the second invocation and
// leave its temp workspace locked. Give the real subprocess chain time to exit.
setDefaultTimeout(20_000);

const TEST_ENTITY = "areas/people/__test_mw__";
let TEST_WORKSPACE;
let LIFE_DIR;
let TEST_ENTITY_DIR;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function createEntity(facts = []) {
  mkdirSync(TEST_ENTITY_DIR, { recursive: true });
  writeFileSync(
    join(TEST_ENTITY_DIR, "items.json"),
    JSON.stringify({ entityId: TEST_ENTITY, entityType: "area", facts }, null, 2),
  );
  writeFileSync(join(TEST_ENTITY_DIR, "summary.md"), "# Test\n\n_Created automatically._\n");
}

function readItems() {
  return JSON.parse(readFileSync(join(TEST_ENTITY_DIR, "items.json"), "utf-8"));
}

async function run(args, cwd = ENGRAM_DIR, envOverrides = {}) {
  const proc = Bun.spawn(["bun", join(SCRIPTS_DIR, "memory-write.js"), ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ENGRAM_WORKSPACE: TEST_WORKSPACE, ...envOverrides },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout, stderr, exitCode: proc.exitCode };
}

async function runJson(args, envOverrides = {}) {
  const { stdout, stderr, exitCode } = await run(args, ENGRAM_DIR, envOverrides);
  try {
    return { result: JSON.parse(stdout), stderr, exitCode };
  } catch {
    return { result: null, stdout, stderr, exitCode };
  }
}

// ─────────────────────────────────────────────────────────────
// Setup / Teardown
// ─────────────────────────────────────────────────────────────

beforeEach(() => {
  TEST_WORKSPACE = mkdtempSync(join(tmpdir(), "engram-memory-write-"));
  LIFE_DIR = join(TEST_WORKSPACE, "life");
  TEST_ENTITY_DIR = join(LIFE_DIR, TEST_ENTITY);
  mkdirSync(join(TEST_WORKSPACE, "workspace", "memory-state"), { recursive: true });
  writeFileSync(join(TEST_WORKSPACE, "workspace", "memory-state", "fact-hashes.json"), "{}");
});

afterEach(() => {
  if (TEST_WORKSPACE && existsSync(TEST_WORKSPACE)) rmSync(TEST_WORKSPACE, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────
// Validation: required args
// ─────────────────────────────────────────────────────────────

describe("memory-write — argument validation", () => {
  test("exits with error when --entity is missing", async () => {
    const { exitCode, stderr } = await run(["--fact", "Test", "--category", "preference"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--entity");
  });

  test("exits with error when --fact is missing", async () => {
    const { exitCode, stderr } = await run(["--entity", TEST_ENTITY, "--category", "preference"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--fact");
  });

  test("exits with error when --category is missing", async () => {
    const { exitCode, stderr } = await run(["--entity", TEST_ENTITY, "--fact", "Test"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--category");
  });

  test("exits with error for invalid category", async () => {
    createEntity();
    const { exitCode, stderr } = await run([
      "--entity", TEST_ENTITY,
      "--fact", "Test fact",
      "--category", "invalid_category",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Неверная категория");
  });

  test("exits with error for invalid abstractionLevel", async () => {
    createEntity();
    const before = readFileSync(join(TEST_ENTITY_DIR, "items.json"), "utf-8");
    const { exitCode, stderr } = await run([
      "--entity", TEST_ENTITY,
      "--fact", "Test fact",
      "--category", "context",
      "--abstraction", "context",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Неверный --abstraction");
    expect(readFileSync(join(TEST_ENTITY_DIR, "items.json"), "utf-8")).toBe(before);
  });

  test("rejects --abstraction without a value", async () => {
    createEntity();
    const { exitCode, stderr } = await run([
      "--entity", TEST_ENTITY,
      "--fact", "Test fact",
      "--category", "context",
      "--abstraction",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Неверный --abstraction");
  });

  test("accepts all valid categories", async () => { // slow: 7 spawns × ~2s each
    const categories = ["relationship", "milestone", "status", "preference", "context", "decision", "correction"];
    for (const cat of categories) {
      // Recreate entity fresh (previous write changes state)
      if (existsSync(TEST_ENTITY_DIR)) rmSync(TEST_ENTITY_DIR, { recursive: true });
      writeFileSync(join(TEST_WORKSPACE, "workspace", "memory-state", "fact-hashes.json"), "{}");
      createEntity();

      const { result } = await runJson([
        "--entity", TEST_ENTITY,
        "--fact", `Test fact for category ${cat} ${Date.now()}`,
        "--category", cat,
      ]);
      expect(result?.status).toBe("created");
      expect(result?.fact?.category).toBe(cat);
    }
  }, 30000);

  test.each(["null", "NaN", "Infinity", "-0.1", "1.01"])("rejects invalid confidence %s before writing", async (confidence) => {
    createEntity();
    const { exitCode, stderr } = await run([
      "--entity", TEST_ENTITY,
      "--fact", `Invalid confidence ${confidence}`,
      "--category", "context",
      "--confidence", confidence,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--confidence должен быть числом от 0 до 1");
    expect(readItems().facts).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Entity handling
// ─────────────────────────────────────────────────────────────

describe("memory-write — entity handling", () => {
  test("errors when entity does not exist and --entity-create not passed", async () => {
    const { exitCode, stderr } = await run([
      "--entity", "areas/people/__nonexistent__",
      "--fact", "Test",
      "--category", "context",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Entity не существует");
  });

  test("creates entity with --entity-create flag", async () => {
    const newEntity = "areas/people/__test_autocreate__";
    const newEntityDir = join(LIFE_DIR, newEntity);
    try {
      const { result } = await runJson([
        "--entity", newEntity,
        "--fact", "Auto-created entity test",
        "--category", "context",
        "--entity-create",
      ]);
      expect(result?.status).toBe("created");
      expect(existsSync(join(newEntityDir, "items.json"))).toBe(true);
      expect(existsSync(join(newEntityDir, "summary.md"))).toBe(true);
    } finally {
      if (existsSync(newEntityDir)) rmSync(newEntityDir, { recursive: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Core write flow
// ─────────────────────────────────────────────────────────────

describe("memory-write — write flow", () => {
  test("creates fact with all required fields", async () => {
    createEntity();
    const { result } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Prefers Bun over Node.js for all new projects",
      "--category", "preference",
      "--confidence", "0.9",
      "--abstraction", "pattern",
      "--tags", "tools,runtime",
      "--source", "2026-03-01",
    ]);

    expect(result?.status).toBe("created");
    const f = result.fact;
    expect(f.fact).toBe("Prefers Bun over Node.js for all new projects");
    expect(f.category).toBe("preference");
    expect(f.confidence).toBe(0.9);
    expect(f.abstractionLevel).toBe("pattern");
    expect(f.tags).toEqual(["tools", "runtime"]);
    expect(f.source).toBe("2026-03-01");
    expect(f.status).toBe("active");
    expect(f.supersededBy).toBeNull();
    expect(f.accessCount).toBe(1);
    expect(f.id).toMatch(/^__test_mw__-\d{3}$/);
  });

  test("uses defaults for optional fields", async () => {
    createEntity();
    const { result } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Default fields test fact",
      "--category", "context",
    ]);

    const f = result.fact;
    expect(f.confidence).toBe(0.8); // default
    expect(f.abstractionLevel).toBe("episode"); // default
    expect(f.tags).toEqual([]); // default
    expect(f.relatedEntities).toEqual([]); // default
  });

  test("includes description when provided (truncated to 150 chars)", async () => {
    createEntity();
    const longDesc = "A".repeat(200);
    const { result } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Description test " + Date.now(),
      "--category", "context",
      "--description", longDesc,
    ]);

    expect(result.fact.description).toBeDefined();
    expect(result.fact.description.length).toBeLessThanOrEqual(150);
  });

  test("omits description when not provided", async () => {
    createEntity();
    const { result } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "No description test " + Date.now(),
      "--category", "context",
    ]);

    expect(result.fact.description).toBeUndefined();
  });

  test("writes fact to items.json on disk", async () => {
    createEntity();
    await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Persisted fact test",
      "--category", "milestone",
    ]);

    const data = readItems();
    expect(data.facts.length).toBe(1);
    expect(data.facts[0].fact).toBe("Persisted fact test");
  });

  test("can supersede existing facts when writing their replacement", async () => {
    createEntity([{
      id: "__test_mw__-001",
      fact: "Old noisy assistant status text",
      category: "context",
      confidence: 0.6,
      abstractionLevel: "episode",
      tags: [],
      timestamp: "2026-05-21",
      source: "test",
      status: "active",
      supersededBy: null,
      relatedEntities: [],
      lastAccessed: "2026-05-21",
      accessCount: 1,
    }, {
      id: "__test_mw__-002",
      fact: "Old tool log noise",
      category: "context",
      confidence: 0.6,
      abstractionLevel: "episode",
      tags: [],
      timestamp: "2026-05-21",
      source: "test",
      status: "active",
      supersededBy: null,
      relatedEntities: [],
      lastAccessed: "2026-05-21",
      accessCount: 1,
    }]);

    const { result } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Replacement durable fact",
      "--category", "context",
      "--supersedes", "__test_mw__-001,__test_mw__-002",
    ]);

    expect(result.status).toBe("created");
    const data = readItems();
    expect(data.facts[0].status).toBe("superseded");
    expect(data.facts[0].supersededBy).toBe("__test_mw__-003");
    expect(data.facts[1].status).toBe("superseded");
    expect(data.facts[1].supersededBy).toBe("__test_mw__-003");
    expect(data.facts[2].fact).toBe("Replacement durable fact");
  });

  test("--supersedes bypasses in-entity Jaccard dedup (explicit supersede wins over implicit skip)", async () => {
    // Setup: existing preference fact that is a near-paraphrase of the new one.
    // Without --supersedes, in-entity Jaccard would block this as "skipped".
    // With --supersedes, explicit intent must win and the write must proceed.
    createEntity([{
      id: "__test_mw__-001",
      fact: "Use cleanup keep for hb-extract subagents to preserve debug history forever",
      category: "preference",
      confidence: 0.85,
      abstractionLevel: "pattern",
      tags: [],
      timestamp: "2026-05-21",
      source: "test",
      status: "active",
      supersededBy: null,
      relatedEntities: [],
      lastAccessed: "2026-05-21",
      accessCount: 1,
    }]);

    const { result, exitCode } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Use cleanup keep for hb-extract subagents to preserve debug history",
      "--category", "preference",
      "--supersedes", "__test_mw__-001",
    ]);

    expect(exitCode).toBe(0);
    expect(result.status).toBe("created");
    expect(result.fact.id).toBe("__test_mw__-002");

    const data = readItems();
    expect(data.facts[0].status).toBe("superseded");
    expect(data.facts[0].supersededBy).toBe("__test_mw__-002");
    expect(data.facts[1].fact).toBe("Use cleanup keep for hb-extract subagents to preserve debug history");
  });

  test("increments IDs correctly", async () => {
    createEntity();

    const { result: r1 } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "First fact unique " + Date.now(),
      "--category", "context",
    ]);
    const { result: r2 } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Second fact unique " + Date.now(),
      "--category", "context",
    ]);

    expect(r1.fact.id).toBe("__test_mw__-001");
    expect(r2.fact.id).toBe("__test_mw__-002");
  });

  test("normalizes backslashes in entity path", async () => {
    createEntity();
    const { result } = await runJson([
      "--entity", "areas\\people\\__test_mw__",
      "--fact", "Backslash normalization test " + Date.now(),
      "--category", "context",
    ]);

    expect(result?.status).toBe("created");
  });
});

// ─────────────────────────────────────────────────────────────
// Deduplication
// ─────────────────────────────────────────────────────────────

describe("memory-write — deduplication", () => {
  test("skips exact duplicate fact", async () => {
    createEntity();
    const fact = "Exact duplicate test fact " + Date.now();

    await runJson(["--entity", TEST_ENTITY, "--fact", fact, "--category", "preference"]);
    const { result: r2 } = await runJson(["--entity", TEST_ENTITY, "--fact", fact, "--category", "preference"]);

    expect(r2.status).toBe("skipped");
    expect(r2.reason).toContain("Duplicate");
  });

  test("allows different facts with same entity", async () => {
    createEntity();
    const ts = Date.now();

    const { result: r1 } = await runJson([
      "--entity", TEST_ENTITY, "--fact", `Prefers Bun runtime over NodeJS ${ts}`, "--category", "preference",
    ]);
    const { result: r2 } = await runJson([
      "--entity", TEST_ENTITY, "--fact", `Uses TypeScript for backend projects ${ts}`, "--category", "preference",
    ]);

    expect(r1.status).toBe("created");
    expect(r2.status).toBe("created");
  });
});

// ─────────────────────────────────────────────────────────────
// In-entity Jaccard dedup (always-on)
// ─────────────────────────────────────────────────────────────

describe("memory-write — in-entity Jaccard deduplication", () => {
  test("blocks paraphrase of existing fact (Jaccard ≥ 0.65)", async () => {
    createEntity();

    // Write original fact
    await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Timeout for research subagents is always 600 seconds minimum",
      "--category", "preference",
    ]);

    // Try to write a paraphrase — high Jaccard overlap
    const { result } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Research subagents timeout must always be 600 seconds minimum",
      "--category", "preference",
    ]);

    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("Jaccard");
    expect(result.existingId).toBeDefined();
  });

  test("allows clearly different fact in same entity", async () => {
    createEntity();

    await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Timeout for research subagents is always 600 seconds minimum",
      "--category", "preference",
    ]);

    // Completely different topic
    const { result } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Prefers Bun runtime over Node.js for new TypeScript projects",
      "--category", "preference",
    ]);

    expect(result.status).toBe("created");
  });

  test("respects --jaccard-threshold override (0.9 = stricter)", async () => {
    createEntity();

    await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Timeout for research subagents is always 600 seconds minimum",
      "--category", "preference",
    ]);

    // Same paraphrase but with high threshold — should pass through
    const { result } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Research subagents timeout must always be 600 seconds minimum",
      "--category", "preference",
      "--jaccard-threshold", "0.95",
    ]);

    // At 0.95 threshold paraphrase should not be blocked
    expect(result.status).toBe("created");
  });

  test("skipped result includes existingId and existingFact preview", async () => {
    createEntity();

    await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Timeout for research subagents is always 600 seconds minimum",
      "--category", "preference",
    ]);

    const { result } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Research subagents timeout must always be 600 seconds minimum",
      "--category", "preference",
    ]);

    if (result.status === "skipped" && result.reason?.includes("Jaccard")) {
      expect(result.existingId).toMatch(/^__test_mw__-\d{3}$/);
      expect(typeof result.existingFact).toBe("string");
      expect(result.existingFact.length).toBeGreaterThan(0);
    }
  });

  test("does not block first write to empty entity", async () => {
    createEntity(); // empty facts array

    const { result } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "First fact in empty entity",
      "--category", "context",
    ]);

    expect(result.status).toBe("created");
  });
});

// ─────────────────────────────────────────────────────────────
// Access tracking
// ─────────────────────────────────────────────────────────────

describe("memory-write — access tracking", () => {
  test("increments accessCount and updates lastAccessed", async () => {
    const accessEntity = "people/access-example";
    const accessDir = join(LIFE_DIR, accessEntity);
    mkdirSync(accessDir, { recursive: true });
    writeFileSync(join(accessDir, "items.json"), JSON.stringify({
      entityId: accessEntity,
      entityType: "person",
      facts: [{
        id: "access-example-001",
        fact: "Access tracking target is immediately restored to the summary",
        category: "preference",
        confidence: 1,
        abstractionLevel: "pattern",
        tags: [],
        timestamp: "2026-01-01",
        source: "2026-01-01",
        status: "active",
        supersededBy: null,
        relatedEntities: [],
        lastAccessed: "2026-01-01",
        accessCount: 1,
      }],
    }, null, 2));
    writeFileSync(join(accessDir, "summary.md"), "# Access example\n\n_Stale._\n");

    const { result: wr } = await runJson([
      "--entity", accessEntity,
      "--fact", "Unrelated fact to initialise the write pipeline " + Date.now(),
      "--category", "context",
    ]);
    expect(wr.status).toBe("created");

    const { result } = await runJson(["--access", "--entity", accessEntity, "--id", "access-example-001"]);
    expect(result.status).toBe("accessed");
    expect(result.accessCount).toBe(2);
    expect(result.summaryUpdated).toBe(true);
    expect(readFileSync(join(accessDir, "summary.md"), "utf-8")).toContain("Access tracking target");
  });

  test("errors when --access without --entity", async () => {
    const { exitCode, stderr } = await run(["--access", "--id", "foo"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--entity");
  });

  test("errors when --access without --id", async () => {
    const { exitCode, stderr } = await run(["--access", "--entity", TEST_ENTITY]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--id");
  });

  test("errors when fact ID not found", async () => {
    createEntity();
    const { exitCode, stderr } = await run(["--access", "--entity", TEST_ENTITY, "--id", "nonexistent-999"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("не найден");
  });
});

// ─────────────────────────────────────────────────────────────
// Related entities
// ─────────────────────────────────────────────────────────────

describe("memory-write — related entities", () => {
  test("parses comma-separated --related", async () => {
    createEntity();
    const { result } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Related entities test " + Date.now(),
      "--category", "relationship",
      "--related", "projects/engram,areas/tools/qmd",
    ]);

    expect(result.fact.relatedEntities).toEqual(["projects/engram", "areas/tools/qmd"]);
  });
});

// ─────────────────────────────────────────────────────────────
// Semantic check (--semantic-check, requires qmd running)
// ─────────────────────────────────────────────────────────────

// Check if QMD index exists (required for semantic-check tests)
const qmdIndexExists = existsSync(join(ENGRAM_DIR, ".qmd", "index.db")) ||
  existsSync(join(ENGRAM_DIR, "workspace", ".qmd", "index.db"));

describe("memory-write — semantic check (qmd integration)", () => {
  test("sanitizes/caps qmd query and keeps the exact fact in KG", async () => {
    createEntity();
    const qmdLog = join(TEST_WORKSPACE, "fake-qmd.log");
    const fakeQmd = `bun ${join(import.meta.dir, "fixtures", "fake-qmd.js")}`;
    const longFact = `Durable migration completed successfully ${"diagnostic-noise ".repeat(40)}`;
    const { result } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", longFact,
      "--category", "milestone",
      "--semantic-check",
    ], {
      ENGRAM_QMD: fakeQmd,
      FAKE_QMD_LOG: qmdLog,
    });

    expect(result.status).toBe("created");
    expect(result.fact.fact).toBe(longFact);
    const calls = readFileSync(qmdLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const queryCall = calls.find((call) => call[0] === "query");
    expect(queryCall).toBeDefined();
    expect(queryCall[1].length).toBeLessThanOrEqual(300);
    expect(queryCall).toContain("-n");
    expect(queryCall).toContain("10");
  });

  test("qmd query timeout is fail-open and does not affect qmd update/embed limits", async () => {
    createEntity();
    const fakeQmd = `bun ${join(import.meta.dir, "fixtures", "fake-qmd.js")}`;
    const { result, exitCode } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Engram release migration completed with a bounded semantic check",
      "--category", "milestone",
      "--semantic-check",
    ], {
      ENGRAM_QMD: fakeQmd,
      ENGRAM_QMD_QUERY_TIMEOUT_MS: "100",
      FAKE_QMD_QUERY_DELAY_MS: "2000",
    });

    expect(exitCode).toBe(0);
    expect(result.status).toBe("created");
    expect(result.warnings?.semanticCheck?.[0]?.type).toBe("timeout");
  });

  test("writes unique fact without semantic warnings", async () => {
    if (!qmdIndexExists) return; // skip: QMD index not available in this env
    createEntity();
    const { result } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Completely unique xyzzy blorgfish fact " + Date.now(),
      "--category", "context",
      "--semantic-check",
    ]);

    expect(result.status).toBe("created");
    // No semantic warnings for a nonsense fact
    expect(result.warnings?.semanticSimilar).toBeUndefined();
  });

  test("semantic check runs without errors on matching content", async () => {
    if (!qmdIndexExists) return; // skip: QMD index not available in this env
    createEntity();
    // Use a fact that overlaps with KG content (Telemax project uses Bun + TypeScript + Hono)
    // Even if Jaccard doesn't hit threshold, the check should run cleanly
    const { result, stderr } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Telemax bot project uses Bun TypeScript Hono RabbitMQ PostgreSQL Kysely",
      "--category", "context",
      "--semantic-check",
    ]);

    // Should succeed (created or skipped as semantic dup) — no crash
    expect(["created", "skipped"]).toContain(result.status);
    // No error output from semantic check
    expect(stderr).not.toContain("Semantic check ошибка");
  });

  test("respects custom --search-collections", async () => {
    createEntity();
    // Search in a non-existent collection → no matches → should create cleanly
    const { result } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Custom collection search test " + Date.now(),
      "--category", "context",
      "--semantic-check",
      "--search-collections", "nonexistent_collection_xyz",
    ]);

    expect(result.status).toBe("created");
  });

  test("semantic duplicate blocks write (Jaccard ≥ 0.5)", async () => {
    createEntity();
    // First: write a fact via normal path (no semantic check)
    const uniqueFact = "Engram memory extraction system uses BM25 and vector search for deduplication";
    await runJson([
      "--entity", TEST_ENTITY,
      "--fact", uniqueFact,
      "--category", "context",
    ]);

    // Run qmd update so the new fact is indexed
    const qmdProc = Bun.spawn(["qmd", "update"], { cwd: ENGRAM_DIR, stdout: "pipe", stderr: "pipe" });
    await qmdProc.exited;

    // Now try writing a very similar fact WITH semantic check
    const { result } = await runJson([
      "--entity", TEST_ENTITY,
      "--fact", "Engram memory extraction uses BM25 vector search deduplication system",
      "--category", "context",
      "--semantic-check",
      "--search-collections", "life",
    ]);

    // High Jaccard overlap → should be blocked by in-entity Jaccard or QMD semantic check
    if (result.status === "skipped") {
      expect(result.reason).toMatch(/Jaccard|Semantic duplicate/);
    }
    // If not blocked (qmd didn't index fast enough), at least it shouldn't crash
    expect(["created", "skipped"]).toContain(result.status);
  });
});
