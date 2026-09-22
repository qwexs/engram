import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSessionSegment } from "../session-key.ts";
import { parseCanonicalSessionKey } from "./contracts.ts";
import { deliveryOwnershipDecision, readDeliveryOwnerPolicy } from "./policy.ts";

function agentId(event: any, raw: string): string | null {
  const parsed = /^agent:([^:]+):/.exec(raw)?.[1];
  if (parsed) return parsed;
  const typed = typeof event?.context?.agentId === "string" ? event.context.agentId.trim() : "";
  if (typed) return typed;
  const top = typeof event?.agentId === "string" ? event.agentId.trim() : "";
  if (top) return top;
  return null;
}

function workspaceAgentId(workspace: string): string | null {
  try {
    const config = JSON.parse(readFileSync(join(workspace, "engram.json"), "utf8"));
    const value = typeof config?.workspace?.id === "string" ? config.workspace.id.trim() : "";
    return value || null;
  } catch {
    return null;
  }
}

export function canonicalLegacySessionKey(workspace: string, event: any): string | null {
  const raw = String(event?.context?.sessionKey || event?.sessionKey || "").trim();
  if (!raw) return null;
  if (parseCanonicalSessionKey(raw)) return raw;
  const id = agentId(event, raw) ?? workspaceAgentId(workspace);
  const segment = normalizeSessionSegment(raw);
  if (!id || !segment) return null;
  if (segment === "main") return `agent:${id}:main`;
  let match = /^telegram-direct-(\d+)$/.exec(segment);
  if (match) return `agent:${id}:telegram:direct:${match[1]}`;
  match = /^telegram-group--(\d+)-topic-(\d+)$/.exec(segment);
  if (match) return `agent:${id}:telegram:group:-${match[1]}:topic:${match[2]}`;
  match = /^telegram-group--(\d+)$/.exec(segment);
  if (match) return `agent:${id}:telegram:group:-${match[1]}`;
  return null;
}

/**
 * Shared cutover guard for legacy bootstrap hooks. Missing, malformed, or
 * unresolved policy keeps legacy delivery enabled so context is not lost.
 */
export function legacyDeliveryAllowed(workspace: string, event: any): boolean {
  try {
    const sessionKey = canonicalLegacySessionKey(workspace, event);
    if (!sessionKey) return true;
    return deliveryOwnershipDecision(readDeliveryOwnerPolicy(workspace), sessionKey).legacyMayDeliver;
  } catch {
    return true;
  }
}
