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
  requireOwner: boolean;
  senderIsOwner: boolean;
}

export type KgLivePendingInboundTurn = Omit<KgLiveInboundTurn, "runId" | "senderIsOwner">;

export interface KgLiveAdoptedInboundTurn extends KgLivePendingInboundTurn {
  sourceTurnId: string;
  senderIsOwner: boolean;
}

export interface KgLiveToolRequester {
  channel?: string;
  accountId?: string;
  senderId?: string;
  senderIsOwner?: boolean;
}

export interface KgLiveInboundHookIdentity {
  runId: string;
  runtimeSessionKey: string;
  messageId: string;
  actorId: string;
  accountId: string;
}

export interface KgLivePersistedUserTurnHookIdentity {
  runtimeSessionKey: string;
  transport: "telegram" | "openclaw";
  messageId: string;
  sourceTurnId: string;
  senderIsOwner: boolean;
}

export interface KgLiveAgentTurnPrepareHookIdentity {
  runId: string;
  runtimeSessionKey: string;
  actorId: string;
  accountId: string;
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

function sharedHookToken(label: string, eventValue: unknown, contextValue: unknown): string {
  const eventToken = eventValue === undefined || eventValue === null ? null : token(eventValue) ? eventValue : undefined;
  const contextToken = contextValue === undefined || contextValue === null ? null : token(contextValue) ? contextValue : undefined;
  if (eventToken === undefined || contextToken === undefined) {
    throw new KgLiveIngressError("INVALID_TURN", `${label} is invalid`);
  }
  if (eventToken && contextToken && eventToken !== contextToken) {
    throw new KgLiveIngressError("INVALID_TURN", `${label} differs between inbound event and context`);
  }
  const value = eventToken || contextToken;
  if (!value) throw new KgLiveIngressError("INVALID_TURN", `${label} is missing from inbound event/context`);
  return value;
}

/**
 * Normalize the server-owned identity duplicated across OpenClaw's
 * `inbound_claim` event and context. SDK fields are optional on each surface,
 * so either may supply a value, but disagreement must fail closed.
 */
export function resolveKgLiveInboundHookIdentity(event: Record<string, unknown>, context: Record<string, unknown>): KgLiveInboundHookIdentity {
  return {
    runId: sharedHookToken("runId", event.runId, context.runId),
    runtimeSessionKey: sharedHookToken("sessionKey", event.sessionKey, context.sessionKey),
    messageId: sharedHookToken("messageId", event.messageId, context.messageId),
    actorId: sharedHookToken("senderId", event.senderId, context.senderId),
    accountId: sharedHookToken("accountId", event.accountId, context.accountId),
  };
}

/** Normalize the server-owned identity exposed by ordinary `message_received`. */
export function resolveKgLiveMessageReceivedHookIdentity(event: Record<string, unknown>, context: Record<string, unknown>): Omit<KgLiveInboundHookIdentity, "runId"> {
  const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
    ? event.metadata as Record<string, unknown>
    : {};
  const messageId = sharedHookToken("messageId", event.messageId, context.messageId);
  const actorId = sharedHookToken("senderId", event.senderId, context.senderId);
  if (metadata.messageId !== undefined && requiredHookToken("metadata.messageId", metadata.messageId) !== messageId) {
    throw new KgLiveIngressError("INVALID_TURN", "messageId differs from message metadata");
  }
  if (metadata.senderId !== undefined && requiredHookToken("metadata.senderId", metadata.senderId) !== actorId) {
    throw new KgLiveIngressError("INVALID_TURN", "senderId differs from message metadata");
  }
  return {
    runtimeSessionKey: sharedHookToken("sessionKey", event.sessionKey, context.sessionKey),
    messageId,
    actorId,
    accountId: sharedHookToken("accountId", event.accountId, context.accountId),
  };
}

/**
 * Normalize the protected user-turn metadata exposed to the synchronous
 * `before_message_write` hook. OpenClaw restores these fields after hooks, so
 * they are an adoption barrier rather than model-controlled provenance.
 */
export function resolveKgLivePersistedUserTurnHookIdentity(event: Record<string, unknown>, context: Record<string, unknown>): KgLivePersistedUserTurnHookIdentity {
  const message = event.message && typeof event.message === "object" && !Array.isArray(event.message)
    ? event.message as Record<string, unknown>
    : null;
  if (!message || message.role !== "user") {
    throw new KgLiveIngressError("INVALID_TURN", "persisted turn is not a user message");
  }
  const metadata = message.__openclaw && typeof message.__openclaw === "object" && !Array.isArray(message.__openclaw)
    ? message.__openclaw as Record<string, unknown>
    : null;
  const transport = metadata?.transport && typeof metadata.transport === "object" && !Array.isArray(metadata.transport)
    ? metadata.transport as Record<string, unknown>
    : null;
  const channel = requiredHookToken("transport.channel", transport?.channel);
  if (channel !== "telegram" && channel !== "openclaw") {
    throw new KgLiveIngressError("INVALID_TURN", "persisted turn transport is unsupported");
  }
  const sourceTurnId = requiredHookToken("sourceTurnId", message.idempotencyKey);
  if (!/^channel-user:v1:[a-f0-9]{64}$/.test(sourceTurnId)) {
    throw new KgLiveIngressError("INVALID_TURN", "persisted turn source identity is invalid");
  }
  const senderIsOwner = metadata?.senderIsOwner;
  if (typeof senderIsOwner !== "boolean") {
    throw new KgLiveIngressError("INVALID_TURN", "senderIsOwner is missing from persisted turn");
  }
  return {
    runtimeSessionKey: sharedHookToken("sessionKey", event.sessionKey, context.sessionKey),
    transport: channel,
    messageId: requiredHookToken("transport.messageId", transport?.messageId),
    sourceTurnId,
    senderIsOwner,
  };
}

/** Attach an adopted user message to the run allocated by OpenClaw. */
export function resolveKgLiveAgentTurnPrepareHookIdentity(_event: Record<string, unknown>, context: Record<string, unknown>): KgLiveAgentTurnPrepareHookIdentity {
  return {
    runId: requiredHookToken("runId", context.runId),
    runtimeSessionKey: requiredHookToken("sessionKey", context.sessionKey),
    actorId: requiredHookToken("senderId", context.senderId),
    accountId: requiredHookToken("accountId", context.accountId),
  };
}

function requiredHookToken(label: string, value: unknown): string {
  if (!token(value)) throw new KgLiveIngressError("INVALID_TURN", `${label} is missing or invalid`);
  return value;
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
    && requester.senderId === turn.actorId;
}

function samePendingTurn(left: KgLivePendingInboundTurn, right: KgLivePendingInboundTurn): boolean {
  return left.runtimeSessionKey === right.runtimeSessionKey
    && left.workspace === right.workspace
    && left.workspaceId === right.workspaceId
    && left.grantSessionKey === right.grantSessionKey
    && left.transport === right.transport
    && left.accountId === right.accountId
    && left.actorId === right.actorId
    && left.messageId === right.messageId
    && left.contextKind === right.contextKind
    && left.observedAt === right.observedAt
    && left.requireOwner === right.requireOwner;
}

function sameCapturedTurn(left: KgLiveInboundTurn, right: KgLiveInboundTurn): boolean {
  return left.runId === right.runId
    && left.runtimeSessionKey === right.runtimeSessionKey
    && left.workspace === right.workspace
    && left.workspaceId === right.workspaceId
    && left.grantSessionKey === right.grantSessionKey
    && left.transport === right.transport
    && left.accountId === right.accountId
    && left.actorId === right.actorId
    && left.messageId === right.messageId
    && left.contextKind === right.contextKind
    && left.observedAt === right.observedAt
    && left.requireOwner === right.requireOwner;
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
  readonly #pending = new Map<string, { turn: KgLivePendingInboundTurn; expiresAt: number }>();
  readonly #adopted = new Map<string, { turn: KgLiveAdoptedInboundTurn; expiresAt: number }>();
  readonly #toolCalls = new Map<string, BoundToolCall>();

  constructor(readonly options: { now?: () => number; ttlMs?: number } = {}) {}

  capturePending(turn: KgLivePendingInboundTurn): void {
    const now = this.options.now?.() ?? Date.now();
    this.prune(now);
    if (!token(turn.runtimeSessionKey) || !token(turn.workspace) || !token(turn.workspaceId)
      || !token(turn.grantSessionKey) || !token(turn.accountId)
      || !token(turn.actorId) || !token(turn.messageId) || !iso(turn.observedAt)
      || typeof turn.requireOwner !== "boolean"
      || !["telegram", "openclaw"].includes(turn.transport)
      || !["direct", "group", "topic"].includes(turn.contextKind)) {
      throw new KgLiveIngressError("INVALID_TURN", "pending live inbound turn is incomplete");
    }
    const key = `${turn.runtimeSessionKey}\u0000${turn.messageId}`;
    const frozen = Object.freeze({ ...turn });
    const adopted = [...this.#adopted.entries()].find(([, state]) => state.turn.runtimeSessionKey === turn.runtimeSessionKey
      && state.turn.messageId === turn.messageId);
    if (adopted) {
      if (samePendingTurn(adopted[1].turn, frozen)) return;
      this.#adopted.delete(adopted[0]);
      throw new KgLiveIngressError("INVALID_TURN", "conflicting pending capture follows an adopted messageId");
    }
    const captured = [...this.#turns.entries()].find(([, state]) => state.turn.runtimeSessionKey === turn.runtimeSessionKey
      && state.turn.messageId === turn.messageId);
    if (captured) {
      if (samePendingTurn(captured[1].turn, frozen)) return;
      this.dropRun(captured[0]);
      throw new KgLiveIngressError("INVALID_TURN", "conflicting pending capture follows a captured messageId");
    }
    const existing = this.#pending.get(key);
    if (existing && !samePendingTurn(existing.turn, frozen)) {
      this.#pending.delete(key);
      throw new KgLiveIngressError("INVALID_TURN", "conflicting pending captures share one messageId");
    }
    this.#pending.set(key, { turn: frozen, expiresAt: now + (this.options.ttlMs ?? 10 * 60_000) });
  }

  adoptPendingTurn(input: { runtimeSessionKey?: string; transport?: string; messageId?: string; sourceTurnId?: string; senderIsOwner?: boolean }): void {
    const now = this.options.now?.() ?? Date.now();
    this.prune(now);
    if (!token(input.runtimeSessionKey) || !token(input.messageId) || !token(input.sourceTurnId)
      || !["telegram", "openclaw"].includes(input.transport || "") || typeof input.senderIsOwner !== "boolean") {
      throw new KgLiveIngressError("TURN_NOT_FOUND", "persisted user turn has no trusted pending-turn identity");
    }
    const pendingKey = `${input.runtimeSessionKey}\u0000${input.messageId}`;
    const adoptedKey = `${input.runtimeSessionKey}\u0000${input.sourceTurnId}`;
    const existing = this.#adopted.get(adoptedKey);
    if (existing) {
      if (existing.turn.messageId !== input.messageId
        || existing.turn.transport !== input.transport
        || existing.turn.senderIsOwner !== input.senderIsOwner) {
        this.#adopted.delete(adoptedKey);
        this.#pending.delete(pendingKey);
        throw new KgLiveIngressError("INVALID_TURN", "conflicting persisted turns share one source identity");
      }
      return;
    }
    const state = this.#pending.get(pendingKey);
    if (!state || state.turn.transport !== input.transport) {
      throw new KgLiveIngressError("TURN_NOT_FOUND", "persisted user turn does not match a pending inbound turn");
    }
    this.#pending.delete(pendingKey);
    const turn = Object.freeze({ ...state.turn, sourceTurnId: input.sourceTurnId, senderIsOwner: input.senderIsOwner });
    this.#adopted.set(adoptedKey, { turn, expiresAt: now + (this.options.ttlMs ?? 10 * 60_000) });
  }

  attachAdoptedRun(input: { runId?: string; runtimeSessionKey?: string; accountId?: string; actorId?: string }): void {
    const now = this.options.now?.() ?? Date.now();
    this.prune(now);
    if (!token(input.runId) || !token(input.runtimeSessionKey) || !token(input.accountId) || !token(input.actorId)) {
      throw new KgLiveIngressError("TURN_NOT_FOUND", "agent turn has no trusted adopted-turn identity");
    }
    const captured = this.#turns.get(input.runId);
    if (captured) {
      if (captured.turn.runtimeSessionKey !== input.runtimeSessionKey
        || captured.turn.accountId !== input.accountId
        || captured.turn.actorId !== input.actorId) {
        this.dropRun(input.runId);
        throw new KgLiveIngressError("INVALID_TURN", "agent run identity conflicts with its captured turn");
      }
      return;
    }
    const matches = [...this.#adopted.entries()].filter(([, state]) => state.turn.runtimeSessionKey === input.runtimeSessionKey
      && state.turn.accountId === input.accountId
      && state.turn.actorId === input.actorId);
    if (matches.length !== 1) {
      if (matches.length > 1) {
        for (const [key] of matches) this.#adopted.delete(key);
      }
      throw new KgLiveIngressError("TURN_NOT_FOUND", matches.length === 0
        ? "agent run does not match an adopted inbound turn"
        : "agent run matches multiple adopted inbound turns");
    }
    const [key, state] = matches[0]!;
    this.#adopted.delete(key);
    const { sourceTurnId: _sourceTurnId, ...turn } = state.turn;
    this.capture({ ...turn, runId: input.runId });
  }

  capture(turn: KgLiveInboundTurn): void {
    const now = this.options.now?.() ?? Date.now();
    this.prune(now);
    if (!token(turn.runId) || !token(turn.runtimeSessionKey) || !token(turn.workspace)
      || !token(turn.workspaceId) || !token(turn.grantSessionKey) || !token(turn.accountId)
      || !token(turn.actorId) || !token(turn.messageId) || !iso(turn.observedAt)
      || typeof turn.requireOwner !== "boolean" || typeof turn.senderIsOwner !== "boolean"
      || !["telegram", "openclaw"].includes(turn.transport)
      || !["direct", "group", "topic"].includes(turn.contextKind)) {
      throw new KgLiveIngressError("INVALID_TURN", "live inbound turn is incomplete");
    }
    const existing = this.#turns.get(turn.runId);
    if (existing) {
      if (!sameCapturedTurn(existing.turn, turn)) {
        this.dropRun(turn.runId);
        throw new KgLiveIngressError("INVALID_TURN", "conflicting trusted captures share one runId");
      }
      if (turn.senderIsOwner && !existing.turn.senderIsOwner) {
        existing.turn = Object.freeze({ ...existing.turn, senderIsOwner: true });
      }
      return;
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
    if (state.turn.requireOwner && input.requester.senderIsOwner !== true) {
      throw new KgLiveIngressError("REQUESTER_MISMATCH", "tool requester is not the authorized owner");
    }
    const boundTurn = state.turn.senderIsOwner || input.requester.senderIsOwner !== true
      ? state.turn
      : Object.freeze({ ...state.turn, senderIsOwner: true });
    const expected: InboundMetadataEnvelope = {
      transport: boundTurn.transport,
      accountId: boundTurn.accountId,
      workspaceId: boundTurn.workspaceId,
      sessionKey: boundTurn.grantSessionKey,
      actorId: boundTurn.actorId,
      messageId: boundTurn.messageId,
      contextKind: boundTurn.contextKind,
    };
    const verifier = new TrustedInboundVerifier((candidate) => JSON.stringify(candidate) === JSON.stringify(expected));
    state.used = true;
    this.#toolCalls.set(input.toolCallId, { turn: boundTurn, verifier });
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
    for (const [key, state] of this.#pending) if (state.expiresAt <= now) this.#pending.delete(key);
    for (const [key, state] of this.#adopted) if (state.expiresAt <= now) this.#adopted.delete(key);
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
