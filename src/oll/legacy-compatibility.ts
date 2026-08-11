export const LEGACY_RETHINK_COMPATIBILITY_VERSION = 1 as const;

export type LegacyCompatibleAction =
  | { type: "promote_observation"; observationId: string }
  | { type: "resolve_tension"; tensionId: string; resolution: string };

export interface LegacyCompatibilityHandlers {
  promoteObservation(action: Extract<LegacyCompatibleAction, { type: "promote_observation" }>): unknown;
  resolveTension(action: Extract<LegacyCompatibleAction, { type: "resolve_tension" }>): unknown;
}

/**
 * Explicit compatibility boundary for legacy observation/tension maintenance.
 * It is intentionally not part of oll.rethink-handoff.v2 and cannot admit
 * experiments, rethink2, or autoresearch.
 */
export function applyLegacyRethinkCompatibilityAction(
  version: number,
  action: LegacyCompatibleAction,
  handlers: LegacyCompatibilityHandlers,
): unknown {
  if (version !== LEGACY_RETHINK_COMPATIBILITY_VERSION) throw new Error("unsupported legacy rethink compatibility version");
  if (action.type === "promote_observation") return handlers.promoteObservation(action);
  if (action.type === "resolve_tension") return handlers.resolveTension(action);
  throw new Error("legacy action is outside the observation/tension compatibility boundary");
}
