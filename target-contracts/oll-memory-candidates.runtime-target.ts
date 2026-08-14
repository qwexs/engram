import { describe, expect, test } from "bun:test";
import { CANDIDATE_BLOCKER_TRACEABILITY } from "../src/oll/memory-candidate-contracts-v2";
import {
  inspectCandidateRollbackBarrierV1,
  rollbackCandidateCompilerV1,
} from "../src/oll/memory-candidate-rollout-v1";

// This suite stays outside Bun's default `*.test.*` discovery. Phase 1 compiler
// gates are covered in `oll-memory-candidate-compiler-v2.test.ts`; Phase 2 inert
// shadow gates are covered in `oll-nightly-coordinator.test.ts`. The entries
// Phase 3 store gates are covered in `oll-memory-candidate-store-v2.test.ts`;
// Phase 4 apply/review gates are covered in `oll-memory-candidate-runtime-v2.test.ts`.
// Phase 5 closes the final rollout/rollback gate without activating a live
// workspace. Real shadow and materialize canaries remain evidence-gated.
const TARGET_ASSERTIONS: Record<(typeof CANDIDATE_BLOCKER_TRACEABILITY)[number]["targetTest"], string> = {
  "shadow-legacy-path-isolation": "shadow must never add candidate payload or change the legacy context/handoff path",
  "production-template-source-fixtures": "runtime parsers must admit rendered copies of every production source template",
  "disabled-byte-compatible-protocol": "missing config and disabled must preserve the legacy protocol",
  "report-recovery-frozen-inputs": "post-publication recovery must use only the verified frozen report",
  "review-outcome-continuation": "authorized rejection and expiry must release every cited candidate deterministically",
  "source-admission-adversarial": "path races, symlinks, private text, and forged registry mappings must fail closed",
  "materialization-payload-verification": "materialization must recompute report, occurrence, cluster, ranking, and operation identities",
  "exact-rfc3339-forward-boundary": "runtime admission must enforce exact instants and declared legacy timezone rules",
  "kg-decay-matrix": "cold KG decisions/preferences must be provenance-only and compiler reads must emit no access receipt",
  "provenance-root-deduplication": "cross-layer copies with one provenance root must produce one cluster without repetition boost",
  "live-source-lifecycle-revalidation": "revoked, superseded, or retracted sources must only narrow or invalidate",
  "projected-load-metrics": "reports must project bounded model-spawn and review load",
  "single-cluster-single-review": "one semantic-scope cluster must consume one context slot and at most one review",
  "reservation-before-effect": "every candidate must be CAS-reserved before the first proposal/review effect",
  "authoritative-scope-lattice": "policy may narrow but never create or broaden source authority",
  "frozen-selection-assessment": "in-flight selection must use the frozen report/access/policy snapshot",
  "shadow-fault-isolation": "shadow compilation failure must not block an ordinary behavioral rethink",
  "per-phase-rollback-barrier": "rollback must drain or quarantine every acknowledged candidate-aware phase",
  "scope-narrowing-new-identity": "live scope narrowing must invalidate the old candidate and defer new identity to a later batch",
  "atomic-no-replace-revision": "revision publication must be fsynced, no-replace, contiguous, and cache-independent",
  "pending-evidence-inbox": "evidence arriving under reservation/review must be inboxed without mutating the cited epoch",
};

const CLOSED_THROUGH_PHASE_5 = new Set<(typeof CANDIDATE_BLOCKER_TRACEABILITY)[number]["targetTest"]>([
  "shadow-legacy-path-isolation",
  "production-template-source-fixtures",
  "disabled-byte-compatible-protocol",
  "source-admission-adversarial",
  "exact-rfc3339-forward-boundary",
  "kg-decay-matrix",
  "provenance-root-deduplication",
  "projected-load-metrics",
  "single-cluster-single-review",
  "authoritative-scope-lattice",
  "shadow-fault-isolation",
  "report-recovery-frozen-inputs",
  "materialization-payload-verification",
  "live-source-lifecycle-revalidation",
  "frozen-selection-assessment",
  "scope-narrowing-new-identity",
  "atomic-no-replace-revision",
  "pending-evidence-inbox",
  "review-outcome-continuation",
  "reservation-before-effect",
  "per-phase-rollback-barrier",
]);

describe("OLL memory candidate runtime target contracts (closed through Phase 5 tooling)", () => {
  const open = CANDIDATE_BLOCKER_TRACEABILITY.filter((item) => !CLOSED_THROUGH_PHASE_5.has(item.targetTest));
  test("all traced blockers have executable implementation coverage", () => {
    expect(open).toEqual([]);
    expect(typeof inspectCandidateRollbackBarrierV1).toBe("function");
    expect(typeof rollbackCandidateCompilerV1).toBe("function");
  });
  for (const entry of open) {
    test(entry.targetTest, () => {
      throw new Error(`RED target contract [spec §${entry.clause}]: ${TARGET_ASSERTIONS[entry.targetTest]}`);
    });
  }
});
