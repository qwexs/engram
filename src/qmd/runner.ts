import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { policyError } from "../cli/errors.ts";
import { redactQmdInvocation, requestsStructuredOutput } from "./invocation.ts";
import { decideQmdPolicy, summarizeQmdPolicyDecision } from "./policy.ts";
import type {
  QmdContext,
  QmdCallerContext,
  QmdInvocation,
  QmdOperationClass,
  QmdOperationRecord,
  QmdPolicyDecision,
  QmdRunResult,
} from "./types.ts";

export type QmdProcessOptions = {
  env?: Record<string, string | undefined>;
};

export type QmdRunnerOptions = QmdProcessOptions & {
  caller: QmdCallerContext;
  decision: QmdPolicyDecision;
};

function terminateProcessTree(proc: Bun.Subprocess): void {
  if (process.platform !== "win32" && proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct process when a process group is unavailable.
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // The process may have exited between the timeout and termination attempt.
  }
}

function operationClass(operation: QmdInvocation["operation"]): QmdOperationClass {
  if (operation === "probe" || operation === "capabilities" || operation === "status" || operation === "collection-list") return "diagnostic";
  if (operation === "collection-add") return "provisioning";
  if (operation === "update" || operation === "embed") return "maintenance";
  return "read";
}

function assertCurrentDecision(
  context: QmdContext,
  invocation: QmdInvocation,
  caller: QmdCallerContext,
  decision: QmdPolicyDecision,
): void {
  const currentDecision = decideQmdPolicy(context, invocation, caller);
  if (!currentDecision.allowed
    || !decision.allowed
    || decision.operation !== invocation.operation
    || decision.effectiveScope !== invocation.effectiveScope
    || !sameValues(decision.collections, invocation.collections)
    || !sameCaller(decision.caller, caller)) {
    throw policyError("Runner requires a current matching allowed QMD policy decision.", {
      decision: summarizeQmdPolicyDecision(currentDecision),
    });
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

function sameValues(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameCaller(left: QmdCallerContext, right: QmdCallerContext): boolean {
  return left.kind === right.kind
    && left.sessionKey === right.sessionKey
    && left.domain === right.domain
    && sameValues(left.allowedCollections, right.allowedCollections)
    && sameValues(left.capabilities, right.capabilities);
}

function operationRecord(
  context: QmdContext,
  invocation: QmdInvocation,
  startedAt: string,
  completedAt: string,
  elapsedMs: number,
  exitCode: number | null,
  signal: string | null,
  timedOut: boolean,
  caller: QmdCallerContext,
  decision: QmdPolicyDecision,
): QmdOperationRecord {
  return {
    schema: "engram.qmd.operation.v1",
    command: "qmd",
    operation: invocation.operation,
    operationClass: operationClass(invocation.operation),
    workspace: context.workspace,
    topology: context.topology,
    indexKey: invocation.indexKey,
    effectiveScope: invocation.effectiveScope,
    collections: [...invocation.collections],
    caller: { kind: caller.kind },
    policyDecision: summarizeQmdPolicyDecision(decision),
    invocation: redactQmdInvocation(invocation),
    startedAt,
    completedAt,
    elapsedMs,
    exitCode,
    signal,
    timedOut,
  };
}

export async function runQmdInvocation(
  context: QmdContext,
  invocation: QmdInvocation,
  options: QmdRunnerOptions,
): Promise<QmdRunResult> {
  const startedAt = isoNow();
  const started = performance.now();
  const { caller, decision } = options;
  assertCurrentDecision(context, invocation, caller, decision);
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let signal: string | null = null;
  let timedOut = false;
  let spawnError: QmdRunResult["spawnError"];

  try {
    const proc = Bun.spawn([invocation.executable, ...invocation.argv], {
      cwd: invocation.cwd,
      env: { ...process.env, ...options.env, PWD: invocation.cwd },
      detached: process.platform !== "win32",
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(proc);
    }, invocation.timeoutMs);

    try {
      exitCode = await proc.exited;
      signal = proc.signalCode ?? null;
    } finally {
      clearTimeout(timeout);
    }
    [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  } catch (error) {
    spawnError = {
      code: "SPAWN_FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const elapsedMs = Math.max(0, Math.round(performance.now() - started));
  const completedAt = isoNow();
  const record = operationRecord(
    context,
    invocation,
    startedAt,
    completedAt,
    elapsedMs,
    exitCode,
    signal,
    timedOut,
    caller,
    decision,
  );
  const result: QmdRunResult = {
    schema: "engram.qmd.run.v1",
    ok: exitCode === 0 && !timedOut && spawnError === undefined,
    stdout,
    stderr,
    exitCode,
    signal,
    timedOut,
    ...(spawnError ? { spawnError } : {}),
    operationRecord: record,
  };

  if (requestsStructuredOutput(invocation.operation) && stdout.trim() !== "") {
    try {
      result.structuredData = JSON.parse(stdout);
    } catch (error) {
      result.parseError = {
        code: "INVALID_STRUCTURED_OUTPUT",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return result;
}

/**
 * Synchronous runner for legacy synchronous diagnostics only. It preserves the
 * same typed invocation, policy re-check, argv-only spawn and operation record
 * as the asynchronous runner; callers do not construct QMD subprocesses.
 */
export function runQmdInvocationSync(
  context: QmdContext,
  invocation: QmdInvocation,
  options: QmdRunnerOptions,
): QmdRunResult {
  const startedAt = isoNow();
  const started = performance.now();
  const { caller, decision } = options;
  assertCurrentDecision(context, invocation, caller, decision);
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let signal: string | null = null;
  let timedOut = false;
  let spawnError: QmdRunResult["spawnError"];
  try {
    const proc = spawnSync(invocation.executable, invocation.argv, {
      cwd: invocation.cwd,
      env: { ...process.env, ...options.env, PWD: invocation.cwd },
      encoding: "utf-8",
      timeout: invocation.timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    stdout = proc.stdout || "";
    stderr = proc.stderr || "";
    exitCode = proc.status;
    signal = proc.signal ?? null;
    timedOut = (proc.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    if (proc.error && !timedOut) {
      spawnError = { code: "SPAWN_FAILED", message: proc.error.message };
    }
  } catch (error) {
    spawnError = {
      code: "SPAWN_FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const elapsedMs = Math.max(0, Math.round(performance.now() - started));
  const completedAt = isoNow();
  const record = operationRecord(
    context, invocation, startedAt, completedAt, elapsedMs, exitCode, signal, timedOut, caller, decision,
  );
  const result: QmdRunResult = {
    schema: "engram.qmd.run.v1",
    ok: exitCode === 0 && !timedOut && spawnError === undefined,
    stdout,
    stderr,
    exitCode,
    signal,
    timedOut,
    ...(spawnError ? { spawnError } : {}),
    operationRecord: record,
  };
  if (requestsStructuredOutput(invocation.operation) && stdout.trim() !== "") {
    try {
      result.structuredData = JSON.parse(stdout);
    } catch (error) {
      result.parseError = {
        code: "INVALID_STRUCTURED_OUTPUT",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return result;
}
