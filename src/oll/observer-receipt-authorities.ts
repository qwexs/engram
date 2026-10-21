import { evaluationQuality, readModelTransition } from "../memory-observation/model-transition.ts";
import { qualityScopeEnabled, readableContextualDigests } from "../memory-observation/quality-rollout.ts";
import { BATCH_EVALUATOR_AUTHORITY } from "../memory-observation/batch-observation.ts";
import { CONTEXTUAL_EVALUATOR_AUTHORITY } from "../memory-observation/contextual-batch-observation.ts";
import type { MemoryObservationProjectionV1 } from "../memory-observation/projection.ts";
import type { ObserverReceiptScopeV1, ObserverReceiptProducerRefV1 } from "./observer-receipt-bridge-v1.ts";

/** Exact readable policies from the Worker's own verified quality/transition
 * contracts. No inference, queue processing, arbitrary historical policy grant,
 * or assumption that the base policy is the active contextual policy. */
export function observerBridgeLiveAuthorities(workspace: string, projection: MemoryObservationProjectionV1, scope: ObserverReceiptScopeV1) {
  const output: Array<{ producer: ObserverReceiptProducerRefV1; policyDigest: `sha256:${string}` }> = [];
  const add = (p: MemoryObservationProjectionV1, quality: ReturnType<typeof evaluationQuality>) => {
    if (!p.evaluation?.policyDigest) return;
    output.push({ producer: BATCH_EVALUATOR_AUTHORITY, policyDigest: p.evaluation.policyDigest });
    if (qualityScopeEnabled(quality, scope)) for (const policyDigest of readableContextualDigests(p.evaluation.policyDigest))
      output.push({ producer: CONTEXTUAL_EVALUATOR_AUTHORITY, policyDigest });
  };
  if (projection.evaluation?.mode !== "batch-cron") return output;
  add(projection, evaluationQuality(workspace, projection));
  const transition = readModelTransition(workspace, projection);
  if (transition) add(transition.previousProjection, transition.previousQuality);
  return output.filter((v, i, a) => a.findIndex(x => x.producer.digest === v.producer.digest && x.policyDigest === v.policyDigest) === i);
}
