# Source debt and verified closure

Source debt is protected administrative accounting, not another memory writer,
queue, scheduler, or KG assertion store. It prevents evidence retention from
turning a failed or unverified source into an apparently complete history.

## Storage and identity

State lives under `<workspace>/memory-state/memory-observation/source-debt/v1/`:

| Directory | Contract | Meaning |
|---|---|---|
| `failures` | `engram.memory-source-debt.v1` | immutable failure/unverified origin |
| `links` | `engram.memory-source-debt-link.v1` | verified candidate-to-admitted-source link |
| `closures` | `engram.memory-source-debt-closure.v1` | verified outcome and applicable effects |

Identity includes workspace, exact runtime session and source/candidate/trace
kind. A requeue is not closure. Different stages can retain distinct immutable
origins for the same debt identity. Old valid records without `batchParents`
remain readable; upgrading legacy archive accounting appends an origin instead
of rewriting the old record. Hashes bind bytes/identities; they are not a
replacement for filesystem permissions or trusted operator authorization.

The writer uses a scoped lease, immutable files, fsync and bounded inventory:
at most 10,000 records / 64 MiB. Invalid metadata or exhausted capacity blocks
destructive lifecycle work. It does not silently drop old debt. Source text,
model output and credentials are not copied into these records. Exact session
IDs and filesystem references are still private operational metadata: do not
publish live state, receipts, plans, or production fixtures.

## Capture, retention and runtime separation

`source-debt-capture.ts` is Node-safe. The host plugin calls its capture/purge
guard before deleting expired evidence or lifecycle artifacts. The actual
evidence expiry is authoritative, including non-default short TTLs. A fresh
per-admission purge with nothing to delete does not create or scan debt.

The standalone Bun Worker uses `source-debt.ts`: before its unchanged host-style
guard it can retain authenticated legacy recovery origins whose operational
envelopes have already expired. Such origins are `identity_unverified` TRACE
debt with no fabricated envelope or successful closure. Missing or corrupt
archive proof remains a blocking error. Worker-only closure verification is not
bundled into the Node host plugin.

A disabled semantic projection does not authorize inference or canonical
memory writes. Lifecycle/purge bookkeeping can still run before the disabled
result, and can fail closed; disabled is not an instruction to erase debt.

## What closes a source

`verifySourceEffectClosure` reconstructs and checks the exact source, immutable
job, evaluator result and terminal disposition. A write additionally requires
the expected observation, canonical daily-note read-back, receipt aliases, and
all applicable QMD/domain effects. QMD proof includes the exact index binding,
generation, document/anchor and canonical digest. A plain exit code, queue
reason, dirty marker or successful model response cannot substitute for proof.

| Result | Closure |
|---|---|
| `evaluated_skip` | validated explicit semantic skip; no invented write |
| `materialized_verified` | expected assertion and every applicable effect verified |
| deferred / ambiguous / incomplete / missing proof | remains open with a reason |

In particular, `semantic_batch_grouped_no_assertion` is not automatically treated
as a proven semantic skip. Supporting a new terminal reason requires a reviewed
proof contract, not merely adding its name to a success list.

`scanSourceDebt` is the Bun wrapper that can write verified closure certificates.
The Worker runs it after effects and on the idle path: the separate QMD
coordinator can finish indexing without a new chat message. Certificates retain
authenticated compact proof after ordinary source/effect TTLs. Existing
certificates are validated, not overwritten. `sourceDebtSnapshot` is read-only;
`observed: false`, corruption and missing proof must not be interpreted as zero
historical loss or a fully audited history.

No path here writes KG v3, edits legacy KG v2, grants cross-workspace retrieval,
or promotes administrative metadata to domain facts. Proof of indexed capture
also does not prove that a later agent answer retrieved or used the memory.

## Operator cessation of recovery (not closure)

An explicit trusted operator request may stop recovery of a finite, reviewed,
inactive historical set. Use `scripts/memory-source-debt-writeoff.ts --workspace
<absolute-owner-workspace> --request <private-exact-request.json>` to plan;
append `--apply` to persist the immutable decision. The request pins workspace,
debt identity, sorted exact failure record IDs, historical cutoff, a bounded
reason code, the review evidence digest, authorizing actor/source and timestamp.
Keep the review artifact in the owner's private operational contour.

Receipts live separately in `memory-state/memory-observation/source-debt-writeoffs/v1/`.
They do not edit failures, semantic closures, queues, raw evidence, notes or KG.
Only inactive history is accepted: pending jobs, nonterminal evaluation/daily
effects, deferred/unresolved context and recovered admissions needing proof are
rejected. This does not introduce an alternative automatic retry path.

The Bun Worker snapshot adds `writtenOffIds`, disjoint from `closedIds` and
`openIds`. Host capture/purge remains unchanged and retains the full raw debt;
the overlay is intentionally not bundled into the host plugin. Fleet incidents
exclude written-off identities from recurring recovery counts, but never call
them restored. Additional failure records or reactivation of the same source
invalidate the old waiver and reopen its identity. Different/new sources are
unaffected. Missing or corrupt waiver metadata fails closed. Historical raw
health counters can remain degraded; a write-off does not certify system health.

## Verification

Run from the repository root:

```bash
bun test src/memory-observation/source-debt-capture.test.ts \
  src/memory-observation/source-debt.test.ts \
  src/memory-observation/source-effect-proof.test.ts
```

Fixtures are synthetic. The Node import test builds the actual checked-out
source with only SDK test stubs; it does not apply external patch files.

See [recovery operators](memory-recovery-operators.md) and
[fleet reporting](memory-fleet-isolation.md).
