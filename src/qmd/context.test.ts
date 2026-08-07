import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, EXIT_CODES } from "../cli/errors.ts";
import { resolveQmdContext, type QmdContextRuntime } from "./context.ts";

const roots: string[] = [];
const runtime = (env: Record<string, string | undefined> = {}): QmdContextRuntime => ({
  env,
  homedir: () => "/home/tester",
  platform: "linux",
});

function workspace(config: Record<string, unknown>, localConfig?: "yml" | "yaml"): string {
  const root = mkdtempSync(join(tmpdir(), "engram-qmd-context-"));
  roots.push(root);
  writeFileSync(join(root, "engram.json"), JSON.stringify(config));
  if (localConfig) {
    mkdirSync(join(root, ".qmd"));
    writeFileSync(join(root, ".qmd", `index.${localConfig}`), "collections: {}\n");
  }
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("resolveQmdContext", () => {
  test("resolves a canonical local index and merges readable policy", () => {
    const root = workspace({
      qmd: {
        command: "/usr/bin/qmd",
        commandArgs: ["--no-gpu"],
        localIndex: true,
        collection: "self-memory",
        collections: ["self-memory", "life"],
        verticalAccess: {
          enabled: true,
          collections: { "child-memory": { path: "/child" } },
        },
      },
      domains: {
        general: { type: "meta-domain", qmdCollections: ["child-memory", "child-domains"] },
      },
    }, "yaml");
    const alias = `${root}-alias`;
    roots.push(alias);
    symlinkSync(root, alias);

    const context = resolveQmdContext({ value: alias, source: "explicit" }, runtime());

    expect(context).toMatchObject({
      workspace: root,
      workspaceSource: "explicit",
      topology: "isolated",
      selector: { kind: "local" },
      physicalIndex: { path: join(root, ".qmd", "index.sqlite"), exists: false },
      command: { executable: "/usr/bin/qmd", prefixArgs: ["--no-gpu"] },
      policy: {
        ownedCollections: ["self-memory", "life"],
        readableCollections: ["self-memory", "life", "child-memory", "child-domains"],
      },
      warnings: [],
    });
    expect(context.physicalIndex.key).toMatch(/^[a-f0-9]{64}$/);
  });

  test("keeps localIndex topology isolated but falls back to the global selector", () => {
    const root = workspace({ qmd: { localIndex: true, collection: "main-memory" } });
    const context = resolveQmdContext({ value: root, source: "cwd" }, runtime({ XDG_CACHE_HOME: "/cache" }));

    expect(context.topology).toBe("isolated");
    expect(context.selector).toEqual({ kind: "global" });
    expect(context.physicalIndex.path).toBe("/cache/qmd/index.sqlite");
    expect(context.policy.ownedCollections).toEqual(["main-memory"]);
    expect(context.warnings.map((warning) => warning.code)).toEqual([
      "LEGACY_COLLECTION_NORMALIZED",
      "LOCAL_INDEX_CONFIG_MISSING",
    ]);
  });

  test("resolves named indexes in XDG cache without adding invocation args", () => {
    const root = workspace({
      qmd: { index: "team", collections: ["team-memory"], command: "qmd", commandArgs: ["--no-gpu"] },
    });
    const context = resolveQmdContext({ value: root, source: "env" }, runtime({ XDG_CACHE_HOME: "/xdg" }));

    expect(context).toMatchObject({
      workspaceSource: "env",
      topology: "shared",
      selector: { kind: "named", name: "team" },
      physicalIndex: { path: "/xdg/qmd/team.sqlite" },
      command: { executable: "qmd", prefixArgs: ["--no-gpu"] },
    });
  });

  test("preserves an executable path containing spaces as one command value", () => {
    const root = workspace({
      qmd: {
        collections: ["self"],
        command: "/opt/QMD Tools/bin/qmd",
        commandArgs: ["--no-gpu"],
      },
    });

    expect(resolveQmdContext({ value: root, source: "cwd" }, runtime()).command).toEqual({
      executable: "/opt/QMD Tools/bin/qmd",
      prefixArgs: ["--no-gpu"],
    });
  });

  test("uses meta-domain collections from the registry independently of vertical access", () => {
    const root = workspace({ qmd: { collections: ["self"] } });
    mkdirSync(join(root, "memory", "domains"), { recursive: true });
    writeFileSync(join(root, "memory", "domains", "registry.json"), JSON.stringify({
      domains: { general: { metaDomain: true, qmdCollections: ["project-memory"] } },
    }));

    expect(resolveQmdContext({ value: root, source: "cwd" }, runtime()).policy.readableCollections)
      .toEqual(["self", "project-memory"]);
  });

  test.each([
    [{ qmd: { localIndex: true, index: "team", collections: ["self"] } }, "conflicts"],
    [{ qmd: { collections: [] } }, "at least one collection"],
    [{ qmd: { collection: "primary", collections: ["other"] } }, "outside"],
    [{ qmd: { command: "qmd --no-gpu", collections: ["self"] } }, "only the executable"],
    [{ qmd: { localIndex: "true", collections: ["self"] } }, "must be a boolean"],
    [{ qmd: { index: "../team", collections: ["self"] } }, "not a filesystem path"],
  ])("rejects invalid context %#", (config, message) => {
    const root = workspace(config);
    try {
      resolveQmdContext({ value: root, source: "cwd" }, runtime());
      throw new Error("expected context error");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect(error).toMatchObject({ code: "CONTEXT", exitCode: EXIT_CODES.CONTEXT_ERROR });
      expect((error as Error).message).toContain(message);
    }
  });

  test("requires an existing real workspace with valid engram.json", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-qmd-invalid-"));
    roots.push(root);
    writeFileSync(join(root, "engram.json"), "{");
    expect(() => resolveQmdContext({ value: root, source: "cwd" }, runtime())).toThrow("not valid JSON");
  });
});
