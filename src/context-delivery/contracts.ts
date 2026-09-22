import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { samePath } from "./paths.ts";

export const DELIVERY_SOURCE_ORDER = ["oll", "domain", "session", "kg"] as const;

export type DeliverySource = (typeof DELIVERY_SOURCE_ORDER)[number];
export type DeliveryScopeKind = "main" | "peer-direct" | "group-direct" | "topic-thread";
export type DeliveryOwnerMode = "legacy" | "shadow" | "canary" | "active";
export type DeliveryReason =
  | "DELIVERED"
  | "OBSERVED_WOULD_DELIVER"
  | "CANARY_NOT_SELECTED"
  | "SESSION_UNRESOLVED"
  | "WORKSPACE_MISMATCH"
  | "SCOPE_DENIED"
  | "AUTH_DENIED"
  | "AMBIGUOUS_ACTOR"
  | "DOMAIN_UNBOUND"
  | "SNAPSHOT_UNAVAILABLE"
  | "SOURCE_MISSING"
  | "SOURCE_INVALID"
  | "BUDGET_SOURCE_CAP"
  | "BUDGET_TOTAL_CAP"
  | "HOST_CONTEXT_BUDGET_TOO_SMALL"
  | "DUPLICATE_SOURCE"
  | "INTERNAL_ERROR";

export type CanonicalDeliveryScope = {
  sessionKey: string;
  agentId: string;
  kind: DeliveryScopeKind;
  actorId?: string;
  chatId?: string;
  topicId?: string;
};

export type DeliveryHookIdentity = {
  runId: string;
  agentId: string;
  sessionKey: string;
  workspaceDir: string;
  expectedWorkspaceDir: string;
  channel?: string;
  chatId?: string;
  senderId?: string;
};

export type DeliveryOwnerPolicyBodyV2 = {
  schema: "engram.context-delivery-owner-policy.v2";
  revision: number;
  mode: DeliveryOwnerMode;
  canarySessionKeys: string[];
  caps: {
    totalBytes: number;
    sourceBytes: Record<DeliverySource, number>;
    minContextTokenBudget: number | null;
  };
};

export type DeliveryOwnerPolicyV2 = DeliveryOwnerPolicyBodyV2 & {
  policyDigest: `sha256:${string}`;
};

export type DeliverySourceBlock = {
  source: DeliverySource;
  artifactDigest: `sha256:${string}`;
  content: string;
};

export type DeliverySourceOutcome =
  | { source: DeliverySource; status: "selected"; block: DeliverySourceBlock }
  | { source: DeliverySource; status: "omitted"; reason: DeliveryReason };

export type DeliverySourceReceipt = {
  source: DeliverySource;
  artifactDigest: `sha256:${string}` | null;
  renderedBytes: number;
  selected: boolean;
  reason: DeliveryReason;
};

export type DeliveryReceiptV1 = {
  schema: "engram.context-delivery-receipt.v1";
  mode: DeliveryOwnerMode;
  reason: DeliveryReason;
  scopeKind: DeliveryScopeKind;
  scopeDigest: `sha256:${string}`;
  policyDigest: `sha256:${string}`;
  envelopeDigest: `sha256:${string}` | null;
  renderedBytes: number;
  totalCapBytes: number;
  contextTokenBudget: number | null;
  sources: DeliverySourceReceipt[];
};

export type DeliveryPlan = {
  context: string | null;
  prospectiveContext: string | null;
  receipt: DeliveryReceiptV1;
};

const AGENT_TOKEN = "[A-Za-z0-9][A-Za-z0-9._@-]{0,299}";
const LOCATION_TOKEN = "-?[A-Za-z0-9][A-Za-z0-9._@-]{0,299}";
const MAIN_KEY = new RegExp(`^agent:(${AGENT_TOKEN}):main$`);
const DIRECT_KEY = new RegExp(`^agent:(${AGENT_TOKEN}):telegram:direct:(${LOCATION_TOKEN})$`);
const GROUP_KEY = new RegExp(`^agent:(${AGENT_TOKEN}):telegram:group:(${LOCATION_TOKEN})$`);
const TOPIC_KEY = new RegExp(`^agent:(${AGENT_TOKEN}):telegram:group:(${LOCATION_TOKEN}):topic:(${LOCATION_TOKEN})$`);
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalPolicyJson(policy: DeliveryOwnerPolicyBodyV2): string {
  return JSON.stringify({
    schema: policy.schema,
    revision: policy.revision,
    mode: policy.mode,
    canarySessionKeys: [...policy.canarySessionKeys].sort(),
    caps: {
      totalBytes: policy.caps.totalBytes,
      sourceBytes: {
        oll: policy.caps.sourceBytes.oll,
        domain: policy.caps.sourceBytes.domain,
        session: policy.caps.sourceBytes.session,
        kg: policy.caps.sourceBytes.kg,
      },
      minContextTokenBudget: policy.caps.minContextTokenBudget,
    },
  });
}

export function parseCanonicalSessionKey(sessionKey: string): CanonicalDeliveryScope | null {
  let match = MAIN_KEY.exec(sessionKey);
  if (match) return { sessionKey, agentId: match[1]!, kind: "main" };
  match = DIRECT_KEY.exec(sessionKey);
  if (match) return { sessionKey, agentId: match[1]!, kind: "peer-direct", actorId: match[2]! };
  match = TOPIC_KEY.exec(sessionKey);
  if (match) return { sessionKey, agentId: match[1]!, kind: "topic-thread", chatId: match[2]!, topicId: match[3]! };
  match = GROUP_KEY.exec(sessionKey);
  if (match) return { sessionKey, agentId: match[1]!, kind: "group-direct", chatId: match[2]! };
  return null;
}

export function resolveDeliveryScope(identity: DeliveryHookIdentity): CanonicalDeliveryScope | null {
  if (!identity.runId.trim() || !identity.agentId.trim()
    || !isAbsolute(identity.workspaceDir) || !isAbsolute(identity.expectedWorkspaceDir)
    || !samePath(identity.workspaceDir, identity.expectedWorkspaceDir)) return null;
  const scope = parseCanonicalSessionKey(identity.sessionKey);
  if (!scope || scope.agentId !== identity.agentId) return null;
  if (scope.kind !== "main" && identity.channel !== undefined && identity.channel !== "telegram") return null;
  if (scope.kind === "peer-direct") {
    if (identity.senderId !== undefined && identity.senderId !== scope.actorId) return null;
    if (identity.chatId !== undefined && identity.chatId !== scope.actorId) return null;
  }
  if (scope.kind === "group-direct" && identity.chatId !== undefined && identity.chatId !== scope.chatId) return null;
  return scope;
}

export function parseDeliveryOwnerPolicy(value: unknown): DeliveryOwnerPolicyV2 {
  if (!isRecord(value) || !exactKeys(value, ["schema", "revision", "mode", "canarySessionKeys", "caps", "policyDigest"])) {
    throw new Error("invalid delivery owner policy shape");
  }
  if (value.schema !== "engram.context-delivery-owner-policy.v2") throw new Error("invalid delivery owner policy schema");
  if (typeof value.policyDigest !== "string" || !SHA256.test(value.policyDigest)) throw new Error("invalid delivery owner policy digest");
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error("invalid delivery owner policy revision");
  if (!(["legacy", "shadow", "canary", "active"] as unknown[]).includes(value.mode)) throw new Error("invalid delivery owner policy mode");
  if (!Array.isArray(value.canarySessionKeys) || value.canarySessionKeys.some((key) => typeof key !== "string" || !parseCanonicalSessionKey(key))) {
    throw new Error("invalid delivery owner policy canary keys");
  }
  if (new Set(value.canarySessionKeys).size !== value.canarySessionKeys.length) throw new Error("duplicate delivery owner policy canary key");
  if (!isRecord(value.caps) || !exactKeys(value.caps, ["totalBytes", "sourceBytes", "minContextTokenBudget"])) {
    throw new Error("invalid delivery owner policy caps");
  }
  if (!Number.isSafeInteger(value.caps.totalBytes) || (value.caps.totalBytes as number) < 256) throw new Error("invalid total byte cap");
  if (!isRecord(value.caps.sourceBytes) || !exactKeys(value.caps.sourceBytes, DELIVERY_SOURCE_ORDER)) throw new Error("invalid source byte caps");
  for (const source of DELIVERY_SOURCE_ORDER) {
    const cap = value.caps.sourceBytes[source];
    if (!Number.isSafeInteger(cap) || (cap as number) < 128) throw new Error(`invalid ${source} byte cap`);
  }
  const minimum = value.caps.minContextTokenBudget;
  if (minimum !== null && (!Number.isSafeInteger(minimum) || (minimum as number) < 1)) throw new Error("invalid minimum context token budget");
  const policy: DeliveryOwnerPolicyV2 = {
    schema: value.schema,
    revision: value.revision as number,
    mode: value.mode as DeliveryOwnerMode,
    canarySessionKeys: [...value.canarySessionKeys] as string[],
    caps: {
      totalBytes: value.caps.totalBytes as number,
      sourceBytes: {
        oll: value.caps.sourceBytes.oll as number,
        domain: value.caps.sourceBytes.domain as number,
        session: value.caps.sourceBytes.session as number,
        kg: value.caps.sourceBytes.kg as number,
      },
      minContextTokenBudget: minimum as number | null,
    },
    policyDigest: value.policyDigest as `sha256:${string}`,
  };
  if (deliveryOwnerPolicyDigest(policy) !== policy.policyDigest) throw new Error("delivery owner policy digest mismatch");
  return policy;
}

export function deliveryOwnerPolicyDigest(policy: DeliveryOwnerPolicyBodyV2): `sha256:${string}` {
  return sha256(canonicalPolicyJson(policy));
}

export function sealDeliveryOwnerPolicy(policy: DeliveryOwnerPolicyBodyV2): DeliveryOwnerPolicyV2 {
  return { ...policy, policyDigest: deliveryOwnerPolicyDigest(policy) };
}

function legacyMarker(source: DeliverySource, digest: `sha256:${string}`): string {
  if (source === "kg") return "<!-- engram-kg-v3-current -->";
  if (source === "oll") return `<!-- engram-bootstrap-context-hash:${digest} -->`;
  if (source === "session") return `<!-- engram-session-context:v1 digest=${digest} -->`;
  return `<!-- engram-system-event-hash:${digest.slice("sha256:".length, "sha256:".length + 8)} -->`;
}

function renderSource(block: DeliverySourceBlock): string {
  const version = block.source === "kg" ? "v3-current" : "v1";
  return [
    `<!-- engram-context-source:${block.source}:${version} digest=${block.artifactDigest} -->`,
    legacyMarker(block.source, block.artifactDigest),
    block.content.trim(),
  ].join("\n");
}

/** Exact serialized byte size used by the planner for one source. */
export function renderedDeliverySourceBytes(block: DeliverySourceBlock): number {
  return Buffer.byteLength(`\n${renderSource(block)}`, "utf8");
}

export function planDelivery(input: {
  identity: DeliveryHookIdentity;
  policy: DeliveryOwnerPolicyV2;
  sources: DeliverySourceBlock[];
  omissions?: Array<{ source: DeliverySource; reason: DeliveryReason }>;
  contextTokenBudget?: number;
}): DeliveryPlan {
  if (deliveryOwnerPolicyDigest(input.policy) !== input.policy.policyDigest) {
    throw new Error("delivery owner policy digest mismatch");
  }
  const scope = resolveDeliveryScope(input.identity);
  if (!scope) throw new Error("delivery scope is unresolved");
  const policyDigest = deliveryOwnerPolicyDigest(input.policy);
  const scopeDigest = sha256(scope.sessionKey);
  const sourceMap = new Map<DeliverySource, DeliverySourceBlock>();
  const omissionMap = new Map<DeliverySource, DeliveryReason>();
  const duplicates = new Set<DeliverySource>();
  for (const block of input.sources) {
    if (!SHA256.test(block.artifactDigest) || !block.content.trim()) throw new Error(`invalid ${block.source} source block`);
    if (sourceMap.has(block.source)) duplicates.add(block.source);
    else sourceMap.set(block.source, block);
  }
  for (const omission of input.omissions ?? []) {
    if (sourceMap.has(omission.source) || omissionMap.has(omission.source)) {
      throw new Error(`duplicate ${omission.source} source outcome`);
    }
    omissionMap.set(omission.source, omission.reason);
  }

  const hostBudget = Number.isSafeInteger(input.contextTokenBudget) && input.contextTokenBudget! > 0
    ? input.contextTokenBudget!
    : null;
  const budgetTooSmall = input.policy.caps.minContextTokenBudget !== null
    && (hostBudget === null || hostBudget < input.policy.caps.minContextTokenBudget);
  const canarySelected = input.policy.canarySessionKeys.includes(scope.sessionKey);
  const deliveryEnabled = input.policy.mode === "active" || (input.policy.mode === "canary" && canarySelected);

  const placeholderHeader = `<!-- engram-context-delivery:v1 envelope=sha256:${"0".repeat(64)} policy=${policyDigest} -->`;
  let renderedBytes = Buffer.byteLength(placeholderHeader, "utf8");
  const selected: Array<{ block: DeliverySourceBlock; rendered: string; bytes: number }> = [];
  const receipts: DeliverySourceReceipt[] = [];

  for (const source of DELIVERY_SOURCE_ORDER) {
    const block = sourceMap.get(source);
    if (!block) {
      receipts.push({
        source,
        artifactDigest: null,
        renderedBytes: 0,
        selected: false,
        reason: omissionMap.get(source) ?? "SOURCE_MISSING",
      });
      continue;
    }
    const rendered = renderSource(block);
    const bytes = renderedDeliverySourceBytes(block);
    let reason: DeliveryReason = "DELIVERED";
    let include = true;
    if (duplicates.has(source)) {
      reason = "DUPLICATE_SOURCE";
      include = false;
    } else if (bytes > input.policy.caps.sourceBytes[source]) {
      reason = "BUDGET_SOURCE_CAP";
      include = false;
    } else if (renderedBytes + bytes > input.policy.caps.totalBytes) {
      reason = "BUDGET_TOTAL_CAP";
      include = false;
    }
    if (include) {
      selected.push({ block, rendered, bytes });
      renderedBytes += bytes;
    }
    receipts.push({ source, artifactDigest: block.artifactDigest, renderedBytes: bytes, selected: include, reason });
  }

  const envelopeDigest = selected.length
    ? sha256(JSON.stringify({
      schema: "engram.context-delivery-envelope.v1",
      scopeKind: scope.kind,
      policyDigest,
      sources: selected.map(({ block, bytes }) => ({ source: block.source, artifactDigest: block.artifactDigest, renderedBytes: bytes })),
    }))
    : null;
  const prospectiveContext = envelopeDigest
    ? [`<!-- engram-context-delivery:v1 envelope=${envelopeDigest} policy=${policyDigest} -->`, ...selected.map(({ rendered }) => rendered)].join("\n")
    : null;

  let reason: DeliveryReason;
  if (budgetTooSmall) reason = "HOST_CONTEXT_BUDGET_TOO_SMALL";
  else if (!selected.length) reason = receipts.find((receipt) => receipt.reason !== "SOURCE_MISSING")?.reason ?? "SOURCE_MISSING";
  else if (input.policy.mode === "canary" && !canarySelected) reason = "CANARY_NOT_SELECTED";
  else if (input.policy.mode === "legacy" || input.policy.mode === "shadow") reason = "OBSERVED_WOULD_DELIVER";
  else reason = "DELIVERED";

  const context = deliveryEnabled && !budgetTooSmall ? prospectiveContext : null;
  return {
    context,
    prospectiveContext,
    receipt: {
      schema: "engram.context-delivery-receipt.v1",
      mode: input.policy.mode,
      reason,
      scopeKind: scope.kind,
      scopeDigest,
      policyDigest,
      envelopeDigest,
      renderedBytes: prospectiveContext ? Buffer.byteLength(prospectiveContext, "utf8") : 0,
      totalCapBytes: input.policy.caps.totalBytes,
      contextTokenBudget: hostBudget,
      sources: receipts,
    },
  };
}
