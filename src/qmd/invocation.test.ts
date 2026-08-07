import { describe, expect, test } from "bun:test";
import { CliError } from "../cli/errors.ts";
import { buildQmdInvocation, DEFAULT_QMD_TIMEOUT_MS, redactQmdInvocation } from "./invocation.ts";
import type { QmdContext, QmdInvocationRequest } from "./types.ts";

function context(overrides: Partial<QmdContext> = {}): QmdContext {
  return {
    workspace: "/workspace with spaces",
    workspaceSource: "explicit",
    topology: "shared",
    selector: { kind: "named", name: "team" },
    physicalIndex: { path: "/cache/qmd/team.sqlite", key: "index-key", exists: true },
    command: { executable: "/bin with spaces/qmd", prefixArgs: ["--no-gpu"] },
    policy: { ownedCollections: ["self-memory", "life"], readableCollections: ["self-memory", "life", "child"] },
    warnings: [],
    ...overrides,
  };
}

describe("buildQmdInvocation", () => {
  test("keeps executable separate and puts a named selector before the operation", () => {
    const invocation = buildQmdInvocation(context(), {
      operation: "query",
      query: "how does memory work?",
      collections: ["life", "child"],
      limit: 10,
    });

    expect(invocation).toEqual({
      executable: "/bin with spaces/qmd",
      argv: [
        "--no-gpu", "--index", "team", "query", "how does memory work?",
        "--format", "json", "-c", "life", "-c", "child", "-n", "10",
      ],
      cwd: "/workspace with spaces",
      operation: "query",
      effectiveScope: "collections",
      indexKey: "index-key",
      collections: ["life", "child"],
      timeoutMs: DEFAULT_QMD_TIMEOUT_MS,
    });
  });

  test.each([
    ["capabilities", ["--no-gpu", "--index", "team", "capabilities", "--format", "json"]],
    ["status", ["--no-gpu", "--index", "team", "status"]],
    ["collection-list", ["--no-gpu", "--index", "team", "collection", "list"]],
    ["update", ["--no-gpu", "--index", "team", "update"]],
  ] as const)("builds index-scoped %s without collection flags", (operation, argv) => {
    const invocation = buildQmdInvocation(context(), { operation });
    expect(invocation.argv).toEqual(argv);
    expect(invocation.effectiveScope).toBe("index");
    expect(invocation.collections).toEqual([]);
    expect(invocation.argv).not.toContain("-c");
  });

  test("keeps bootstrap probes index-independent and argv-safe", () => {
    const help = buildQmdInvocation(context(), { operation: "probe", probe: "help" });
    const version = buildQmdInvocation(context(), { operation: "probe", probe: "version" });
    expect(help.argv).toEqual(["--no-gpu", "--help"]);
    expect(version.argv).toEqual(["--no-gpu", "--version"]);
    expect(help.effectiveScope).toBe("index");
    expect(help.collections).toEqual([]);
  });

  test("scopes embed to owned collections and requests structured output", () => {
    const invocation = buildQmdInvocation(context(), { operation: "embed", timeoutMs: 45_000 });
    expect(invocation.argv).toEqual([
      "--no-gpu", "--index", "team", "embed", "--format", "json",
      "-c", "self-memory", "-c", "life",
    ]);
    expect(invocation.collections).toEqual(["self-memory", "life"]);
    expect(invocation.timeoutMs).toBe(45_000);
  });

  test("allows a trusted internal coordinator to request an explicit embed scope", () => {
    const invocation = buildQmdInvocation(context(), {
      operation: "embed",
      collections: ["self-memory", "child"],
    });
    expect(invocation.argv).toEqual([
      "--no-gpu", "--index", "team", "embed", "--format", "json",
      "-c", "self-memory", "-c", "child",
    ]);
    expect(invocation.collections).toEqual(["self-memory", "child"]);
    expect(invocation.argv).not.toContain("-f");
  });

  test("builds argv-safe named-index collection provisioning", () => {
    const invocation = buildQmdInvocation(context(), {
      operation: "collection-add",
      collection: "sample-memory",
      path: "/workspace with spaces/memory",
      mask: "**/*.md",
    });
    expect(invocation.argv).toEqual([
      "--no-gpu", "--index", "team", "collection", "add",
      "/workspace with spaces/memory", "--name", "sample-memory", "--mask", "**/*.md",
    ]);
    expect(invocation).toMatchObject({ effectiveScope: "collections", collections: ["sample-memory"] });
    expect(invocation.argv).not.toContain("-c");
  });

  test.each(["search", "query", "vsearch"] as const)("uses explicit collections for %s", (operation) => {
    const request: QmdInvocationRequest = { operation, query: "term", collections: ["life"] };
    const invocation = buildQmdInvocation(context({ selector: { kind: "local" } }), request);
    expect(invocation.argv).toEqual(["--no-gpu", operation, "term", "--format", "json", "-c", "life"]);
    expect(invocation.effectiveScope).toBe("collections");
  });

  test("rejects invalid timeout, empty query, and empty collection scope", () => {
    expect(() => buildQmdInvocation(context(), { operation: "status", timeoutMs: 0 })).toThrow(CliError);
    expect(() => buildQmdInvocation(context(), { operation: "search", query: "", collections: ["life"] })).toThrow("non-empty query");
    expect(() => buildQmdInvocation(context(), { operation: "query", query: "term", collections: [] })).toThrow("at least one collection");
    expect(() => buildQmdInvocation(context(), { operation: "query", query: "term", collections: ["life"], limit: 101 })).toThrow("1 to 100");
    expect(() => buildQmdInvocation(context(), { operation: "collection-add", collection: "bad/name", path: "/tmp/x", mask: "**/*.md" })).toThrow("non-path");
    expect(() => buildQmdInvocation(context(), { operation: "collection-add", collection: "good", path: "relative", mask: "**/*.md" })).toThrow("absolute");
  });
});

describe("redactQmdInvocation", () => {
  test("redacts secret option values and long query text", () => {
    const longQuery = "sensitive context ".repeat(20);
    const invocation = buildQmdInvocation(context({
      command: {
        executable: "qmd",
        prefixArgs: ["--access-token", "token-value", "--jina-api-key=key-value", "query"],
      },
    }), { operation: "query", query: longQuery, collections: ["life"] });

    const logged = redactQmdInvocation(invocation);
    expect(logged.argv).toContain("[REDACTED]");
    expect(logged.argv).toContain("--jina-api-key=[REDACTED]");
    expect(logged.argv).toContain(`[REDACTED QUERY: ${longQuery.length} chars]`);
    expect(JSON.stringify(logged)).not.toContain("token-value");
    expect(JSON.stringify(logged)).not.toContain("key-value");
    expect(JSON.stringify(logged)).not.toContain(longQuery);
  });
});
