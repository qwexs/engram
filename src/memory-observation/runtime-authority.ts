import type { ProducerRef } from "./ledger.ts";

// Shared unchanged runtime admission policy; replay never broadens authority.
export const RUNTIME_AUTHORITY: ProducerRef = {
  id: "openclaw-runtime",
  version: "v1",
  digest: "sha256:41580b56cf8dc83fea5f78568092308214f851833a5c6cae537bf1a21b3626bd",
};
export const EVALUATOR_AUTHORITY: ProducerRef = {
  id: "post-turn-observer",
  version: "v1",
  digest: "sha256:d4f0bf349ea08594fbd3a72f1e6f05ea5dda32800422c1e2cefbc434552cd406",
};
export const RUNTIME_REGISTRY = {
  schema: "engram.memory-producer-registry.v1",
  producers: [
    {
      ...RUNTIME_AUTHORITY,
      authorityClass: "runtime",
      artifactSchemas: ["engram.memory-observation-job.v1", "engram.memory-admission-gap-receipt.v1", "engram.memory-trace-event.v1"],
      observationClasses: [],
    },
    {
      ...EVALUATOR_AUTHORITY,
      authorityClass: "evaluator",
      artifactSchemas: ["engram.memory-observation.v1"],
      observationClasses: ["episodic.event", "episodic.decision"],
    },
  ],
};
export const RUNTIME_POLICY = {
  schema: "engram.memory-authority-policy.v1",
  policyVersion: "memory-observation-authority-v1",
  rules: [
    {
      artifactSchema: "engram.memory-observation-job.v1",
      stage: "source-admission",
      allowedAuthorityClasses: ["runtime"],
      allowedProducerIds: ["openclaw-runtime"],
      requiredTrustedInputs: ["completed-source-turn", "runtime-session-key", "workspace-binding", "source-completion-time"],
    },
    {
      artifactSchema: "engram.memory-observation.v1",
      stage: "advisory-evaluation",
      allowedAuthorityClasses: ["evaluator"],
      allowedProducerIds: ["post-turn-observer"],
      requiredTrustedInputs: ["observation-job", "ttl-evidence-store", "producer-registry"],
    },
  ],
  defaultDecision: "deny",
};
