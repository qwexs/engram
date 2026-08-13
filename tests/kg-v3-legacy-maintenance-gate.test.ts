import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const skill = join(import.meta.dir, "..");

function workspace(): { root: string; items: string } {
  const root = mkdtempSync(join(tmpdir(), "engram-v3-maintenance-"));
  roots.push(root);
  const entity = join(root, "life", "projects", "legacy");
  mkdirSync(entity, { recursive: true });
  mkdirSync(join(root, "memory-state", "kg-v3"), { recursive: true });
  writeFileSync(join(root, "engram.json"), JSON.stringify({ agent: "agent-main" }));
  writeFileSync(join(root, "memory-state", "kg-v3", "authority.json"), JSON.stringify({
    schema: "engram.kg-v3-authority.v1",
    mode: "canary",
  }));
  const items = join(entity, "items.json");
  writeFileSync(items, JSON.stringify([{ id: "legacy-1", text: "Legacy fact" }], null, 2));
  return { root, items };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("KG v3 legacy maintenance gate", () => {
  test("validate --fix becomes read-only under active authority", () => {
    const { root, items } = workspace();
    const before = readFileSync(items, "utf8");
    const run = Bun.spawnSync([
      "bun", join(skill, "scripts", "validate.js"), "--fix", "--agent-id", "main",
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(run.stderr.toString()).toContain("--fix disabled");
    expect(readFileSync(items, "utf8")).toBe(before);
  });

  test("migrate-v2 write mode fails closed under active authority", () => {
    const { root, items } = workspace();
    const before = readFileSync(items, "utf8");
    const run = Bun.spawnSync([
      "bun", join(skill, "scripts", "migrate-v2.js"),
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain("LEGACY_MUTATOR_DISABLED");
    expect(readFileSync(items, "utf8")).toBe(before);
    expect(existsSync(join(root, "life", "_derived", "facts-active.md"))).toBe(false);
  });
});
