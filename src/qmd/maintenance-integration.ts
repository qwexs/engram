import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { contextError } from "../cli/errors.ts";
import { resolveQmdContext, type QmdContextRuntime } from "./context.ts";
import { markQmdDirty, type QmdMaintenanceState } from "./maintenance.ts";

type UnknownRecord = Record<string, unknown>;

export type QmdMaintenanceMode = "legacy" | "shadow" | "coordinated";

export type WorkspaceDirtyMarkResult = {
  schema: "engram.qmd.dirty-mark.v1";
  status: "disabled" | "marked" | "error";
  mode: QmdMaintenanceMode;
  workspace: string;
  indexKey?: string;
  generation?: number;
  collections?: string[];
  error?: string;
};

export type MarkWorkspaceQmdDirtyInput = {
  workspace: string;
  reason: string;
  collections?: string[];
  collectionRole?: "primary" | "knowledge-graph";
  bm25?: boolean;
  vectors?: boolean;
};

export type QmdMaintenanceIntegrationRuntime = QmdContextRuntime & {
  warn: (message: string) => void;
  markDirty: typeof markQmdDirty;
};

const defaultRuntime: QmdMaintenanceIntegrationRuntime = {
  env: process.env,
  homedir,
  platform: process.platform,
  warn: (message) => console.error(message),
  markDirty: markQmdDirty,
};

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readConfig(workspace: string): UnknownRecord {
  const path = join(workspace, "engram.json");
  // Legacy installations may not have an Engram config yet. They must remain
  // a true no-op until shadow/coordinated mode is explicitly configured.
  if (!existsSync(path)) return {};
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw contextError("Workspace engram.json is not valid JSON.", {
      workspace,
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isRecord(config)) {
    throw contextError("Workspace engram.json must contain a JSON object.", { workspace, path });
  }
  return config;
}

function maintenanceConfig(config: UnknownRecord): UnknownRecord {
  const qmd = config.qmd;
  if (qmd === undefined) return {};
  if (!isRecord(qmd)) throw contextError("engram.json qmd must be an object.");
  const maintenance = qmd.maintenance;
  if (maintenance === undefined) return {};
  if (!isRecord(maintenance)) {
    throw contextError("qmd.maintenance must be an object.", { field: "qmd.maintenance" });
  }
  return maintenance;
}

export function resolveQmdMaintenanceMode(config: UnknownRecord): QmdMaintenanceMode {
  const mode = maintenanceConfig(config).mode ?? "legacy";
  if (mode !== "legacy" && mode !== "shadow" && mode !== "coordinated") {
    throw contextError("qmd.maintenance.mode must be legacy, shadow, or coordinated.", {
      field: "qmd.maintenance.mode",
      mode,
    });
  }
  return mode;
}

export function resolveQmdMaintenanceStateRoot(
  runtime: Pick<QmdMaintenanceIntegrationRuntime, "env" | "homedir"> = defaultRuntime,
): string {
  const configured = runtime.env.OPENCLAW_STATE_DIR?.trim();
  if (configured && !isAbsolute(configured)) {
    throw contextError("OPENCLAW_STATE_DIR must be an absolute path.", {
      field: "OPENCLAW_STATE_DIR",
      value: configured,
    });
  }
  const openclawState = configured
    ? configured
    : join(runtime.homedir(), ".openclaw");
  return join(openclawState, "engram", "qmd-maintenance");
}

function primaryCollection(config: UnknownRecord): string | undefined {
  const qmd = isRecord(config.qmd) ? config.qmd : {};
  return typeof qmd.collection === "string" && qmd.collection.trim() !== ""
    ? qmd.collection.trim()
    : undefined;
}

function knowledgeGraphCollection(config: UnknownRecord): string {
  const qmd = isRecord(config.qmd) ? config.qmd : {};
  // Shared-index migration replaces the generic `life` claim with a
  // workspace-owned canonical collection. Before migration, keep the legacy
  // name so shadow deployments retain their existing behavior.
  return typeof qmd.workspaceKgCollection === "string" && qmd.workspaceKgCollection.trim() !== ""
    ? qmd.workspaceKgCollection.trim()
    : "life";
}

function normalizedCollections(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

/**
 * Best-effort bridge for real writers. A completed business write must never
 * be rolled back because shadow bookkeeping is unavailable; failures are
 * returned and logged for watchdog/rollout diagnostics.
 */
export async function markWorkspaceQmdDirty(
  input: MarkWorkspaceQmdDirtyInput,
  runtime: QmdMaintenanceIntegrationRuntime = defaultRuntime,
): Promise<WorkspaceDirtyMarkResult> {
  const workspace = resolve(input.workspace);
  let mode: QmdMaintenanceMode = "legacy";
  try {
    const config = readConfig(workspace);
    mode = resolveQmdMaintenanceMode(config);
    if (mode === "legacy") {
      return { schema: "engram.qmd.dirty-mark.v1", status: "disabled", mode, workspace };
    }

    const context = resolveQmdContext({ value: workspace, source: "explicit" }, runtime);
    const defaultCollections = input.collectionRole === "knowledge-graph"
      ? [knowledgeGraphCollection(config)]
      : (primaryCollection(config) ? [primaryCollection(config)!] : []);
    const collections = normalizedCollections(input.collections ?? defaultCollections);
    if (collections.length === 0) {
      throw contextError("QMD dirty mark requires explicit collections or qmd.collection.");
    }
    const outsideOwnership = collections.filter(
      (collection) => !context.policy.ownedCollections.includes(collection),
    );
    if (outsideOwnership.length > 0) {
      throw contextError("QMD dirty mark collections are outside workspace ownership.", {
        requestedCollections: collections,
        ownedCollections: context.policy.ownedCollections,
        deniedCollections: outsideOwnership,
      });
    }

    const stateRoot = resolveQmdMaintenanceStateRoot(runtime);
    const relativeStateRoot = relative(context.workspace, stateRoot);
    if (relativeStateRoot === "" || (!relativeStateRoot.startsWith("..") && !isAbsolute(relativeStateRoot))) {
      throw contextError("QMD maintenance state must live outside indexed workspace content.", {
        workspace: context.workspace,
        stateRoot,
      });
    }

    const state: QmdMaintenanceState = await runtime.markDirty(
      stateRoot,
      {
        indexKey: context.physicalIndex.key,
        collections,
        reason: input.reason,
        bm25: input.bm25,
        vectors: input.vectors,
      },
    );
    return {
      schema: "engram.qmd.dirty-mark.v1",
      status: "marked",
      mode,
      workspace,
      indexKey: context.physicalIndex.key,
      generation: state.generation,
      collections,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.warn(`[engram:qmd-maintenance] dirty mark failed open: ${message}`);
    return {
      schema: "engram.qmd.dirty-mark.v1",
      status: "error",
      mode,
      workspace,
      error: message,
    };
  }
}
