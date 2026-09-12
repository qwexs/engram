import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineCanaryQmdRuntimeResolver,
  preflightCanaryQmdBinding,
  resolveCanaryQmdRuntimeBinding,
} from "./qmd-binding-preflight.ts";

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
  const physicalPath = join(base, ".qmd", "index.sqlite");
  mkdirSync(join(base, ".qmd"), { recursive: true });
  if (!existsSync(physicalPath)) writeFileSync(physicalPath, "");
  const context = overrides.context ?? {
    workspace: base,
    physicalIndex: { path: physicalPath, key: createHash("sha256").update(physicalPath).digest("hex"), exists: true },
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
    symlinkSync(target, collectionPath, process.platform === "win32" ? "junction" : "dir");
    expect(() => preflightCanaryQmdBinding(input(base))).toThrow("symlink root escape");
  });

  test("resolves one pinned exact-session collection for a family canary", () => {
    const base = root();
    const value = manifest(base);
    const manifestPath = join(base, "ops", "qmd-migration.json");
    mkdirSync(join(base, "ops"), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify({ registry: value })}\n`);
    const source = input(base);
    const resolver = defineCanaryQmdRuntimeResolver({
      workspace: base,
      workspaceId: "main",
      manifestPath,
      context: source.context,
    });
    const result = resolveCanaryQmdRuntimeBinding({
      workspace: base,
      runtimeSessionKey: source.runtimeSessionKey,
      timezone: source.timezone,
      destinationAt: source.applyAfter,
      resolver,
      context: source.context,
    });
    expect(result.collection).toBe("main-direct-memory");
    expect(result.bindingDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.destinationDir).toBe(join(base, "memory", "agent-main", "telegram-direct-100000001"));
  });

  test("fails closed on manifest drift, a broad mask, or a missing physical index", () => {
    const base = root();
    const value = manifest(base);
    const manifestPath = join(base, "ops", "qmd-migration.json");
    mkdirSync(join(base, "ops"), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(value)}\n`);
    const source = input(base);
    const resolver = defineCanaryQmdRuntimeResolver({
      workspace: base,
      workspaceId: "main",
      manifestPath,
      context: source.context,
    });
    writeFileSync(manifestPath, `${JSON.stringify({ ...value, collections: value.collections.map((entry) => ({ ...entry, mask: "**/*.md" })) })}\n`);
    expect(() => resolveCanaryQmdRuntimeBinding({
      workspace: base,
      runtimeSessionKey: source.runtimeSessionKey,
      timezone: source.timezone,
      destinationAt: source.applyAfter,
      resolver,
      context: source.context,
    })).toThrow("workspace registry digest mismatch");

    writeFileSync(manifestPath, `${JSON.stringify(value)}\n`);
    const broadResolver = defineCanaryQmdRuntimeResolver({ workspace: base, workspaceId: "main", manifestPath, context: source.context });
    const broad = { ...value, collections: value.collections.map((entry) => ({ ...entry, mask: "**/*.md" })) };
    writeFileSync(manifestPath, `${JSON.stringify(broad)}\n`);
    const pinnedBroad = defineCanaryQmdRuntimeResolver({ workspace: base, workspaceId: "main", manifestPath, context: source.context });
    expect(() => resolveCanaryQmdRuntimeBinding({
      workspace: base,
      runtimeSessionKey: source.runtimeSessionKey,
      timezone: source.timezone,
      destinationAt: source.applyAfter,
      resolver: pinnedBroad,
      context: source.context,
    })).toThrow("missing exact-session collection");
    expect(broadResolver.workspaceRegistryDigest).not.toBe(pinnedBroad.workspaceRegistryDigest);

    expect(() => preflightCanaryQmdBinding(input(base, {
      context: { ...source.context, physicalIndex: { ...source.context.physicalIndex, exists: false } },
    }))).toThrow("wrong physical index");
  });

  test("pins only the current workspace registry slice and rejects wildcard runtime keys", () => {
    const base = root();
    const adjacent = root();
    const adjacentOne = join(adjacent, "memory", "agent-adjacent", "main");
    const adjacentTwo = join(adjacent, "memory", "agent-adjacent", "direct");
    mkdirSync(adjacentOne, { recursive: true });
    mkdirSync(adjacentTwo, { recursive: true });
    const value = manifest(base);
    value.workspaces.push({ id: "adjacent", path: adjacent, kind: "technical", parents: [], readableCollections: ["adjacent-memory"] });
    value.collections.push({ name: "adjacent-memory", owner: "adjacent", path: adjacentOne, mask: "*.md" });
    const manifestPath = join(base, "ops", "qmd-migration.json");
    mkdirSync(join(base, "ops"), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(value)}\n`);
    const source = input(base);
    const resolver = defineCanaryQmdRuntimeResolver({ workspace: base, workspaceId: "main", manifestPath, context: source.context });
    const changed = {
      ...value,
      workspaces: value.workspaces.map((entry) => entry.id === "adjacent"
        ? { ...entry, readableCollections: ["adjacent-new"] }
        : entry),
      collections: value.collections.map((entry) => entry.owner === "adjacent"
        ? { ...entry, name: "adjacent-new", path: adjacentTwo }
        : entry),
    };
    writeFileSync(manifestPath, `${JSON.stringify(changed)}\n`);
    expect(resolveCanaryQmdRuntimeBinding({
      workspace: base,
      runtimeSessionKey: source.runtimeSessionKey,
      timezone: source.timezone,
      destinationAt: source.applyAfter,
      resolver,
      context: source.context,
    }).collection).toBe("main-direct-memory");
    expect(() => resolveCanaryQmdRuntimeBinding({
      workspace: base,
      runtimeSessionKey: "agent:main:*",
      timezone: source.timezone,
      destinationAt: source.applyAfter,
      resolver,
      context: source.context,
    })).toThrow("must be exact");
  });
});
