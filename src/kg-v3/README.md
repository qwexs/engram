# Engram KG v3 MVP core contract

PR2 is a dormant, fleet-neutral core. Production authority is disabled when
`memory-state/kg-v3/authority.json` is absent, malformed, schema-mismatched, or
has mode `legacy-contained`. PR3/PR4 own marker activation.

## Authoritative files

```text
life/v3/assertions/<assertion-uuid>.json
memory-state/kg-v3/operations/<operation-sha256-hex>.json
memory-state/kg-v3/locks/<workspace-entity-sha256>.lock/
memory-state/kg-v3/registry.json
memory-state/kg-v3/authority.json
life/v3/current-summary.md
```

The registry and authority marker are declarative inputs; the PR2 writer never
creates or activates them. Assertion and registry schemas live in `schemas/`.

## Commit and recovery FSM

Each operation is serialized by a per-workspace/entity lock. Every JSON write
uses a mode-0600 temporary file, file `fsync`, atomic rename, and directory
`fsync` where supported.

```text
no journal
  → prepared (WAL contains the complete deterministic mutation plan)
  → assertion file(s) atomically replaced
  → store_committed
  → committed (terminal receipt is durable)
  → current-summary projection
```

Recovery replays the plan embedded in `prepared` or `store_committed`. Atomic
replacement makes each step idempotent. Projection is generated only after a
terminal commit. A committed record whose projection was interrupted repairs
the projection before returning its original receipt.

After terminal commit, the async typed API marks the owned knowledge-graph
collection dirty through the existing maintenance integration and never runs
raw QMD update/embed. Marker success, disabled mode, or best-effort failure is
persisted in the operation journal and returned in the receipt; bookkeeping
failure never rolls back KG state and is retried by replay/recovery.

Normal replay and recovery-before-mark issue one dirty notification. There is
an intentionally accepted at-least-once window if the process crashes after a
successful maintenance-state mark but before its journal read-back is stored;
recovery may increment dirty generation once more. This is safe because dirty
generation is idempotent work for the coordinator. PR2 does not add a global,
unbounded QMD idempotency index for distributed exactly-once delivery.

The writer recomputes `operationId` from trusted workspace/session/actor,
message identity and the semantic target (entity + predicate, or entity +
retracted assertion ID). Runtime timestamps do not participate. The journal
stores a canonical payload digest. Reusing an operation ID with a changed
payload returns `OPERATION_CONFLICT`.

## Read boundaries

`await KgV3Reader.current()` recovers pending WAL records and returns active v3 only.
`historicalV2(entityId)` is a separate explicit adapter and never contributes
to current/default projection.

At a valid `canary` or `enabled` marker, `scripts/memory-write.js` blocks legacy
fact mutation. The typed API still requires both trusted caller capability and
the same capability enabled for that exact session in the marker.

`scripts/kg-v3-tool.ts --context` is an operator/test harness, not a trusted
agent boundary. Production ingress must construct `TrustedKgCallerContext` in
the runtime adapter from verified inbound metadata and call the typed core API.
