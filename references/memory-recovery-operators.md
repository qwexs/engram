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
are unchanged. Separately, ordinary scheduled selection now falls back to a
fresh-only frame when reconsidered deferred context would select no fresh input
(byte/turn bounds or a distant historical time segment). The old context stays
waiting and every normal fresh-only bound still applies. This narrow selection
fallback does not enable independent execution past an unfinished retry job;
that remains the explicit finite-recovery option above. No source is silently
requeued or declared skipped/closed by either scheduling path.

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

## Native evidence restoration and immutable source debt

Refreshing missing evidence from exact authorized native history legitimately
changes the evidence/envelope hash, not source identity. Ordinary debt capture
continues to reject arbitrary proof drift with `DEBT_SOURCE_CONFLICT`.
`linkSourceDebtRestoration` is an explicit operator-only accounting step for an
already completed `engram.exact-native-restoration.v1` journal. It requires the
caller's exact authorization actor/time, canonical owner-only archive files,
unchanged source identity/scope/authority/policy, original envelope/queue hashes,
the current evidence recovery metadata and the completed restoration digest.

The immutable metadata link contains only identities/digests. Original failure
records remain byte-identical; further unreviewed evidence changes still fail
closed. The link is neither replay permission nor debt closure. Only the normal
exact source-effect verifier can close the debt against the restored envelope;
the resulting compact certificate retains the linked lineage after raw proof
retention. Unsupported multi-step restoration or existing conflicting links
require separate review rather than automatic overwrite.

## Code-only plugin release rebind

When the canonical source checkout is shared with live Workers, pause the four
existing Worker jobs and verify no active Worker before editing plugin-bundled
modules. Workers build the canonical bundle for their digest preflight, so an
unpublished source edit can otherwise cause a fail-closed mismatch before the
installed runtime changes. Keep the same job IDs, payloads and schedules; restore
their original enablement after installed/source/projection/runtime read-back.
This maintenance barrier is not a new scheduler. If code was already edited,
record any preflight failures honestly rather than treating them as lost facts
or clearing their run history.

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


## Late host steering attestation

The runtime may persist a user-shaped source before the host confirms its
`steerTargetRunId`. The existing `agent_turn_prepare` and `before_prompt_build`
hooks await reconciliation **before** `attachRun` selects competing sources.
The implementation uses the public host visible-message delta SDK with exact
agent/session-key/session-ID targeting, opaque cursors and a caught-up scan.
There is no direct database reader, recency heuristic or second scheduler.

Only ambiguous unbound source sets require a read; existing exact-run selection
and already attached runs keep their fast path. Reads are bounded to 32 pages,
256 messages / 1 MiB per page, 16 MiB total and four seconds. A reset, oversized
entry, incomplete/missing source, timeout, SDK failure or stopped generation
retains the unbound candidates and reports `STEERING_SOURCE_UNVERIFIED`; it does
not prove ordinary ambiguity and does not create a synthetic skip/completion.
The next existing hook can retry. If a verified complete source set contains
no steering distinction, the existing true-ambiguity guard still applies.

Late enrichment checks exact protected source/transport/actor/reply identity,
source text and the current binding, then compares the checkpoint digest under
the existing disposition/storage locks. It adds only the steering target to a
live `persisted` checkpoint with no ordinary run/session binding, retaining its
original creation and expiry. It never reopens a terminal gap, retargets a
confirmed source, or makes a steering input a completed standalone source.
Normal hook replay does not gain permission to mutate steering identity.

This changes the plugin bundle digest. Publication to Git is not activation:
use the existing maintenance barrier, install/code-only rebind and loaded-runtime
read-back for a separate live rollout. Do not update a shared live source checkout
before that barrier. A natural steer -> ordinary completion -> Worker -> canonical
effect -> indexed retrieval remains a separate E2E proof.
