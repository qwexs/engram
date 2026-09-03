import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repository = join(import.meta.dir, "..", "..");
const entry = join(repository, "integrations", "openclaw-memory-observation", "index.ts");
const manifest = join(repository, "integrations", "openclaw-memory-observation", "openclaw.plugin.json");
const rollout = join(repository, "scripts", "memory-observation-rollout.ts");

describe("memory observation shadow and daily-note canary rollout integration", () => {
  test("bundles the runtime adapter, gated evaluator, and event-only daily-note applicator", async () => {
    const result = await Bun.build({
      entrypoints: [entry],
      target: "node",
      format: "esm",
      external: ["openclaw/plugin-sdk/core"],
      write: false,
    });
    expect(result.success).toBe(true);
    expect(result.outputs).toHaveLength(1);
    const bundle = await result.outputs[0]!.text();
    for (const marker of [
      "engram-memory-observation",
      "message_received",
      "before_message_write",
      "agent_turn_prepare",
      "before_prompt_build",
      "agent_end",
      "message_sent",
      "replyToId",
      "transport-links",
      "maxInferenceCalls",
      "inference.model",
      "model: current.projection.inference.model",
      "resolved unexpected model",
      "episodic-evaluator",
      "runtime.llm.complete",
      "registerService",
      "nextEvaluationAt",
      "engram-memory-observation-episodic-shadow",
      "daily-note canary",
      "episodic.event",
      "canonical_applied",
      "kill_switch_or_policy_changed",
      "memory-observation:daily-note-handoff",
      "qmd_pending",
      "nextDueAt",
    ]) expect(bundle).toContain(marker);
    for (const forbidden of [
      "runEmbeddedAgent",
      "daily-note-append",
      "engram_memory_save",
      "PostTurnObserverStore",
      "oll-rule-materializer",
      "kg-v3-explicit-intent-ingress",
      "qmd-indexer",
      "BatchLiveWorker",
      "openClawRawModelRunProvider",
      "memory-batch-live",
    ]) expect(bundle).not.toContain(forbidden);
  });

  test("uses a separate plugin identity and requires explicit local activation", () => {
    const value = JSON.parse(readFileSync(manifest, "utf8"));
    expect(value.id).toBe("engram-memory-observation");
    expect(value.activation.onStartup).toBe(true);
    const source = readFileSync(entry, "utf8");
    expect(source).toContain("resolveMemoryObservationProjection");
    expect(source).toContain("expectedPluginDigest: PLUGIN_DIGEST");
    expect(source).toContain("evaluatorEnabled: projection.limits.maxInferenceCalls === 1");
    expect(source).toContain("projection.limits.maxInferenceCalls === 1");
    expect(source).toContain("assertInferenceBoundary");
    expect(source).toContain("assertResolvedInferenceModel");
    expect(source).toContain("api.registerService");
    expect(source).not.toContain("agentId: agentIdFromSessionKey");
    expect(source).toContain("model: current.projection.inference.model");
    expect(source).not.toContain("configuredAgentModel");
    expect(source).not.toContain("src/post-turn-observer");
    const rolloutSource = readFileSync(rollout, "utf8");
    expect(rolloutSource).toContain("plugins.entries.${PLUGIN_ID}.llm.allowModelOverride");
    expect(rolloutSource).toContain("plugins.entries.${PLUGIN_ID}.llm.allowedModels");
    expect(rolloutSource).toContain("hasExactInferenceModelAuthorization");
    expect(rolloutSource).not.toContain("inference model must match the configured default main agent model");
    const registry = JSON.parse(readFileSync(join(repository, "contracts", "memory-observation", "v1", "producer-registry.json"), "utf8"));
    const runtime = registry.producers.find((producer: any) => producer.id === "openclaw-runtime");
    expect(source).toContain(runtime.digest);
  });

  test("requires exact plugin model authorization for immediate and batch evaluators", () => {
    const source = readFileSync(rollout, "utf8");
    expect(source).toContain('if (!hostInferenceBoundary(projection).active)');
    expect(source).toContain("hasExactInferenceModelAuthorization");
  });
});
