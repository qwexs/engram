import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyQmdGlobalProvisioning,
  planQmdGlobalProvisioning,
  rollbackQmdGlobalProvisioning,
  type QmdProvisionRuntime,
} from "./global-provisioning.ts";
import { resolveQmdContext } from "./context.ts";
import type { QmdGlobalMigrationManifest } from "./global-migration.ts";
import type { QmdInvocation, QmdRunResult } from "./types.ts";

const roots: string[] = [];

function createIndex(path: string, rows: Array<{ name: string; path: string; mask: string }> = []): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.run("CREATE TABLE IF NOT EXISTS store_collections (name TEXT PRIMARY KEY, path TEXT, pattern TEXT)");
  for (const row of rows) db.run("INSERT INTO store_collections VALUES (?, ?, ?)", [row.name, row.path, row.mask]);
  db.close();
}

function collectionNames(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT name FROM store_collections ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function fixture(): { root: string; manifest: QmdGlobalMigrationManifest } {
  const root = mkdtempSync(join(tmpdir(), "engram-global-provision-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const memory = join(workspace, "memory", "agent-sample");
  const life = join(workspace, "life");
  mkdirSync(join(workspace, ".qmd"), { recursive: true });
  mkdirSync(memory, { recursive: true });
  mkdirSync(life, { recursive: true });
  writeFileSync(join(workspace, ".qmd", "index.yml"), "collections: {}\n");
  writeFileSync(join(workspace, "engram.json"), JSON.stringify({
    agent: "agent-sample",
    qmd: { localIndex: true, collection: "sample-memory", collections: ["sample-memory"] },
  }));
  createIndex(join(workspace, ".qmd", "index.sqlite"), [
    { name: "sample-memory", path: memory, mask: "**/*.md" },
  ]);
  return {
    root,
    manifest: {
      schema: "engram.qmd.global-migration.v1",
      indexPath: join(root, "cache", "sample-global.sqlite"),
      registry: {
        schema: "engram.qmd.global-registry.v1",
        index: { name: "sample-global" },
        workspaces: [{
          id: "sample",
          path: workspace,
          kind: "technical",
          parents: [],
          readableCollections: ["sample-memory", "sample-life"],
        }],
        collections: [
          { name: "sample-memory", path: memory, owner: "sample", mask: "**/*.md" },
          { name: "sample-life", path: life, owner: "sample", mask: "**/*.md" },
        ],
      },
      workspaces: [],
    },
  };
}

function runtime(target: string, seen: QmdInvocation[], fail = false): QmdProvisionRuntime {
  return {
    resolveContext: resolveQmdContext,
    resolveNamedIndexPath: () => target,
    run: async (_context, invocation): Promise<QmdRunResult> => {
      seen.push(invocation);
      if (!fail) {
        const add = invocation.argv.indexOf("add");
        const name = invocation.argv[invocation.argv.indexOf("--name") + 1]!;
        const mask = invocation.argv[invocation.argv.indexOf("--mask") + 1]!;
        const path = invocation.argv[add + 1]!;
        if (!existsSync(target)) createIndex(target);
        const db = new Database(target);
        db.run("INSERT INTO store_collections VALUES (?, ?, ?)", [name, path, mask]);
        db.close();
      }
      return {
        schema: "engram.qmd.run.v1",
        ok: !fail,
        stdout: "",
        stderr: fail ? "synthetic failure" : "",
        exitCode: fail ? 1 : 0,
        signal: null,
        timedOut: false,
        operationRecord: {} as QmdRunResult["operationRecord"],
      };
    },
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("global index provisioning", () => {
  test("dry-run reports additions without creating the target index", () => {
    const item = fixture();
    const plan = planQmdGlobalProvisioning(item.manifest);
    expect(plan.summary).toEqual({ collections: 2, add: 2, present: 0 });
    expect(plan.targetExists).toBe(false);
    expect(existsSync(item.manifest.indexPath)).toBe(false);
  });

  test("apply is argv-safe and idempotent; rollback removes a newly created target", async () => {
    const item = fixture();
    const seen: QmdInvocation[] = [];
    const backup = join(item.root, "backup");
    const result = await applyQmdGlobalProvisioning(
      item.manifest,
      backup,
      "sample-global",
      runtime(item.manifest.indexPath, seen),
    );
    expect(result.addedCollections).toEqual(["sample-memory", "sample-life"]);
    expect(seen).toHaveLength(2);
    expect(seen.every((entry) => entry.operation === "collection-add" && !entry.argv.includes("-f"))).toBe(true);
    expect(planQmdGlobalProvisioning(item.manifest).summary).toEqual({ collections: 2, add: 0, present: 2 });
    rollbackQmdGlobalProvisioning(join(backup, "manifest.json"), "sample-global", () => item.manifest.indexPath);
    expect(existsSync(item.manifest.indexPath)).toBe(false);
  });

  test("detects path drift and restores a new target after a failed add", async () => {
    const item = fixture();
    createIndex(item.manifest.indexPath, [{
      name: "sample-memory",
      path: join(item.root, "wrong"),
      mask: "**/*.md",
    }]);
    expect(() => planQmdGlobalProvisioning(item.manifest)).toThrow("collection drift");
    rmSync(item.manifest.indexPath);

    await expect(applyQmdGlobalProvisioning(
      item.manifest,
      join(item.root, "backup"),
      "sample-global",
      runtime(item.manifest.indexPath, [], true),
    )).rejects.toThrow("collection add failed");
    expect(existsSync(item.manifest.indexPath)).toBe(false);
  });

  test("rejects unmanaged target collections and named-index path mismatch", async () => {
    const item = fixture();
    createIndex(item.manifest.indexPath, [{ name: "foreign", path: join(item.root, "foreign"), mask: "**/*.md" }]);
    expect(() => planQmdGlobalProvisioning(item.manifest)).toThrow("unmanaged collections");
    rmSync(item.manifest.indexPath);

    const wrongRuntime = runtime(item.manifest.indexPath, []);
    wrongRuntime.resolveNamedIndexPath = () => join(item.root, "other.sqlite");
    await expect(applyQmdGlobalProvisioning(
      item.manifest,
      join(item.root, "backup"),
      "sample-global",
      wrongRuntime,
    )).rejects.toThrow("different physical SQLite");
    expect(existsSync(item.manifest.indexPath)).toBe(false);
  });

  test("backs up an existing index and restores it on rollback", async () => {
    const item = fixture();
    const first = item.manifest.registry.collections[0]!;
    createIndex(item.manifest.indexPath, [{ name: first.name, path: first.path, mask: first.mask }]);
    const backup = join(item.root, "backup");
    await applyQmdGlobalProvisioning(item.manifest, backup, "sample-global", runtime(item.manifest.indexPath, []));
    expect(planQmdGlobalProvisioning(item.manifest).summary.add).toBe(0);
    rollbackQmdGlobalProvisioning(join(backup, "manifest.json"), "sample-global", () => item.manifest.indexPath);
    expect(collectionNames(item.manifest.indexPath)).toEqual(["sample-memory"]);
    expect(planQmdGlobalProvisioning(item.manifest).summary).toEqual({ collections: 2, add: 1, present: 1 });
  });

  test("does not remove a provisioning lock owned by another process", async () => {
    const item = fixture();
    mkdirSync(dirname(item.manifest.indexPath), { recursive: true });
    const lock = `${item.manifest.indexPath}.engram-provision.lock`;
    writeFileSync(lock, "other owner\n");
    await expect(applyQmdGlobalProvisioning(
      item.manifest,
      join(item.root, "backup"),
      "sample-global",
      runtime(item.manifest.indexPath, []),
    )).rejects.toThrow();
    expect(existsSync(lock)).toBe(true);
  });

  test("incomplete backup requires an explicit recovery flag", async () => {
    const item = fixture();
    const backup = join(item.root, "backup");
    await applyQmdGlobalProvisioning(item.manifest, backup, "sample-global", runtime(item.manifest.indexPath, []));
    const path = join(backup, "manifest.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.status = "prepared";
    record.afterSha256 = null;
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    expect(() => rollbackQmdGlobalProvisioning(
      path,
      "sample-global",
      () => item.manifest.indexPath,
    )).toThrow("explicit recovery");
    rollbackQmdGlobalProvisioning(path, "sample-global", () => item.manifest.indexPath, true);
    expect(existsSync(item.manifest.indexPath)).toBe(false);
  });
});
