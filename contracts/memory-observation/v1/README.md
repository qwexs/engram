# Memory Observation Layer — PR0 contract pack

Status: **contract pack implemented / guarded immediate and batch evaluators /
daily-note canary and exact observer ownership active only through digest-gated rollout**. This directory remains the schema and
default-deny policy pack. The separate `src/memory-observation/` module
implements the storage boundary and strict episodic `write|skip` evaluator.
The evaluator has no tools or canonical mutation authority, reuses the existing
queue, and runs only behind an exact reviewed projection. Its
plugin-owned autonomous runner provides one in-process drain/retry lifecycle;
it is not a cron, external scheduler, or second queue.
A separate canary applicator may mutate Events, or explicitly gated Events and
Decisions, for future typed observations from one exact source scope. A runtime
may pin only an exact reviewed repository commit containing this pack.

## Canonical identities

- Schema bundle: `schemas/memory-observation-contracts-v1.schema.json`.
- Producer registry: `producer-registry.json`.
- OLL receipt producer admission registry: `oll-receipt-producer-registry.json`.
- Observation class registry: `class-registry.json`.
- Producer authority: `authority-policy.json`.
- Consumer admission: one `consumer-*.json` policy per sink.

Artifact and policy digests use RFC 8785/JCS canonical JSON followed by SHA-256
and the `sha256:<hex>` representation. Producer digests in this PR0 pack bind
the named contract release, not a future runtime binary. A runtime rollout must
replace them with the reviewed release artifact digest and pin that exact value
in the producer registry and consumer policy.

## Closed derivations

```text
traceId = SHA256("engram.memory-trace.v1\0" + workspaceId + "\0" +
                 runtimeSessionKey + "\0" + sourceTurnId)

sourceDigest = SHA256(JCS({sourceTurnId, scope, sourceCompletedAt}))
evidenceDigest = SHA256(JCS(redactedEvidenceEnvelope))
observationId = SHA256("engram.memory-observation.v1\0" + traceId + "\0" +
                       producer.id + "\0" + observationClass)
operationId = SHA256("engram.memory-apply.v1\0" + consumer + "\0" +
                     observationId + "\0" + destinationEntryId)
eventId = SHA256("engram.memory-trace-event.v1\0" + traceId + "\0" +
                 stage + "\0" + stageRef.digest)
```

The same identity with a different digest is `CONTENT_CONFLICT`; it is never an
update or retry. Replay re-runs authority and admission against the current
policy. A disabled or changed policy may therefore reject an old queued item.
Persisted semantic skips retain evaluator producer and current policy digest,
so their crash replay is authorized symmetrically with persisted writes.

## Authority and admission are separate

`authority-policy.json` answers **who may produce an artifact at a stage**.
Consumer policies answer **whether one sink accepts that artifact now**. Both
must admit; either rejection is terminal for that attempt and records a reason
code. Model confidence cannot override either decision.

The PR0 contract executor recognizes only authority policy
`memory-observation-authority-v1` and consumer policy `v1`. It resolves the
artifact/stage rule, exact registered producer release, authority class,
required trusted inputs, and required consumer provenance fields. Unknown
policy versions and unmet inputs fail closed. This is a narrow contract check,
not a general policy engine.

| Sink | Input authority | Default admission | Sole mutator / effect owner |
|---|---|---|---|
| Daily note | typed episodic observation only | disabled | `daily-note-applicator` |
| KG v3 diagnostic | typed durable-intent-gap observation | disabled | no canonical mutator |
| KG v3 canonical | trusted explicit-intent ingress only | disabled in this layer | `kg-v3-explicit-intent-ingress` |
| OLL | receipt-joined `batch-post-turn-observer` Decisions only | disabled; registry is report-only with empty scope/policy allowlists | `oll-rule-materializer` after separate approval |
| QMD | canonical record references only | disabled | `qmd-indexer` (derived index only) |
| Recall telemetry | typed diagnostic/trace only | disabled | `memory-trace-writer` |

Unknown producer, producer digest, observation class, input schema, target
consumer, or exact scope is denied. An empty `exactScopeAllowlist` admits
nothing. Templates must be rebound to a reviewed workspace and exact source
partition before a canary; changing `mode` alone is insufficient.

## Typed daily-note join

The daily-note applicator writes one journaled operation containing:

1. an opaque Markdown anchor `<!-- engram-entry:sha256:... -->` immediately
   before the human-readable bullet;
2. the bullet;
3. `engram.memory-apply-receipt.v1` stored by `destinationEntryId`.

The anchor is only a lookup key. Receipt field `producer` identifies the daily
applicator. `sourceProvenance` independently preserves the source turn,
observation producer release, episodic class, bounded evidence refs, and
observation digest. Scope, trace, source completion time, policy, and read-back
metadata remain on the receipt. Downstream consumers must join by
`destinationEntryId`; they must not infer provenance from text, section, path,
anchor syntax, or a short-lived observation record. A missing, duplicate,
mismatched, or unreadable receipt is `PROVENANCE_UNRESOLVED` and fails closed.

## Storage and ownership decision

PR1 may create only this workspace-local root:

```text
memory-state/memory-observation/v1/
  pre-admission/
    checkpoints/  # mutable monotonic hook checkpoints; terminal payload is content-free
    *.json         # sealed completed-turn spool awaiting ledger disposition
  envelopes/       # immutable admitted envelopes
  evidence/        # encrypted/permission-bounded TTL evidence
  transport-links/ # immutable same-session reply indexes, TTL-bound to evidence
  observations/    # immutable typed write observations; skips remain typed terminal trace events
  traces/           # append-only stage events
  receipts/
    admission-gap/  # immutable content-free terminal pre-admission dispositions
    by-operation/   # immutable canonical apply receipts
    by-entry/       # immutable canonical-entry receipt index
  queues/           # source/evaluator queue state
  consumers/        # sink-specific queue state
  locks/            # workspace and destination leases
```

One workspace coordinator owns source admission, observation queues, evidence
purge, and trace append ordering. Each consumer keeps a separate queue and sole
mutator. The coordinator cannot call canonical writers directly.

Admission candidate identity is
`SHA256("engram.memory-admission-candidate.v1\0" + workspaceId + "\0" +
runtimeSessionKey + "\0" + channel + "\0" + inboundMessageId)`.
The single terminal gap receipt identity is
`SHA256("engram.memory-admission-gap-receipt.v1\0" + candidateId)`;
`receiptDigest` covers the complete receipt body except `receiptDigest` itself.
Same identity and content is a duplicate; changed content is a conflict. The
crash guarantee begins at the successful atomic `received` checkpoint, not
before the host invokes the plugin hook.

Transport-neutral identity derivation reuses the runtime semantics already
used for `channel-user:v1`, but its future implementation belongs to a shared
runtime/observation namespace. The layer must not import a KG v3 writer module
or treat KG authority as identity authority.

## Retention v1

- raw evidence: 72 hours maximum;
- transport reply links: no longer than their referenced raw evidence;
- envelope and typed observation: 30 days after terminal disposition;
- content-free terminal admission checkpoints and spools: 180 days;
- trace events, apply receipts, and admission-gap receipts: 180 days;
- resolved/expired diagnostic records: 90 days;
- open diagnostics expire after 30 days unless explicitly acknowledged.

Purge is an independent lifecycle task and cannot wait for another user turn.
Legal/privacy deletion follows an operator-authorized purge path and is not
modeled as ordinary memory supersession.

Because an observation may be purged after 30 days, every apply receipt carries
the source producer/class provenance required to validate its canonical entry
for the receipt's full 180-day lifetime. It stores refs and digests, not raw
evidence.

Durable-intent gaps have no review UI in v1. They remain report-only typed
diagnostic records with `open → acknowledged|resolved|expired`; a UI requires a
later product/authority contract and is not a hidden PR1 deliverable.

## Remaining implementation gates

- The isolated ledger provides queue mechanics, terminal semantic trace, and an
  autonomous 72h/30d/180d purge lifecycle. The OpenClaw integration imports the runtime adapter
  and can enable evaluation only with `maxInferenceCalls=1`, an
  exact `evaluateAfter` boundary, and a matching default-agent provider/model.
- The strict episodic evaluator, typed-observation writer, guarded daily-note
  consumer queue, deterministic anchor, immutable receipt, canonical trace,
  crash recovery, read-back, and kill switch exist. Runtime activation remains
  a separate guarded rollout.
- The evaluator policy is causal and novelty-aware: it may use only the admitted
  target evidence plus bounded reply context, never future supersession, and it
  skips explanation-only restatements while retaining new verified status or a
  concrete operational plan accurately even when follow-up still awaits approval.
- Batch prompt v9 requires every durable assertion to carry at least one exact
  `source-turn` citation whose current evidence segment matches `actorRef`
  (`source.role=user` or `outcome.role=assistant`). Reply-context message
  citations remain supporting context and cannot replace that source anchor.
- The daily-note OLL parser rejects naked or invalid observer anchors as
  `invalid_schema`. A valid batch Decision is admitted only through the
  versioned `oll-receipt-producer-registry.json` join: exact applicator and
  producer release, exact scope, evaluator policy digest, canonical receipt,
  destination read-back, and rollout state must all match. Missing registry,
  direct-observer receipts, Events, scope drift, policy drift, and a rollout
  state below the compiler execution mode remain `unsupported_source`.
  Pre-bridge immutable batch receipts remain schema-valid but lack the new
  evaluator-policy provenance field, so they are deliberately ineligible for
  OLL admission and are not rewritten or backfilled.
  The shipped registry cannot admit live input because both its exact-scope
  and evaluator-policy allowlists are empty; runtime activation is a separate
  reviewed config and rollout step. Exact-session canaries may perform a
  durable QMD dirty handoff. Family canaries reject a single ambiguous QMD
  binding until per-session collection mapping exists.
- Independent blocker review completed with a targeted-rework verdict. This
  pack must remain an isolated repository commit and pass ordinary review
  before any runtime may pin its digest.
- Runtime inference activation and every later canonical-write step require
  separate approval and exact installed-byte read-back.
