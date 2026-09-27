import { createHash } from "node:crypto";
import { BATCH_SHADOW_PROMPT_VERSION, BATCH_SHADOW_THINKING } from "./batch-shadow-runner.ts";

export type BatchEvaluationPolicyIdentityV2 = {
  workspaceId: string;
  sessionKey: string;
  scopeId: string;
  model: string;
  pluginDigest: `sha256:${string}`;
  batch: {
    sourcePolicyDigest: `sha256:${string}`;
    inactivityGapSeconds: number;
    maxTurns: number;
    maxEvidenceBytes: number;
    maxAgeSeconds: number;
    maxInferenceCallsPerRun: 1;
    schedulerId: string;
  };
};

export function deriveBatchEvaluationPolicyDigest(
  identity: BatchEvaluationPolicyIdentityV2,
  evaluatorContractVersion: string = BATCH_SHADOW_PROMPT_VERSION,
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    schema: "engram.memory-batch-live-policy.v3",
    evaluatorContractVersion,
    thinking: BATCH_SHADOW_THINKING,
    pluginDigest: identity.pluginDigest,
    workspaceId: identity.workspaceId,
    sessionKey: identity.sessionKey,
    scopeId: identity.scopeId,
    model: identity.model,
    batch: identity.batch,
  })).digest("hex")}`;
}
