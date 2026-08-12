export const KG_V3_ASSERTION_SCHEMA = "engram.kg-assertion.v3-mvp" as const;
export const KG_V3_OPERATION_SCHEMA = "engram.kg-v3-operation.v1" as const;
export const KG_V3_REGISTRY_SCHEMA = "engram.kg-v3-registry.v1" as const;
export const KG_V3_AUTHORITY_SCHEMA = "engram.kg-v3-authority.v1" as const;

export type KgKind = "identity" | "preference" | "decision" | "constraint";
export type KgObjectType = "string" | "number" | "boolean" | "entity-ref";
export type KgLifecycleStatus = "active" | "superseded" | "retracted";
export type KgSourceKind = "user_message" | "operator-curated";

export type KgObject =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "entity-ref"; value: string };

export interface KgProvenance {
  sourceKind: KgSourceKind;
  sessionKey: string;
  messageId: string;
  actorId: string;
  operationId: `sha256:${string}`;
  observedAt: string;
}

export interface KgAssertionLifecycle {
  status: KgLifecycleStatus;
  replacesId: string | null;
  supersededById: string | null;
  changedAt: string;
}

export interface KgAssertionV3 {
  schema: typeof KG_V3_ASSERTION_SCHEMA;
  id: string;
  workspaceId: string;
  entityId: string;
  entityType: string;
  kind: KgKind;
  predicate: string;
  object: KgObject;
  scope: string[];
  lifecycle: KgAssertionLifecycle;
  provenance: KgProvenance;
  createdAt: string;
}

export interface KgAssertionInput {
  workspaceId: string;
  entityId: string;
  entityType: string;
  kind: KgKind;
  predicate: string;
  object: KgObject;
  scope: string[];
  replacesId: string | null;
  provenance: KgProvenance;
}

export type KgStatementClass =
  | "durable"
  | "plan"
  | "proposal"
  | "progress"
  | "audit"
  | "test-output"
  | "project-status";

export interface KgWriteRequest {
  assertion: KgAssertionInput;
  intent: {
    explicit: boolean;
    compound: boolean;
    store: "kg-current" | "daily-note" | "domain-doc";
    statementClass: KgStatementClass;
  };
}

export interface KgRetractionRequest {
  workspaceId: string;
  entityId: string;
  assertionId: string;
  provenance: KgProvenance;
}

export interface TrustedKgCallerContext {
  trusted: true;
  workspaceId: string;
  sessionKey: string;
  actorId: string;
  capabilities: readonly ("kg:v3:write" | "kg:v3:retract" | "kg:v3:seed")[];
}

export type KgAdmissionReason =
  | "CALLER_NOT_AUTHORIZED"
  | "WORKSPACE_MISMATCH"
  | "ENTITY_UNRESOLVED"
  | "KIND_NOT_ALLOWED"
  | "PREDICATE_NOT_ALLOWED"
  | "OBJECT_TYPE_MISMATCH"
  | "SOURCE_NOT_EXPLICIT"
  | "COMPOUND_ASSERTION"
  | "WRONG_STORE"
  | "PROVENANCE_MISSING"
  | "DUPLICATE"
  | "REPLACEMENT_REQUIRED"
  | "OPERATION_CONFLICT";

export interface KgReceipt {
  schema: "engram.kg-v3-receipt.v1";
  operationId: string;
  status: "committed" | "skipped" | "rejected";
  assertionId: string | null;
  reason: KgAdmissionReason | null;
  payloadDigest: `sha256:${string}`;
  committedAt: string | null;
}

export interface KgRegistryPredicate {
  name: string;
  kinds: KgKind[];
  objectTypes: KgObjectType[];
}

export interface KgRegistryEntity {
  id: string;
  type: string;
  scopes: string[];
  predicates: KgRegistryPredicate[];
}

export interface KgRegistryV1 {
  schema: typeof KG_V3_REGISTRY_SCHEMA;
  workspaceId: string;
  revision: number;
  entities: KgRegistryEntity[];
}

export interface KgAuthorityMarkerV1 {
  schema: typeof KG_V3_AUTHORITY_SCHEMA;
  workspaceId: string;
  releaseDigest: `sha256:${string}`;
  schemaDigest: `sha256:${string}`;
  mode: "legacy-contained" | "canary" | "enabled";
  enabledSessionCapabilities: Array<{
    sessionKey: string;
    capabilities: Array<"kg:v3:write" | "kg:v3:retract" | "kg:v3:seed">;
  }>;
  currentProjectionVersion: 1;
  approvedBy: string;
  approvedAt: string;
}

export type KgCrashPoint =
  | "after-prepared"
  | "after-assertion-store"
  | "after-previous-store"
  | "after-store-committed"
  | "after-committed";
