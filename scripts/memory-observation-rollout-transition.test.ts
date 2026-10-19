import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { sha256 } from "../src/memory-observation/ledger.ts";

const repository = resolve(import.meta.dir, ".."), roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const put = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };

async function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "engram-rollout-transition-")); roots.push(workspace);
  put(join(workspace, "engram.json"), { workspace: { id: "main" } });
  const build = await Bun.build({ entrypoints: [join(repository, "integrations/openclaw-memory-observation/index.ts")],
    target: "node", format: "esm", external: ["openclaw/plugin-sdk/core", "openclaw/plugin-sdk/session-transcript-runtime"],
    minify: false, sourcemap: "none", write: false });
  expect(build.success).toBe(true);
  const plugin = join(workspace, "plugin.js"), bytes = Buffer.from(await build.outputs[0]!.arrayBuffer());
  writeFileSync(plugin, bytes);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const model = "openai/gpt-6-luna", bin = join(workspace, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "openclaw"), `#!${process.execPath}\nconst args=process.argv.slice(2);\n`
    + `if(args[0]==="plugins"&&args[1]==="inspect")console.log(JSON.stringify({plugin:{source:${JSON.stringify(plugin)},enabled:true,status:"loaded"},diagnostics:[]}));\n`
    + `else if(args[0]==="config"&&args[1]==="get"&&args[2]==="agents.entries.main.model")console.log(JSON.stringify(${JSON.stringify(model)}));\n`
    + `else if(args[0]==="config"&&args[1]==="get"&&args[2]==="plugins.entries.engram-memory-observation.llm")console.log(JSON.stringify({allowModelOverride:true,allowedModels:[${JSON.stringify(model)}]}));\n`
    + `else { console.error("unexpected host call"); process.exit(91); }\n`, { mode: 0o755 });
  const common = ["--workspace", workspace, "--session-key", "agent:main:telegram:direct:123", "--scope-id", "telegram:123",
    "--approved-by", "operator", "--approved-at", "2026-10-01T00:00:00.000Z", "--effective-after", "2026-10-01T00:00:00.000Z",
    "--inference-model", model, "--max-inference-calls", "1", "--scheduler-id", "fixture"];
  const run = (command: string) => Bun.spawnSync([process.execPath, join(repository, "scripts/memory-observation-rollout.ts"), command, ...common,
    ...(command.startsWith("enable") ? ["--ack-loaded-plugin-readback", "--ack-canary", "--ack-foreground-offload",
      "--ack-decision-sidecars", "--ack-batch-cron", "--ack-immediate-evaluator-off", "--ack-kill-switch"] : [])],
    { cwd: repository, env: { ...process.env, PATH: bin + ":" + process.env.PATH } });
  const plan = run("plan-batch-canary"); expect(plan.exitCode, plan.stderr.toString()).toBe(0);
  const current = JSON.parse(plan.stdout.toString()).projection;
  expect(current.pluginDigest).toBe(digest);
  // Simulate an installed-byte refresh after the Luna migration had drained.
  const before = structuredClone(current); before.pluginDigest = sha256("prior-plugin"); before.evaluation.policyDigest = sha256("prior-policy");
  const previous = structuredClone(before); previous.inference.model = "openai/gpt-5.6-terra"; previous.evaluation.policyDigest = sha256("old-policy");
  const root = join(workspace, "memory-state/memory-observation");
  put(join(root, "projection.json"), before);
  const body = { schema: "engram.memory-model-transition.v1", targetProjectionDigest: sha256(before), previousProjection: previous,
    previousQuality: null, approvedBy: "operator", approvedAt: before.approvedAt };
  const transition = { ...body, digest: sha256(body) }; put(join(root, "model-transition.json"), transition);
  const quality = { schema: "engram.memory-quality-rollout.v1", mode: "active", workspaceId: "main", pluginDigest: before.pluginDigest,
    baseEvaluationPolicyDigest: before.evaluation.policyDigest, sourcePolicyDigest: before.evaluation.batch.sourcePolicyDigest,
    applyAfter: before.consumers.dailyNote.applyAfter, exactScopes: [{ workspaceId: "main", runtimeSessionKey: current.bindings[0].runtimeSessionKey,
      scopeId: current.bindings[0].scopeId, scopeClass: current.bindings[0].scopeClass }],
    preparedAt: before.approvedAt, inventoryDigest: sha256("inventory") };
  put(join(root, "quality-rollout.json"), { ...quality, digest: sha256(quality) });
  return { root, run, current, before, transition };
}

test("canonical enable-batch-canary retires a drained migration and rebinds the quality sidecar", async () => {
  const f = await fixture(), result = f.run("enable-batch-canary");
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ status: "enabled-batch-canary", qualityRolloutRebound: true, readBack: true });
  expect(JSON.parse(readFileSync(join(f.root, "projection.json"), "utf8"))).toEqual(f.current);
  expect(JSON.parse(readFileSync(join(f.root, "model-transition-history", f.transition.digest.slice(7) + ".json"), "utf8"))).toEqual(f.transition);
  expect(JSON.parse(readFileSync(join(f.root, "quality-rollout.json"), "utf8")).pluginDigest).toBe(f.current.pluginDigest);
  expect(f.run("enable-batch-canary").exitCode).toBe(0);
});

test("canonical rollout refuses outstanding work without changing the projection, sidecar or transition", async () => {
  const f = await fixture();
  put(join(f.root, "v1/queues/evaluator/pending.json"), { traceId: sha256("source"), status: "queued" });
  const paths = ["projection.json", "quality-rollout.json", "model-transition.json"];
  const before = paths.map(path => readFileSync(join(f.root, path), "utf8"));
  const result = f.run("enable-batch-canary");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("MODEL_TRANSITION_DRAIN_REQUIRED");
  expect(paths.map(path => readFileSync(join(f.root, path), "utf8"))).toEqual(before);
});
