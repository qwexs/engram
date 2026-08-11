import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type AdaptationScopeLevel = "person" | "domain" | "workspace" | "company";
export type AdaptationRisk = "low" | "medium" | "high";

export interface AdaptationScope {
  level: AdaptationScopeLevel;
  subject: string;
  domain?: string | null;
}

export interface TrustedActorContext {
  trusted: true;
  channel: string;
  accountId: string;
  actorId: string;
  contextKind: "direct" | "group" | "topic" | "system" | "import";
}

export interface ActorGrant {
  grantId?: string;
  workspaceId: string;
  scope: string;
  actions: string[];
  maxRisk: AdaptationRisk;
}

interface ActorPrincipal {
  principalId: string;
  transportBindings: Array<{ channel: string; accountId: string; actorId: string }>;
  grants: ActorGrant[];
}

export interface ActorRegistryV1 {
  schema: "oll.actor-registry.v1";
  revision: number;
  principals: ActorPrincipal[];
}

export interface AuthorizationDecision {
  status: "authorized" | "review_required" | "denied";
  resolverVersion: 1;
  principalId: string | null;
  grantId: string | null;
  registryRevision: number;
  registryDigest: `sha256:${string}`;
  requestedScope: { level: AdaptationScopeLevel; subject: string; domain: string | null };
  reason: string;
}

export interface LoadedActorRegistry {
  registry: ActorRegistryV1;
  digest: `sha256:${string}`;
  path: string;
}

const RISK_ORDER: Record<AdaptationRisk, number> = { low: 1, medium: 2, high: 3 };
const EMPTY_REGISTRY_DIGEST = `sha256:${createHash("sha256").update("").digest("hex")}` as const;

function normalizeScope(scope: AdaptationScope): AuthorizationDecision["requestedScope"] {
  if (!scope || !["person", "domain", "workspace", "company"].includes(scope.level)) {
    throw new Error("invalid adaptation scope level");
  }
  const subject = String(scope.subject || "").trim();
  if (!subject || subject.length > 300) throw new Error("adaptation scope subject is required");
  const domain = scope.domain == null ? null : String(scope.domain).trim() || null;
  return { level: scope.level, subject, domain };
}

function validateRegistry(value: unknown): ActorRegistryV1 {
  const registry = value as ActorRegistryV1;
  if (!registry || registry.schema !== "oll.actor-registry.v1") throw new Error("unsupported actor registry schema");
  if (!Number.isInteger(registry.revision) || registry.revision < 1) throw new Error("actor registry revision must be >= 1");
  if (!Array.isArray(registry.principals)) throw new Error("actor registry principals must be an array");
  for (const principal of registry.principals) {
    if (!principal?.principalId || !Array.isArray(principal.transportBindings) || !Array.isArray(principal.grants)) {
      throw new Error("invalid actor registry principal");
    }
  }
  return registry;
}

export function loadActorRegistry(path: string): LoadedActorRegistry {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`actor registry is unavailable: ${absolute}`);
  const raw = readFileSync(absolute, "utf8");
  return {
    registry: validateRegistry(JSON.parse(raw)),
    digest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    path: absolute,
  };
}

function grantId(principalId: string, grant: ActorGrant, index: number): string {
  return grant.grantId || `grant:${principalId}:${index + 1}`;
}

function scopeMatches(grant: ActorGrant, scope: AuthorizationDecision["requestedScope"], context: TrustedActorContext): boolean {
  if (scope.level === "person") {
    const selfSubjects = new Set([
      `${context.channel}:${context.actorId}`,
      `${context.channel}:user:${context.actorId}`,
    ]);
    return grant.scope === "person:self" && selfSubjects.has(scope.subject);
  }
  if (scope.level === "domain") return grant.scope === "domain" || grant.scope === `domain:${scope.subject}`;
  if (scope.level === "workspace") return grant.scope === "workspace";
  return grant.scope === "company";
}

function reviewDecision(
  scope: AuthorizationDecision["requestedScope"],
  reason: string,
  registryRevision = 1,
  registryDigest: `sha256:${string}` = EMPTY_REGISTRY_DIGEST,
  principalId: string | null = null,
): AuthorizationDecision {
  return {
    status: "review_required",
    resolverVersion: 1,
    principalId,
    grantId: null,
    registryRevision,
    registryDigest,
    requestedScope: scope,
    reason,
  };
}

export function authorizeAdaptationAction(options: {
  registry?: LoadedActorRegistry | null;
  actorContext?: TrustedActorContext | null;
  workspaceId: string;
  scope: AdaptationScope;
  action: "signal:create" | "rule:auto-activate" | "rule:review" | "rule:approve";
  risk?: AdaptationRisk;
  sourceType?: "message" | "daily-note" | "transcript" | "import" | "system";
}): AuthorizationDecision {
  const scope = normalizeScope(options.scope);
  const loaded = options.registry || null;
  const registryRevision = loaded?.registry.revision || 1;
  const registryDigest = loaded?.digest || EMPTY_REGISTRY_DIGEST;
  const context = options.actorContext || null;
  if (!loaded) return reviewDecision(scope, "actor registry unavailable", registryRevision, registryDigest);
  if (!context || context.trusted !== true) {
    return reviewDecision(scope, "trusted inbound actor metadata is required", registryRevision, registryDigest);
  }
  if (options.sourceType && options.sourceType !== "message") {
    return reviewDecision(scope, "non-message or reconstructed evidence requires review", registryRevision, registryDigest);
  }
  const principals = loaded.registry.principals.filter((principal) => principal.transportBindings.some((binding) => (
    binding.channel === context.channel
      && binding.accountId === context.accountId
      && String(binding.actorId) === String(context.actorId)
  )));
  if (principals.length !== 1) {
    return reviewDecision(scope, principals.length ? "ambiguous actor binding" : "unknown actor binding", registryRevision, registryDigest);
  }
  const principal = principals[0];
  if (scope.level === "company" && options.action !== "rule:approve") {
    return reviewDecision(scope, "company scope always requires human review", registryRevision, registryDigest, principal.principalId);
  }
  if ((context.contextKind === "group" || context.contextKind === "topic") && scope.level === "person") {
    const self = scope.subject === `${context.channel}:${context.actorId}` || scope.subject === `${context.channel}:user:${context.actorId}`;
    if (!self) return reviewDecision(scope, "group context cannot authorize another person's scope", registryRevision, registryDigest, principal.principalId);
  }
  const risk = options.risk || "low";
  const matching = principal.grants
    .map((grant, index) => ({ grant, index }))
    .filter(({ grant }) => (
      (grant.workspaceId === options.workspaceId || grant.workspaceId === "*")
        && grant.actions.includes(options.action)
        && scopeMatches(grant, scope, context)
        && RISK_ORDER[grant.maxRisk] >= RISK_ORDER[risk]
    ));
  if (matching.length !== 1) {
    return reviewDecision(
      scope,
      matching.length ? "ambiguous matching grant" : "no exact grant for actor, workspace, scope, action, and risk",
      registryRevision,
      registryDigest,
      principal.principalId,
    );
  }
  const match = matching[0];
  return {
    status: "authorized",
    resolverVersion: 1,
    principalId: principal.principalId,
    grantId: grantId(principal.principalId, match.grant, match.index),
    registryRevision,
    registryDigest,
    requestedScope: scope,
    reason: "exact trusted actor and scope grant matched",
  };
}

const HIGH_RISK_RE = /\b(legal|law|privacy|personal data|security|permission|credential|payment|publish|send|message|email|external action|safety)\b|(юрид|правов|приватн|персональн|безопасн|разрешен|парол|оплат|опублик|отправ|внешнее действ)/iu;
const LOW_RISK_RE = /\b(tone|format|terminology|wording|structure|layout|style|workflow|sequence)\b|(тон|формат|термин|формулиров|структур|стил|порядок|процесс)/iu;

export function classifyAdaptationRisk(input: {
  scope: AdaptationScope;
  statement: string;
  expectedBehavior?: string;
}): { risk: AdaptationRisk; reasons: string[]; reviewRequired: boolean } {
  const text = `${input.statement || ""}\n${input.expectedBehavior || ""}`;
  const reasons: string[] = [];
  if (input.scope.level === "company") reasons.push("company scope");
  if (HIGH_RISK_RE.test(text)) reasons.push("regulated, authority, or external-action semantics");
  if (reasons.length) return { risk: "high", reasons, reviewRequired: true };
  if (input.scope.level === "workspace") {
    return { risk: "medium", reasons: ["workspace-wide scope"], reviewRequired: true };
  }
  if (LOW_RISK_RE.test(text)) return { risk: "low", reasons: ["reversible tone/format/terminology/workflow behavior"], reviewRequired: false };
  return { risk: "medium", reasons: ["semantics are not in the deterministic low-risk class"], reviewRequired: true };
}
