import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

test("stdin transport uses public SDK exports and preserves large input and model.run authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "engram-public-sdk-"));
  try {
    mkdirSync(join(root, "sdk"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "openclaw", type: "module", exports: {
      "./plugin-sdk/gateway-runtime": "./sdk/gateway.mjs", "./plugin-sdk/config-runtime": "./sdk/config.mjs",
    } }));
    const command = join(root, "openclaw.mjs");
    writeFileSync(command, "// Synthetic installed command; never executed.\n");
    writeFileSync(join(root, "sdk/config.mjs"), "export const loadConfig=()=>({agents:{entries:{main:{}},defaults:{systemAgent:{agentId:'main'}}}});\n");
    writeFileSync(join(root, "sdk/gateway.mjs"), `
      import { createHash } from 'node:crypto';
      export async function callGatewayFromCli(method, opts, p, extra) {
        if(method!=='agent'||!opts.expectFinal||p.agentId!=='main'||p.provider!=='openai'||p.model!=='test-model'
          ||p.thinking!=='high'||!p.modelRun||p.promptMode!=='none'||!p.cleanupBundleMcpOnRunEnd
          ||!p.sessionKey.startsWith('agent:main:model-run-')||extra.clientName!=='gateway-client'
          ||extra.mode!=='backend'||extra.scopes.join()!=='operator.admin')throw Error('wrong contract');
        return {result:{meta:{agentMeta:{provider:p.provider,model:p.model,fallbackAttempts:[]}},
          payloads:[{text:createHash('sha256').update(p.message).digest('hex'),mediaUrl:null}]}};
      }
    `);
    const prompt = "Не обрезать исходный контекст. ".repeat(8_000);
    const run = Bun.spawnSync(["node", join(import.meta.dir, "memory-model-run-stdin.mjs"), "--command", command, "--timeout", "120000"], {
      stdin: new TextEncoder().encode(JSON.stringify({ model: "openai/test-model", thinking: "high", prompt })),
    });
    expect(run.exitCode).toBe(0);
    const result = JSON.parse(run.stdout.toString());
    expect(result).toMatchObject({ ok: true, transport: "gateway", capability: "model.run", provider: "openai", model: "test-model", attempts: [] });
    expect(result.outputs[0].text).toBe(createHash("sha256").update(prompt).digest("hex"));
    const invalid = Bun.spawnSync(["node", join(import.meta.dir, "memory-model-run-stdin.mjs"), "--command", command, "--timeout", "120000"], {
      stdin: new TextEncoder().encode(JSON.stringify({ model: "openai/test-model", thinking: "high", prompt, tools: ["forbidden"] })),
    });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr.toString()).toBe("MODEL_RUN_STDIN_TRANSPORT_FAILED\n");
    expect(invalid.stdout.length).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
