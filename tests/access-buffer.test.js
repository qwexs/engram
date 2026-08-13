import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ENGRAM_DIR = join(import.meta.dir, "..");
const BUFFER = join(ENGRAM_DIR, "scripts", "memory-access-buffer.js");
const FLUSH = join(ENGRAM_DIR, "scripts", "flush-access-buffer.js");
let root;

function makeWorkspace() {
  root = mkdtempSync(join(tmpdir(), "engram-access-buffer-"));
  mkdirSync(join(root, "life", "people", "alice"), { recursive: true });
  writeFileSync(join(root, "engram.json"), "{}\n");
  writeFileSync(join(root, "life", "people", "alice", "items.json"), JSON.stringify({
    entityId: "people/alice",
    facts: [{
      id: "alice-001", fact: "Prefers concise reports", category: "preference",
      confidence: 1, abstractionLevel: "pattern", tags: [], timestamp: "2026-01-01",
      source: "2026-01-01", status: "active", supersededBy: null, relatedEntities: [],
      lastAccessed: "2026-01-01", accessCount: 1,
    }],
  }, null, 2));
  return root;
}

function run(args) {
  return Bun.spawnSync(["bun", ...args], {
    cwd: ENGRAM_DIR,
    env: { ...process.env, ENGRAM_TZ: "Europe/Moscow" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("buffered fact access", () => {
  test("queues by exact fact and applies it during flush", () => {
    const workspace = makeWorkspace();
    const queued = run([BUFFER, "--workspace", workspace, "--entity", "people/alice", "--fact", "Prefers concise reports"]);
    expect(queued.exitCode, queued.stderr.toString()).toBe(0);
    expect(existsSync(join(workspace, "workspace", "memory-state", "access-buffer.jsonl"))).toBe(true);

    const flushed = run([FLUSH, "--workspace", workspace, "--json"]);
    expect(flushed.exitCode, flushed.stderr.toString()).toBe(0);
    const report = JSON.parse(flushed.stdout.toString());
    expect(report.applied).toBe(1);
    expect(report.unresolved).toBe(0);
    const data = JSON.parse(readFileSync(join(workspace, "life", "people", "alice", "items.json"), "utf8"));
    expect(data.facts[0].accessCount).toBe(2);
    expect(data.facts[0].lastAccessed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(readFileSync(join(workspace, "life", "people", "alice", "summary.md"), "utf8")).toContain("Prefers concise reports");
    expect(existsSync(join(workspace, "workspace", "memory-state", "access-buffer.jsonl"))).toBe(false);
    expect(existsSync(join(workspace, "workspace", "ops", "access-buffer", `applied-${data.facts[0].lastAccessed}.jsonl`))).toBe(true);
  });

  test("does not mutate a fact when exact text is ambiguous", () => {
    const workspace = makeWorkspace();
    const itemsPath = join(workspace, "life", "people", "alice", "items.json");
    const data = JSON.parse(readFileSync(itemsPath, "utf8"));
    data.facts.push({ ...data.facts[0], id: "alice-002" });
    writeFileSync(itemsPath, JSON.stringify(data, null, 2));
    expect(run([BUFFER, "--workspace", workspace, "--entity", "people/alice", "--fact", "Prefers concise reports"]).exitCode).toBe(0);
    const flushed = run([FLUSH, "--workspace", workspace, "--json"]);
    expect(flushed.exitCode, flushed.stderr.toString()).toBe(0);
    expect(JSON.parse(flushed.stdout.toString()).unresolved).toBe(1);
    const after = JSON.parse(readFileSync(itemsPath, "utf8"));
    expect(after.facts.map((fact) => fact.accessCount)).toEqual([1, 1]);
  });

  test("does not queue or apply v2 access mutations after KG v3 cutover", () => {
    const workspace = makeWorkspace();
    mkdirSync(join(workspace, "memory-state", "kg-v3"), { recursive: true });
    writeFileSync(join(workspace, "memory-state", "kg-v3", "authority.json"), JSON.stringify({
      schema: "engram.kg-v3-authority.v1",
      mode: "canary",
    }));
    const itemsPath = join(workspace, "life", "people", "alice", "items.json");
    const before = readFileSync(itemsPath, "utf8");
    const queued = run([BUFFER, "--workspace", workspace, "--entity", "people/alice", "--id", "alice-001"]);
    expect(queued.exitCode).toBe(0);
    expect(JSON.parse(queued.stdout.toString())).toMatchObject({
      status: "retired",
      reason: "KG_V3_ACCESS_TRACKING_NOT_ADMITTED",
    });

    const flushed = run([FLUSH, "--workspace", workspace, "--json"]);
    expect(flushed.exitCode, flushed.stderr.toString()).toBe(0);
    expect(JSON.parse(flushed.stdout.toString())).toMatchObject({
      mode: "retired",
      reason: "KG_V3_AUTHORITY_ACTIVE",
      applied: 0,
    });
    expect(readFileSync(itemsPath, "utf8")).toBe(before);
    expect(existsSync(join(workspace, "workspace", "memory-state", "access-buffer.jsonl"))).toBe(false);
  });
});
