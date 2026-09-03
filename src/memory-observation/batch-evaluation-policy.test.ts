import { describe, expect, test } from "bun:test";
import { BATCH_SHADOW_PROMPT_VERSION } from "./batch-shadow-runner.ts";
import { deriveBatchEvaluationPolicyDigest, type BatchEvaluationPolicyIdentityV2 } from "./batch-evaluation-policy.ts";

const identity: BatchEvaluationPolicyIdentityV2 = {
  workspaceId: "main",
  sessionKey: "agent:main:*",
  scopeId: "workspace:main",
  model: "openai/gpt-5.6-terra",
  pluginDigest: `sha256:${"1".repeat(64)}`,
  batch: {
    sourcePolicyDigest: `sha256:${"2".repeat(64)}`,
    inactivityGapSeconds: 300,
    maxTurns: 8,
    maxEvidenceBytes: 262_144,
    maxAgeSeconds: 900,
    maxInferenceCallsPerRun: 1,
    schedulerId: "engram-memory-batch-main",
  },
};

describe("batch evaluation policy identity", () => {
  test("is stable for one exact evaluator contract", () => {
    expect(deriveBatchEvaluationPolicyDigest(identity)).toBe(deriveBatchEvaluationPolicyDigest(structuredClone(identity)));
    expect(deriveBatchEvaluationPolicyDigest(identity)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("changes across prompt contract and installed evaluator bytes", () => {
    const current = deriveBatchEvaluationPolicyDigest(identity);
    expect(deriveBatchEvaluationPolicyDigest(identity, `${BATCH_SHADOW_PROMPT_VERSION}-next`)).not.toBe(current);
    expect(deriveBatchEvaluationPolicyDigest({
      ...identity,
      pluginDigest: `sha256:${"3".repeat(64)}`,
    })).not.toBe(current);
  });
});
