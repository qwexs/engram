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
  resolveKgLiveAgentTurnPrepareHookIdentity,
  resolveKgLiveInboundHookIdentity,
  resolveKgLiveIngressProjection,
  resolveKgLiveMessageReceivedHookIdentity,
  resolveKgLivePersistedUserTurnHookIdentity,
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
    actorId: "actor-001",
    messageId: "8260",
    contextKind: "direct" as const,
    observedAt: "2026-08-13T00:40:07.000Z",
    requireOwner: true,
    senderIsOwner: true,
  };
}

function pendingTurn(root: string) {
  const { runId: _runId, senderIsOwner: _senderIsOwner, ...pending } = turn(root);
  return pending;
}

const sourceTurnId = `channel-user:v1:${"a".repeat(64)}`;

function adoptedIdentity(messageId = "8260", idempotencyKey = sourceTurnId) {
  return {
    runtimeSessionKey: "agent:main:telegram:direct:actor-001",
    transport: "telegram" as const,
    messageId,
    sourceTurnId: idempotencyKey,
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
  test("binds an adopted ordinary message to its run without comparing prompt text", () => {
    const root = workspace();
    const authority = new KgLiveTurnAuthority();
    authority.capturePending(pendingTurn(root));
    authority.adoptPendingTurn(adoptedIdentity());
    authority.attachAdoptedRun({
      runId: "run-ordinary",
      runtimeSessionKey: turn(root).runtimeSessionKey,
    });
    expect(authority.hasRun("run-ordinary", turn(root).runtimeSessionKey)).toBe(true);
  });

  test("fails closed when hooks are reordered or adopted identity is ambiguous", () => {
    const root = workspace();
    const authority = new KgLiveTurnAuthority();
    authority.capturePending(pendingTurn(root));
    expect(() => authority.attachAdoptedRun({
      runId: "run-bad",
      runtimeSessionKey: turn(root).runtimeSessionKey,
    })).toThrow("does not match");
    authority.adoptPendingTurn(adoptedIdentity());
    authority.capturePending({ ...pendingTurn(root), messageId: "8261" });
    authority.adoptPendingTurn(adoptedIdentity("8261", `channel-user:v1:${"b".repeat(64)}`));
    expect(() => authority.attachAdoptedRun({
      runId: "run-ambiguous",
      runtimeSessionKey: turn(root).runtimeSessionKey,
    })).toThrow("multiple adopted");
    expect(() => authority.attachAdoptedRun({
      runId: "run-stale",
      runtimeSessionKey: turn(root).runtimeSessionKey,
    })).toThrow("does not match");
  });

  test("keeps duplicate adoption and run preparation idempotent", () => {
    const root = workspace();
    const authority = new KgLiveTurnAuthority();
    authority.capturePending(pendingTurn(root));
    authority.adoptPendingTurn(adoptedIdentity());
    authority.adoptPendingTurn(adoptedIdentity());
    const run = {
      runId: "run-retry",
      runtimeSessionKey: turn(root).runtimeSessionKey,
    };
    authority.attachAdoptedRun(run);
    authority.attachAdoptedRun(run);
    authority.capturePending(pendingTurn(root));
    expect(authority.hasRun(run.runId, run.runtimeSessionKey)).toBe(true);
  });

  test("drops conflicting reuse of a persisted source identity", () => {
    const root = workspace();
    const authority = new KgLiveTurnAuthority();
    authority.capturePending(pendingTurn(root));
    authority.adoptPendingTurn(adoptedIdentity());
    authority.capturePending({ ...pendingTurn(root), messageId: "8261" });
    expect(() => authority.adoptPendingTurn(adoptedIdentity("8261"))).toThrow("conflicting persisted turns");
    expect(() => authority.attachAdoptedRun({
      runId: "run-conflict",
      runtimeSessionKey: turn(root).runtimeSessionKey,
    })).toThrow("does not match");
  });

  test("binds trusted requester metadata and permits only one tool call", () => {
    const root = workspace();
    const authority = new KgLiveTurnAuthority();
    authority.capture(turn(root));
    expect(() => authority.bindToolCall({
      runId: "run-1",
      toolCallId: "call-bad",
      runtimeSessionKey: turn(root).runtimeSessionKey,
      requester: { channel: "telegram", senderId: "attacker", senderIsOwner: true },
    })).toThrow("requester does not match");
    authority.bindToolCall({
      runId: "run-1",
      toolCallId: "call-1",
      runtimeSessionKey: turn(root).runtimeSessionKey,
      requester: { channel: "telegram", senderId: "actor-001", senderIsOwner: true },
    });
    expect(() => authority.bindToolCall({
      runId: "run-1",
      toolCallId: "call-2",
      runtimeSessionKey: turn(root).runtimeSessionKey,
      requester: { channel: "telegram", senderId: "actor-001", senderIsOwner: true },
    })).toThrow("already used");
    const consumed = authority.consumeToolCall("call-1");
    expect(consumed.metadata).toEqual({
      transport: "telegram",
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
      requester: { channel: "telegram", senderId: "actor-001", senderIsOwner: true },
    })).toThrow("does not belong to a captured inbound turn");
  });

  test("expires adopted turns fail closed", () => {
    const root = workspace();
    let now = 1_000;
    const authority = new KgLiveTurnAuthority({ now: () => now, ttlMs: 50 });
    authority.capturePending(pendingTurn(root));
    authority.adoptPendingTurn(adoptedIdentity());
    now = 1_051;
    expect(() => authority.attachAdoptedRun({
      runId: "run-expired",
      runtimeSessionKey: turn(root).runtimeSessionKey,
    })).toThrow("does not match");
  });

  test("defers owner proof to the host requester without resetting single-use authority", () => {
    const root = workspace();
    const authority = new KgLiveTurnAuthority();
    const deferred = { ...turn(root), senderIsOwner: false };
    authority.capture(deferred);
    authority.capture(deferred);
    expect(() => authority.bindToolCall({
      runId: "run-1",
      toolCallId: "call-non-owner",
      runtimeSessionKey: deferred.runtimeSessionKey,
      requester: { channel: "telegram", senderId: "actor-001", senderIsOwner: false },
    })).toThrow("not the authorized owner");
    authority.bindToolCall({
      runId: "run-1",
      toolCallId: "call-owner",
      runtimeSessionKey: deferred.runtimeSessionKey,
      requester: { channel: "telegram", senderId: "actor-001", senderIsOwner: true },
    });
    expect(authority.consumeToolCall("call-owner").turn.senderIsOwner).toBe(true);
    authority.capture(deferred);
    expect(() => authority.bindToolCall({
      runId: "run-1",
      toolCallId: "call-second",
      runtimeSessionKey: deferred.runtimeSessionKey,
      requester: { channel: "telegram", senderId: "actor-001", senderIsOwner: true },
    })).toThrow("already used");
  });

  test("conflicting recapture fails closed and drops the run", () => {
    const root = workspace();
    const authority = new KgLiveTurnAuthority();
    authority.capture(turn(root));
    expect(() => authority.capture({ ...turn(root), messageId: "different" })).toThrow("conflicting trusted captures");
    expect(authority.hasRun("run-1", turn(root).runtimeSessionKey)).toBe(false);
  });
});

describe("KG v3 inbound hook identity normalization", () => {
  test("normalizes ordinary message receipt and rejects metadata disagreement", () => {
    const event = {
      sessionKey: "agent:main:telegram:direct:actor-001",
      messageId: "8279",
      senderId: "actor-001",
      metadata: { messageId: "8279", senderId: "actor-001" },
    };
    expect(resolveKgLiveMessageReceivedHookIdentity(event, {})).toEqual({
      runtimeSessionKey: "agent:main:telegram:direct:actor-001",
      messageId: "8279",
      actorId: "actor-001",
    });
    expect(() => resolveKgLiveMessageReceivedHookIdentity(
      { ...event, metadata: { ...event.metadata, messageId: "8280" } },
      {},
    )).toThrow("messageId differs");
  });

  test("normalizes protected persisted-turn metadata and rejects malformed adoption", () => {
    const event = {
      message: {
        role: "user",
        content: "remember this",
        idempotencyKey: sourceTurnId,
        __openclaw: {
          senderIsOwner: true,
          transport: { channel: "telegram", messageId: "8260" },
        },
      },
    };
    const context = { sessionKey: "agent:main:telegram:direct:actor-001" };
    expect(resolveKgLivePersistedUserTurnHookIdentity(event, context)).toEqual(adoptedIdentity());
    expect(() => resolveKgLivePersistedUserTurnHookIdentity({
      message: { ...event.message, idempotencyKey: "model-supplied" },
    }, context)).toThrow("source identity is invalid");
    expect(() => resolveKgLivePersistedUserTurnHookIdentity({
      message: { ...event.message, __openclaw: { ...event.message.__openclaw, senderIsOwner: undefined } },
    }, context)).toThrow("senderIsOwner is missing");
    expect(() => resolveKgLivePersistedUserTurnHookIdentity({
      message: { ...event.message, role: "assistant" },
    }, context)).toThrow("not a user message");
  });

  test("normalizes agent-turn preparation from host context only", () => {
    const context = { runId: "run-ordinary", sessionKey: "agent:main:telegram:direct:actor-001" };
    expect(resolveKgLiveAgentTurnPrepareHookIdentity({ prompt: "runtime envelope differs" }, context)).toEqual({
      runId: "run-ordinary",
      runtimeSessionKey: "agent:main:telegram:direct:actor-001",
    });
    expect(() => resolveKgLiveAgentTurnPrepareHookIdentity({}, { ...context, runId: undefined })).toThrow("runId is missing");
  });

  test("accepts canonical identity supplied only by inbound context", () => {
    expect(resolveKgLiveInboundHookIdentity(
      {},
      { runId: "run-context", sessionKey: "agent:main:telegram:direct:actor-001", messageId: "8279", senderId: "actor-001" },
    )).toEqual({
      runId: "run-context",
      runtimeSessionKey: "agent:main:telegram:direct:actor-001",
      messageId: "8279",
      actorId: "actor-001",
    });
  });

  test("accepts matching duplicated identity and rejects disagreement", () => {
    const identity = { runId: "run-1", sessionKey: "agent:main:main", messageId: "8279", senderId: "actor-001" };
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
    requester: { channel: "telegram", senderId: "actor-001", senderIsOwner: true },
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
      bindings: [{ transport: "telegram", actorId: "actor-001" }],
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
