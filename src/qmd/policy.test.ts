import { describe, expect, test } from "bun:test";
import { CliError, EXIT_CODES } from "../cli/errors.ts";
import { buildQmdInvocation } from "./invocation.ts";
import { authorizeQmdInvocation, decideQmdPolicy } from "./policy.ts";
import type { QmdCallerContext, QmdContext, QmdInvocation } from "./types.ts";

function context(): QmdContext {
  return {
    workspace: "/workspace",
    workspaceSource: "explicit",
    topology: "isolated",
    selector: { kind: "local" },
    physicalIndex: { path: "/workspace/.qmd/index.sqlite", key: "index-key", exists: true },
    command: { executable: "qmd", prefixArgs: [] },
    policy: {
      ownedCollections: ["self-memory", "life"],
      readableCollections: ["self-memory", "life", "domain-alpha", "child-memory"],
    },
    warnings: [],
  };
}

function readCaller(overrides: Partial<QmdCallerContext> = {}): QmdCallerContext {
  return {
    kind: "main",
    capabilities: ["read"],
    allowedCollections: ["self-memory", "life"],
    ...overrides,
  };
}

describe("QMD policy", () => {
  test("allows operator diagnostics and requires capability for internal diagnostics", () => {
    const ctx = context();
    const invocation = buildQmdInvocation(ctx, { operation: "capabilities" });
    expect(decideQmdPolicy(ctx, invocation, { kind: "operator", allowedCollections: [], capabilities: [] })).toMatchObject({
      allowed: true,
      code: "ALLOW_OPERATOR_DIAGNOSTIC",
    });
    expect(decideQmdPolicy(ctx, invocation, { kind: "main", allowedCollections: [], capabilities: [] })).toMatchObject({
      allowed: false,
      code: "DENY_CALLER_CAPABILITY",
    });
    expect(decideQmdPolicy(ctx, invocation, { kind: "subagent", allowedCollections: [], capabilities: ["diagnostics"] })).toMatchObject({
      allowed: true,
      code: "ALLOW_INTERNAL_DIAGNOSTIC",
    });
  });

  test("fails closed on empty collection scope", () => {
    const ctx = context();
    const valid = buildQmdInvocation(ctx, { operation: "query", query: "term", collections: ["life"] });
    const empty: QmdInvocation = { ...valid, collections: [] };
    expect(decideQmdPolicy(ctx, empty, readCaller())).toMatchObject({
      allowed: false,
      code: "DENY_EMPTY_COLLECTION_SCOPE",
    });
  });

  test("requires every requested collection in workspace/caller intersection", () => {
    const ctx = context();
    const allowed = buildQmdInvocation(ctx, { operation: "search", query: "term", collections: ["life"] });
    expect(decideQmdPolicy(ctx, allowed, readCaller())).toMatchObject({
      allowed: true,
      code: "ALLOW_COLLECTION_READ",
    });

    const foreign = buildQmdInvocation(ctx, {
      operation: "search",
      query: "term",
      collections: ["life", "child-memory"],
    });
    expect(decideQmdPolicy(ctx, foreign, readCaller())).toMatchObject({
      allowed: false,
      code: "DENY_COLLECTION_SCOPE",
    });
  });

  test("enforces topic isolation through trusted allowedCollections", () => {
    const ctx = context();
    const ownDomain = buildQmdInvocation(ctx, {
      operation: "query",
      query: "term",
      collections: ["domain-alpha"],
    });
    const topic = readCaller({
      kind: "topic",
      sessionKey: "telegram-group-1-topic-2",
      domain: "alpha",
      allowedCollections: ["domain-alpha"],
    });
    expect(decideQmdPolicy(ctx, ownDomain, topic).allowed).toBe(true);

    const crossDomain = buildQmdInvocation(ctx, {
      operation: "query",
      query: "term",
      collections: ["life"],
    });
    expect(decideQmdPolicy(ctx, crossDomain, topic)).toMatchObject({
      allowed: false,
      code: "DENY_COLLECTION_SCOPE",
      caller: { kind: "topic", domain: "alpha" },
    });
  });

  test("allows only maintenance-capable provisioning/heartbeat for embed", () => {
    const ctx = context();
    const invocation = buildQmdInvocation(ctx, { operation: "embed" });
    const provisioning = { kind: "provisioning", allowedCollections: [], capabilities: ["maintenance"] } as const;
    expect(decideQmdPolicy(ctx, invocation, provisioning)).toMatchObject({
      allowed: true,
      code: "ALLOW_OWNED_EMBED",
      collections: ["self-memory", "life"],
    });
    expect(decideQmdPolicy(ctx, invocation, { kind: "operator", allowedCollections: [], capabilities: ["maintenance"] })).toMatchObject({
      allowed: false,
      code: "DENY_MAINTENANCE_CALLER",
    });
    expect(decideQmdPolicy(ctx, invocation, { kind: "heartbeat", allowedCollections: [], capabilities: [] })).toMatchObject({
      allowed: false,
      code: "DENY_CALLER_CAPABILITY",
    });
    expect(decideQmdPolicy(ctx, { ...invocation, collections: ["self-memory"] }, provisioning)).toMatchObject({
      allowed: false,
      code: "DENY_COLLECTION_SCOPE",
    });
  });

  test("allows coordinator embed only inside its explicit trusted scope", () => {
    const ctx = context();
    const invocation = buildQmdInvocation(ctx, {
      operation: "embed",
      collections: ["self-memory", "child-memory"],
    });
    const coordinator: QmdCallerContext = {
      kind: "coordinator",
      allowedCollections: ["self-memory", "child-memory"],
      capabilities: ["maintenance"],
    };
    expect(decideQmdPolicy(ctx, invocation, coordinator)).toMatchObject({
      allowed: true,
      code: "ALLOW_COORDINATED_EMBED",
    });
    expect(decideQmdPolicy(ctx, { ...invocation, collections: ["self-memory", "foreign"] }, coordinator)).toMatchObject({
      allowed: false,
      code: "DENY_COLLECTION_SCOPE",
    });
  });

  test("allows index-wide update only for explicit maintenance callers", () => {
    const ctx = context();
    const invocation = buildQmdInvocation(ctx, { operation: "update" });
    expect(invocation).toMatchObject({ effectiveScope: "index", collections: [] });
    expect(invocation.argv).not.toContain("-c");
    expect(decideQmdPolicy(ctx, invocation, {
      kind: "heartbeat",
      allowedCollections: [],
      capabilities: ["maintenance"],
    })).toMatchObject({ allowed: true, code: "ALLOW_INDEX_UPDATE" });
    expect(decideQmdPolicy(ctx, { ...invocation, collections: ["life"] }, {
      kind: "provisioning",
      allowedCollections: [],
      capabilities: ["maintenance"],
    })).toMatchObject({ allowed: false, code: "DENY_EFFECTIVE_SCOPE" });
  });

  test("allows collection provisioning only for the dedicated manifest scope", () => {
    const ctx = context();
    const invocation = buildQmdInvocation(ctx, {
      operation: "collection-add",
      collection: "sample-memory",
      path: "/srv/sample/memory",
      mask: "**/*.md",
    });
    const caller: QmdCallerContext = {
      kind: "provisioning",
      allowedCollections: ["sample-memory"],
      capabilities: ["provisioning"],
    };
    expect(decideQmdPolicy(ctx, invocation, caller)).toMatchObject({
      allowed: true,
      code: "ALLOW_COLLECTION_PROVISION",
    });
    expect(decideQmdPolicy(ctx, invocation, { ...caller, allowedCollections: [] })).toMatchObject({
      allowed: false,
      code: "DENY_COLLECTION_SCOPE",
    });
    expect(decideQmdPolicy(ctx, invocation, { ...caller, kind: "operator" })).toMatchObject({
      allowed: false,
      code: "DENY_CALLER_CAPABILITY",
    });
  });

  test("authorization throws POLICY_DENIED/exit4 with its typed decision", () => {
    const ctx = context();
    const invocation = buildQmdInvocation(ctx, { operation: "vsearch", query: "term", collections: ["life"] });
    try {
      authorizeQmdInvocation(ctx, invocation, { kind: "subagent", allowedCollections: [], capabilities: [] });
      throw new Error("expected policy denial");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect(error).toMatchObject({ code: "POLICY_DENIED", exitCode: EXIT_CODES.POLICY_DENIED });
      expect((error as CliError).details?.decision).toMatchObject({
        schema: "engram.qmd.policy-decision.v1",
        allowed: false,
        code: "DENY_CALLER_CAPABILITY",
      });
    }
  });
});
