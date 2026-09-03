import type { Digest } from "../memory-observation/ledger.ts";
import { canonicalizeJcs, sha256Digest } from "./handoff-v2.ts";

export const OLL_OBSERVER_RECEIPT_REGISTRY_V1_SCHEMA = "oll.memory-observer-receipt-producer-registry.v1" as const;

export type ObserverReceiptScopeV1 = {
  workspaceId: string;
  runtimeSessionKey: string;
  scopeClass: "self" | "managers" | "company" | "project";
  scopeId: string;
};

export type ObserverReceiptProducerRefV1 = {
  id: string;
  version: string;
  digest: Digest;
};

export type ObserverReceiptProducerAdmissionV1 = {
  producer: ObserverReceiptProducerRefV1;
  observationSchemas: Array<"engram.memory-batch-observation.v1">;
  allowedObservationClasses: Array<"episodic.decision" | "episodic.learning">;
  allowedScopeClasses: ObserverReceiptScopeV1["scopeClass"][];
  exactScopeAllowlist: ObserverReceiptScopeV1[];
  requiredReceiptSchema: "engram.memory-apply-receipt.v1";
  requireCanonicalReadBack: true;
  allowedEvaluationPolicyDigests: Digest[];
  rolloutState: "report-only" | "shadow" | "materialize";
};

export type ObserverReceiptProducerRegistryV1 = {
  schema: typeof OLL_OBSERVER_RECEIPT_REGISTRY_V1_SCHEMA;
  workspaceId: string;
  registryVersion: number;
  canonicalApplicator: ObserverReceiptProducerRefV1;
  entries: ObserverReceiptProducerAdmissionV1[];
  digest: Digest;
};

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const TOKEN_RE = /^[a-z][a-z0-9._:-]{0,127}$/;
const SESSION_RE = /^agent:[a-z][a-z0-9_-]{0,63}:(?:\*|[a-z0-9][a-z0-9:._-]{0,255})$/;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function exactKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const row = value as Record<string, unknown>;
  invariant(Object.keys(row).sort().join("\0") === [...keys].sort().join("\0"), `${label} fields are invalid`);
  return row;
}

function producerRef(value: unknown, label: string): asserts value is ObserverReceiptProducerRefV1 {
  const row = exactKeys(value, ["id", "version", "digest"], label);
  invariant(typeof row.id === "string" && TOKEN_RE.test(row.id), `${label}.id is invalid`);
  invariant(typeof row.version === "string" && TOKEN_RE.test(row.version), `${label}.version is invalid`);
  invariant(typeof row.digest === "string" && DIGEST_RE.test(row.digest), `${label}.digest is invalid`);
}

function scope(value: unknown, workspaceId: string, label: string): asserts value is ObserverReceiptScopeV1 {
  const row = exactKeys(value, ["workspaceId", "runtimeSessionKey", "scopeClass", "scopeId"], label);
  invariant(row.workspaceId === workspaceId, `${label}.workspaceId does not match registry`);
  invariant(typeof row.runtimeSessionKey === "string" && SESSION_RE.test(row.runtimeSessionKey), `${label}.runtimeSessionKey is invalid`);
  invariant(["self", "managers", "company", "project"].includes(String(row.scopeClass)), `${label}.scopeClass is invalid`);
  invariant(typeof row.scopeId === "string" && row.scopeId.length > 0 && row.scopeId.length <= 256, `${label}.scopeId is invalid`);
}

export function observerReceiptProducerRegistryDigestV1(value: Omit<ObserverReceiptProducerRegistryV1, "digest"> | ObserverReceiptProducerRegistryV1): Digest {
  const { digest: _digest, ...base } = value as ObserverReceiptProducerRegistryV1;
  return sha256Digest(canonicalizeJcs(base));
}

export function validateObserverReceiptProducerRegistryV1(value: unknown): ObserverReceiptProducerRegistryV1 {
  const row = exactKeys(value, ["schema", "workspaceId", "registryVersion", "canonicalApplicator", "entries", "digest"], "observer receipt producer registry");
  invariant(row.schema === OLL_OBSERVER_RECEIPT_REGISTRY_V1_SCHEMA, "observer receipt producer registry schema is unsupported");
  invariant(typeof row.workspaceId === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(row.workspaceId), "observer receipt producer registry workspaceId is invalid");
  invariant(Number.isInteger(row.registryVersion) && Number(row.registryVersion) >= 1, "observer receipt producer registry version is invalid");
  producerRef(row.canonicalApplicator, "observer receipt producer registry canonicalApplicator");
  invariant(Array.isArray(row.entries) && row.entries.length > 0, "observer receipt producer registry entries must be a non-empty array");
  const identities = new Set<string>();
  for (const [index, raw] of row.entries.entries()) {
    const entry = exactKeys(raw, [
      "producer", "observationSchemas", "allowedObservationClasses", "allowedScopeClasses", "exactScopeAllowlist",
      "requiredReceiptSchema", "requireCanonicalReadBack", "allowedEvaluationPolicyDigests", "rolloutState",
    ], `observer receipt producer registry entry ${index}`);
    producerRef(entry.producer, `observer receipt producer registry entry ${index}.producer`);
    const ref = entry.producer as ObserverReceiptProducerRefV1;
    const identity = `${ref.id}\0${ref.version}\0${ref.digest}`;
    invariant(!identities.has(identity), `observer receipt producer registry entry ${index} is duplicated`);
    identities.add(identity);
    invariant(Array.isArray(entry.observationSchemas) && entry.observationSchemas.length === 1
      && entry.observationSchemas[0] === "engram.memory-batch-observation.v1", `observer receipt producer registry entry ${index} observationSchemas are invalid`);
    invariant(Array.isArray(entry.allowedObservationClasses) && entry.allowedObservationClasses.length > 0
      && entry.allowedObservationClasses.every((item) => item === "episodic.decision" || item === "episodic.learning")
      && new Set(entry.allowedObservationClasses).size === entry.allowedObservationClasses.length,
    `observer receipt producer registry entry ${index} observation classes are invalid`);
    invariant(Array.isArray(entry.allowedScopeClasses) && entry.allowedScopeClasses.length > 0
      && entry.allowedScopeClasses.every((item) => ["self", "managers", "company", "project"].includes(String(item)))
      && new Set(entry.allowedScopeClasses).size === entry.allowedScopeClasses.length,
    `observer receipt producer registry entry ${index} scope classes are invalid`);
    invariant(Array.isArray(entry.exactScopeAllowlist), `observer receipt producer registry entry ${index} exactScopeAllowlist must be an array`);
    for (const [scopeIndex, exactScope] of entry.exactScopeAllowlist.entries()) scope(exactScope, row.workspaceId as string, `observer receipt producer registry entry ${index} scope ${scopeIndex}`);
    invariant(entry.requiredReceiptSchema === "engram.memory-apply-receipt.v1" && entry.requireCanonicalReadBack === true,
      `observer receipt producer registry entry ${index} receipt requirements are invalid`);
    invariant(Array.isArray(entry.allowedEvaluationPolicyDigests)
      && entry.allowedEvaluationPolicyDigests.every((item) => typeof item === "string" && DIGEST_RE.test(item))
      && new Set(entry.allowedEvaluationPolicyDigests).size === entry.allowedEvaluationPolicyDigests.length,
    `observer receipt producer registry entry ${index} evaluation policy digests are invalid`);
    invariant(["report-only", "shadow", "materialize"].includes(String(entry.rolloutState)), `observer receipt producer registry entry ${index} rollout state is invalid`);
  }
  invariant(typeof row.digest === "string" && DIGEST_RE.test(row.digest), "observer receipt producer registry digest is invalid");
  const registry = row as unknown as ObserverReceiptProducerRegistryV1;
  invariant(registry.digest === observerReceiptProducerRegistryDigestV1(registry), "observer receipt producer registry digest mismatch");
  return registry;
}

export function observerReceiptRolloutAllowsV1(
  state: ObserverReceiptProducerAdmissionV1["rolloutState"],
  executionMode: "report-only" | "shadow" | "materialize",
): boolean {
  if (executionMode === "report-only") return true;
  if (executionMode === "shadow") return state === "shadow" || state === "materialize";
  return state === "materialize";
}

export function observerReceiptScopeEqualV1(left: ObserverReceiptScopeV1, right: ObserverReceiptScopeV1): boolean {
  return left.workspaceId === right.workspaceId
    && left.runtimeSessionKey === right.runtimeSessionKey
    && left.scopeClass === right.scopeClass
    && left.scopeId === right.scopeId;
}
