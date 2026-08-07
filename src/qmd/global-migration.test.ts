import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyQmdGlobalMigration,
  planQmdGlobalMigration,
  rollbackQmdGlobalMigration,
  type QmdGlobalMigrationManifest,
} from "./global-migration.ts";

const roots: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture(): { root: string; manifest: QmdGlobalMigrationManifest; config: string; registry: string } {
  const root = mkdtempSync(join(tmpdir(), "engram-global-migration-"));
  roots.push(root);
  const workspace = join(root, "sample-workspace");
  const domains = join(workspace, "memory", "domains");
  mkdirSync(domains, { recursive: true });
  const config = JSON.stringify({
    agent: "agent-sample",
    qmd: { localIndex: true, collection: "memory", collections: ["memory", "life"] },
    domains: { general: { type: "meta-domain", qmdCollections: ["memory"] } },
  }, null, 2) + "\n";
  const registry = JSON.stringify({
    domains: { general: { type: "meta-domain", qmdCollections: ["memory"] } },
  }, null, 2) + "\n";
  writeFileSync(join(workspace, "engram.json"), config);
  writeFileSync(join(domains, "registry.json"), registry);
  const memoryPath = join(workspace, "memory", "agent-sample");
  const lifePath = join(workspace, "life");
  mkdirSync(memoryPath, { recursive: true });
  mkdirSync(lifePath, { recursive: true });
  return {
    root,
    config,
    registry,
    manifest: {
      schema: "engram.qmd.global-migration.v1",
      indexPath: join(root, "state", "global.sqlite"),
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
          { name: "sample-memory", path: memoryPath, owner: "sample", mask: "**/*.md" },
          { name: "sample-life", path: lifePath, owner: "sample", mask: "**/*.md" },
        ],
      },
      workspaces: [{
        id: "sample",
        primaryCollection: "sample-memory",
        kgCollection: "sample-life",
        collectionRenames: { memory: "sample-memory", life: "sample-life" },
        expectedSha256: { engramConfig: hash(config), domainRegistry: hash(registry) },
      }],
    },
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("global QMD migration", () => {
  test("dry-run is deterministic and performs no writes", () => {
    const item = fixture();
    const first = planQmdGlobalMigration(item.manifest);
    const second = planQmdGlobalMigration(item.manifest);
    expect(first).toEqual(second);
    expect(first.summary).toEqual({ workspaces: 1, files: 2, changed: 2 });
    expect(readFileSync(first.files[0]!.path, "utf8")).toBe(item.config);
    expect(first.files[0]!.content).toContain('"index": "sample-global"');
    expect(first.files[0]!.content).toContain('"mode": "coordinated"');
  });

  test("apply requires exact confirmation, backs up, and rollback restores", () => {
    const item = fixture();
    const plan = planQmdGlobalMigration(item.manifest);
    const backup = join(item.root, "backup");
    expect(() => applyQmdGlobalMigration(plan, backup, "wrong-index")).toThrow();
    const result = applyQmdGlobalMigration(plan, backup, "sample-global");
    const backupManifest = join(backup, "manifest.json");
    expect(existsSync(backupManifest)).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(readFileSync(plan.files[0]!.path, "utf8")).toBe(plan.files[0]!.content);
    rollbackQmdGlobalMigration(backupManifest);
    expect(readFileSync(plan.files[0]!.path, "utf8")).toBe(item.config);
    expect(readFileSync(plan.files[1]!.path, "utf8")).toBe(item.registry);
  });

  test("refuses drift before apply and refuses rollback over later changes", () => {
    const item = fixture();
    const plan = planQmdGlobalMigration(item.manifest);
    writeFileSync(plan.files[0]!.path, "{}\n");
    expect(() => applyQmdGlobalMigration(plan, join(item.root, "backup-a"), "sample-global")).toThrow("source hash drift");

    writeFileSync(plan.files[0]!.path, item.config);
    const backup = join(item.root, "backup-b");
    applyQmdGlobalMigration(plan, backup, "sample-global");
    writeFileSync(plan.files[0]!.path, "{}\n");
    expect(() => rollbackQmdGlobalMigration(join(backup, "manifest.json"))).toThrow("target changed");
  });

  test("rollback rejects restore paths not authorized by its own manifest contract", () => {
    const item = fixture();
    const plan = planQmdGlobalMigration(item.manifest);
    const backup = join(item.root, "backup");
    applyQmdGlobalMigration(plan, backup, "sample-global");
    const path = join(backup, "manifest.json");
    const tampered = JSON.parse(readFileSync(path, "utf8"));
    tampered.files[0].target = join(item.root, "unrelated.json");
    writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`);
    expect(() => rollbackQmdGlobalMigration(path)).toThrow("unauthorized restore path");
  });
});
