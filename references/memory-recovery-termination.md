# Bounded recovery termination

The existing Worker can stop expired recovery without replaying terminal sources,
adding a scheduler, or spending inference calls. This is accounting, not memory
restoration, semantic skip, source deletion, or KG ingress.

## Enablement

Explicitly opt in per workspace in its existing `engram.json`:

```json
{"memoryObservation":{"autoStopExpiredRecovery":true}}
```

The flag defaults to off. It is a standing operator policy; use an authenticated
workspace administrator change and configuration read-back. The current validated
observer projection supplies the existing `limits.evidenceTtlHours` (up to 72h)
and exact binding. No new duration, model, cron, coordinator or recovery queue is
introduced. The normal `memory-observation-batch-worker.ts` calls the accounting
pass on both active and idle paths, after ordinary source-effect reconciliation.

## Eligibility

The deadline is no earlier than the latest failure plus the existing evidence
TTL and any retained checkpoint, evidence or sealed-input deadline. Age alone is
insufficient. A source is excluded while there is a nonterminal checkpoint,
completion obligation, live evidence, evaluator claim/queue, downstream daily or
domain effect, unfinished job, successful semantic disposition, or persisted
observation/application requiring proof repair. Exact scope/ownership and metadata
must remain valid. Unknown/corrupt metadata fails closed.

Expired terminal `unresolved`/legacy `defer` with no effects may receive
`unresolved_window_ended`; other exhausted history receives
`recovery_window_ended`. If operational evidence was purged, the receipt means
only that the policy window ended, not that native history is unavailable.

Each existing pass writes at most 20 new receipts under the existing debt writer
lease. Metadata is loaded per batch, not by repeatedly invoking the manual
write-off command for every identity. Retries, attempt counters, queues, capture
ownership, evaluation/consumer policies and inference budgets are unchanged.

## Accounting and compatibility

Manual v1 write-off receipts remain immutable and readable. Automatic v2 receipts
use the same `source-debt-writeoffs/v1/` administrative store, explicitly identify
`policy_recovery_stopped`, and bind the exact record set, policy digest, deadline
and content-free evidence digest. They are never labelled operator decisions.

`writtenOffIds` remains the aggregate non-recovered partition;
`automaticallyStoppedIds` is a validated subset. `closedIds` still requires the
existing source-effect proof. A new failure or actual reactivation invalidates an
old stop. Purging already expired evidence does not reopen a valid receipt. A
crash after publication is resumed idempotently by the next normal pass.

Health retains historical failure counts but excludes validated stops from active
failures/gaps. `accounted_incomplete` means no active work/blocker, with known
historical omissions; it does not claim complete memory. Fleet reporting separates
policy stops, manual write-offs and verified recovery and preserves delivery
deduplication.

Turning the flag off stops future automatic receipts; existing decisions remain
auditable and readable. Do not downgrade to a reader predating v2 receipts after
activation: retain the compatible reader when suspending the writer.

## Hook diagnostics

Known `ObservationHookIdentityError` failures expose bounded schema codes/reasons
instead of all collapsing into `RUNTIME_ADAPTER_FAILED`. Unknown error text stays
private, including arbitrary messages supplied to that exported error class.
Identity checks are not weakened. Changes to this hook helper alter the Engram
plugin bundle digest and require the normal code-only plugin rebind, loaded
runtime read-back and Worker maintenance barrier before live activation.

## Verification

Expiry tests cover opt-in/plan/no-op repeat, new errors/reactivation, fresh
evidence, active claims and downstream effects, retained checkpoints, revoked
bindings, bounded batches, publication crash, expiry purge, unsafe paths, and
receipt integrity. Fleet tests ensure a policy stop cannot appear as restoration
or an operator decision. Natural-source E2E remains separate from a config or TTL
fixture check.
