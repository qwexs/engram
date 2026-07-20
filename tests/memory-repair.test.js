import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "memory-repair.js");
let workspace;
let itemsPath;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "engram-memory-repair-"));
  const entityDir = join(workspace, "life", "areas", "project");
  mkdirSync(entityDir, { recursive: true });
  itemsPath = join(entityDir, "items.json");
  writeFileSync(itemsPath, JSON.stringify({
    entityId: "areas/project",
    entityType: "area",
    facts: [{ id: "fact-001", fact: "Test", confidence: 0.8, abstractionLevel: "context" }],
  }, null, 2));
});

afterEach(() => {
  if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
});

async function run(...args) {
  const proc = Bun.spawn(["bun", SCRIPT, "--entity", "areas/project", "--id", "fact-001", ...args], {
    cwd: workspace,
    env: { ...process.env, ENGRAM_WORKSPACE: workspace },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout, stderr, exitCode: proc.exitCode };
}

describe("memory-repair", () => {
  test("repairs abstractionLevel without changing fact content", async () => {
    const result = await run("--abstraction", "episode");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("repaired");
    const fact = JSON.parse(readFileSync(itemsPath, "utf8")).facts[0];
    expect(fact.fact).toBe("Test");
    expect(fact.abstractionLevel).toBe("episode");
    expect(fact.confidence).toBe(0.8);
  });

  test("rejects an invalid abstractionLevel without writing", async () => {
    const before = readFileSync(itemsPath, "utf8");
    const result = await run("--abstraction", "context");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--abstraction");
    expect(readFileSync(itemsPath, "utf8")).toBe(before);
  });

  test("keeps confidence repair backward compatible", async () => {
    const result = await run("--confidence", "0.9");
    expect(result.exitCode).toBe(0);
    const fact = JSON.parse(readFileSync(itemsPath, "utf8")).facts[0];
    expect(fact.confidence).toBe(0.9);
    expect(fact.abstractionLevel).toBe("context");
  });
});
