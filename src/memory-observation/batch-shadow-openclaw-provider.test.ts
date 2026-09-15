import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultOpenClawCommandExecutor,
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

test.skipIf(process.platform !== "win32")("default executor bypasses the Windows command shim", () => {
  const root = mkdtempSync(join(tmpdir(), "engram-openclaw-shim-"));
  const shim = join(root, "openclaw.cmd");
  const shimMarker = join(root, "shim-invoked.txt");
  const cliDirectory = join(root, "node_modules", "openclaw");
  const cliEntry = join(cliDirectory, "openclaw.mjs");
  mkdirSync(cliDirectory, { recursive: true });
  writeFileSync(shim, `@echo shim-invoked>"${shimMarker}"\r\n@exit /b 29\r\n`, "utf8");
  writeFileSync(cliEntry, `
if (process.env.OPENCLAW_NO_RESPAWN !== "1") process.exit(28);
console.log("DIRECT_OPENCLAW_ENTRY");
`, "utf8");
  try {
    const result = defaultOpenClawCommandExecutor(shim, ["config", "get", "agents.entries"], {
      cwd: root, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DIRECT_OPENCLAW_ENTRY");
    expect(existsSync(shimMarker)).toBeFalse();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("stdin transport preserves a large Unicode prompt on Windows", () => {
  const root = mkdtempSync(join(tmpdir(), "engram-model-run-stdin-"));
  const fixture = join(root, "fixture.mjs");
  writeFileSync(fixture, `
import { createHash } from "node:crypto";
if (process.env.NODE_DISABLE_COMPILE_CACHE !== "1"
  || process.env.OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED !== "1"
  || process.env.OPENCLAW_NO_RESPAWN !== "1") {
  console.error("STDIN_TRANSPORT_RESPAWN_GUARD_MISSING");
  process.exit(25);
}
const index = process.argv.indexOf("--prompt");
const prompt = index >= 0 ? process.argv[index + 1] : undefined;
if (typeof prompt !== "string") process.exit(24);
console.log(JSON.stringify({
  length: prompt.length,
  byteLength: Buffer.byteLength(prompt, "utf8"),
  sha256: createHash("sha256").update(prompt, "utf8").digest("hex"),
}));
`, "utf8");
  const prompt = `${"Арктика🧊漢字\r\n".repeat(1_000)}END`;
  expect(prompt.length).toBeGreaterThanOrEqual(9_535);
  try {
    const result = defaultOpenClawModelRunExecutor(fixture, [], {
      cwd: root, timeout: 10_000, maxBuffer: 1024 * 1024, input: prompt,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      length: prompt.length,
      byteLength: Buffer.byteLength(prompt, "utf8"),
      sha256: createHash("sha256").update(prompt, "utf8").digest("hex"),
    });

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test.skipIf(process.platform !== "win32")("stdin transport propagates the primary provider error on Windows", async () => {
  const root = mkdtempSync(join(tmpdir(), "engram-model-run-primary-error-"));
  const fixture = join(root, "fixture.mjs");
  const marker = "PRIMARY_TRANSPORT_ERROR_Ошибка_🧊";
  writeFileSync(fixture, `
const index = process.argv.indexOf("--prompt");
if (index < 0 || !process.argv[index + 1]) process.exit(24);
console.error(${JSON.stringify(marker)});
process.exit(23);
`, "utf8");
  try {
    const provider = openClawRawModelRunProvider({ cwd: root, command: fixture.replaceAll("\\", "/") });
    await expect(provider({
      model: "openai/gpt-5.6-terra", system: "", prompt: "Ошибка 🧊", maxTokens: 1_000, temperature: 0, tools: [],
    })).rejects.toMatchObject({ code: "MODEL_RUN_FAILED", message: expect.stringContaining(marker) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
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
  test("keeps the prompt out of argv and returns exact model read-back without invented usage", async () => {
    let seen: { command: string; args: string[]; input?: string } | null = null;
    const execute: OpenClawModelRunExecutor = (command, args, options) => {
      seen = { command, args, input: options.input };
      return { status: 0, signal: null, stdout: success(), stderr: "" };
    };
    const provider = openClawRawModelRunProvider({ cwd: "/tmp", execute });
    const result = await provider(request);
    expect(seen?.command).toBe("openclaw");
    expect(seen?.args).toEqual([
      "infer", "model", "run", "--gateway", "--model", request.model,
      "--thinking", "off", "--json",
    ]);
    expect(seen?.input).toBe(request.prompt);
    expect(seen?.args).not.toContain(request.prompt);
    expect(result).toEqual({
      output: "{\"schema\":\"engram.memory-batch-shadow-output.v1\",\"groups\":[]}",
      resolvedModel: "openai/gpt-5.6-terra",
    });
  });

  test("accepts the known Windows state-migration warning before strict model JSON", async () => {
    const provider = openClawRawModelRunProvider({ cwd: "/tmp", execute: () => ({
      status: 0, signal: null, stderr: "",
      stdout: `[state-migrations] Legacy state migration warnings:\n- Skipped plugin doctor state migrations because exclusive state ownership is unavailable: GatewayLockError\n${success()}`,
    }) });
    await expect(provider(request)).resolves.toMatchObject({ resolvedModel: "openai/gpt-5.6-terra" });
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
      expect((error as Error).message).toContain("provider unavailable");
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
