import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  markWorkspaceQmdDirty,
  resolveQmdMaintenanceMode,
  resolveQmdMaintenanceStateRoot,
  type QmdMaintenanceIntegrationRuntime,
} from "./maintenance-integration.ts";
import { readQmdMaintenanceState } from "./maintenance.ts";

const roots: string[] = [];

function workspace(mode?: string): string {
  const root = mkdtempSync(join(tmpdir(), "engram-qmd-shadow-"));
  roots.push(root);
  writeFileSync(join(root, "engram.json"), JSON.stringify({
    qmd: {
      index: "global",
      collection: "alpha-memory",
      collections: ["alpha-memory", "alpha-domains", "alpha-life"],
      workspaceKgCollection: "alpha-life",
      ...(mode === undefined ? {} : { maintenance: { mode } }),
    },
  }));
  return root;
}

function stateDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "engram-qmd-shadow-state-"));
  roots.push(root);
  return root;
}

function runtime(state: string, warnings: string[] = []): QmdMaintenanceIntegrationRuntime {
  return {
    env: { OPENCLAW_STATE_DIR: state, XDG_CACHE_HOME: join(state, "cache") },
    homedir: () => join(state, "home"),
    platform: "linux",
    warn: (message) => warnings.push(message),
    markDirty: async (stateRoot, input) => {
      const { markQmdDirty } = await import("./maintenance.ts");
      return markQmdDirty(stateRoot, input);
    },
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("QMD maintenance integration", () => {
  test("defaults to legacy and creates no maintenance state", async () => {
    const root = workspace();
    const state = stateDirectory();
    const result = await markWorkspaceQmdDirty({ workspace: root, reason: "write" }, runtime(state));

    expect(result.status).toBe("disabled");
    expect(result.mode).toBe("legacy");
    expect(existsSync(resolveQmdMaintenanceStateRoot(runtime(state)))).toBe(false);
  });

  test("shadow mode marks the resolved physical index without running QMD", async () => {
    const root = workspace("shadow");
    const state = stateDirectory();
    const result = await markWorkspaceQmdDirty({
      workspace: root,
      reason: "daily-note-write",
    }, runtime(state));

    expect(result).toMatchObject({
      status: "marked",
      mode: "shadow",
      generation: 1,
      collections: ["alpha-memory"],
    });
    const stored = readQmdMaintenanceState(
      resolveQmdMaintenanceStateRoot(runtime(state)),
      result.indexKey!,
    );
    expect(stored.dirty).toMatchObject({ bm25: true, vectors: true, collections: ["alpha-memory"] });
  });

  test("coalesces marks from owned collections on the same index", async () => {
    const root = workspace("shadow");
    const state = stateDirectory();
    const rt = runtime(state);
    const first = await markWorkspaceQmdDirty({
      workspace: root,
      collections: ["alpha-memory"],
      reason: "note",
    }, rt);
    const second = await markWorkspaceQmdDirty({
      workspace: root,
      collections: ["alpha-domains"],
      reason: "domain",
    }, rt);

    expect(first.indexKey).toBe(second.indexKey);
    expect(second.generation).toBe(2);
    expect(readQmdMaintenanceState(resolveQmdMaintenanceStateRoot(rt), second.indexKey!).dirty.collections)
      .toEqual(["alpha-domains", "alpha-memory"]);
  });

  test("maps knowledge-graph writes to the canonical shared-index collection", async () => {
    const root = workspace("coordinated");
    const state = stateDirectory();
    const result = await markWorkspaceQmdDirty({
      workspace: root,
      collectionRole: "knowledge-graph",
      reason: "fact-write",
    }, runtime(state));

    expect(result).toMatchObject({
      status: "marked",
      mode: "coordinated",
      collections: ["alpha-life"],
    });
  });

  test("fails open and reports collections outside workspace ownership", async () => {
    const root = workspace("shadow");
    const warnings: string[] = [];
    const result = await markWorkspaceQmdDirty({
      workspace: root,
      collections: ["beta-memory"],
      reason: "unsafe",
    }, runtime(stateDirectory(), warnings));

    expect(result.status).toBe("error");
    expect(result.error).toContain("outside workspace ownership");
    expect(warnings).toHaveLength(1);
  });

  test("fails open when state persistence fails", async () => {
    const root = workspace("shadow");
    const warnings: string[] = [];
    const rt = runtime(stateDirectory(), warnings);
    rt.markDirty = async () => { throw new Error("disk unavailable"); };

    const result = await markWorkspaceQmdDirty({ workspace: root, reason: "write" }, rt);
    expect(result).toMatchObject({ status: "error", error: "disk unavailable" });
    expect(warnings[0]).toContain("failed open");
  });

  test("fails open instead of storing maintenance state inside the workspace", async () => {
    const root = workspace("shadow");
    const warnings: string[] = [];
    const result = await markWorkspaceQmdDirty(
      { workspace: root, reason: "write" },
      runtime(join(root, "openclaw-state"), warnings),
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("outside indexed workspace");
    expect(warnings).toHaveLength(1);
  });

  test("rejects unknown maintenance modes", () => {
    expect(() => resolveQmdMaintenanceMode({ qmd: { maintenance: { mode: "fast" } } }))
      .toThrow("legacy, shadow, or coordinated");
  });
});
