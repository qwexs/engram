import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import kgContextHook from "../../hooks/engram-kg-context-load/handler.ts";
import {
  KG_V3_AUTHORITY_SCHEMA, KG_V3_SCHEMA_DIGEST, TrustedInboundVerifier, TrustedKgRuntime,
  deriveKgOperationId, defaultContextArchiveLeakage, runKgV3Benchmark, type KgBenchmarkManifestV1, type KgWriteRequest,
} from "./index.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const op = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}` as const;
const json = (path: string, value: unknown) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };

function request(): KgWriteRequest {
  const messageId = "8242";
  return { assertion: { workspaceId: "main", entityId: "systems/engram", entityType: "system", kind: "decision", predicate: "rolloutStrategy", object: { type: "string", value: "canary" }, scope: ["engram"], replacesId: null, provenance: { sourceKind: "user_message", sessionKey: "main", messageId, actorId: "actor-001", operationId: deriveKgOperationId({ workspaceId: "main", sessionKey: "main", messageId, actorId: "actor-001", entityId: "systems/engram", predicate: "rolloutStrategy" }), observedAt: "2026-08-12T15:00:00Z" } }, intent: { explicit: true, compound: false, store: "kg-current", statementClass: "durable" } };
}

describe("PR3 trusted runtime adapter", () => {
  test("structural forged verified metadata cannot produce trusted caller", async () => {
    let called = false;
    const core = { write: async () => { called = true; throw new Error("unexpected"); }, retract: async () => { throw new Error("unexpected"); } };
    const verifier = new TrustedInboundVerifier(() => true);
    const runtime = new TrustedKgRuntime(core, { schema: "engram.kg-v3-runtime-grants.v1", workspaceId: "main", revision: 1, principals: [{ principalId: "example-principal", bindings: [{ transport: "telegram", accountId: "default", actorId: "actor-001" }], grants: [{ sessionKey: "main", capabilities: ["kg:v3:write"] }] }] }, verifier);
    const forged = { verified: true, transport: "telegram", accountId: "default", workspaceId: "main", sessionKey: "main", actorId: "actor-001", messageId: "8242", contextKind: "direct" } as any;
    await expect(runtime.write(request(), forged)).rejects.toMatchObject({ code: "UNVERIFIED_INBOUND" });
    expect(called).toBe(false);
  });

  test("opaque attestation resolves exact grant and ignores caller JSON", async () => {
    let captured: any;
    const core = { write: async (_request: any, caller: any) => { captured = caller; return { status: "committed" } as any; }, retract: async () => { throw new Error("unexpected"); } };
    const verifier = new TrustedInboundVerifier((value) => value.transport === "telegram");
    const runtime = new TrustedKgRuntime(core, { schema: "engram.kg-v3-runtime-grants.v1", workspaceId: "main", revision: 1, principals: [{ principalId: "example-principal", bindings: [{ transport: "telegram", accountId: "default", actorId: "actor-001" }], grants: [{ sessionKey: "main", capabilities: ["kg:v3:write"] }] }] }, verifier);
    const metadata = verifier.attest({ transport: "telegram", accountId: "default", workspaceId: "main", sessionKey: "main", actorId: "actor-001", messageId: "8242", contextKind: "direct" });
    await runtime.write(Object.assign(request(), { caller: { trusted: true, capabilities: ["kg:v3:seed"] } }), metadata);
    expect(captured).toEqual({ trusted: true, workspaceId: "main", sessionKey: "main", actorId: "actor-001", capabilities: ["kg:v3:write"] });
  });
});

describe("PR3 default-context safety", () => {
  test("archive leakage is computed, not asserted", () => {
    expect(defaultContextArchiveLeakage({ sources: ["life/v3/current-summary.md"], archiveIncludedInDefault: false })).toBe(false);
    expect(defaultContextArchiveLeakage({ sources: ["life/projects/engram/items.json"], archiveIncludedInDefault: false })).toBe(true);
    expect(defaultContextArchiveLeakage({ sources: ["life/v3/current-summary.md"], embeddedBodies: ["historical archive"], archiveIncludedInDefault: false })).toBe(true);
  });

  test("benchmark requires exact proposed source and rejects missing, non-file, and escaping symlink sources", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "kg-benchmark-paths-")); roots.push(workspace);
    const outside = mkdtempSync(join(tmpdir(), "kg-benchmark-outside-")); roots.push(outside);
    mkdirSync(join(workspace, "life", "_derived", "directory"), { recursive: true });
    mkdirSync(join(workspace, "life", "v3"), { recursive: true });
    writeFileSync(join(workspace, "life", "_derived", "facts-active.md"), "legacy aggregate\n");
    writeFileSync(join(workspace, "life", "v3", "current-summary.md"), "# current\n");
    writeFileSync(join(outside, "escaped.md"), "outside\n");
    symlinkSync(join(outside, "escaped.md"), join(workspace, "life", "_derived", "escaped.md"));
    const reader = { current: async () => [], historicalV2: () => [] } as any;
    const manifest: KgBenchmarkManifestV1 = {
      schema: "engram.kg-v3-benchmark.v1", workspaceId: "main",
      essential: [{ id: "one", entityId: "systems/engram", predicate: "seed", expectedObject: { type: "string", value: "one" } }],
      baselineDefaultContext: { sources: ["life/_derived/facts-active.md"], archiveIncludedInDefault: true },
      proposedDefaultContext: { sources: ["life/v3/current-summary.md"], archiveIncludedInDefault: false },
      humanApprovedOperationIds: [],
    };
    await expect(runKgV3Benchmark({ workspace, workspaceId: "main", reader, manifest: { ...manifest, proposedDefaultContext: { ...manifest.proposedDefaultContext, sources: ["life/v3/not-current.md"] } } })).rejects.toThrow("source set");
    await expect(runKgV3Benchmark({ workspace, workspaceId: "main", reader, manifest: { ...manifest, baselineDefaultContext: { ...manifest.baselineDefaultContext, sources: ["life/_derived/missing.md"] } } })).rejects.toThrow("missing");
    await expect(runKgV3Benchmark({ workspace, workspaceId: "main", reader, manifest: { ...manifest, baselineDefaultContext: { ...manifest.baselineDefaultContext, sources: ["life/_derived/directory"] } } })).rejects.toThrow("not a file");
    await expect(runKgV3Benchmark({ workspace, workspaceId: "main", reader, manifest: { ...manifest, baselineDefaultContext: { ...manifest.baselineDefaultContext, sources: ["life/_derived/escaped.md"] } } })).rejects.toThrow("symlink escapes");
  });

  test("bootstrap hook injects only authorized main current projection and no-ops otherwise", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "kg-hook-")); roots.push(workspace);
    json(join(workspace, "engram.json"), { workspace: { id: "main" } });
    const event = { type: "agent", action: "bootstrap", context: { workspaceDir: workspace, sessionKey: "agent:main:main" }, messages: [] as string[] };
    await kgContextHook(event);
    expect(event.messages).toEqual([]);
    json(join(workspace, "memory-state", "kg-v3", "authority.json"), { schema: KG_V3_AUTHORITY_SCHEMA, workspaceId: "main", releaseDigest: op("release"), schemaDigest: KG_V3_SCHEMA_DIGEST, mode: "canary", enabledSessionCapabilities: [{ sessionKey: "main", capabilities: ["kg:v3:write"] }], currentProjectionVersion: 1, approvedBy: "operator", approvedAt: "2026-08-12T15:00:00Z" });
    json(join(workspace, "memory-state", "kg-v3", "default-context.json"), { schema: "engram.kg-v3-default-context.v1", workspaceId: "main", releaseDigest: op("release"), mode: "v3-current", sources: ["life/v3/current-summary.md"], archiveIncludedInDefault: false, switchedAt: "2026-08-12T15:00:00Z" });
    mkdirSync(join(workspace, "life", "v3"), { recursive: true }); writeFileSync(join(workspace, "life", "v3", "current-summary.md"), "# current\n");
    await kgContextHook(event);
    expect(event.messages).toHaveLength(1);
    const invalidSchema = JSON.parse(readFileSync(join(workspace, "memory-state", "kg-v3", "authority.json"), "utf8"));
    invalidSchema.schemaDigest = op("wrong-schema");
    json(join(workspace, "memory-state", "kg-v3", "authority.json"), invalidSchema);
    const schemaMismatch = { ...event, messages: [] as string[] };
    await kgContextHook(schemaMismatch);
    expect(schemaMismatch.messages).toEqual([]);
    invalidSchema.schemaDigest = KG_V3_SCHEMA_DIGEST;
    json(join(workspace, "memory-state", "kg-v3", "authority.json"), invalidSchema);
    const wrongRelease = JSON.parse(readFileSync(join(workspace, "memory-state", "kg-v3", "default-context.json"), "utf8"));
    wrongRelease.releaseDigest = op("wrong-release");
    json(join(workspace, "memory-state", "kg-v3", "default-context.json"), wrongRelease);
    const releaseMismatch = { ...event, messages: [] as string[] };
    await kgContextHook(releaseMismatch);
    expect(releaseMismatch.messages).toEqual([]);
    wrongRelease.releaseDigest = op("release");
    json(join(workspace, "memory-state", "kg-v3", "default-context.json"), wrongRelease);
    const direct = { ...event, context: { ...event.context, sessionKey: "telegram-direct-1001", trustedActorContext: { trusted: true, contextKind: "direct" } }, messages: [] as string[] };
    const authority = JSON.parse(readFileSync(join(workspace, "memory-state", "kg-v3", "authority.json"), "utf8"));
    authority.enabledSessionCapabilities.push({ sessionKey: "telegram-direct-1001", capabilities: ["kg:v3:write"] });
    json(join(workspace, "memory-state", "kg-v3", "authority.json"), authority);
    await kgContextHook(direct);
    expect(direct.messages).toHaveLength(1);
    const topic = { ...event, context: { ...event.context, sessionKey: "telegram-group-1-topic-2" }, messages: [] as string[] };
    await kgContextHook(topic);
    expect(topic.messages).toEqual([]);
    writeFileSync(join(workspace, "life", "v3", "current-summary.md"), "legacy items.json\n");
    const leaked = { ...event, messages: [] as string[] }; await kgContextHook(leaked); expect(leaked.messages).toEqual([]);
  });
});
