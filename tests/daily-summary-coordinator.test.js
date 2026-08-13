import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordKgV3AccessEvent } from "../src/kg-v3/access.ts";

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
  test("skips workspaces without active KG v3 authority sequentially", () => {
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
    expect(report.workspaces.every((item) => item.skipped === "kg-v3-authority-inactive")).toBe(true);
    expect(existsSync(join(first, "life", "people", "first", "summary.md"))).toBe(false);
    expect(existsSync(join(second, "life", "people", "second", "summary.md"))).toBe(false);
  });

  test("accepts a transport-safe encoded workspace list without repeated path arguments", () => {
    root = mkdtempSync(join(tmpdir(), "engram-summary-coordinator-"));
    const first = workspace("first");
    const second = workspace("second");
    const encoded = encodeURIComponent(JSON.stringify([first, second]));
    const proc = Bun.spawnSync(["bun", SCRIPT, "--workspaces-uri", encoded, "--json"], {
      cwd: ENGRAM_DIR,
      env: { ...process.env, ENGRAM_TZ: "Europe/Moscow" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString();
    expect(proc.exitCode, proc.stderr.toString() || stdout).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.workspaces.map((item) => item.workspace)).toEqual([first, second]);
  });

  test("reads ordered workspaces from a scheduler declaration", () => {
    root = mkdtempSync(join(tmpdir(), "engram-summary-coordinator-"));
    const first = workspace("first");
    const second = workspace("second");
    const declaration = join(root, "scheduler.json");
    writeFileSync(declaration, JSON.stringify({
      schema: "engram.daily-summary-scheduler.v1",
      payload: { argv: ["bun", SCRIPT, "--workspace", first, "--workspace", second, "--json"] },
    }));
    const proc = Bun.spawnSync(["bun", SCRIPT, "--scheduler-declaration", declaration, "--json"], {
      cwd: ENGRAM_DIR,
      env: { ...process.env, ENGRAM_TZ: "Europe/Moscow" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString();
    expect(proc.exitCode, proc.stderr.toString() || stdout).toBe(0);
    expect(JSON.parse(stdout).workspaces.map((item) => item.workspace)).toEqual([first, second]);
  });

  test("never consumes or applies a legacy access buffer", () => {
    root = mkdtempSync(join(tmpdir(), "engram-summary-coordinator-"));
    const first = workspace("first");
    mkdirSync(join(first, "workspace", "memory-state"), { recursive: true });
    writeFileSync(join(first, "workspace", "memory-state", "access-buffer.jsonl"), JSON.stringify({
      schema: "engram.access-event.v1", entity: "people/first", id: "first-001",
    }) + "\n");
    const proc = Bun.spawnSync(["bun", SCRIPT, "--workspace", first, "--json"], {
      cwd: ENGRAM_DIR,
      env: { ...process.env, ENGRAM_TZ: "Europe/Moscow" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const report = JSON.parse(proc.stdout.toString());
    expect(report.workspaces[0].skipped).toBe("kg-v3-authority-inactive");
    const data = JSON.parse(readFileSync(join(first, "life", "people", "first", "items.json"), "utf8"));
    expect(data.facts[0].accessCount).toBe(1);
    expect(existsSync(join(first, "workspace", "memory-state", "access-buffer.jsonl"))).toBe(true);
  });

  test("applies native v3 access and rebuilds the decay-aware current projection", () => {
    root = mkdtempSync(join(tmpdir(), "engram-summary-coordinator-"));
    const first = join(root, "main");
    const assertionId = "11111111-1111-4111-8111-111111111111";
    mkdirSync(join(first, "life", "v3", "assertions"), { recursive: true });
    mkdirSync(join(first, "memory-state", "kg-v3"), { recursive: true });
    writeFileSync(join(first, "engram.json"), JSON.stringify({ workspace: { id: "main" } }));
    writeFileSync(join(first, "memory-state", "kg-v3", "authority.json"), JSON.stringify({
      schema: "engram.kg-v3-authority.v1", workspaceId: "main", mode: "canary",
    }));
    writeFileSync(join(first, "life", "v3", "assertions", `${assertionId}.json`), JSON.stringify({
      schema: "engram.kg-assertion.v3-mvp", id: assertionId, workspaceId: "main",
      entityId: "people/example", entityType: "person", kind: "decision", predicate: "deliveryPolicy",
      object: { type: "string", value: "Use concise delivery" }, scope: ["personal"],
      lifecycle: { status: "active", replacesId: null, supersededById: null, changedAt: "2026-06-01T00:00:00.000Z" },
      provenance: { sourceKind: "user_message", sessionKey: "main", messageId: "1", actorId: "owner", operationId: `sha256:${"1".repeat(64)}`, observedAt: "2026-06-01T00:00:00.000Z" },
      createdAt: "2026-06-01T00:00:00.000Z",
    }));
    recordKgV3AccessEvent({ workspace: first, workspaceId: "main", sessionKey: "main", messageId: "8554", assertionIds: [assertionId], observedAt: new Date().toISOString() });
    const proc = Bun.spawnSync(["bun", SCRIPT, "--workspace", first, "--json"], {
      cwd: ENGRAM_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const report = JSON.parse(proc.stdout.toString());
    expect(report.workspaces[0].access).toMatchObject({ applied: 1, assertionTouches: 1 });
    expect(report.workspaces[0].projection).toMatchObject({ included: 1, hot: 1 });
    expect(readFileSync(join(first, "life", "v3", "current-summary.md"), "utf8")).toContain(assertionId);
    const state = JSON.parse(readFileSync(join(first, "memory-state", "kg-v3", "access", "state.json"), "utf8"));
    expect(state.assertions[assertionId].accessCount).toBe(1);
  });
});
