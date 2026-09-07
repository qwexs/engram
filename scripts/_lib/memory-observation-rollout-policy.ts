import { realpathSync } from "node:fs";
import { sha256, type JsonValue } from "../../src/memory-observation/ledger.ts";

/** Admission uses the runtime subset, not the downstream consumer policies. */
export function runtimeSourcePolicyDigest(policy: any): `sha256:${string}` {
  const rules = policy.rules.filter((rule: any) =>
    rule.stage === "source-admission" || rule.stage === "advisory-evaluation");
  if (rules.length !== 2) throw new Error("runtime authority policy is ambiguous");
  return sha256({ schema: policy.schema, policyVersion: policy.policyVersion,
    rules, defaultDecision: policy.defaultDecision } as JsonValue);
}

/** Non-admin peers are authorized by an exact configured DM route, never a family selector. */
export function personalBatchBinding(config: any, workspace: string, workspaceId: string, sessionKey: string) {
  const match = /^agent:([A-Za-z0-9._-]+):telegram:direct:([1-9][0-9]*)$/.exec(sessionKey);
  if (!match || match[1] === "main" || match[1] !== workspaceId) {
    throw new Error("personal batch activation requires an exact matching non-main Telegram direct contour");
  }
  const [, agentId, peerId] = match;
  const entries = config?.agents?.entries;
  const entry = Array.isArray(entries) ? entries.find((candidate: any) => candidate.id === agentId) : entries?.[agentId!];
  if (!entry?.workspace || realpathSync(entry.workspace) !== realpathSync(workspace)) {
    throw new Error("configured agent workspace mismatch");
  }
  const routes = (config.bindings ?? []).filter((route: any) =>
    route.match?.channel === "telegram" && route.match?.peer?.kind === "direct"
    && String(route.match.peer.id) === peerId);
  if (routes.length !== 1 || routes[0].agentId !== agentId) {
    throw new Error("personal direct route is missing, ambiguous, or belongs to another agent");
  }
  return { runtimeSessionKey: sessionKey, scopeClass: "self" as const,
    scopeId: `telegram:${peerId}`, requireOwner: false, allowedChannels: ["telegram"] as ["telegram"] };
}
