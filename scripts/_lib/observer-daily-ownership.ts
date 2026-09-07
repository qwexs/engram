import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSessionSegment, splitCanonicalSessionKey } from "../../src/session-key.ts";
import { resolveMemoryObservationProjection } from "../../src/memory-observation/projection.ts";

/** Resolve an on-disk partition without widening an exact runtime binding. */
export function observerOwnsDailyCapture(workspace: string, agentId: string, session: string, now = new Date()): boolean {
  try {
    const config = JSON.parse(readFileSync(join(workspace, "engram.json"), "utf8"));
    if (config.workspace?.id !== agentId) return false;
    const full = splitCanonicalSessionKey(session);
    if (full && full.agentId !== agentId) return false;
    const segment = full?.sessionKey ?? normalizeSessionSegment(session);
    if (!segment) return false;
    const projection = resolveMemoryObservationProjection({ workspace, workspaceId: agentId });
    if (projection.mode !== "canary" || projection.captureOwnership?.owner !== "observer"
      || Date.parse(projection.captureOwnership.effectiveAfter) > now.getTime()) return false;
    return projection.bindings.some((binding) => binding.runtimeSessionKey === `agent:${agentId}:*`
      || (splitCanonicalSessionKey(binding.runtimeSessionKey)?.agentId === agentId
        && splitCanonicalSessionKey(binding.runtimeSessionKey)?.sessionKey === segment));
  } catch { return false; }
}

/** Only v4 group domains transfer their derived changelog/status projection. */
export function observerOwnsDomainProjection(workspace: string, domain: string, now = new Date()): boolean {
  try {
    const config = JSON.parse(readFileSync(join(workspace, "engram.json"), "utf8"));
    const projection = resolveMemoryObservationProjection({ workspace, workspaceId: config.workspace?.id });
    return projection.schema === "engram.memory-observation-rollout.v4"
      && projection.captureOwnership?.owner === "observer"
      && Date.parse(projection.captureOwnership.effectiveAfter) <= now.getTime()
      && projection.bindings.some(binding => binding.topicDomain?.domain === domain);
  } catch { return false; }
}
