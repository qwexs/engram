import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { KG_V3_SCHEMA_DIGEST, deriveKgOperationId, validateKgRegistry } from "./core.ts";
import { TrustedInboundVerifier, type AttestedInboundMetadata, type InboundMetadataEnvelope } from "./trusted-runtime.ts";
import {
  KG_V3_AUTHORITY_SCHEMA,
  type KgAuthorityMarkerV1,
  type KgKind,
  type KgObject,
  type KgRegistryV1,
  type KgRetractionRequest,
  type KgWriteRequest,
} from "./types.ts";

export const KG_V3_LIVE_INGRESS_SCHEMA = "engram.kg-v3-live-ingress.v1" as const;

export interface KgLiveIngressProjectionV1 {
  schema: typeof KG_V3_LIVE_INGRESS_SCHEMA;
  workspaceId: string;
  releaseDigest: `sha256:${string}`;
  mode: "canary" | "enabled";
  enabled: boolean;
  grantSessionKey: string;
  allowedContextKinds: Array<"direct" | "group" | "topic">;
  requireOwner: boolean;
  pluginDigest: `sha256:${string}`;
  approvedBy: string;
  approvedAt: string;
}

export interface KgLiveInboundTurn {
  runId: string;
  runtimeSessionKey: string;
  workspace: string;
  workspaceId: string;
  grantSessionKey: string;
  transport: "telegram" | "openclaw";
  accountId: string;
  actorId: string;
  messageId: string;
  contextKind: "direct" | "group" | "topic";
  observedAt: string;
  senderIsOwner: boolean;
}

export interface KgLiveToolRequester {
  channel?: string;
  accountId?: string;
  senderId?: string;
  senderIsOwner?: boolean;
}

export interface KgLiveWriteInput {
  entityId: string;
  kind: KgKind;
  predicate: string;
  object: KgObject;
  replacesId?: string | null;
}

export interface KgLiveRetractInput {
  entityId: string;
  assertionId: string;
}

export class KgLiveIngressError extends Error {
  constructor(readonly code:
    | "LIVE_INGRESS_DISABLED"
    | "INVALID_TURN"
    | "TURN_NOT_FOUND"
    | "TURN_ALREADY_USED"
    | "REQUESTER_MISMATCH"
    | "TOOL_CALL_NOT_BOUND"
    | "ENTITY_UNRESOLVED",
  message: string) {
    super(message);
    this.name = "KgLiveIngressError";
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function token(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value;
}

function digest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sameRequester(turn: KgLiveInboundTurn, requester: KgLiveToolRequester): boolean {
  return requester.channel === turn.transport
    && requester.accountId === turn.accountId
    && requester.senderId === turn.actorId
    && (!turn.senderIsOwner || requester.senderIsOwner === true);
}

/**
 * Resolve and validate the local live-ingress authority projection. Merely
 * installing the OpenClaw plugin never enables a workspace.
 */
export function resolveKgLiveIngressProjection(options: { workspace: string; workspaceId: string; expectedPluginDigest?: `sha256:${string}` }): KgLiveIngressProjectionV1 {
  const workspace = resolve(options.workspace);
  const state = join(workspace, "memory-state", "kg-v3");
  const projectionPath = join(state, "live-ingress.json");
  const authorityPath = join(state, "authority.json");
  if (!existsSync(projectionPath) || !existsSync(authorityPath)) {
    throw new KgLiveIngressError("LIVE_INGRESS_DISABLED", "KG v3 live ingress has no local projection/authority");
  }
  const projection = readJson<KgLiveIngressProjectionV1>(projectionPath);
  const authority = readJson<KgAuthorityMarkerV1>(authorityPath);
  if (projection.schema !== KG_V3_LIVE_INGRESS_SCHEMA
    || projection.workspaceId !== options.workspaceId
    || projection.enabled !== true
    || !["canary", "enabled"].includes(projection.mode)
    || !digest(projection.releaseDigest)
    || !digest(projection.pluginDigest)
    || !token(projection.grantSessionKey)
    || !Array.isArray(projection.allowedContextKinds)
    || projection.allowedContextKinds.length === 0
    || projection.allowedContextKinds.some((kind) => !["direct", "group", "topic"].includes(kind))
    || new Set(projection.allowedContextKinds).size !== projection.allowedContextKinds.length
    || typeof projection.requireOwner !== "boolean"
    || !token(projection.approvedBy)
    || !iso(projection.approvedAt)) {
    throw new KgLiveIngressError("LIVE_INGRESS_DISABLED", "KG v3 live-ingress projection is invalid");
  }
  if (options.expectedPluginDigest && projection.pluginDigest !== options.expectedPluginDigest) {
    throw new KgLiveIngressError("LIVE_INGRESS_DISABLED", "KG v3 live ingress plugin digest mismatch");
  }
  const sessionAuthority = authority.enabledSessionCapabilities?.find((entry) => entry.sessionKey === projection.grantSessionKey);
  if (authority.schema !== KG_V3_AUTHORITY_SCHEMA
    || authority.workspaceId !== projection.workspaceId
    || authority.releaseDigest !== projection.releaseDigest
    || authority.schemaDigest !== KG_V3_SCHEMA_DIGEST
    || authority.mode !== projection.mode
    || !sessionAuthority?.capabilities.includes("kg:v3:write")) {
    throw new KgLiveIngressError("LIVE_INGRESS_DISABLED", "KG v3 live ingress does not match current authority");
  }
  return projection;
}

type BoundToolCall = { turn: KgLiveInboundTurn; verifier: TrustedInboundVerifier };

/**
 * In-process, single-use bridge from server-stamped inbound hooks to model
 * tool execution. Model parameters never contain provenance authority.
 */
export class KgLiveTurnAuthority {
  readonly #turns = new Map<string, { turn: KgLiveInboundTurn; used: boolean; expiresAt: number }>();
  readonly #toolCalls = new Map<string, BoundToolCall>();

  constructor(readonly options: { now?: () => number; ttlMs?: number } = {}) {}

  capture(turn: KgLiveInboundTurn): void {
    const now = this.options.now?.() ?? Date.now();
    this.prune(now);
    if (!token(turn.runId) || !token(turn.runtimeSessionKey) || !token(turn.workspace)
      || !token(turn.workspaceId) || !token(turn.grantSessionKey) || !token(turn.accountId)
      || !token(turn.actorId) || !token(turn.messageId) || !iso(turn.observedAt)
      || !["telegram", "openclaw"].includes(turn.transport)
      || !["direct", "group", "topic"].includes(turn.contextKind)) {
      throw new KgLiveIngressError("INVALID_TURN", "live inbound turn is incomplete");
    }
    this.#turns.set(turn.runId, { turn: Object.freeze({ ...turn }), used: false, expiresAt: now + (this.options.ttlMs ?? 10 * 60_000) });
  }

  bindToolCall(input: { runId?: string; toolCallId?: string; runtimeSessionKey?: string; requester?: KgLiveToolRequester }): void {
    const now = this.options.now?.() ?? Date.now();
    this.prune(now);
    if (!token(input.runId) || !token(input.toolCallId) || !token(input.runtimeSessionKey)) {
      throw new KgLiveIngressError("TURN_NOT_FOUND", "tool call has no trusted run/session identity");
    }
    const state = this.#turns.get(input.runId);
    if (!state || state.turn.runtimeSessionKey !== input.runtimeSessionKey) {
      throw new KgLiveIngressError("TURN_NOT_FOUND", "tool call does not belong to a captured inbound turn");
    }
    if (state.used) throw new KgLiveIngressError("TURN_ALREADY_USED", "source turn already used its KG write authority");
    if (!input.requester || !sameRequester(state.turn, input.requester)) {
      throw new KgLiveIngressError("REQUESTER_MISMATCH", "tool requester does not match captured inbound sender");
    }
    const expected: InboundMetadataEnvelope = {
      transport: state.turn.transport,
      accountId: state.turn.accountId,
      workspaceId: state.turn.workspaceId,
      sessionKey: state.turn.grantSessionKey,
      actorId: state.turn.actorId,
      messageId: state.turn.messageId,
      contextKind: state.turn.contextKind,
    };
    const verifier = new TrustedInboundVerifier((candidate) => JSON.stringify(candidate) === JSON.stringify(expected));
    state.used = true;
    this.#toolCalls.set(input.toolCallId, { turn: state.turn, verifier });
  }

  consumeToolCall(toolCallId: string): { turn: KgLiveInboundTurn; metadata: AttestedInboundMetadata; verifier: TrustedInboundVerifier } {
    const binding = this.#toolCalls.get(toolCallId);
    if (!binding) throw new KgLiveIngressError("TOOL_CALL_NOT_BOUND", "tool call has no server-stamped inbound authority");
    this.#toolCalls.delete(toolCallId);
    const envelope: InboundMetadataEnvelope = {
      transport: binding.turn.transport,
      accountId: binding.turn.accountId,
      workspaceId: binding.turn.workspaceId,
      sessionKey: binding.turn.grantSessionKey,
      actorId: binding.turn.actorId,
      messageId: binding.turn.messageId,
      contextKind: binding.turn.contextKind,
    };
    return { turn: binding.turn, metadata: binding.verifier.attest(envelope), verifier: binding.verifier };
  }

  dropRun(runId?: string): void {
    if (!runId) return;
    this.#turns.delete(runId);
    for (const [toolCallId, binding] of this.#toolCalls) if (binding.turn.runId === runId) this.#toolCalls.delete(toolCallId);
  }

  hasRun(runId?: string, runtimeSessionKey?: string): boolean {
    if (!runId || !runtimeSessionKey) return false;
    const now = this.options.now?.() ?? Date.now();
    this.prune(now);
    const state = this.#turns.get(runId);
    return Boolean(state && !state.used && state.turn.runtimeSessionKey === runtimeSessionKey);
  }

  private prune(now: number): void {
    for (const [runId, state] of this.#turns) if (state.expiresAt <= now) this.dropRun(runId);
  }
}

export function readKgLiveRegistry(workspace: string, workspaceId: string): KgRegistryV1 {
  const path = join(resolve(workspace), "memory-state", "kg-v3", "registry.json");
  if (!existsSync(path)) throw new KgLiveIngressError("ENTITY_UNRESOLVED", "KG v3 registry is unavailable");
  try {
    return validateKgRegistry(readJson(path), workspaceId);
  } catch {
    throw new KgLiveIngressError("ENTITY_UNRESOLVED", "KG v3 registry is invalid");
  }
}

export function createKgLiveWriteRequest(options: { registry: KgRegistryV1; metadata: AttestedInboundMetadata; observedAt: string; input: KgLiveWriteInput }): KgWriteRequest {
  const entity = options.registry.entities.find((item) => item.id === options.input.entityId);
  if (!entity) throw new KgLiveIngressError("ENTITY_UNRESOLVED", `unknown KG v3 entity: ${options.input.entityId}`);
  return {
    assertion: {
      workspaceId: options.metadata.workspaceId,
      entityId: entity.id,
      entityType: entity.type,
      kind: options.input.kind,
      predicate: options.input.predicate,
      object: options.input.object,
      scope: [...entity.scopes],
      replacesId: options.input.replacesId ?? null,
      provenance: {
        sourceKind: "user_message",
        sessionKey: options.metadata.sessionKey,
        messageId: options.metadata.messageId,
        actorId: options.metadata.actorId,
        operationId: deriveKgOperationId({
          workspaceId: options.metadata.workspaceId,
          sessionKey: options.metadata.sessionKey,
          messageId: options.metadata.messageId,
          actorId: options.metadata.actorId,
          entityId: entity.id,
          predicate: options.input.predicate,
        }),
        observedAt: options.observedAt,
      },
    },
    intent: { explicit: true, compound: false, store: "kg-current", statementClass: "durable" },
  };
}

export function createKgLiveRetractionRequest(options: { metadata: AttestedInboundMetadata; observedAt: string; input: KgLiveRetractInput }): KgRetractionRequest {
  return {
    workspaceId: options.metadata.workspaceId,
    entityId: options.input.entityId,
    assertionId: options.input.assertionId,
    provenance: {
      sourceKind: "user_message",
      sessionKey: options.metadata.sessionKey,
      messageId: options.metadata.messageId,
      actorId: options.metadata.actorId,
      operationId: deriveKgOperationId({
        workspaceId: options.metadata.workspaceId,
        sessionKey: options.metadata.sessionKey,
        messageId: options.metadata.messageId,
        actorId: options.metadata.actorId,
        entityId: options.input.entityId,
        assertionId: options.input.assertionId,
        action: "retract",
      }),
      observedAt: options.observedAt,
    },
  };
}
