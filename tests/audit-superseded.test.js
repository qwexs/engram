import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "engram-audit-"));
  mkdirSync(join(root, "life", "projects", "test"), { recursive: true });
  writeFileSync(join(root, "engram.json"), JSON.stringify({ agent: "agent-main" }));
  return root;
}

function seedEntity(root, entity, facts) {
  const entityPath = join(root, "life", entity);
  mkdirSync(entityPath, { recursive: true });
  const data = { entityId: entity, entityType: "project", facts };
  writeFileSync(join(entityPath, "items.json"), JSON.stringify(data, null, 2));
}

function runAudit(args, cwd) {
  return spawnSync("bun", [
    join(import.meta.dir, "..", "scripts", "audit-superseded.js"),
    ...args,
  ], {
    cwd: cwd || join(import.meta.dir, ".."),
    encoding: "utf8",
    shell: false,
  });
}

describe("audit-superseded", () => {
  test("dry-run reports orphans but does not write to disk", async () => {
    const root = makeWorkspace();
    try {
      const itemsPath = join(root, "life", "projects", "test", "items.json");
      const beforeMtime = existsSync(itemsPath) ? readFileSync(itemsPath, "utf8") : null;

      seedEntity(root, "projects/test", [
        {
          id: "test-001",
          fact: "Some orphan superseded fact",
          category: "preference",
          status: "superseded",
          supersededBy: null,
          confidence: 0.7,
          abstractionLevel: "episode",
          tags: [],
          timestamp: "2026-05-21",
          source: "test",
          lastAccessed: "2026-05-21",
          accessCount: 1,
        },
      ]);

      const proc = runAudit([
        "--workspace", root,
        "--entity", "projects/test",
        "--dry-run",
        "--jaccard-threshold", "0.5",
      ]);
      const report = JSON.parse(proc.stdout);

      expect(report.mode).toBe("dry-run");
      expect(report.superseded_orphan_count).toBe(1);
      expect(report.entities).toHaveLength(1);

      // File contents unchanged in dry-run
      const afterMtime = readFileSync(itemsPath, "utf8");
      expect(afterMtime).toContain("\"supersededBy\": null");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("auto-fix with high Jaccard match sets supersededBy target", async () => {
    const root = makeWorkspace();
    try {
      seedEntity(root, "projects/test", [
        {
          id: "test-001",
          fact: "Use cleanup keep for hb-extract subagents to preserve debug history",
          category: "preference",
          status: "superseded",
          supersededBy: null,
          confidence: 0.7,
          abstractionLevel: "episode",
          tags: [],
          timestamp: "2026-05-21",
          source: "test",
          lastAccessed: "2026-05-21",
          accessCount: 1,
        },
        {
          id: "test-002",
          fact: "Use cleanup keep for hb-extract subagents to preserve debug history forever",
          category: "preference",
          status: "active",
          supersededBy: null,
          confidence: 0.85,
          abstractionLevel: "pattern",
          tags: [],
          timestamp: "2026-05-21",
          source: "test",
          lastAccessed: "2026-05-21",
          accessCount: 1,
        },
      ]);

      const proc = runAudit([
        "--workspace", root,
        "--entity", "projects/test",
        "--auto-fix",
        "--jaccard-threshold", "0.7",
      ]);
      const report = JSON.parse(proc.stdout);

      expect(report.mode).toBe("write");
      expect(report.auto_fixed_count).toBe(1);
      expect(report.entities[0].auto_fixed[0].id).toBe("test-001");
      expect(report.entities[0].auto_fixed[0].target).toBe("test-002");

      // File now reflects the fix
      const after = JSON.parse(readFileSync(join(root, "life", "projects", "test", "items.json"), "utf8"));
      const orphan = after.facts.find((f) => f.id === "test-001");
      expect(orphan.supersededBy).toBe("test-002");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("low Jaccard marks pending by default, no auto-fix", async () => {
    const root = makeWorkspace();
    try {
      seedEntity(root, "projects/test", [
        {
          id: "test-001",
          fact: "Orphan fact about apples and oranges",
          category: "preference",
          status: "superseded",
          supersededBy: null,
          confidence: 0.7,
          abstractionLevel: "episode",
          tags: [],
          timestamp: "2026-05-21",
          source: "test",
          lastAccessed: "2026-05-21",
          accessCount: 1,
        },
        {
          id: "test-002",
          fact: "Completely unrelated fact about spaceships and quantum mechanics",
          category: "preference",
          status: "active",
          supersededBy: null,
          confidence: 0.85,
          abstractionLevel: "pattern",
          tags: [],
          timestamp: "2026-05-21",
          source: "test",
          lastAccessed: "2026-05-21",
          accessCount: 1,
        },
      ]);

      const proc = runAudit([
        "--workspace", root,
        "--entity", "projects/test",
        "--auto-fix",
      ]);
      const report = JSON.parse(proc.stdout);

      expect(report.auto_fixed_count).toBe(0);
      expect(report.marked_pending_count).toBe(1);
      expect(report.entities[0].marked_pending[0].id).toBe("test-001");

      const after = JSON.parse(readFileSync(join(root, "life", "projects", "test", "items.json"), "utf8"));
      const orphan = after.facts.find((f) => f.id === "test-001");
      expect(orphan.status).toBe("pending");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--no-mark-pending leaves status unchanged", async () => {
    const root = makeWorkspace();
    try {
      seedEntity(root, "projects/test", [
        {
          id: "test-001",
          fact: "Orphan fact about apples and oranges",
          category: "preference",
          status: "superseded",
          supersededBy: null,
          confidence: 0.7,
          abstractionLevel: "episode",
          tags: [],
          timestamp: "2026-05-21",
          source: "test",
          lastAccessed: "2026-05-21",
          accessCount: 1,
        },
      ]);

      const proc = runAudit([
        "--workspace", root,
        "--entity", "projects/test",
        "--no-mark-pending",
      ]);
      const report = JSON.parse(proc.stdout);

      expect(report.marked_pending_count).toBe(0);
      expect(report.still_unresolved_count).toBe(1);

      const after = JSON.parse(readFileSync(join(root, "life", "projects", "test", "items.json"), "utf8"));
      const orphan = after.facts.find((f) => f.id === "test-001");
      expect(orphan.status).toBe("superseded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips superseded facts that already have a target", async () => {
    const root = makeWorkspace();
    try {
      seedEntity(root, "projects/test", [
        {
          id: "test-001",
          fact: "Old fact already superseded correctly",
          category: "preference",
          status: "superseded",
          supersededBy: "test-002",
          confidence: 0.7,
          abstractionLevel: "episode",
          tags: [],
          timestamp: "2026-05-21",
          source: "test",
          lastAccessed: "2026-05-21",
          accessCount: 1,
        },
      ]);

      const proc = runAudit([
        "--workspace", root,
        "--entity", "projects/test",
      ]);
      const report = JSON.parse(proc.stdout);

      expect(report.superseded_orphan_count).toBe(0);
      expect(report.auto_fixed_count).toBe(0);
      expect(report.marked_pending_count).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scans all entities when --entity not specified", async () => {
    const root = makeWorkspace();
    try {
      mkdirSync(join(root, "life", "people", "alice"), { recursive: true });
      seedEntity(root, "projects/test", [
        {
          id: "test-001",
          fact: "Project orphan fact",
          category: "preference",
          status: "superseded",
          supersededBy: null,
          confidence: 0.7,
          abstractionLevel: "episode",
          tags: [],
          timestamp: "2026-05-21",
          source: "test",
          lastAccessed: "2026-05-21",
          accessCount: 1,
        },
      ]);
      writeFileSync(
        join(root, "life", "people", "alice", "items.json"),
        JSON.stringify({
          entityId: "people/alice",
          entityType: "person",
          facts: [{
            id: "alice-001",
            fact: "Person orphan fact",
            category: "preference",
            status: "superseded",
            supersededBy: null,
            confidence: 0.7,
            abstractionLevel: "episode",
            tags: [],
            timestamp: "2026-05-21",
            source: "test",
            lastAccessed: "2026-05-21",
            accessCount: 1,
          }],
        }, null, 2)
      );

      const proc = runAudit(["--workspace", root, "--dry-run"]);
      const report = JSON.parse(proc.stdout);

      expect(report.entities_scanned).toBe(2);
      expect(report.superseded_orphan_count).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});