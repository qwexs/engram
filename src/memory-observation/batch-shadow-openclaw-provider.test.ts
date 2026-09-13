import { describe, expect, test } from "bun:test";
import {
  defaultOpenClawModelRunExecutor,
  BatchShadowOpenClawProviderError,
  openClawGatewayModelRunProvider,
  openClawRawModelRunProvider,
  type OpenClawModelRunExecutor,
} from "./batch-shadow-openclaw-provider.ts";

test("default executor can invoke the OpenClaw launcher on the current platform", () => {
  const result = defaultOpenClawModelRunExecutor("openclaw", ["--version"], {
    cwd: process.cwd(),
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("OpenClaw");
});
import type { BatchShadowCompletionRequest } from "./batch-shadow-runner.ts";

const request: BatchShadowCompletionRequest = {
  model: "openai/gpt-5.6-terra",
  system: "",
  prompt: "{\"schema\":\"engram.memory-batch-shadow-single-prompt.v1\"}",
  maxTokens: 2_000,
  temperature: 0,
  tools: [],
};

function success(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    capability: "model.run",
    transport: "gateway",
    provider: "openai",
    model: "gpt-5.6-terra",
    attempts: [],
    outputs: [{ text: "{\"schema\":\"engram.memory-batch-shadow-output.v1\",\"groups\":[]}", mediaUrl: null }],
    ...overrides,
  });
}

function gatewaySuccess(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    runId: "run-1",
    status: "ok",
    summary: "completed",
    result: {
      payloads: [{ text: "{\"schema\":\"engram.memory-batch-shadow-output.v1\",\"groups\":[]}", mediaUrl: null }],
      meta: {
        durationMs: 2500,
        agentMeta: {
          provider: "openai",
          model: "gpt-5.6-terra",
          lastCallUsage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, reasoningTokens: 0, total: 150 },
          costUsd: 0.00125,
        },
        executionTrace: {
          winnerProvider: "openai",
          winnerModel: "gpt-5.6-terra",
          fallbackUsed: false,
        },
      },
      ...overrides,
    },
  });
}

describe("OpenClaw raw model-run provider", () => {
  test("uses argv without a shell and returns exact model read-back without invented usage", async () => {
    let seen: { command: string; args: string[] } | null = null;
    const execute: OpenClawModelRunExecutor = (command, args) => {
      seen = { command, args };
      return { status: 0, signal: null, stdout: success(), stderr: "" };
    };
    const provider = openClawRawModelRunProvider({ cwd: "/tmp", execute });
    const result = await provider(request);
    expect(seen?.command).toBe("openclaw");
    expect(seen?.args).toEqual([
      "infer", "model", "run", "--gateway", "--model", request.model,
      "--thinking", "off", "--json", "--prompt", request.prompt,
    ]);
    expect(result).toEqual({
      output: "{\"schema\":\"engram.memory-batch-shadow-output.v1\",\"groups\":[]}",
      resolvedModel: "openai/gpt-5.6-terra",
    });
  });

  test("rejects system-role requests, fallbacks, and model-run failures", async () => {
    const provider = openClawRawModelRunProvider({
      cwd: "/tmp",
      execute: () => ({ status: 0, signal: null, stdout: success({ attempts: [{ model: "fallback" }] }), stderr: "" }),
    });
    await expect(provider({ ...request, system: "hidden" })).rejects.toMatchObject({ code: "UNSUPPORTED_REQUEST" });
    await expect(provider(request)).rejects.toMatchObject({ code: "INVALID_READBACK" });

    const failed = openClawRawModelRunProvider({
      cwd: "/tmp",
      execute: () => ({ status: 1, signal: null, stdout: "", stderr: "provider unavailable" }),
    });
    try {
      await failed(request);
      throw new Error("expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BatchShadowOpenClawProviderError);
      expect((error as BatchShadowOpenClawProviderError).code).toBe("MODEL_RUN_FAILED");
    }
  });
});

describe("OpenClaw gateway model-run provider", () => {
  test("returns exact model, provider usage, cost, and latency from terminal gateway metadata", async () => {
    let seenArgs: string[] = [];
    const provider = openClawGatewayModelRunProvider({
      cwd: "/tmp",
      agentId: "managers",
      execute: (_command, args) => {
        seenArgs = args;
        return { status: 0, signal: null, stdout: gatewaySuccess(), stderr: "" };
      },
    });
    await expect(provider(request)).resolves.toEqual({
      output: "{\"schema\":\"engram.memory-batch-shadow-output.v1\",\"groups\":[]}",
      resolvedModel: "openai/gpt-5.6-terra",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 },
      costUsd: 0.00125,
      latencyMs: 2500,
    });
    expect(seenArgs.slice(0, 7)).toEqual([
      "gateway", "call", "agent", "--expect-final", "--json", "--timeout", "120000",
    ]);
    const params = JSON.parse(seenArgs[8]);
    expect(params.agentId).toBe("managers");
    expect(params).not.toHaveProperty("provider");
    expect(params).not.toHaveProperty("model");
    expect(params.promptMode).toBe("none");
  });

  test("fails closed on fallback, model mismatch, or missing measured economics", async () => {
    const cases = [
      gatewaySuccess({ meta: {
        durationMs: 2500,
        agentMeta: {
          provider: "openai", model: "gpt-5.6-sol",
          lastCallUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, costUsd: 0.1,
        },
        executionTrace: { winnerProvider: "openai", winnerModel: "gpt-5.6-sol", fallbackUsed: false },
      } }),
      gatewaySuccess({ meta: {
        durationMs: 2500,
        agentMeta: {
          provider: "openai", model: "gpt-5.6-terra",
          lastCallUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, costUsd: 0.1,
        },
        executionTrace: { winnerProvider: "openai", winnerModel: "gpt-5.6-terra", fallbackUsed: true },
      } }),
      gatewaySuccess({ meta: {
        durationMs: 2500,
        agentMeta: {
          provider: "openai", model: "gpt-5.6-terra",
          lastCallUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        },
        executionTrace: { winnerProvider: "openai", winnerModel: "gpt-5.6-terra", fallbackUsed: false },
      } }),
    ];
    for (const stdout of cases) {
      const provider = openClawGatewayModelRunProvider({
        cwd: "/tmp",
        agentId: "managers",
        execute: () => ({ status: 0, signal: null, stdout, stderr: "" }),
      });
      await expect(provider(request)).rejects.toMatchObject({ code: "INVALID_READBACK" });
    }
  });
});


test('explicit evaluator thinking is passed to the supported CLI, while malformed levels are rejected',async()=>{
 let calls=0;
 const provider=openClawRawModelRunProvider({cwd:'/tmp',execute:(_command,args)=>{calls++;expect(args[args.indexOf('--thinking')+1]).toBe('medium');return {status:0,signal:null,stdout:success(),stderr:''};}});
 await provider({...request,thinking:'medium'});expect(calls).toBe(1);
 await expect(provider({...request,thinking:'unbounded' as any})).rejects.toMatchObject({code:'UNSUPPORTED_REQUEST'});expect(calls).toBe(1);
});
