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
