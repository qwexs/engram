import { normalizeSessionSegment, splitAgentAndSession } from "./parse-agent-id.js";

export type RuntimeSessionSkipReason = "cron" | "heartbeat" | "ephemeral";

export function runtimeSessionSkipReason(
  event: any,
  explicitSessionSegment?: string,
): RuntimeSessionSkipReason | null {
  const rawKey = String(
    explicitSessionSegment ||
    event?.context?.sessionKey ||
    event?.sessionKey ||
    "",
  ).trim();
  const parsed = splitAgentAndSession(rawKey);
  const sessionSegment = String(
    parsed?.sessionKey || normalizeSessionSegment(rawKey) || "",
  ).toLowerCase();

  if (/^cron(?:-|$)/.test(sessionSegment)) return "cron";
  if (/^heartbeat(?:-|$)/.test(sessionSegment)) return "heartbeat";
  if (/^(?:subagent|ephemeral)(?:-|$)/.test(sessionSegment)) return "ephemeral";

  const runtimeHint = String(
    event?.context?.runKind ||
    event?.context?.sessionType ||
    event?.context?.triggerKind ||
    "",
  ).toLowerCase();
  if (runtimeHint === "cron") return "cron";
  if (runtimeHint === "heartbeat") return "heartbeat";
  if (runtimeHint === "subagent" || runtimeHint === "ephemeral") return "ephemeral";
  return null;
}

export function isNamedEphemeralSession(sessionSegment: string): boolean {
  return runtimeSessionSkipReason({}, sessionSegment) !== null;
}

export function isHeartbeatIneligibleSession(sessionSegment: string): boolean {
  const name = String(sessionSegment || "").trim().toLowerCase();
  if (isNamedEphemeralSession(name)) return true;
  if (/^_/.test(name)) return true;
  if (/-test$/.test(name)) return true;
  if (/^skill-workshop-review-incognito-/.test(name)) return true;
  if (/^telegram-\d+$/.test(name)) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name);
}
