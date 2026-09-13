import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  BatchShadowCompletionRequest,
  BatchShadowProviderResult,
} from "./batch-shadow-runner.ts";

type Row = Record<string, unknown>;

export class BatchShadowOpenClawProviderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BatchShadowOpenClawProviderError";
  }
}

export type OpenClawModelRunExecution = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type OpenClawModelRunExecutor = (command: string, args: string[], options: {
  cwd: string;
  timeout: number;
  maxBuffer: number;
}) => OpenClawModelRunExecution;

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,299}$/;

function row(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function fail(code: string, message: string): never {
  throw new BatchShadowOpenClawProviderError(code, message);
}

function parseOpenClawJson(stdout: string): unknown {
  const start = stdout.indexOf("{");
  if (start < 0) fail("INVALID_READBACK", "OpenClaw raw model-run did not return strict JSON");
  const prefix = stdout.slice(0, start).trim();
  if (prefix && !prefix.split(/\r?\n/).every((line) =>
    line.startsWith("[state-migrations]")
    || line.startsWith("- Skipped plugin doctor state migrations because exclusive state ownership is unavailable:"))) {
    fail("INVALID_READBACK", "OpenClaw raw model-run returned unexpected non-JSON output");
  }
  try { return JSON.parse(stdout.slice(start)); }
  catch { fail("INVALID_READBACK", "OpenClaw raw model-run did not return strict JSON"); }
}

export function defaultOpenClawModelRunExecutor(command: string, args: string[], options: {
  cwd: string;
  timeout: number;
  maxBuffer: number;
}): OpenClawModelRunExecution {
  const resolved = command === "openclaw" ? Bun.which(command) ?? command : command;
  const javascript = /\.(?:c|m)?js$/i.test(resolved);
  const windowsShim = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(resolved);
  const executable = javascript ? process.execPath
    : windowsShim ? (process.env.ComSpec || "cmd.exe")
      : resolved;
  const childArgs = javascript ? [resolved, ...args]
    : windowsShim ? ["/d", "/s", "/c", resolved, ...args]
      : args;
  const result = spawnSync(executable, childArgs, {
    cwd: options.cwd,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

export function openClawRawModelRunProvider(options: {
  cwd: string;
  command?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  execute?: OpenClawModelRunExecutor;
}): (request: BatchShadowCompletionRequest) => Promise<BatchShadowProviderResult> {
  if (!options.cwd) fail("INVALID_CONFIG", "an explicit model-run cwd is required");
  const command = options.command ?? "openclaw";
  const timeout = options.timeoutMs ?? 120_000;
  const maxBuffer = options.maxBufferBytes ?? 2 * 1024 * 1024;
  if (!TOKEN_RE.test(command) || !Number.isSafeInteger(timeout) || timeout < 1
    || !Number.isSafeInteger(maxBuffer) || maxBuffer < 1) {
    fail("INVALID_CONFIG", "model-run command or bounds are invalid");
  }
  const execute = options.execute ?? defaultOpenClawModelRunExecutor;
  return async (request) => {
    if ((request.thinking !== undefined && !["off", "low", "medium", "high"].includes(request.thinking))
      || request.system !== "" || request.tools.length !== 0 || request.temperature !== 0
      || !TOKEN_RE.test(request.model) || !Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1
      || typeof request.prompt !== "string" || !request.prompt.trim()) {
      fail("UNSUPPORTED_REQUEST", "raw model-run requires the digested single-user tool-free request mode");
    }
    const execution = execute(command, [
      "infer", "model", "run",
      "--gateway",
      "--model", request.model,
      "--thinking", request.thinking ?? "off",
      "--json",
      "--prompt", request.prompt,
    ], { cwd: options.cwd, timeout, maxBuffer });
    if (execution.error || execution.status !== 0 || execution.signal !== null) {
      const detail = execution.error?.message ?? execution.stderr.trim() ?? `exit=${String(execution.status)}`;
      fail("MODEL_RUN_FAILED", `OpenClaw raw model-run failed: ${detail.slice(0, 500)}`);
    }
    const parsed = parseOpenClawJson(execution.stdout);
    const result = row(parsed);
    if (!result || result.ok !== true || result.capability !== "model.run" || result.transport !== "gateway"
      || typeof result.provider !== "string" || !TOKEN_RE.test(result.provider)
      || typeof result.model !== "string" || !TOKEN_RE.test(result.model)
      || !Array.isArray(result.attempts) || result.attempts.length !== 0
      || !Array.isArray(result.outputs) || result.outputs.length !== 1) {
      fail("INVALID_READBACK", "OpenClaw raw model-run read-back is incomplete or used a fallback");
    }
    const output = row(result.outputs[0]);
    if (!output || typeof output.text !== "string" || !output.text.trim()
      || output.mediaUrl !== null || ("mediaUrls" in output && output.mediaUrls !== undefined)) {
      fail("INVALID_READBACK", "OpenClaw raw model-run returned non-text or ambiguous output");
    }
    return {
      output: output.text,
      resolvedModel: `${result.provider}/${result.model}`,
    };
  };
}

export function openClawGatewayModelRunProvider(options: {
  cwd: string;
  agentId: string;
  command?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  execute?: OpenClawModelRunExecutor;
}): (request: BatchShadowCompletionRequest) => Promise<BatchShadowProviderResult> {
  if (!options.cwd || !TOKEN_RE.test(options.agentId)) {
    fail("INVALID_CONFIG", "an explicit model-run cwd and configured gateway agent id are required");
  }
  const command = options.command ?? "openclaw";
  const timeout = options.timeoutMs ?? 120_000;
  const maxBuffer = options.maxBufferBytes ?? 2 * 1024 * 1024;
  if (!TOKEN_RE.test(command) || !Number.isSafeInteger(timeout) || timeout < 1
    || !Number.isSafeInteger(maxBuffer) || maxBuffer < 1) {
    fail("INVALID_CONFIG", "gateway model-run command or bounds are invalid");
  }
  const execute = options.execute ?? defaultOpenClawModelRunExecutor;
  return async (request) => {
    if ((request.thinking !== undefined && !["off", "low", "medium", "high"].includes(request.thinking))
      || request.system !== "" || request.tools.length !== 0 || request.temperature !== 0
      || !TOKEN_RE.test(request.model) || !Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1
      || typeof request.prompt !== "string" || !request.prompt.trim()) {
      fail("UNSUPPORTED_REQUEST", "gateway model-run requires the digested single-user tool-free request mode");
    }
    const sessionId = `memory-batch-model-run-${randomUUID()}`;
    const params = {
      agentId: options.agentId,
      sessionId,
      sessionKey: `agent:${options.agentId}:${sessionId}`,
      message: request.prompt,
      thinking: request.thinking ?? "off",
      modelRun: true,
      promptMode: "none",
      cleanupBundleMcpOnRunEnd: true,
      idempotencyKey: randomUUID(),
    };
    const execution = execute(command, [
      "gateway", "call", "agent",
      "--expect-final",
      "--json",
      "--timeout", String(timeout),
      "--params", JSON.stringify(params),
    ], { cwd: options.cwd, timeout: timeout + 5_000, maxBuffer });
    if (execution.error || execution.status !== 0 || execution.signal !== null) {
      const detail = execution.error?.message ?? execution.stderr.trim() ?? `exit=${String(execution.status)}`;
      fail("MODEL_RUN_FAILED", `OpenClaw gateway model-run failed: ${detail.slice(0, 500)}`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(execution.stdout); }
    catch { fail("INVALID_READBACK", "OpenClaw gateway model-run did not return strict JSON"); }
    const response = row(parsed);
    const result = row(response?.result);
    const meta = row(result?.meta);
    const agentMeta = row(meta?.agentMeta);
    const usage = row(agentMeta?.lastCallUsage);
    const trace = row(meta?.executionTrace);
    if (!response || response.status !== "ok" || response.summary !== "completed"
      || !result || ("aborted" in result && result.aborted !== false && result.aborted !== null)
      || !Array.isArray(result.payloads) || result.payloads.length !== 1
      || !meta || !agentMeta || !usage || !trace || trace.fallbackUsed !== false
      || typeof agentMeta.provider !== "string" || !TOKEN_RE.test(agentMeta.provider)
      || typeof agentMeta.model !== "string" || !TOKEN_RE.test(agentMeta.model)
      || trace.winnerProvider !== agentMeta.provider || trace.winnerModel !== agentMeta.model
      || `${agentMeta.provider}/${agentMeta.model}` !== request.model
      || !Number.isSafeInteger(usage.input) || (usage.input as number) < 0
      || !Number.isSafeInteger(usage.output) || (usage.output as number) < 0
      || !Number.isSafeInteger(usage.cacheRead) || (usage.cacheRead as number) < 0
      || !Number.isSafeInteger(usage.cacheWrite) || (usage.cacheWrite as number) < 0
      || !Number.isSafeInteger(usage.total) || usage.total !== (usage.input as number) + (usage.output as number)
        + (usage.cacheRead as number) + (usage.cacheWrite as number)
      || typeof agentMeta.costUsd !== "number" || !Number.isFinite(agentMeta.costUsd) || agentMeta.costUsd < 0
      || typeof meta.durationMs !== "number" || !Number.isFinite(meta.durationMs) || meta.durationMs < 0) {
      fail("INVALID_READBACK", "OpenClaw gateway model-run read-back lacks exact model, usage, cost, or terminal metadata");
    }
    const payload = row(result.payloads[0]);
    if (!payload || typeof payload.text !== "string" || !payload.text.trim()
      || payload.mediaUrl !== null || ("mediaUrls" in payload && payload.mediaUrls !== undefined)) {
      fail("INVALID_READBACK", "OpenClaw gateway model-run returned non-text or ambiguous output");
    }
    return {
      output: payload.text,
      resolvedModel: `${agentMeta.provider}/${agentMeta.model}`,
      usage: {
        inputTokens: usage.input as number,
        outputTokens: usage.output as number,
        cacheReadTokens: usage.cacheRead as number,
        cacheWriteTokens: usage.cacheWrite as number,
      },
      costUsd: agentMeta.costUsd,
      latencyMs: meta.durationMs,
    };
  };
}
