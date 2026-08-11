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
  accessFlush?: unknown;
  accessFlushStdout?: string;
  stats?: unknown;
  stdout?: string;
  error?: string;
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

function parseJsonOrText(stdout: string): { json?: unknown; text?: string } {
  try { return { json: JSON.parse(stdout.trim()) }; }
  catch { return { text: stdout.slice(0, 1000) }; }
}

/** Shared deterministic flush + summary rebuild used by legacy and nightly coordinators. */
export async function reconcileWorkspaceMemory(options: {
  workspace: string;
  scriptsDir: string;
  timeoutMs?: number;
  dryRun?: boolean;
  runtime?: ReconciliationRuntime;
}): Promise<WorkspaceReconciliationResult> {
  const workspace = resolve(options.workspace);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const runtime = options.runtime || new BunReconciliationRuntime();
  const result: WorkspaceReconciliationResult = { workspace, status: "ok" };
  if (!existsSync(join(workspace, "engram.json"))) return { ...result, status: "error", error: "engram.json is missing" };
  const env = { ...process.env, ENGRAM_WORKSPACE: workspace };

  const flushArgs = ["bun", join(options.scriptsDir, "flush-access-buffer.js"), "--workspace", workspace, "--json"];
  if (options.dryRun) flushArgs.push("--dry-run");
  const flush = await runtime.run(flushArgs, { cwd: workspace, env, timeoutMs });
  const parsedFlush = parseJsonOrText(flush.stdout);
  if (parsedFlush.json !== undefined) result.accessFlush = parsedFlush.json;
  else result.accessFlushStdout = parsedFlush.text;
  if (flush.exitCode !== 0 || flush.timedOut) {
    result.status = "error";
    result.error = flush.timedOut ? "access flush timed out" : `access flush: ${flush.stderr.slice(0, 900) || `exit ${flush.exitCode}`}`;
    return result;
  }

  const rebuildArgs = ["bun", join(options.scriptsDir, "rebuild-summaries.js"), "--apply-decay", "--json"];
  if (options.dryRun) rebuildArgs.push("--dry-run");
  const rebuild = await runtime.run(rebuildArgs, { cwd: workspace, env, timeoutMs });
  const parsedRebuild = parseJsonOrText(rebuild.stdout);
  if (parsedRebuild.json !== undefined) result.stats = parsedRebuild.json;
  else result.stdout = parsedRebuild.text;
  if (rebuild.exitCode !== 0 || rebuild.timedOut) {
    result.status = "error";
    result.error = rebuild.timedOut ? "summary rebuild timed out" : rebuild.stderr.slice(0, 1000) || `exit ${rebuild.exitCode}`;
  }
  return result;
}
