import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KgV3Core, beginKgCanary, currentKgCanaryReleaseDigest, deriveKgOperationId, finalizeKgCanary,
  kgCanaryDigest, planKgCanary, recordCanaryExplicitReceipt, resolveKgDefaultContext, rollbackKgCanary,
  executeKgCanaryReplay, planKgCanaryReplay,
  TrustedInboundVerifier, TrustedKgRuntime, KG_V3_CANARY_RELEASE_FILES,
  computeKgCanaryReleaseDigest,
  type KgCanaryManifestV1, type KgWriteRequest, type TrustedKgCallerContext,
} from "./index.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const json = (path: string, value: unknown) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };

function writeRequest(label: string, predicate: string, sourceKind: "user_message" | "operator-curated" = "user_message"): KgWriteRequest {
  return { assertion: { workspaceId: "main", entityId: "systems/engram", entityType: "system", kind: "decision", predicate, object: { type: "string", value: `value-${label}` }, scope: ["engram"], replacesId: null, provenance: { sourceKind, sessionKey: "main", messageId: label, actorId: "operator", operationId: deriveKgOperationId({ workspaceId: "main", sessionKey: "main", messageId: label, actorId: "operator", entityId: "systems/engram", predicate }), observedAt: "2026-08-12T15:00:00Z" } }, intent: { explicit: true, compound: false, store: "kg-current", statementClass: "durable" } };
}

function fixture(options: { wrongBenchmark?: boolean } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "kg-canary-")); roots.push(workspace);
  json(join(workspace, "engram.json"), { workspace: { id: "main" } });
  const predicates = ["seed", ...Array.from({ length: 20 }, (_, index) => `explicit${index + 1}`)];
  const registry = { schema: "engram.kg-v3-registry.v1", workspaceId: "main", revision: 1, entities: [{ id: "systems/engram", type: "system", scopes: ["engram"], predicates: predicates.map((name) => ({ name, kinds: ["decision"], objectTypes: ["string"] })) }] };
  const registryPath = join(workspace, "memory-state", "kg-v3", "registry.json"); json(registryPath, registry);
  const seed = writeRequest("seed-message", "seed", "operator-curated");
  json(join(workspace, "life", "systems", "engram", "items.json"), { entityId: "systems/engram", facts: [{ id: "engram-001", fact: "seed historical truth", category: "decision", status: "active", source: "2025" }] });
  const explicitRequests = Array.from({ length: 20 }, (_, index) => writeRequest(`explicit-message-${index + 1}`, `explicit${index + 1}`));
  const runtimeGrants = { schema: "engram.kg-v3-runtime-grants.v1" as const, workspaceId: "main", revision: 1, principals: [{ principalId: "operator", bindings: [{ transport: "telegram" as const, accountId: "default", actorId: "operator" }], grants: [{ sessionKey: "main", capabilities: ["kg:v3:write" as const] }] }] };
  const runtimeGrantsPath = join(workspace, "memory-state", "kg-v3", "runtime-grants.json"); json(runtimeGrantsPath, runtimeGrants);
  const releaseDigest = currentKgCanaryReleaseDigest();
  const manifest: KgCanaryManifestV1 = {
    schema: "engram.kg-v3-canary.v1", workspaceId: "main", releaseDigest,
    registryDigest: kgCanaryDigest(registry), seedManifestDigest: kgCanaryDigest([seed]), explicitRequestManifestDigest: kgCanaryDigest(explicitRequests),
    runtimeGrantsDigest: kgCanaryDigest(runtimeGrants),
    seedRequests: [seed], explicitRequests, humanApprovedOperationIds: [seed.assertion.provenance.operationId, ...explicitRequests.map((request) => request.assertion.provenance.operationId)],
    benchmark: {
      schema: "engram.kg-v3-benchmark.v1", workspaceId: "main",
      essential: [{ id: "seed", entityId: "systems/engram", predicate: "seed", expectedObject: options.wrongBenchmark ? { type: "string", value: "wrong" } : seed.assertion.object, v2FactId: "engram-001", expectedV2Text: "seed historical truth" }],
      baselineDefaultContext: { body: "x".repeat(20_000) },
      proposedDefaultContext: { sources: ["life/v3/current-summary.md"], archiveIncludedInDefault: false },
      humanApprovedOperationIds: [seed.assertion.provenance.operationId],
    },
    enabledSessionCapabilities: [{ sessionKey: "main", capabilities: ["kg:v3:seed", "kg:v3:write", "kg:v3:retract"] }],
    approvedBy: "operator", approvedAt: "2026-08-12T15:00:00Z",
  };
  const manifestPath = join(workspace, "memory-state", "kg-v3", "canary-manifest.json"); json(manifestPath, manifest);
  return { workspace, registryPath, manifestPath, runtimeGrantsPath, runtimeGrants, manifest, seed, explicitRequests, options: { workspace, workspaceId: "main", manifestPath, now: "2026-08-12T15:00:00Z" } };
}

describe("PR3 canary control plane", () => {
  test("plan is byte-stable and writes nothing; begin/finalize require acknowledgement", async () => {
    const h = fixture();
    const before = readFileSync(h.manifestPath);
    expect(planKgCanary(h.options)).toEqual(planKgCanary(h.options));
    expect(readFileSync(h.manifestPath)).toEqual(before);
    expect(existsSync(join(h.workspace, "memory-state", "kg-v3", "authority.json"))).toBe(false);
    await expect(beginKgCanary(h.options)).rejects.toMatchObject({ code: "ACK_REQUIRED" });
    await expect(finalizeKgCanary(h.options)).rejects.toMatchObject({ code: "ACK_REQUIRED" });
  });

  test("release mismatch fails before any control-plane write", () => {
    const h = fixture();
    h.manifest.releaseDigest = `sha256:${"0".repeat(64)}`;
    json(h.manifestPath, h.manifest);
    expect(() => planKgCanary(h.options)).toThrow("release digest");
    expect(existsSync(join(h.workspace, "memory-state", "kg-v3", "authority.json"))).toBe(false);
  });

  test("replay plan writes nothing, execute requires ack, and forged grants fail closed", async () => {
    const h = fixture();
    const options = { ...h.options, runtimeGrantsPath: h.runtimeGrantsPath };
    const before = readFileSync(h.manifestPath);
    expect(planKgCanaryReplay(options)).toMatchObject({ requestCount: 20, mutatesWorkspace: false });
    const cli = Bun.spawnSync({ cmd: [process.execPath, join(import.meta.dir, "..", "..", "scripts", "kg-v3-canary-execute.ts"), "--workspace", h.workspace, "--workspace-id", "main", "--manifest", h.manifestPath, "--runtime-grants", h.runtimeGrantsPath] });
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout.toString())).toMatchObject({ requestCount: 20, mutatesWorkspace: false });
    expect(readFileSync(h.manifestPath)).toEqual(before);
    expect(existsSync(join(h.workspace, "memory-state", "kg-v3", "authority.json"))).toBe(false);
    await expect(executeKgCanaryReplay(options)).rejects.toMatchObject({ code: "ACK_REQUIRED" });
    h.runtimeGrants.principals[0].bindings[0].actorId = "forged-actor";
    json(h.runtimeGrantsPath, h.runtimeGrants);
    expect(() => planKgCanaryReplay(options)).toThrow("runtime grants");
    expect(existsSync(join(h.workspace, "memory-state", "kg-v3", "authority.json"))).toBe(false);
  });

  test("executor performs 20 attested writes, derives ledger, and is idempotent", async () => {
    const h = fixture();
    const options = { ...h.options, runtimeGrantsPath: h.runtimeGrantsPath };
    await beginKgCanary({ ...h.options, acknowledge: true });
    const first = await executeKgCanaryReplay({ ...options, acknowledge: true });
    expect(first).toMatchObject({ requestedCount: 20, receiptCount: 20 });
    const ledgerPath = join(h.workspace, "memory-state", "kg-v3", "canary", h.manifest.releaseDigest.slice(7), "explicit-receipts.json");
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).entries).toHaveLength(20);
    const second = await executeKgCanaryReplay({ ...options, acknowledge: true });
    expect(second.receipts).toEqual(first.receipts);
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).entries).toHaveLength(20);
  }, 15_000);

  test("manifest provenance drift after begin is rejected before any replay write", async () => {
    const h = fixture();
    await beginKgCanary({ ...h.options, acknowledge: true });
    h.manifest.explicitRequests[0].assertion.provenance.actorId = "forged-actor";
    h.manifest.explicitRequestManifestDigest = kgCanaryDigest(h.manifest.explicitRequests);
    json(h.manifestPath, h.manifest);
    await expect(executeKgCanaryReplay({ ...h.options, runtimeGrantsPath: h.runtimeGrantsPath, acknowledge: true })).rejects.toMatchObject({ code: "REPLAY_BINDING_INVALID" });
    expect(existsSync(join(h.workspace, "memory-state", "kg-v3", "operations", `${h.explicitRequests[1].assertion.provenance.operationId.slice(7)}.json`))).toBe(false);
  });

  test("semantic release digest includes bootstrap injection handler", () => {
    expect(KG_V3_CANARY_RELEASE_FILES).toContain("hooks/engram-kg-context-load/handler.ts");
    const copy = mkdtempSync(join(tmpdir(), "kg-release-copy-")); roots.push(copy);
    const repository = join(import.meta.dir, "..", "..");
    for (const path of KG_V3_CANARY_RELEASE_FILES) { mkdirSync(join(copy, path, ".."), { recursive: true }); cpSync(join(repository, path), join(copy, path)); }
    const before = computeKgCanaryReleaseDigest(copy);
    writeFileSync(join(copy, "hooks", "engram-kg-context-load", "handler.ts"), "mutated injection path\n");
    expect(computeKgCanaryReleaseDigest(copy)).not.toBe(before);
  });

  test("begin → 20 verified receipts → benchmark → switch → byte rollback", async () => {
    const h = fixture();
    const begun = await beginKgCanary({ ...h.options, acknowledge: true });
    expect(begun.status).toBe("collecting");
    expect(resolveKgDefaultContext({ workspace: h.workspace, workspaceId: "main" }).mode).toBe("v2-current");
    const core = new KgV3Core({ workspace: h.workspace, workspaceId: "main", registryPath: h.registryPath });
    const verifier = new TrustedInboundVerifier((metadata) => metadata.transport === "telegram" && metadata.accountId === "default");
    const runtime = new TrustedKgRuntime(core, { schema: "engram.kg-v3-runtime-grants.v1", workspaceId: "main", revision: 1, principals: [{ principalId: "operator", bindings: [{ transport: "telegram", accountId: "default", actorId: "operator" }], grants: [{ sessionKey: "main", capabilities: ["kg:v3:write"] }] }] }, verifier);
    for (const request of h.explicitRequests) {
      const metadata = verifier.attest({ transport: "telegram", accountId: "default", workspaceId: "main", sessionKey: "main", actorId: "operator", messageId: request.assertion.provenance.messageId, contextKind: "direct" });
      expect((await runtime.write(request, metadata)).status).toBe("committed");
      recordCanaryExplicitReceipt({ ...h.options, operationId: request.assertion.provenance.operationId });
    }
    const report = await finalizeKgCanary({ ...h.options, acknowledge: true });
    expect(report).toMatchObject({ status: "passed", projectionSwitched: true, archiveLeakage: false });
    expect(report.benchmark).toMatchObject({ baselineRecallPercent: 100, v3RecallPercent: 100, provenanceCompletenessPercent: 100, humanApprovedPercent: 100 });
    expect(report.explicitReceipts).toHaveLength(20);
    expect(resolveKgDefaultContext({ workspace: h.workspace, workspaceId: "main" })).toEqual({ mode: "v3-current", sources: ["life/v3/current-summary.md"], archiveIncludedInDefault: false });
    const result = rollbackKgCanary({ ...h.options, acknowledge: true });
    expect(result).toMatchObject({ status: "rolled_back", readBack: true, assertionsPreserved: true, operationsPreserved: true });
    expect(existsSync(join(h.workspace, "memory-state", "kg-v3", "authority.json"))).toBe(false);
    expect(existsSync(join(h.workspace, "memory-state", "kg-v3", "default-context.json"))).toBe(false);
  });

  test("benchmark stop restores control plane while preserving committed stores", async () => {
    const h = fixture({ wrongBenchmark: true });
    await beginKgCanary({ ...h.options, acknowledge: true });
    const core = new KgV3Core({ workspace: h.workspace, workspaceId: "main", registryPath: h.registryPath });
    const verifier = new TrustedInboundVerifier(() => true);
    const runtime = new TrustedKgRuntime(core, { schema: "engram.kg-v3-runtime-grants.v1", workspaceId: "main", revision: 1, principals: [{ principalId: "operator", bindings: [{ transport: "telegram", accountId: "default", actorId: "operator" }], grants: [{ sessionKey: "main", capabilities: ["kg:v3:write"] }] }] }, verifier);
    for (const request of h.explicitRequests) {
      await runtime.write(request, verifier.attest({ transport: "telegram", accountId: "default", workspaceId: "main", sessionKey: "main", actorId: "operator", messageId: request.assertion.provenance.messageId, contextKind: "direct" }));
      recordCanaryExplicitReceipt({ ...h.options, operationId: request.assertion.provenance.operationId });
    }
    await expect(finalizeKgCanary({ ...h.options, acknowledge: true })).rejects.toMatchObject({ code: "BENCHMARK_FAILED" });
    expect(existsSync(join(h.workspace, "memory-state", "kg-v3", "authority.json"))).toBe(false);
    expect(existsSync(join(h.workspace, "memory-state", "kg-v3", "default-context.json"))).toBe(false);
    expect(existsSync(join(h.workspace, "life", "v3", "assertions"))).toBe(true);
    expect(existsSync(join(h.workspace, "memory-state", "kg-v3", "operations"))).toBe(true);
  });

  test("incomplete ledger restores authority and never switches projection", async () => {
    const h = fixture();
    await beginKgCanary({ ...h.options, acknowledge: true });
    await expect(finalizeKgCanary({ ...h.options, acknowledge: true })).rejects.toMatchObject({ code: "EXPLICIT_LEDGER_INCOMPLETE" });
    expect(existsSync(join(h.workspace, "memory-state", "kg-v3", "authority.json"))).toBe(false);
    expect(existsSync(join(h.workspace, "memory-state", "kg-v3", "default-context.json"))).toBe(false);
    expect(existsSync(join(h.workspace, "life", "v3", "assertions"))).toBe(true);
  });

  test("receipt recorder rejects uncommitted and forged external claims", async () => {
    const h = fixture(); await beginKgCanary({ ...h.options, acknowledge: true });
    expect(() => recordCanaryExplicitReceipt({ ...h.options, operationId: h.explicitRequests[0].assertion.provenance.operationId })).toThrow();
    expect(() => recordCanaryExplicitReceipt({ ...h.options, operationId: `sha256:${"f".repeat(64)}` })).toThrow("approved explicit request");
  });
});
