import type { KgV3AccessState } from "./access.ts";
import type { KgAssertionV3 } from "./types.ts";

export type KgV3DecayTier = "hot" | "warm" | "cold";

export interface KgV3ProjectionStats {
  active: number;
  included: number;
  hot: number;
  warm: number;
  coldIncluded: number;
  coldOmitted: number;
}

export interface KgV3ProjectionResult {
  body: string;
  searchBody: string;
  stats: KgV3ProjectionStats;
}

function daysSince(value: string, now: Date): number {
  const elapsed = now.getTime() - Date.parse(value);
  if (!Number.isFinite(elapsed)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(elapsed / 86_400_000));
}

export function kgV3DecayTier(assertion: KgAssertionV3, accessState: KgV3AccessState, now: Date): KgV3DecayTier {
  const access = accessState.assertions[assertion.id];
  const elapsed = daysSince(access?.lastAccessed || assertion.createdAt, now);
  let tier: KgV3DecayTier = elapsed <= 7 ? "hot" : elapsed <= 30 ? "warm" : "cold";
  if (tier === "cold" && (access?.accessCount || 0) >= 10) tier = "warm";
  return tier;
}

function permanentlyIncluded(assertion: KgAssertionV3): boolean {
  return assertion.kind === "identity" || assertion.kind === "constraint";
}

/**
 * Native v3 projection policy:
 * - identity/constraint are stable context and remain projected;
 * - preference/decision follow Hot/Warm/Cold decay;
 * - accessCount >= 10 resists Cold demotion;
 * - canonical assertions remain immutable and fully retrievable regardless of tier.
 */
export function renderKgV3Projection(assertions: KgAssertionV3[], accessState: KgV3AccessState, now = new Date()): KgV3ProjectionResult {
  const active = assertions.filter((assertion) => assertion.lifecycle.status === "active");
  const decorated = active.map((assertion) => {
    const access = accessState.assertions[assertion.id];
    return {
      assertion,
      tier: kgV3DecayTier(assertion, accessState, now),
      accessCount: access?.accessCount || 0,
    };
  });
  const included = decorated.filter((item) => item.tier !== "cold" || permanentlyIncluded(item.assertion));
  const rank: Record<KgV3DecayTier, number> = { hot: 0, warm: 1, cold: 2 };
  included.sort((left, right) => rank[left.tier] - rank[right.tier]
    || right.accessCount - left.accessCount
    || left.assertion.entityId.localeCompare(right.assertion.entityId)
    || left.assertion.predicate.localeCompare(right.assertion.predicate)
    || left.assertion.id.localeCompare(right.assertion.id));

  const lines = ["# Engram KG v3 current", "", "_Generated from committed active v3 assertions with native access-aware decay. Do not edit._", ""];
  for (const item of included) {
    const assertion = item.assertion;
    lines.push(`- \`${assertion.entityId}\` · \`${assertion.predicate}\` = ${JSON.stringify(assertion.object.value)} (\`${assertion.id}\`)`);
  }
  const searchLines = ["# Engram KG v3 searchable current", "", "_Generated from every committed active v3 assertion. Not injected into default context. Do not edit._", ""];
  for (const assertion of [...active].sort((left, right) => left.entityId.localeCompare(right.entityId)
    || left.predicate.localeCompare(right.predicate) || left.id.localeCompare(right.id))) {
    searchLines.push(`- \`${assertion.entityId}\` · \`${assertion.predicate}\` = ${JSON.stringify(assertion.object.value)} (\`${assertion.id}\`)`);
  }
  const stats: KgV3ProjectionStats = {
    active: active.length,
    included: included.length,
    hot: decorated.filter((item) => item.tier === "hot").length,
    warm: decorated.filter((item) => item.tier === "warm").length,
    coldIncluded: included.filter((item) => item.tier === "cold").length,
    coldOmitted: decorated.filter((item) => item.tier === "cold" && !permanentlyIncluded(item.assertion)).length,
  };
  return { body: `${lines.join("\n")}\n`, searchBody: `${searchLines.join("\n")}\n`, stats };
}
