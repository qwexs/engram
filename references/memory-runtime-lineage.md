# Runtime durability, model lineage and bounded context

These contracts preserve exact source meaning across runtime cache eviction,
projection changes and separately evaluated micro-batches. They do not replace
trusted source admission, grant KG authority, or guarantee model interpretation.

## Cache lifetime is not the recovery deadline

The runtime adapter's short in-memory TTL bounds service caches. AdmissionStore
owns the durable checkpoint deadline. Cache eviction, service restart or an
unavailable host binding cannot by themselves prove that a source/run failed.
Late exact hooks can rehydrate a pending durable checkpoint. A matched final
retains its idempotent admission/spool obligations instead of becoming an
invented missing-final event.

Terminal gaps stay terminal. An immutable gap receipt is reconciled rather than
reopened; actual durable expiry and revoked/changed exact scope fail closed.
A transiently unavailable binding retains debt. This keeps the distinction
between a cache miss, an identity conflict, expired evidence and known failure.
No last-message, text-similarity or timestamp-based source join is introduced.

## Additive topic lineage

`readModelTransition` validates both the stored target digest and original model
lineage. An unexpected target is still an error; recomputing a checksum is not
an authorized repair. `validateModelTransition` also accepts an explicitly
supplied historical target for administrative preflight, without making stale
targets acceptable to runtime reads.

`extendHistoricalModelTransition` requires the exact historical target and an
additive approved current projection. Main uses its existing family-preserving
v3/v6 rules. Project groups require v4, unchanged existing bindings, unique exact
runtime session keys, project-scoped topic identities and Telegram-only routes.
The extension may account for the new exact-session QMD resolver and installed
plugin identity, but not change model, policy, epochs or other authority. The
original `previousProjection`/`previousQuality` remain immutable; a baseline
projection records the scope extension instead of rewriting the old model.

The caller must separately validate canonical projection, actual host routes,
domain registry and every exact-session QMD binding before publishing. A
lineage hash is not a replacement for that deployment read-back. Ordinary
projection mutations still drain/archive completed lineage through the
existing retirement operator. Unfinished/unknown policies remain blocked.

## Bounded context across model calls

Each batch remains an independent model call. Exact reply context requires a
verified transport link within the same workspace/session. Where a host's
native outbound hook lacks source/run/session provenance, Engram reports the
missing link; it does not fabricate one. Message-tool delivery and native
delivery are separate provenance contracts.

Opted-in exact scopes can additionally retain recent context candidates:
up to three earlier source/outcome pairs within two hours, at most 16 KiB,
and bounded 2,048-code-point prefixes per message. Evidence TTL and exact scope
are rechecked. Candidates are explicitly contextual evidence, not a reply
chain, new actor statement or source to requeue. A completed previous batch can
therefore inform a later correction without reopening its evaluator queue.

Quality sidecars control exact scope opt-in and producer mode. `drain` may keep
context capture/readability while preserving the existing producer behavior;
it is not deletion of the sidecar. Immutable outstanding jobs retain their own
policy/model identity. Do not relabel cached output or blindly raise batch,
reasoning or output limits to repair a scope/identity blocker.

## Verification

Run the runtime adapter, model transition, model transition retirement,
reply-context and Worker CLI test files. Tests distinguish source capture,
canonical application, indexed proof and actual later retrieval/use. A
configuration read-back or synthetic boundary test is not a natural-source
E2E claim for every deployment. See [source debt](memory-source-debt.md).
