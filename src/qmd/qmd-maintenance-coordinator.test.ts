import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
const script = resolve(import.meta.dir, "../../scripts/qmd-maintenance-coordinator.ts");

function root(): string { const value = mkdtempSync(join(tmpdir(), "engram-qmd-cli-")); roots.push(value); return value; }
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function manifest(base: string): string {
  const path = join(base, "manifest.json");
  mkdirSync(join(base, "memory", "agent-main", "telegram-direct-100000001"), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schema: "engram.qmd.global-registry.v1",
    index: { name: "sample-global" },
    workspaces: [{ id: "main", path: base, kind: "technical", parents: [], readableCollections: ["test-memory"] }],
    collections: [{ name: "test-memory", path: join(base, "memory", "agent-main", "telegram-direct-100000001"), owner: "main", mask: "*.md" }],
  }));
  return path;
}

describe("qmd maintenance coordinator cli", () => {
  test("rejects missing collections and incompatible initial flags", () => {
    const base = root();
    const man = manifest(base);
    const missing = spawnSync("bun", [script, "--manifest", man, "--workspace", base, "--initial-sync"], { encoding: "utf8" });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("--collections is required");
    const incompatible = spawnSync("bun", [script, "--manifest", man, "--workspace", base, "--collections", "test-memory", "--initial-backfill", "--initial-sync"], { encoding: "utf8" });
    expect(incompatible.status).toBe(1);
    expect(incompatible.stderr).toContain("mutually exclusive");
  });
});
