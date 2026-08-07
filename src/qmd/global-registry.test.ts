import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditLegacyCollectionClaims,
  auditQmdGlobalRegistry,
  readLegacyWorkspaceClaim,
} from "./global-registry.ts";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "engram-qmd-registry-"));
  roots.push(value);
  return value;
}

function healthyRegistry(base: string) {
  const paths = Object.fromEntries(["main", "executive-a", "leadership", "organization", "initiative"].map((id) => {
    const path = join(base, id);
    mkdirSync(path, { recursive: true });
    return [id, path];
  }));
  return {
    schema: "engram.qmd.global-registry.v1",
    index: { name: "engram-global" },
    workspaces: [
      { id: "main", path: paths.main, kind: "technical", parents: [], readableCollections: ["main-memory"] },
      { id: "executive-a", path: paths["executive-a"], kind: "business", parents: [], readableCollections: ["executive-a-memory", "leadership-memory", "organization-memory", "initiative-memory"] },
      { id: "leadership", path: paths.leadership, kind: "business", parents: ["executive-a"], readableCollections: ["leadership-memory", "organization-memory", "initiative-memory"] },
      { id: "organization", path: paths.organization, kind: "business", parents: ["leadership"], readableCollections: ["organization-memory", "initiative-memory"] },
      { id: "initiative", path: paths.initiative, kind: "business", parents: ["organization"], readableCollections: ["initiative-memory"] },
    ],
    collections: [
      { name: "main-memory", path: join(paths.main, "memory"), owner: "main", mask: "**/*.md" },
      { name: "executive-a-memory", path: join(paths["executive-a"], "memory"), owner: "executive-a", mask: "**/*.md" },
      { name: "leadership-memory", path: join(paths.leadership, "memory"), owner: "leadership", mask: "**/*.md" },
      { name: "organization-memory", path: join(paths.organization, "memory"), owner: "organization", mask: "**/*.md" },
      { name: "initiative-memory", path: join(paths.initiative, "memory"), owner: "initiative", mask: "**/*.md" },
    ],
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("global QMD registry", () => {
  test("rejects an empty registry even when schema and index are present", () => {
    const result = auditQmdGlobalRegistry({
      schema: "engram.qmd.global-registry.v1",
      index: { name: "engram-global" },
    });
    expect(result.ok).toBe(false);
    expect(result.findings.map((entry) => entry.code)).toEqual([
      "INVALID_WORKSPACE",
      "INVALID_COLLECTION",
    ]);
  });

  test("accepts one global index with isolated technical scope and downward business reads", () => {
    const result = auditQmdGlobalRegistry(healthyRegistry(root()));
    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ workspaces: 5, collections: 5, errors: 0, warnings: 0 });
  });

  test("rejects client collections in the technical main scope", () => {
    const registry = healthyRegistry(root());
    registry.workspaces[0].readableCollections.push("initiative-memory");
    expect(auditQmdGlobalRegistry(registry).findings.map((entry) => entry.code))
      .toContain("TECHNICAL_SCOPE_ESCAPE");
  });

  test("rejects horizontal and upward business access", () => {
    const registry = healthyRegistry(root());
    registry.workspaces[4].readableCollections.push("organization-memory");
    expect(auditQmdGlobalRegistry(registry).findings.map((entry) => entry.code))
      .toContain("HORIZONTAL_OR_UPWARD_ACCESS");
  });

  test("rejects duplicate names, duplicate paths, and nested collection roots", () => {
    const registry = healthyRegistry(root());
    registry.collections.push({
      name: "initiative-memory",
      path: registry.collections[4].path,
      owner: "initiative",
      mask: "**/*.md",
    });
    registry.collections.push({
      name: "initiative-topic",
      path: join(registry.collections[4].path, "topic"),
      owner: "initiative",
      mask: "**/*.md",
    });
    const codes = auditQmdGlobalRegistry(registry).findings.map((entry) => entry.code);
    expect(codes).toContain("DUPLICATE_COLLECTION");
    expect(codes).toContain("DUPLICATE_COLLECTION_PATH");
    expect(codes).toContain("OVERLAPPING_COLLECTION_PATH");
  });

  test("rejects duplicate workspace paths and collections outside their owner", () => {
    const registry = healthyRegistry(root());
    registry.workspaces[4].path = registry.workspaces[3].path;
    registry.collections[4].path = join(registry.workspaces[1].path, "foreign");
    const codes = auditQmdGlobalRegistry(registry).findings.map((entry) => entry.code);
    expect(codes).toContain("DUPLICATE_WORKSPACE_PATH");
    expect(codes).toContain("COLLECTION_OUTSIDE_OWNER");
  });

  test("rejects hierarchy cycles", () => {
    const registry = healthyRegistry(root());
    registry.workspaces[1].parents.push("initiative");
    expect(auditQmdGlobalRegistry(registry).findings.map((entry) => entry.code))
      .toContain("WORKSPACE_CYCLE");
  });

  test("detects legacy life/ops claims before migration", () => {
    const base = root();
    const workspaces = ["alpha", "beta"].map((id) => {
      const path = join(base, id);
      mkdirSync(path);
      writeFileSync(join(path, "engram.json"), JSON.stringify({
        qmd: { collections: [`${id}-memory`, "life", "ops"] },
      }));
      return readLegacyWorkspaceClaim(path);
    });
    const findings = auditLegacyCollectionClaims(workspaces);
    expect(findings.map((entry) => entry.details?.collection)).toEqual(["life", "ops"]);
    expect(findings.every((entry) => entry.code === "LEGACY_DUPLICATE_COLLECTION_CLAIM")).toBe(true);
  });
});
