import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightCanaryQmdBinding } from "./qmd-binding-preflight.ts";

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "engram-qmd-binding-"));
  roots.push(value);
  return value;
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function manifest(base: string, overrides: Partial<any> = {}) {
  const collectionPath = join(base, "memory", "agent-main", "telegram-direct-100000001");
  mkdirSync(collectionPath, { recursive: true });
  return {
    schema: "engram.qmd.global-registry.v1",
    index: { name: "engram-global" },
    collections: [{ name: "main-direct-memory", owner: "main", path: collectionPath, mask: "*.md" }, ...(overrides.collections ?? [])],
    workspaces: [{ id: "main", path: base, kind: "technical", parents: [], readableCollections: ["main-direct-memory"] }],
    ...(overrides.index ? { index: overrides.index } : {}),
  };
}

function input(base: string, overrides: Partial<any> = {}) {
  const context = overrides.context ?? {
    workspace: base,
    physicalIndex: { path: join(base, ".qmd", "index.sqlite"), key: "engram-global", exists: true },
    selector: { kind: "named", name: "engram-global" },
    policy: { ownedCollections: ["main-direct-memory"], readableCollections: ["main-direct-memory"] },
  };
  return {
    workspace: base,
    runtimeSessionKey: "agent:main:telegram:direct:100000001",
    qmdCollection: "main-direct-memory",
    timezone: "UTC",
    applyAfter: "2026-08-28T15:00:00.000Z",
    manifest: manifest(base, overrides.manifest ?? {}),
    context,
    ...overrides,
  };
}

describe("canary QMD binding preflight", () => {
  test("accepts the exact binding", () => {
    const base = root();
    const result = preflightCanaryQmdBinding(input(base));
    expect(result).toMatchObject({
      collection: "main-direct-memory",
      destinationDir: join(base, "memory", "agent-main", "telegram-direct-100000001"),
      destinationFile: join(base, "memory", "agent-main", "telegram-direct-100000001", "2026-08-28.md"),
      date: "2026-08-28",
    });
  });

  test("accepts a migration wrapper manifest", () => {
    const base = root();
    const result = preflightCanaryQmdBinding({ ...input(base), manifest: { registry: manifest(base) } });
    expect(result.collection).toBe("main-direct-memory");
  });

  test("rejects missing, duplicate, wrong root, mask, owner, index, and policy cases", () => {
    const base = root();
    const cases = [
      { manifest: { collections: [] } },
      { manifest: { collections: [{ name: "main-direct-memory", owner: "main", path: "/tmp/a", mask: "*.md" }, { name: "main-direct-memory", owner: "main", path: "/tmp/b", mask: "*.md" }] } },
      { manifest: { collections: [{ name: "main-direct-memory", owner: "main", path: join(base, "other"), mask: "*.md" }] } },
      { manifest: { collections: [{ name: "main-direct-memory", owner: "main", path: join(base, "memory", "agent-main", "telegram-direct-100000001"), mask: "**/*.md" }] } },
      { manifest: { collections: [{ name: "main-direct-memory", owner: "other", path: join(base, "memory", "agent-main", "telegram-direct-100000001"), mask: "*.md" }] } },
      { manifest: { index: { name: "wrong" } } },
      { context: { workspace: base, physicalIndex: { path: join(base, ".qmd", "index.sqlite"), key: "engram-global", exists: true }, selector: { kind: "local" }, policy: { ownedCollections: [], readableCollections: [] } } },
    ];
    for (const overrides of cases) expect(() => preflightCanaryQmdBinding(input(base, overrides))).toThrow();
  });

  test("rejects symlink escape", () => {
    const base = root();
    const target = join(base, "escape-target");
    mkdirSync(target, { recursive: true });
    const collectionPath = join(base, "memory", "agent-main", "telegram-direct-100000001");
    mkdirSync(join(base, "memory", "agent-main"), { recursive: true });
    symlinkSync(target, collectionPath);
    expect(() => preflightCanaryQmdBinding(input(base))).toThrow("symlink root escape");
  });
});
