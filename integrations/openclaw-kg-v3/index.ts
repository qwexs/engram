import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/core";
import {
  KgLiveIngressError,
  KgLiveTurnAuthority,
  KgV3Core,
  TrustedKgRuntime,
  createKgLiveRetractionRequest,
  createKgLiveWriteRequest,
  readKgLiveRegistry,
  resolveKgLiveAgentRunHookIdentity,
  resolveKgLiveInboundHookIdentity,
  resolveKgLiveIngressProjection,
  resolveKgLiveMessageReceivedHookIdentity,
  resolveKgLiveReplyDispatchHookIdentity,
  type KgLiveRetractInput,
  type KgLiveWriteInput,
  type KgRuntimeGrantRegistryV1,
} from "../../src/kg-v3/index.ts";

const SAVE_TOOL = "engram_memory_save";
const RETRACT_TOOL = "engram_memory_retract";
const TOOL_NAMES = new Set([SAVE_TOOL, RETRACT_TOOL]);
const authority = new KgLiveTurnAuthority();

function pluginDigest(): `sha256:${string}` {
  const bytes = readFileSync(fileURLToPath(import.meta.url));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const installedPluginDigest = pluginDigest();

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function agentIdFromSessionKey(sessionKey?: string): string | null {
  const match = sessionKey?.match(/^agent:([^:]+):/);
  return match?.[1] || null;
}

function contextKindFromSessionKey(sessionKey: string, threadId?: unknown): "direct" | "group" | "topic" | null {
  if (threadId !== undefined && threadId !== null) return "topic";
  const parts = sessionKey.split(":");
  if (parts.includes("direct")) return "direct";
  if (parts.includes("group")) return "group";
  return null;
}

function resolveAgentWorkspace(config: any, agentId: string): string | null {
  const entries = config?.agents?.entries;
  let entry: any;
  if (Array.isArray(entries)) entry = entries.find((candidate) => candidate?.id === agentId);
  else if (entries && typeof entries === "object") entry = entries[agentId];
  const value = entry?.workspace || (agentId === "main" ? config?.agents?.defaults?.workspace : null);
  return typeof value === "string" && value.trim() ? resolve(value) : null;
}

function workspaceId(workspace: string): string | null {
  try {
    const config = readJson<any>(join(workspace, "engram.json"));
    return typeof config?.workspace?.id === "string" && config.workspace.id.trim() ? config.workspace.id.trim() : null;
  } catch {
    return null;
  }
}

function timestamp(value?: number): string {
  if (!Number.isFinite(value)) return new Date().toISOString();
  const milliseconds = value! < 10_000_000_000 ? value! * 1_000 : value!;
  return new Date(milliseconds).toISOString();
}

function activeWorkspaceFromToolContext(ctx: any) {
  const workspace = typeof ctx.workspaceDir === "string" ? resolve(ctx.workspaceDir) : null;
  if (!workspace) return null;
  const id = workspaceId(workspace);
  if (!id) return null;
  try {
    const projection = resolveKgLiveIngressProjection({ workspace, workspaceId: id, expectedPluginDigest: installedPluginDigest });
    if (projection.requireOwner && ctx.senderIsOwner !== true) return null;
    return { workspace, workspaceId: id, projection };
  } catch {
    return null;
  }
}

function registryDescription(workspace: string, workspaceId: string): string {
  try {
    const registry = readKgLiveRegistry(workspace, workspaceId);
    const lines = registry.entities.map((entity) => `${entity.id}: ${entity.predicates.map((predicate) => `${predicate.name}[${predicate.kinds.join("|")};${predicate.objectTypes.join("|")}]`).join(", ")}`);
    return lines.join("\n").slice(0, 6_000);
  } catch {
    return "Registry unavailable; the tool will fail closed.";
  }
}

const objectSchema = {
  anyOf: [
    { type: "object", properties: { type: { const: "string" }, value: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["type", "value"], additionalProperties: false },
    { type: "object", properties: { type: { const: "number" }, value: { type: "number" } }, required: ["type", "value"], additionalProperties: false },
    { type: "object", properties: { type: { const: "boolean" }, value: { type: "boolean" } }, required: ["type", "value"], additionalProperties: false },
    { type: "object", properties: { type: { const: "entity-ref" }, value: { type: "string", minLength: 3, maxLength: 300 } }, required: ["type", "value"], additionalProperties: false },
  ],
};

function createSaveTool(ctx: any) {
  const active = activeWorkspaceFromToolContext(ctx);
  if (!active) return null;
  return {
    name: SAVE_TOOL,
    label: "Engram Memory Save",
    description: [
      "Save exactly one explicit durable user assertion to canonical KG v3.",
      "Use only when the user explicitly asks to remember or states a stable identity, preference, decision, or constraint that must change future answers/actions.",
      "Never use for proposals, plans, progress, audit/test output, project status, casual text, or facts outside the allowlisted registry. Use at most once per source turn.",
      "Current allowlist:",
      registryDescription(active.workspace, active.workspaceId),
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        entityId: { type: "string", minLength: 3, maxLength: 300 },
        kind: { type: "string", enum: ["identity", "preference", "decision", "constraint"] },
        predicate: { type: "string", minLength: 1, maxLength: 128 },
        object: objectSchema,
        replacesId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
      },
      required: ["entityId", "kind", "predicate", "object"],
      additionalProperties: false,
    },
    execute: async (toolCallId: string, params: KgLiveWriteInput) => {
      const bound = authority.consumeToolCall(toolCallId);
      const projection = resolveKgLiveIngressProjection({ workspace: bound.turn.workspace, workspaceId: bound.turn.workspaceId, expectedPluginDigest: installedPluginDigest });
      if (!projection.allowedContextKinds.includes(bound.turn.contextKind) || (projection.requireOwner && !bound.turn.senderIsOwner)) {
        throw new KgLiveIngressError("LIVE_INGRESS_DISABLED", "source turn is outside the live-ingress projection");
      }
      const registry = readKgLiveRegistry(bound.turn.workspace, bound.turn.workspaceId);
      const grants = readJson<KgRuntimeGrantRegistryV1>(join(bound.turn.workspace, "memory-state", "kg-v3", "runtime-grants.json"));
      const runtime = new TrustedKgRuntime(new KgV3Core({ workspace: bound.turn.workspace, workspaceId: bound.turn.workspaceId }), grants, bound.verifier);
      const receipt = await runtime.write(createKgLiveWriteRequest({ registry, metadata: bound.metadata, observedAt: bound.turn.observedAt, input: params }), bound.metadata);
      return { content: [{ type: "text", text: `${receipt.status}${receipt.reason ? `:${receipt.reason}` : ""} assertion=${receipt.assertionId || "none"}` }], details: receipt };
    },
  };
}

function createRetractTool(ctx: any) {
  const active = activeWorkspaceFromToolContext(ctx);
  if (!active) return null;
  return {
    name: RETRACT_TOOL,
    label: "Engram Memory Retract",
    description: "Retract one known KG v3 assertion only when the authoritative user explicitly says it is wrong. Use the exact entity and assertion UUID. One KG mutation authority is available per source turn.",
    parameters: {
      type: "object",
      properties: {
        entityId: { type: "string", minLength: 3, maxLength: 300 },
        assertionId: { type: "string", format: "uuid" },
      },
      required: ["entityId", "assertionId"],
      additionalProperties: false,
    },
    execute: async (toolCallId: string, params: KgLiveRetractInput) => {
      const bound = authority.consumeToolCall(toolCallId);
      const projection = resolveKgLiveIngressProjection({ workspace: bound.turn.workspace, workspaceId: bound.turn.workspaceId, expectedPluginDigest: installedPluginDigest });
      if (!projection.allowedContextKinds.includes(bound.turn.contextKind) || (projection.requireOwner && !bound.turn.senderIsOwner)) {
        throw new KgLiveIngressError("LIVE_INGRESS_DISABLED", "source turn is outside the live-ingress projection");
      }
      const grants = readJson<KgRuntimeGrantRegistryV1>(join(bound.turn.workspace, "memory-state", "kg-v3", "runtime-grants.json"));
      const runtime = new TrustedKgRuntime(new KgV3Core({ workspace: bound.turn.workspace, workspaceId: bound.turn.workspaceId }), grants, bound.verifier);
      const receipt = await runtime.retract(createKgLiveRetractionRequest({ metadata: bound.metadata, observedAt: bound.turn.observedAt, input: params }), bound.metadata);
      return { content: [{ type: "text", text: `${receipt.status}${receipt.reason ? `:${receipt.reason}` : ""} assertion=${receipt.assertionId || "none"}` }], details: receipt };
    },
  };
}

export default definePluginEntry({
  id: "engram-kg-v3",
  name: "Engram KG v3 live ingress",
  description: "Trusted, typed, explicit-only KG v3 tools with per-workspace authority markers.",
  register(api: any) {
    api.on("message_received", (event: any, ctx: any) => {
      try {
        const identity = resolveKgLiveMessageReceivedHookIdentity(event || {}, ctx || {});
        const agentId = agentIdFromSessionKey(identity.runtimeSessionKey);
        const config = api.runtime.config?.current?.() ?? api.config;
        if (!agentId || !config) return;
        const workspace = resolveAgentWorkspace(config, agentId);
        const id = workspace ? workspaceId(workspace) : null;
        if (!workspace || !id) return;
        const projection = resolveKgLiveIngressProjection({ workspace, workspaceId: id, expectedPluginDigest: installedPluginDigest });
        const contextKind = contextKindFromSessionKey(identity.runtimeSessionKey, event.threadId);
        if (!contextKind || !projection.allowedContextKinds.includes(contextKind)) return;
        const transport = ctx.channelId === "telegram" ? "telegram" : ctx.channelId === "openclaw" ? "openclaw" : null;
        if (!transport) return;
        authority.capturePending({
          runtimeSessionKey: identity.runtimeSessionKey,
          workspace,
          workspaceId: id,
          grantSessionKey: projection.grantSessionKey,
          transport,
          accountId: identity.accountId,
          actorId: identity.actorId,
          messageId: identity.messageId,
          contextKind,
          observedAt: timestamp(event.timestamp),
          requireOwner: projection.requireOwner,
          content: event.content,
        });
      } catch (error) {
        api.logger.debug?.(`engram-kg-v3: ordinary inbound not eligible: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    api.on("before_agent_run", (event: any, ctx: any) => {
      if (ctx.trigger !== "user") return;
      try {
        const identity = resolveKgLiveAgentRunHookIdentity(event || {}, ctx || {});
        authority.attachPendingRun({
          runId: identity.runId,
          runtimeSessionKey: identity.runtimeSessionKey,
          accountId: identity.accountId,
          actorId: identity.actorId,
          content: identity.content,
          senderIsOwner: identity.senderIsOwner,
        });
      } catch (error) {
        api.logger.debug?.(`engram-kg-v3: agent run has no ordinary inbound authority: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    api.on("reply_dispatch", (event: any) => {
      try {
        const finalized = event?.ctx;
        if (!finalized || finalized.InboundAccessAuthorized !== true) return;
        const identity = resolveKgLiveReplyDispatchHookIdentity(event || {}, finalized);
        const sessionAgentId = agentIdFromSessionKey(identity.runtimeSessionKey);
        const finalizedAgentId = typeof finalized.AgentId === "string" && finalized.AgentId.trim() ? finalized.AgentId.trim() : null;
        const agentId = finalizedAgentId || sessionAgentId;
        if (sessionAgentId && agentId && sessionAgentId !== agentId) {
          throw new KgLiveIngressError("INVALID_TURN", "agentId differs from the canonical session key");
        }
        const config = api.runtime.config?.current?.() ?? api.config;
        if (!agentId || !config) return;
        const workspace = resolveAgentWorkspace(config, agentId);
        const id = workspace ? workspaceId(workspace) : null;
        if (!workspace || !id) return;
        const projection = resolveKgLiveIngressProjection({ workspace, workspaceId: id, expectedPluginDigest: installedPluginDigest });
        const contextKind = finalized.MessageThreadId !== undefined && finalized.MessageThreadId !== null
          ? "topic"
          : finalized.ChatType === "group" || finalized.ChatType === "supergroup" || finalized.GroupSubject || finalized.GroupChannel
            ? "group"
            : "direct";
        if (!projection.allowedContextKinds.includes(contextKind)) return;
        const channel = String(finalized.OriginatingChannel || finalized.Surface || finalized.Provider || "").toLowerCase();
        const transport = channel === "telegram" ? "telegram" : channel === "openclaw" ? "openclaw" : null;
        if (!transport) return;
        authority.capture({
          runId: identity.runId,
          runtimeSessionKey: identity.runtimeSessionKey,
          workspace,
          workspaceId: id,
          grantSessionKey: projection.grantSessionKey,
          transport,
          accountId: identity.accountId,
          actorId: identity.actorId,
          messageId: identity.messageId,
          contextKind,
          observedAt: timestamp(finalized.Timestamp),
          requireOwner: projection.requireOwner,
          senderIsOwner: false,
        });
      } catch (error) {
        api.logger.debug?.(`engram-kg-v3: reply dispatch not eligible: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    api.on("inbound_claim", (event: any, ctx: any) => {
      try {
        const identity = resolveKgLiveInboundHookIdentity(event || {}, ctx || {});
        const sessionAgentId = agentIdFromSessionKey(identity.runtimeSessionKey);
        const agentId = typeof ctx?.agentId === "string" && ctx.agentId.trim() ? ctx.agentId.trim() : sessionAgentId;
        if (sessionAgentId && agentId && sessionAgentId !== agentId) {
          throw new KgLiveIngressError("INVALID_TURN", "agentId differs from the canonical session key");
        }
        const config = api.runtime.config?.current?.() ?? api.config;
        if (!agentId || !config) return;
        const workspace = resolveAgentWorkspace(config, agentId);
        const id = workspace ? workspaceId(workspace) : null;
        if (!workspace || !id) return;
        const projection = resolveKgLiveIngressProjection({ workspace, workspaceId: id, expectedPluginDigest: installedPluginDigest });
        const contextKind = event.threadId !== undefined && event.threadId !== null ? "topic" : event.isGroup ? "group" : "direct";
        if (!projection.allowedContextKinds.includes(contextKind) || (projection.requireOwner && event.senderIsOwner !== true)) return;
        const transport = event.channel === "telegram" ? "telegram" : event.channel === "openclaw" ? "openclaw" : null;
        if (!transport) return;
        authority.capture({
          runId: identity.runId,
          runtimeSessionKey: identity.runtimeSessionKey,
          workspace,
          workspaceId: id,
          grantSessionKey: projection.grantSessionKey,
          transport,
          accountId: identity.accountId,
          actorId: identity.actorId,
          messageId: identity.messageId,
          contextKind,
          observedAt: timestamp(event.timestamp),
          requireOwner: projection.requireOwner,
          senderIsOwner: event.senderIsOwner === true,
        });
      } catch (error) {
        api.logger.debug?.(`engram-kg-v3: inbound not eligible: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    api.on("before_prompt_build", (_event: any, ctx: any) => {
      if (ctx.trigger !== "user" || !authority.hasRun(ctx.runId, ctx.sessionKey)) return;
      return { appendSystemContext: `Engram KG v3 live canary is active for this turn. For one explicit durable user assertion, use ${SAVE_TOOL} (or ${RETRACT_TOOL} for an explicit correction) instead of legacy memory-write.js. Do not call either tool for operational progress, proposals, test output, project status, or ordinary conversation. At most one KG mutation tool call is authorized for this source turn.` };
    });

    api.on("before_tool_call", (event: any, ctx: any) => {
      if (!TOOL_NAMES.has(event.toolName)) return;
      try {
        authority.bindToolCall({ runId: ctx.runId || event.runId, toolCallId: ctx.toolCallId || event.toolCallId, runtimeSessionKey: ctx.sessionKey, requester: ctx.requester });
      } catch (error) {
        const reason = error instanceof KgLiveIngressError ? `${error.code}: ${error.message}` : "UNVERIFIED_INBOUND: live turn authority unavailable";
        return { block: true, blockReason: reason };
      }
    });

    api.on("agent_end", (_event: any, ctx: any) => authority.dropRun(ctx.runId));
    api.registerTool((ctx: any) => createSaveTool(ctx), { name: SAVE_TOOL });
    api.registerTool((ctx: any) => createRetractTool(ctx), { name: RETRACT_TOOL });
    api.registerToolMetadata({ toolName: SAVE_TOOL, displayName: "Engram memory save", description: "Write one explicit durable KG v3 assertion.", risk: "high", tags: ["memory", "engram", "kg-v3"] });
    api.registerToolMetadata({ toolName: RETRACT_TOOL, displayName: "Engram memory retract", description: "Retract one explicitly incorrect KG v3 assertion.", risk: "high", tags: ["memory", "engram", "kg-v3"] });
  },
});
