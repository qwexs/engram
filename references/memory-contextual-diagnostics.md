# Contextual Worker failures and bounded recovery

The standalone Worker now writes an immutable metadata-only receipt for **every**
failed contextual evaluation, including a first retry and later exhausted or
operator-recovered attempts:

`memory-state/memory-observation/batch-live-store/memory-batch-live/v1/contextual-failures/<job digest>/<uuid>.json`

Each receipt contains job/bundle/policy identity, source trace IDs, timestamp,
stage and code, and a content digest. For model-output validation failures it
also contains output length and SHA-256, **not the output**. Files use mode 0600.
Provider messages, stack traces, prompts and credentials are not retained.
An unrecognised provider exception becomes `PROVIDER_EXCEPTION`; this is not an
exact root-cause diagnosis. An old generic failure cannot be reconstructed from
these receipts retroactively. A replay diagnoses a new attempt, not necessarily
the original one.

Stages: `request`, `provider`, `validation`, `observations`, `persistence`.
Validation codes distinguish invalid JSON, output/assertion shape, evidence
references, quotes, actor/status/resolution, dispositions and coverage.
The Worker result includes `diagnostic` and `diagnosticRef`; the queue retains
`batch_contextual_evaluation_failed` for existing recovery consumers.
A diagnostic-write error fails the run before consuming an evaluator attempt.
The existing cached-result fail-closed contract and writer dedup are unchanged.

## Prompt versions v13-v15

New jobs retain the v12 actor/status and owning-input address constraints, then
add two semantic quality rules. One-off mechanical requests and results are
skipped unless they establish a reusable preference, durable decision, or
material artifact state. One bounded request plus its reported completion is
represented as one compact assertion when both describe the same predicate;
partial work, failure, restrictions, and genuinely different durable facts stay
separate. No validation condition is relaxed.

Prompt v10/v11/v12 bytes remain unchanged for queued old jobs; their policy
digests stay explicitly readable. V14 introduced a source-complete JSONL wire
format, but repeated live and replay evaluations showed that the model could
stop after the first valid record and fail strict source coverage. V15 therefore
uses the exact frozen v13 model-facing bytes and canonical single JSON envelope
under a new producer-policy identity. Pending v14 jobs remain readable and keep
their JSONL parser; there is no fallback or second inference call. The already-installed
plugin bundle is unchanged: no Gateway restart or projection re-pinning is
necessary for this standalone-Worker-only release. Always verify this with the
actual build before applying; do not assume it for a future change.

## Operator recovery and verification

1. Inspect current queues, the exact failed job and its immutable reconciliation.
   A later cron `ok` or idle pass does not prove recovery of earlier failures.
2. Diagnose with the failure receipt; if an old receipt is generic, use a bounded,
   same-scope tool-free replay with the configured model. Never inject its result.
3. After fixing and testing, use `recoverReconciledBatch` with exact job ID and
   operator authorization. It checks expiry, original queue digests and absence
   of effects, records recovery, and requeues sources under the current producer.
   Old job/done/reconciliation and source bytes remain unchanged.
4. Let the canonical Worker evaluate and write. Check each source disposition,
   daily apply receipt/read-back, domain effect and QMD index receipt separately.
   An `unresolved` disposition needs semantic review, not a fabricated success.
5. Report historical failure artifacts separately from current pending/failed
   queues. Do not delete failures or reset counters to make health green.

Fleet notifications intentionally contain only failed workspace names; detailed
causes live in workspace-local diagnostic receipts. Alert cooldown and scheduler
ownership are unchanged.
