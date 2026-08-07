import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { contextError } from "../cli/errors.ts";
import { resolveQmdContext } from "./context.ts";
import { buildQmdInvocation } from "./invocation.ts";
import {
  resolveQmdMaintenanceMode,
  resolveQmdMaintenanceStateRoot,
  type QmdMaintenanceMode,
} from "./maintenance-integration.ts";
import {
  markQmdDirty,
  runQmdMaintenance,
  type QmdMaintenanceExecutor,
  type QmdMaintenanceRunResult,
} from "./maintenance.ts";
import { authorizeQmdInvocation } from "./policy.ts";
import { runQmdInvocation } from "./runner.ts";
import type { QmdCallerContext, QmdContext, QmdRunResult } from "./types.ts";

type JsonObject = Record<string, unknown>;

export type WorkspaceMaintenanceResult = {
  schema: "engram.qmd.workspace-maintenance.v1";
  mode: QmdMaintenanceMode;
  status: "ok" | "partial" | "delegated";
  update?: QmdRunResult;
  embed?: QmdRunResult;
  error?: { phase: "update" | "embed"; message: string };
};

export type WorkspaceMaintenanceOptions = {
  workspace: string;
  skipEmbed?: boolean;
  timeoutMs?: number;
  execute?: QmdMaintenanceExecutor;
};

export type GlobalMaintenanceOptions = {
  workspace: string;
  collections: string[];
  expectedIndex: string;
  stateRoot?: string;
  timeoutMs?: number;
  allowPartialDirtyScope?: boolean;
  /** Validated global-registry collection names for the trusted coordinator. */
  trustedCollections?: string[];
  execute?: QmdMaintenanceExecutor;
};

export type GlobalQmdBackfillMarkOptions = {
  workspace: string;
  collections: string[];
  expectedIndex: string;
  stateRoot?: string;
  /** Validated global-registry collection names for the trusted coordinator. */
  trustedCollections?: string[];
};

function configFor(workspace: string): JsonObject {
  const path = join(resolve(workspace), "engram.json");
  if (!existsSync(path)) throw contextError("Workspace does not contain engram.json.", { path });
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw contextError("Workspace engram.json must contain a JSON object.", { path });
  }
  return parsed as JsonObject;
}

export function resolveWorkspaceQmdMaintenanceMode(workspace: string): QmdMaintenanceMode {
  return resolveQmdMaintenanceMode(configFor(workspace));
}

function failureMessage(result: QmdRunResult): string {
  return result.stderr.trim()
    || result.spawnError?.message
    || (result.timedOut ? "QMD maintenance timed out" : `QMD maintenance exited ${result.exitCode}`);
}

function trustedCoordinatorCollections(
  requested: string[],
  trusted: string[] | undefined,
  fallback: string[],
): string[] {
  const collections = [...new Set(requested.map((value) => value.trim()).filter(Boolean))].sort();
  if (collections.length === 0) throw contextError("Global QMD maintenance requires explicit collections.");
  const trustedScope = new Set((trusted ?? fallback).map((value) => value.trim()).filter(Boolean));
  const unknown = collections.filter((collection) => !trustedScope.has(collection));
  if (unknown.length > 0) {
    throw contextError("Global QMD maintenance collections are outside the trusted coordinator registry scope.", { unknown });
  }
  return collections;
}

async function executeAuthorized(
  context: QmdContext,
  operation: "update" | "embed",
  caller: QmdCallerContext,
  collections: string[],
  timeoutMs: number,
  execute: QmdMaintenanceExecutor,
): Promise<QmdRunResult> {
  const invocation = buildQmdInvocation(context, operation === "update"
    ? { operation, timeoutMs }
    : { operation, collections, timeoutMs });
  const decision = authorizeQmdInvocation(context, invocation, caller);
  return execute(context, invocation, { caller, decision });
}

/**
 * Workspace heartbeat bridge. Legacy/shadow modes retain existing maintenance
 * semantics through the typed runner; coordinated mode performs no QMD work
 * because the single global scheduler owns the physical-index lease.
 */
export async function runWorkspaceQmdMaintenance(
  options: WorkspaceMaintenanceOptions,
): Promise<WorkspaceMaintenanceResult> {
  const workspace = resolve(options.workspace);
  const mode = resolveWorkspaceQmdMaintenanceMode(workspace);
  if (mode === "coordinated") {
    return { schema: "engram.qmd.workspace-maintenance.v1", mode, status: "delegated" };
  }

  const context = resolveQmdContext({ value: workspace, source: "explicit" });
  const collections = context.policy.ownedCollections;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const execute = options.execute ?? runQmdInvocation;
  const caller: QmdCallerContext = {
    kind: "heartbeat",
    allowedCollections: collections,
    capabilities: ["maintenance"],
  };
  const update = await executeAuthorized(context, "update", caller, collections, timeoutMs, execute);
  if (!update.ok) {
    return {
      schema: "engram.qmd.workspace-maintenance.v1",
      mode,
      status: "partial",
      update,
      error: { phase: "update", message: failureMessage(update) },
    };
  }
  if (options.skipEmbed) {
    return { schema: "engram.qmd.workspace-maintenance.v1", mode, status: "ok", update };
  }
  const embed = await executeAuthorized(context, "embed", caller, collections, timeoutMs, execute);
  if (!embed.ok) {
    return {
      schema: "engram.qmd.workspace-maintenance.v1",
      mode,
      status: "partial",
      update,
      embed,
      error: { phase: "embed", message: failureMessage(embed) },
    };
  }
  return { schema: "engram.qmd.workspace-maintenance.v1", mode, status: "ok", update, embed };
}

/** Run the one coordinated maintenance pass for a named physical index. */
export async function runGlobalQmdMaintenance(
  options: GlobalMaintenanceOptions,
): Promise<QmdMaintenanceRunResult> {
  const workspace = resolve(options.workspace);
  const mode = resolveWorkspaceQmdMaintenanceMode(workspace);
  if (mode !== "coordinated") {
    throw contextError("Global QMD maintenance requires qmd.maintenance.mode=coordinated.", { mode });
  }
  const context = resolveQmdContext({ value: workspace, source: "explicit" });
  if (context.selector.kind !== "named" || context.selector.name !== options.expectedIndex) {
    throw contextError("Coordinator workspace does not resolve the expected named QMD index.", {
      expectedIndex: options.expectedIndex,
      selector: context.selector,
    });
  }
  const collections = trustedCoordinatorCollections(
    options.collections,
    options.trustedCollections,
    context.policy.readableCollections,
  );
  const caller: QmdCallerContext = {
    kind: "coordinator",
    allowedCollections: collections,
    capabilities: ["maintenance"],
  };
  return runQmdMaintenance({
    context,
    caller,
    collections,
    stateRoot: options.stateRoot ?? resolveQmdMaintenanceStateRoot(),
    timeoutMs: options.timeoutMs,
    allowPartialDirtyScope: options.allowPartialDirtyScope,
    execute: options.execute,
  });
}

/**
 * Marks an explicit initial-backfill batch vector-dirty without refreshing the
 * whole index again. The following coordinator pass embeds only this trusted
 * subset; callers must select collections from the canonical registry.
 */
export async function markGlobalQmdBackfill(
  options: GlobalQmdBackfillMarkOptions,
) {
  const workspace = resolve(options.workspace);
  const mode = resolveWorkspaceQmdMaintenanceMode(workspace);
  if (mode !== "coordinated") {
    throw contextError("Global QMD backfill requires qmd.maintenance.mode=coordinated.", { mode });
  }
  const context = resolveQmdContext({ value: workspace, source: "explicit" });
  if (context.selector.kind !== "named" || context.selector.name !== options.expectedIndex) {
    throw contextError("Coordinator workspace does not resolve the expected named QMD index.", {
      expectedIndex: options.expectedIndex,
      selector: context.selector,
    });
  }
  const collections = trustedCoordinatorCollections(
    options.collections,
    options.trustedCollections,
    context.policy.readableCollections,
  );
  return markQmdDirty(options.stateRoot ?? resolveQmdMaintenanceStateRoot(), {
    indexKey: context.physicalIndex.key,
    collections,
    reason: "operator:initial-backfill",
    bm25: false,
    vectors: true,
  });
}
