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
    });

export type QmdOperationClass = "diagnostic" | "read" | "maintenance";

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
  caller: { kind: "operator" };
  policyDecision: "not-evaluated";
  invocation: RedactedQmdInvocation;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
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
