import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { reconcileKgV3Access, type KgV3AccessReconcileResult } from "../kg-v3/access.ts";
import { KgV3Core } from "../kg-v3/core.ts";
import type { KgV3ProjectionStats } from "../kg-v3/projection.ts";
import { KG_V3_AUTHORITY_SCHEMA, type KgAuthorityMarkerV1 } from "../kg-v3/types.ts";
import { markWorkspaceQmdDirty, type WorkspaceDirtyMarkResult } from "../qmd/maintenance-integration.ts";

export interface ReconciliationCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ReconciliationRuntime {
  run(command: string[], options: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number }): Promise<ReconciliationCommandResult>;
}

export interface WorkspaceReconciliationResult {
  workspace: string;
  status: "ok" | "error";
  error?: string;
  skipped?: string;
  access?: KgV3AccessReconcileResult;
  projection?: KgV3ProjectionStats & { changed: boolean };
  qmdDirty?: WorkspaceDirtyMarkResult;
}

export class BunReconciliationRuntime implements ReconciliationRuntime {
  async run(command: string[], options: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number }): Promise<ReconciliationCommandResult> {
    const child = Bun.spawn(command, {
      cwd: options.cwd,
      env: options.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    return { exitCode, stdout, stderr, timedOut };
  }
}

/** Reconcile native KG v3 access state and decay-aware prompt projection. */
export async function reconcileWorkspaceMemory(options: {
  workspace: string;
  scriptsDir: string;
  timeoutMs?: number;
  dryRun?: boolean;
  runtime?: ReconciliationRuntime;
}): Promise<WorkspaceReconciliationResult> {
  const workspace = resolve(options.workspace);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const result: WorkspaceReconciliationResult = { workspace, status: "ok" };
  if (!existsSync(join(workspace, "engram.json"))) return { ...result, status: "error", error: "engram.json is missing" };
  void timeoutMs;
  let workspaceId: string;
  let authority: KgAuthorityMarkerV1;
  try {
    const config = JSON.parse(readFileSync(join(workspace, "engram.json"), "utf8"));
    workspaceId = String(config?.workspace?.id || "").trim();
    authority = JSON.parse(readFileSync(join(workspace, "memory-state", "kg-v3", "authority.json"), "utf8"));
  } catch {
    return { ...result, skipped: "kg-v3-authority-inactive" };
  }
  if (!workspaceId || authority.schema !== KG_V3_AUTHORITY_SCHEMA || authority.workspaceId !== workspaceId
    || !["canary", "enabled"].includes(authority.mode)) {
    return { ...result, skipped: "kg-v3-authority-inactive" };
  }
  try {
    const access = reconcileKgV3Access({ workspace, workspaceId, dryRun: options.dryRun });
    if (access.invalid > 0) return { ...result, status: "error", error: `invalid KG v3 access events: ${access.invalid}`, access };
    const core = new KgV3Core({ workspace, workspaceId });
    const projection = await core.rebuildProjection({ accessState: access.state, dryRun: options.dryRun });
    const output: WorkspaceReconciliationResult = { ...result, access, projection };
    if (!options.dryRun && projection.changed) {
      output.qmdDirty = await markWorkspaceQmdDirty({ workspace, collectionRole: "knowledge-graph", reason: "kg-v3:decay-reconcile" });
    }
    return output;
  } catch (error) {
    return { ...result, status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}
