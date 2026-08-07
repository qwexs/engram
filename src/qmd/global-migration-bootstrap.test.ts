import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapQmdGlobalMigration, type QmdMigrationTopology } from "./global-migration-bootstrap.ts";
import { auditQmdGlobalRegistry } from "./global-registry.ts";

const roots: string[] = [];

function workspace(root: string, id: string): string {
  const path = join(root, id);
  const qmd = join(path, ".qmd");
  mkdirSync(join(path, "memory", `agent-${id}`), { recursive: true });
  mkdirSync(join(path, "life"), { recursive: true });
  mkdirSync(qmd, { recursive: true });
  writeFileSync(join(qmd, "index.yml"), "collections: {}\n");
  writeFileSync(join(path, "engram.json"), `${JSON.stringify({
    agent: `agent-${id}`,
    qmd: { localIndex: true, collection: `${id}-memory`, collections: [`${id}-memory`, "life"] },
  }, null, 2)}\n`);
  const db = new Database(join(qmd, "index.sqlite"));
  db.run("CREATE TABLE store_collections (name TEXT, path TEXT, pattern TEXT)");
  db.run("INSERT INTO store_collections VALUES (?, ?, ?)", [`${id}-memory`, join(path, "memory", `agent-${id}`), "**/*.md"]);
  db.run("INSERT INTO store_collections VALUES (?, ?, ?)", ["life", join(path, "life"), "**/*.md"]);
  db.close();
  return path;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("global migration bootstrap", () => {
  test("discovers owned collections and deterministically renames collisions", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-bootstrap-"));
    roots.push(root);
    const upper = workspace(root, "upper");
    const lower = workspace(root, "lower");
    const topology: QmdMigrationTopology = {
      schema: "engram.qmd.global-migration-topology.v1",
      index: { name: "sample-global", path: join(root, "state", "sample-global.sqlite") },
      workspaces: [
        { id: "upper", path: upper, kind: "business", parents: [] },
        { id: "lower", path: lower, kind: "business", parents: ["upper"] },
      ],
    };
    const manifest = bootstrapQmdGlobalMigration(topology);
    expect(manifest.registry.collections.map((entry) => entry.name)).toEqual([
      "upper-memory", "upper-life", "lower-memory", "lower-life",
    ]);
    expect(manifest.registry.workspaces[0]!.readableCollections).toEqual([
      "lower-life", "lower-memory", "upper-life", "upper-memory",
    ]);
    expect(manifest.workspaces[1]!.kgCollection).toBe("lower-life");
    expect(auditQmdGlobalRegistry(manifest.registry).ok).toBe(true);
  });
});
