/**
 * Canonical on-disk session segments.
 *
 * OpenClaw exposes Telegram topic identity in several equivalent forms:
 *   - agent:<agentId>:telegram:group:-<chatId>:topic:<topicId>
 *   - telegram:group:-<chatId>:topic:<topicId>
 *   - telegram:-<chatId>:topic:<topicId>
 *   - telegram-group--<chatId>-topic-<topicId>
 *   - telegram--<chatId>-topic-<topicId> (legacy)
 *
 * They must all resolve to exactly one filesystem segment:
 *   telegram-group--<absChatId>-topic-<topicId>
 */

const FULL_AGENT_KEY = /^agent:([^:]+):(.+)$/;
const TOPIC_COLON_KEY = /^telegram(?::group)?:-?(\d+):topic:(\d+)$/;
const TOPIC_DASH_KEY = /^telegram(?:-group)?--?(\d+)-topic-(\d+)$/;
const TOPIC_THREAD_KEY = /^telegram-(\d+)-thread-(\d+)$/;
const TOPIC_LEGACY_SHORT_KEY = /^telegram--(\d+)-(\d+)$/;

export type SplitSessionKey = {
  agentId: string;
  sessionKey: string;
};

function isUnsafePathSegment(value: string): boolean {
  return value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Convert a runtime or operator-provided session key into one safe on-disk
 * segment. Returns null for empty or path-unsafe values.
 */
export function normalizeSessionSegment(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const full = trimmed.match(FULL_AGENT_KEY);
  const candidate = full ? full[2] : trimmed;

  const topicColon = candidate.match(TOPIC_COLON_KEY);
  const topicDash = candidate.match(TOPIC_DASH_KEY);
  const topicThread = candidate.match(TOPIC_THREAD_KEY);
  const topicLegacyShort = candidate.match(TOPIC_LEGACY_SHORT_KEY);
  const topic = topicColon || topicDash || topicThread || topicLegacyShort;
  if (topic) {
    const chatId = BigInt(topic[1]).toString();
    const topicId = BigInt(topic[2]).toString();
    return `telegram-group--${chatId}-topic-${topicId}`;
  }

  // Preserve the established fallback for non-topic runtime keys while still
  // guaranteeing one path segment and preventing directory traversal.
  const normalized = candidate.replace(/:/g, "-");
  if (!normalized || isUnsafePathSegment(normalized)) return null;
  return normalized;
}

/** Parse a full OpenClaw key and canonicalize its on-disk session segment. */
export function splitCanonicalSessionKey(raw: string | undefined | null): SplitSessionKey | null {
  if (typeof raw !== "string") return null;
  const match = raw.trim().match(FULL_AGENT_KEY);
  if (!match) return null;
  const agentId = match[1];
  if (!agentId || isUnsafePathSegment(agentId) || agentId.includes(":")) return null;
  const sessionKey = normalizeSessionSegment(match[2]);
  return sessionKey ? { agentId, sessionKey } : null;
}
