import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KG_V3_SCHEMA_DIGEST, KgV3Core, deriveKgOperationId } from "./core.ts";
import {
  KG_V3_LIVE_INGRESS_SCHEMA,
  KgLiveIngressError,
  KgLiveTurnAuthority,
  createKgLiveRetractionRequest,
  createKgLiveWriteRequest,
  resolveKgLiveInboundHookIdentity,
  resolveKgLiveIngressProjection,
} from "./live-ingress.ts";
import { TrustedKgRuntime } from "./trusted-runtime.ts";
import { KG_V3_AUTHORITY_SCHEMA, KG_V3_REGISTRY_SCHEMA, type KgRegistryV1 } from "./types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const releaseDigest = `sha256:${"1".repeat(64)}` as const;
const pluginDigest = `sha256:${"2".repeat(64)}` as const;

function json(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function registry(): KgRegistryV1 {
  return {
    schema: KG_V3_REGISTRY_SCHEMA,
    workspaceId: "main",
    revision: 1,
    entities: [{
      id: "systems/engram",
      type: "system",
      scopes: ["engram"],
      predicates: [{ name: "rolloutStrategy", kinds: ["decision"], objectTypes: ["string"] }],
    }],
  };
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kg-live-ingress-"));
  roots.push(root);
  json(join(root, "memory-state", "kg-v3", "registry.json"), registry());
  json(join(root, "memory-state", "kg-v3", "authority.json"), {
    schema: KG_V3_AUTHORITY_SCHEMA,
    workspaceId: "main",
    releaseDigest,
    schemaDigest: KG_V3_SCHEMA_DIGEST,
    mode: "canary",
    enabledSessionCapabilities: [{ sessionKey: "main", capabilities: ["kg:v3:write", "kg:v3:retract"] }],
    currentProjectionVersion: 1,
    approvedBy: "operator",
    approvedAt: "2026-08-13T00:00:00.000Z",
  });
  json(join(root, "memory-state", "kg-v3", "live-ingress.json"), {
    schema: KG_V3_LIVE_INGRESS_SCHEMA,
    workspaceId: "main",
    releaseDigest,
    mode: "canary",
    enabled: true,
    grantSessionKey: "main",
    allowedContextKinds: ["direct"],
    requireOwner: true,
    pluginDigest,
    approvedBy: "operator",
    approvedAt: "2026-08-13T00:00:00.000Z",
  });
  return root;
}

function turn(root: string) {
  return {
    runId: "run-1",
    runtimeSessionKey: "agent:main:telegram:direct:actor-001",
    workspace: root,
    workspaceId: "main",
    grantSessionKey: "main",
    transport: "telegram" as const,
    accountId: "default",
    actorId: "actor-001",
    messageId: "8260",
    contextKind: "direct" as const,
    observedAt: "2026-08-13T00:40:07.000Z",
    senderIsOwner: true,
  };
}

describe("KG v3 live ingress projection", () => {
  test("requires a release-bound local projection and authority", () => {
    const root = workspace();
    expect(resolveKgLiveIngressProjection({ workspace: root, workspaceId: "main" })).toMatchObject({
      schema: KG_V3_LIVE_INGRESS_SCHEMA,
      enabled: true,
      grantSessionKey: "main",
    });
    expect(() => resolveKgLiveIngressProjection({ workspace: root, workspaceId: "main", expectedPluginDigest: `sha256:${"4".repeat(64)}` })).toThrow("plugin digest mismatch");
    const projectionPath = join(root, "memory-state", "kg-v3", "live-ingress.json");
    json(projectionPath, { ...resolveKgLiveIngressProjection({ workspace: root, workspaceId: "main" }), releaseDigest: `sha256:${"3".repeat(64)}` });
    expect(() => resolveKgLiveIngressProjection({ workspace: root, workspaceId: "main" })).toThrow("does not match current authority");
  });

  test("stays disabled without an explicit local projection", () => {
    const root = mkdtempSync(join(tmpdir(), "kg-live-disabled-"));
    roots.push(root);
    expect(() => resolveKgLiveIngressProjection({ workspace: root, workspaceId: "main" })).toThrow(KgLiveIngressError);
  });
});

describe("KG v3 single-use live turn authority", () => {
  test("binds trusted requester metadata and permits only one tool call", () => {
    const root = workspace();
    const authority = new KgLiveTurnAuthority();
    authority.capture(turn(root));
    expect(() => authority.bindToolCall({
      runId: "run-1",
      toolCallId: "call-bad",
      runtimeSessionKey: turn(root).runtimeSessionKey,
      requester: { channel: "telegram", accountId: "default", senderId: "attacker", senderIsOwner: true },
    })).toThrow("requester does not match");
    authority.bindToolCall({
      runId: "run-1",
      toolCallId: "call-1",
      runtimeSessionKey: turn(root).runtimeSessionKey,
      requester: { channel: "telegram", accountId: "default", senderId: "actor-001", senderIsOwner: true },
    });
    expect(() => authority.bindToolCall({
      runId: "run-1",
      toolCallId: "call-2",
      runtimeSessionKey: turn(root).runtimeSessionKey,
      requester: { channel: "telegram", accountId: "default", senderId: "actor-001", senderIsOwner: true },
    })).toThrow("already used");
    const consumed = authority.consumeToolCall("call-1");
    expect(consumed.metadata).toEqual({
      transport: "telegram",
      accountId: "default",
      workspaceId: "main",
      sessionKey: "main",
      actorId: "actor-001",
      messageId: "8260",
      contextKind: "direct",
    });
    expect(() => authority.consumeToolCall("call-1")).toThrow("no server-stamped inbound authority");
  });

  test("expires captured turns fail closed", () => {
    const root = workspace();
    let now = 1_000;
    const authority = new KgLiveTurnAuthority({ now: () => now, ttlMs: 50 });
    authority.capture(turn(root));
    now = 1_051;
    expect(() => authority.bindToolCall({
      runId: "run-1",
      toolCallId: "call-1",
      runtimeSessionKey: turn(root).runtimeSessionKey,
      requester: { channel: "telegram", accountId: "default", senderId: "actor-001", senderIsOwner: true },
    })).toThrow("does not belong to a captured inbound turn");
  });
});

describe("KG v3 inbound hook identity normalization", () => {
  test("accepts canonical identity supplied only by inbound context", () => {
    expect(resolveKgLiveInboundHookIdentity(
      {},
      { runId: "run-context", sessionKey: "agent:main:telegram:direct:actor-001", messageId: "8279", senderId: "actor-001", accountId: "default" },
    )).toEqual({
      runId: "run-context",
      runtimeSessionKey: "agent:main:telegram:direct:actor-001",
      messageId: "8279",
      actorId: "actor-001",
      accountId: "default",
    });
  });

  test("accepts matching duplicated identity and rejects disagreement", () => {
    const identity = { runId: "run-1", sessionKey: "agent:main:main", messageId: "8279", senderId: "actor-001", accountId: "default" };
    expect(resolveKgLiveInboundHookIdentity(identity, identity).runId).toBe("run-1");
    expect(() => resolveKgLiveInboundHookIdentity(identity, { ...identity, runId: "run-2" })).toThrow("runId differs");
  });
});

test("live builder derives provenance and commits through TrustedKgRuntime", async () => {
  const root = workspace();
  const authority = new KgLiveTurnAuthority();
  authority.capture(turn(root));
  authority.bindToolCall({
    runId: "run-1",
    toolCallId: "call-1",
    runtimeSessionKey: turn(root).runtimeSessionKey,
    requester: { channel: "telegram", accountId: "default", senderId: "actor-001", senderIsOwner: true },
  });
  const consumed = authority.consumeToolCall("call-1");
  const request = createKgLiveWriteRequest({
    registry: registry(),
    metadata: consumed.metadata,
    observedAt: consumed.turn.observedAt,
    input: { entityId: "systems/engram", kind: "decision", predicate: "rolloutStrategy", object: { type: "string", value: "main then fleet" } },
  });
  expect(request.assertion.provenance.operationId).toBe(deriveKgOperationId({
    workspaceId: "main",
    sessionKey: "main",
    messageId: "8260",
    actorId: "actor-001",
    entityId: "systems/engram",
    predicate: "rolloutStrategy",
  }));
  const runtime = new TrustedKgRuntime(new KgV3Core({ workspace: root, workspaceId: "main" }), {
    schema: "engram.kg-v3-runtime-grants.v1",
    workspaceId: "main",
    revision: 1,
    principals: [{
      principalId: "example-principal",
      bindings: [{ transport: "telegram", accountId: "default", actorId: "actor-001" }],
      grants: [{ sessionKey: "main", capabilities: ["kg:v3:write", "kg:v3:retract"] }],
    }],
  }, consumed.verifier);
  const receipt = await runtime.write(request, consumed.metadata);
  expect(receipt).toMatchObject({ status: "committed", reason: null });

  const retraction = createKgLiveRetractionRequest({
    metadata: consumed.metadata,
    observedAt: consumed.turn.observedAt,
    input: { entityId: "systems/engram", assertionId: receipt.assertionId! },
  });
  expect(retraction.provenance.actorId).toBe("actor-001");
});
