import {
  splitCanonicalSessionKey,
} from "../../src/session-key.js";

export { normalizeSessionSegment } from "../../src/session-key.js";

/**
 * Extract the agentId from an OpenClaw sessionKey of the form
 * `agent:<id>:<channel>:<rest>`. Returns null if sessionKey is empty or does
 * not match the expected format.
 *
 * Single source of truth for agent-id resolution across all engram hooks.
 * Previously duplicated in `engram-topic-domain-load/workspace-resolver.ts`
 * and inlined (with different fallback logic) in `engram-session-start/handler.ts`.
 * Keeping one helper prevents drift when OpenClaw changes the sessionKey
 * format — every hook updates together.
 *
 * @param sessionKey - the `event.sessionKey` or `event.context.sessionKey` value
 * @returns the agent id, or null if not parseable
 */
export function parseAgentIdFromSessionKey(sessionKey: string | undefined | null): string | null {
  if (!sessionKey) return null;
  const m = sessionKey.match(/^agent:([^:]+):/);
  return m ? m[1] : null;
}

/**
 * Convenience: derive the on-disk session segment from an OpenClaw sessionKey.
 * Format: `agent:<id>:<channel>:<rest>` → a canonical, path-safe session
 * segment. Telegram topic variants all resolve to
 * `telegram-group--<absChatId>-topic-<topicId>`.
 *
 * @returns object with `agentId` and `sessionKey` (path-safe segment), or null
 *          if the sessionKey cannot be parsed.
 */
export function splitAgentAndSession(sessionKey: string | undefined | null): { agentId: string; sessionKey: string } | null {
  return splitCanonicalSessionKey(sessionKey);
}
