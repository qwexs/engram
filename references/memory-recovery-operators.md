# Memory recovery and release operators

These are explicit administrative operations over trusted local state. They do
not infer operator authority from message text, relax citations, install host
patches, create schedulers, or declare memory restored merely because a handoff
finished. Plans/journals can contain exact identities and paths: keep them private
and outside indexed/public source trees. Test with synthetic fixtures first.

## Terminal batch retry

`recoverTerminalBatch` in `batch-terminal-recovery.ts` handles the admitted
failure classes `batch_provider_failure`, `batch_invalid_json` and
`batch_invalid_assertion`. Use the existing
`scripts/memory-observation-recover-terminal.ts` entrypoint with `--workspace`,
`--store-root`, `--job-id`, `--authorized-by`, `--authorized-at` and `--reason`.
Planning is the default; `--apply` publishes the approved retry. Its separate
reviewed-skip, reconciled and legacy-defer modes are not interchangeable with
this terminal retry contract.

Eligibility requires the canonical workspace-owned store, explicit non-future
approval, current observer ownership, exact binding fingerprint, compatible
source/evaluation policies and an admitted source checkpoint. The strict
compiler rebuilds the entire sealed bundle from retained envelopes/evidence.
Evidence must still be valid now, not only at the old approval time. Existing
results, observations or downstream effects require effect reconciliation
instead of blind replay. A locked second preflight detects source/queue/policy
changes. Immutable authorization pins envelope, job and projection digests.

A historical source whose original checkpoint remains `terminal_gap` can be
retried only when `isAdmissionGapRecovered` verifies its exact completed native
history admission and current envelope. The original checkpoint stays immutable.
Only that authenticated candidate's admission-recovery directory and original
gap receipt are provenance rather than downstream effects. Missing/corrupt
admission proof, unrelated receipts and real evaluation effects still block.

An already completed requeue receipt is history, not a new admission: idempotent
replay does not reset progressed queues or require expired raw evidence again.
An incomplete operation resumes its original authorization; it cannot silently
adopt unrelated live bytes. Failed eligibility preserves the original failure.

## Reviewed invalid admission evidence

`scripts/memory-observation-recover-gap.ts --review-invalid-evidence` is an
explicit opt-in for one original `evidence_invalid` admission gap. Default
eligibility is unchanged. The original failure must be at `completion_observed`
with known source-turn, run and session identities; pinned native-history import,
exact binding/actor/transport, same-run terminal completion, source bounds,
current source policy and fresh evidence remain mandatory. The immutable
authorization records `completion_evidence_invalid_native_history.v1` and pins
the original gap/checkpoint plus imported record. It never admits textless
sources, revokes scope checks, repairs model output or claims semantic closure.

Pinned imports may explicitly identify the supported visible-transcript SDK as
their source, without claiming a separate `sessions_history` read. Native SDK
sequence references must be labelled as such. All same-run terminal, actor,
transport, identity, bounds and exact-binding validators remain identical.

## Completion after an identical-job contextual retry

A reconciled contextual retry can produce the same job ID as its original
exhaustion. `reconciled-completion.ts` accepts this only with the exact completed
recovery authorization, original reconciliation/queue proofs, rebuilt persisted
contextual result, terminal and observations, and completed current source claims.
The old exhaustion `done` marker is first retained in that recovery journal as
`superseded-done.json`; only then is the proven terminal published atomically.
An unrelated conflicting done marker still fails closed. Crash resume does not
call the model again or overwrite old failure history. This is a publication
repair, not a new successful outcome, skip, scheduler or producer policy.

Finite recovery adapters can explicitly opt into
`BatchLiveWorker.allowIndependentFreshDuringBackoff`. Default scheduled behavior
is unchanged. The adapter can process due jobs or new unreserved sources while
another exact-scope job waits for its real retry time. Every source in every
unfinished scoped job stays reserved, including a mixed job's already-due rows;
sealed jobs, attempt counters, backoff times, policies, TTL and inference budget
are unchanged. Deferred context that cannot fit with fresh evidence stays waiting
while a fitting fresh-only frame proceeds. No source is silently requeued or
declared skipped/closed by this scheduling option.

## Exact quote-producer migration

`migrateQuoteFailureToContextual` in `quote-producer-migration.ts` is a library
operator for an exact exhausted v1 `batch_source_quote_mismatch`. It requires
the reviewed source set, failure ID, explicit approval and a current authorized
contextual target policy. It is not a generic fallback or retry mechanism.

The envelope, raw evidence, source digests, TTL, partition and complete bundle
remain unchanged. The old failure/done/result identity is archived; only a new
producer-bound job identity and an explicitly reset handoff queue are created.
No model inference or canonical memory write occurs in the migration itself.
Source debt remains open until ordinary processing proves its effects.

The migration journal is a crash barrier, not another scheduler. Missing or
invalid authorization/completion leaves ordinary discovery and inference
blocked. Worker status is `blocked`, with the exact sanitized
`PRODUCER_MIGRATION_INCOMPLETE` or `PRODUCER_MIGRATION_INVALID` scope reason.
The CLI passes it through execution and fleet reporting; it is never healthy
`idle`. A blocked topic consumes no model-call budget and cannot starve healthy
topics. Resume the same approved journal, not a newly guessed source set.

## Historical orphan quarantine

`reconcileExpiredOrphan` in `expired-orphan-accounting.ts` separates an expired
historical job from active scheduling **without closing its source debt**.
Its options require an absolute workspace, exact job ID/digest, approval actor
and non-future approval time. Default `apply` is false; planning is read-only.

Eligibility checks canonical store paths and workspace owner, authenticates
the old bundle at a historical valid instant, and verifies that original
envelope/evidence/evaluator queue records are absent and every sealed input is
expired. Active downstream consumer work or resumable intermediate results
prevent quarantine. Archived results/applied effects are kept untouched and
digest-referenced, not mistaken for a new successful evaluation.

Apply first retains authenticated open TRACE debt, rechecks state, and seals an
`engram.memory-expired-orphan-accounting.v1` receipt with
`outcome: historical_orphan_quarantined`, `closedSources: 0` and
`canonicalWrites: 0`. Both the private `orphan-accounting` journal and scheduling
`done` marker refer to that same receipt. Health validates the protected debt
origin; a filename in `done` alone is not proof. Crashes after debt, journal or
done publication resume the exact operation without deleting debt or
recomputing an unrelated plan. New source/effect bytes cause refusal, not an
implicit extension of approval. The old policy is not added to readability.

## Code-only plugin release rebind

`scripts/memory-observation-code-only-plugin-rebind.ts` has `plan` and `apply`
commands. It builds the canonical source bundle relative to the repository
root regardless of caller cwd. It does not install or restart the plugin.

The reviewed `engram.code-only-plugin-release-attestation.v1` input includes:

- exact from/to plugin digests and complete configured workspace IDs;
- explicit approval actor/time/reason;
- `allowedChangedSurfaces: ["runtime-adapter", "ledger-purge-guard"]`;
- `unchanged: { evaluator: true, model: true, sourcePolicy: true,
  authority: true, consumerSemantics: true }`.

This is a deliberately narrow release contract, not permission to reuse the
attestation for arbitrary source, evaluator, or authority changes. Planning
checks configured fleet equality, canonical workspace paths, current projection,
quality and transition state. It is read-only except for the new plan output.
An explicit exception may preserve one named already-invalid transition only
if its exact original file digest and failure code match; it remains blocked,
not repaired or re-authorized.

Generic invocation, with deployment-owned files and managed state environment:

```bash
bun scripts/memory-observation-code-only-plugin-rebind.ts plan \
  --attestation /absolute/private/release-attestation.json \
  --workspace-manifest /absolute/private/workspaces.json \
  --config /absolute/private/active-config.json \
  --plan-out /absolute/private/rebind-plan.json

bun scripts/memory-observation-code-only-plugin-rebind.ts apply \
  --plan /absolute/private/rebind-plan.json \
  --journal-root /absolute/private/rebind-journal \
  --maintenance-barrier-id approved-existing-workers-barrier \
  --ack-workers-paused
```

The manifest supplies `workspaces: [{id, path}]` (or the supported registry
wrapper). `OPENCLAW_STATE_DIR` comes from the deployment's managed environment;
no secret is copied to arguments or explicit environment values. Apply requires
installed target bytes, the matching source digest and an actual parent-owned
maintenance barrier. The acknowledgement flag does not pause workers itself.

Only projection plugin identity, matching quality identity and valid transition
target/checksum change. Models, evaluation/source policies, all epochs,
bindings, old model lineage, queues and effects remain exact. The durable
per-artifact journal resumes partial publication by the same plan/barrier and
rejects external drift. Completion certifies file read-back, not loaded runtime
or natural-source E2E. The parent verifies installation/restart as required,
loaded generation and restored existing scheduler IDs through normal admin
controls. Do not patch installed host/runtime files as a substitute.

## Verification and recovery boundaries

Tests: `batch-terminal-recovery.test.ts`, `quote-producer-migration.test.ts`,
`expired-orphan-accounting.test.ts` and `code-only-plugin-rebind.test.ts` under
`src/memory-observation/`. They exercise denial, crash/resume, exact source
identity, unchanged artifacts, canonical paths, current TTL and drift.
All approval labels and identities in public tests are synthetic.

See [source debt](memory-source-debt.md),
[runtime/lineage](memory-runtime-lineage.md) and
[fleet reporting](memory-fleet-isolation.md). Do not delete operational debt or
invent a semantic skip to make an audit green.
