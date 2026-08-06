import type { Workspace } from "../cli/args.ts";

export type QmdSelector =
  | { kind: "local" }
  | { kind: "global" }
  | { kind: "named"; name: string };

export type QmdContextWarning = {
  code: "LOCAL_INDEX_CONFIG_MISSING" | "LEGACY_COLLECTION_NORMALIZED" | "REGISTRY_UNREADABLE";
  message: string;
  details?: Record<string, unknown>;
};

export type QmdContext = {
  workspace: string;
  workspaceSource: Workspace["source"];
  topology: "isolated" | "shared";
  selector: QmdSelector;
  physicalIndex: {
    path: string;
    key: string;
    exists: boolean;
  };
  command: {
    executable: string;
    prefixArgs: string[];
  };
  policy: {
    ownedCollections: string[];
    readableCollections: string[];
  };
  warnings: QmdContextWarning[];
};

export type QmdContextData = QmdContext & {
  schema: "engram.qmd.context.v1";
};

export type QmdOperation =
  | "capabilities"
  | "status"
  | "search"
  | "query"
  | "vsearch"
  | "update"
  | "embed";

export type QmdEffectiveScope = "index" | "collections" | "document";

export type QmdInvocation = {
  executable: string;
  argv: string[];
  cwd: string;
  operation: QmdOperation;
  effectiveScope: QmdEffectiveScope;
  indexKey: string;
  collections: string[];
  timeoutMs: number;
};

type QmdBaseRequest = { timeoutMs?: number };

export type QmdInvocationRequest =
  | (QmdBaseRequest & { operation: "capabilities" | "status" | "update" | "embed" })
  | (QmdBaseRequest & {
      operation: "search" | "query" | "vsearch";
      query: string;
      collections: string[];
      limit?: number;
    });

export type QmdOperationClass = "diagnostic" | "read" | "maintenance";

export type QmdCallerKind =
  | "operator"
  | "main"
  | "topic"
  | "subagent"
  | "heartbeat"
  | "provisioning";

export type QmdCallerCapability = "diagnostics" | "read" | "maintenance";

export type QmdCallerContext = {
  kind: QmdCallerKind;
  sessionKey?: string;
  domain?: string;
  allowedCollections: string[];
  capabilities: QmdCallerCapability[];
};

export type QmdCallerSummary = Pick<QmdCallerContext, "kind">;

export type QmdPolicyDecisionCode =
  | "ALLOW_OPERATOR_DIAGNOSTIC"
  | "ALLOW_INTERNAL_DIAGNOSTIC"
  | "ALLOW_COLLECTION_READ"
  | "ALLOW_OWNED_EMBED"
  | "ALLOW_INDEX_UPDATE"
  | "DENY_UNSUPPORTED_OPERATION"
  | "DENY_CALLER_CAPABILITY"
  | "DENY_EMPTY_COLLECTION_SCOPE"
  | "DENY_COLLECTION_SCOPE"
  | "DENY_EFFECTIVE_SCOPE"
  | "DENY_MAINTENANCE_CALLER";

export type QmdPolicyDecision = {
  schema: "engram.qmd.policy-decision.v1";
  allowed: boolean;
  code: QmdPolicyDecisionCode;
  reason: string;
  caller: QmdCallerContext;
  operation: QmdOperation;
  effectiveScope: QmdEffectiveScope;
  collections: string[];
};

export type QmdPolicyDecisionSummary = Omit<QmdPolicyDecision, "caller"> & {
  caller: QmdCallerSummary;
};

export type RedactedQmdInvocation = Omit<QmdInvocation, "argv"> & {
  argv: string[];
};

export type QmdOperationRecord = {
  schema: "engram.qmd.operation.v1";
  command: "qmd";
  operation: QmdOperation;
  operationClass: QmdOperationClass;
  workspace: string;
  topology: QmdContext["topology"];
  indexKey: string;
  effectiveScope: QmdEffectiveScope;
  collections: string[];
  caller: QmdCallerSummary;
  policyDecision: QmdPolicyDecisionSummary;
  invocation: RedactedQmdInvocation;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  qmd?: {
    version: string;
    capabilities: Record<string, boolean>;
  };
};

export type QmdRunResult = {
  schema: "engram.qmd.run.v1";
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  structuredData?: unknown;
  parseError?: {
    code: "INVALID_STRUCTURED_OUTPUT";
    message: string;
  };
  spawnError?: {
    code: "SPAWN_FAILED";
    message: string;
  };
  operationRecord: QmdOperationRecord;
};
