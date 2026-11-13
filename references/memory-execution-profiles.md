# Memory Worker: model-only execution profiles

The canonical batch Worker supports an optional, locally approved
`memory-state/memory-observation/execution-profiles.json`. Its default pointer
selects **new jobs only**. No host/plugin patch, copied Worker, new coordinator,
QMD rollout, source replay or queue drain is needed for a model-only switch.

## Operator

```bash
bun scripts/memory-observation-model.ts status --workspace /absolute/workspace

# One command: synthetic qualification -> sealed plan -> apply -> read-back.
bun scripts/memory-observation-model.ts switch \
  --workspace /absolute/workspace --model openai/gpt-6.1-terra \
  --thinking high --approved-by 'trusted operator + source reference'

# Separately reviewable steps (qualification can be reused for the same exact
# model/thinking/provider boundary and supported contracts for 24 hours).
bun scripts/memory-observation-model.ts qualify \
  --workspace /absolute/workspace --model openai/gpt-6.1-terra \
  --thinking high --out /private/qualification.json
bun scripts/memory-observation-model.ts plan \
  --workspace /absolute/workspace --model openai/gpt-6.1-terra \
  --thinking high --qualification /private/qualification.json \
  --approved-by 'trusted operator + source reference' --out /private/plan.json
bun scripts/memory-observation-model.ts apply --plan /private/plan.json
```

The initial activation pins the current, target and historical provider
boundaries. Later model-only switches must use an already approved endpoint,
protocol and runtime route. Changed provider/endpoint/runtime is a separate
authority rollout, not a flag to waive checks. Legacy inference is pinned too;
consuming an already saved result does not contact its old endpoint.

Source `projection.json`, its inference descriptor, epochs, capture ownership,
scope/routes, plugin digest and QMD remain unchanged. In profile mode the
projection's historical `inference.model` is **not** the effective batch default:
use the `status` command. A new workspace first provisions its normal Worker
authority, then uses this same operator; absent profiles preserve legacy behavior.

## Three independent identities

* **Authority** binds the complete source/consumer projection and data endpoint.
* **Contract** binds prompt/output version and tool-free advisory evaluation.
* **Execution** binds model, explicit thinking and requested generation settings.

New jobs retain all three immutable references. Evaluation-contract, job and
effect identity do not change when only model/thinking changes. Request/result
digests still prove which exact model and thinking generated the result. Every
unfinished job reserves its sources before revision filtering, including jobs
in backoff or stopped execution. Source lifetime, attempts and destinations are
not reset. Deferred reconsideration requires fresh context and is a new bundle,
not a migration of the previous job.

Old jobs without references are reconstructed only from the current and verified
previous legacy snapshots, with their original prompt/model/thinking. The
Luna-specific inference default exists only in that compatibility reader. No
existing artifact is relabelled, copied into a new job, or evaluated again on the
new default. Unsupported/corrupt lineage stays visible and fail-closed.

## Admission, recovery and lifecycle

The existing global inference lease serializes switch/application. Independent
OLL receipt admission is prepared and applied through the canonical bridge
**before** the one atomic default publication. It grants only the existing
positive source/scopes, with no automatic memory-to-rule authority expansion.
A crash before publication leaves the previous default; a crash after it leaves
a default whose consumer admission is already durable. The sealed plan and
receipt support CAS, read-back and idempotent recovery.

```bash
bun scripts/memory-observation-model.ts lifecycle --workspace /absolute/workspace \
  --profile sha256:REVISION --state drain --approved-by 'trusted operator'
```

* `active`: pending execution and cached consumption permitted.
* `drain`: no new calls; consume exact saved base/contextual results, reserve
  unsaved work without starving independent fresh jobs, and reconcile exhaustion.
* `retired`: only after that revision's jobs, typed success/failure/reconciliation,
  daily effects and applicable domain/dirty receipts are verified. Other
  revisions need not drain. Profiles remain immutable history.

Do not drain/retire a current default. First switch to another profile. A rollback
uses `switch` to move the default back; it does not undo notes or move old jobs.
Changes to plugin/authority/quality/bindings are deliberately not model-only:
registry anchors fail closed until an explicit, verified authority rollout.

### Adding an exact topic

`add-domain.js --workspace /absolute/workspace --domain <slug> --type topic-thread
--topic <chatId:topicId> --approved-by '<operator + trusted source reference>'`
uses the separate canonical additive authority path. It does not rewrite old
profiles, jobs, cached results or provider identities. Old revisions reconstruct
against their sealed authority history; new defaults use the expanded scope set
with the same selected model, explicit thinking and prompt/output contract.
The existing model-transition lineage remains readable without forcing unrelated
pending jobs to drain. Current quality mode and epochs stay unchanged.

Projection, quality, transition and profiles are published under the existing
inference/domain leases with a durable CAS journal. OLL policy admission remains
limited to existing positive compiler sources and precedes new executable defaults.
A repeat setup resumes a torn publication from `topic-authority-pending.json`;
unknown changes remain blocking. No second coordinator, plugin rebuild or host
patch is part of this path. Code-only plugin releases and later model switches
preserve this authority history. Tests include immutable old job refs, exact-scope
denial, idempotence, crash recovery and conflicting writes.

## What qualification does and does not prove

One contextual call checks negation, request versus completion, actor, failed
outcome and untrusted injection. A separate base call exercises that actual
prompt/output contract. Both use synthetic evidence only; no notes are written.
This small regression smoke is not a claim of universal semantic entailment.

The raw host CLI verifies the exact model and no fallback. `thinking` is explicitly
requested; the current host does not return an independent effective-thinking
read-back. `maxTokens` is requested by Engram but not enforceable through the host
CLI. Reports say `requested-only` / `unavailable`, not `enforced`. Existing run
budgets remain between-call limits, not hard remote cancellation guarantees.
Measure the full deployed fleet pass and backlog separately; an idle pass or
synthetic qualification is not natural-source message -> Worker -> note -> search
E2E evidence.
