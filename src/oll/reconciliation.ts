import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

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

/** Fleet-cutover compatibility surface: v2 reconciliation is permanently retired. */
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
  return { ...result, skipped: "legacy-v2-reconciliation-retired" };
}
