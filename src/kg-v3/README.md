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
memory-state/kg-v3/live-ingress.json
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

## OpenClaw live ingress boundary

`integrations/openclaw-kg-v3/` is the thin OpenClaw adapter. It registers
`engram_memory_save` and `engram_memory_retract`, but both tools remain absent
unless the current workspace has a valid, enabled `live-ingress.json` whose
workspace, release, mode, session capability, and installed plugin digest
match the guarded KG authority marker.

The adapter preserves direct `inbound_claim` capture for plugin-owned bindings.
For ordinary channel turns it uses a plugin-only adoption FSM across existing
OpenClaw hooks:

```text
message_received → before_message_write → agent_turn_prepare | before_prompt_build
  → before_tool_call → tool consume
```

`message_received` supplies the channel-owned session, sender, and
message identity. The synchronous `before_message_write` hook adopts exactly
that pending message only when OpenClaw's protected persisted user-turn
metadata agrees on transport/message identity, owner status, and the stable
`channel-user:v1` source-turn key. `agent_turn_prepare` (embedded/CLI) or
`before_prompt_build` (including Codex app-server) binds the single eligible
adopted turn to the server-owned `runId` by canonical session before prompt construction;
prompt text is never an authority or correlation key. `before_tool_call`
rechecks run, session, requester channel/sender, owner status, and the server-owned
`toolCallId`.

One source run can bind at most one KG mutation tool call. Duplicate hook
delivery is idempotent and does not reset that budget. Missing/reordered hooks,
conflicts, multiple adopted candidates (including collected/batched turns),
and expired in-memory attestations fail closed. Ordinary turns never use
`reply_dispatch`, text equality, or FIFO guessing for authority.

The model supplies only the typed semantic fields. Entity type and scope are
resolved from the registry, while provenance and stable operation identity are
constructed from the trusted inbound turn. Operational/progress/test/status
material stays in daily/domain stores.

Rollout is explicit and read-back guarded:

```bash
bun scripts/kg-v3-live-ingress.ts plan --workspace /opt/openclaw/workspace --workspace-id main
bun scripts/kg-v3-live-ingress.ts install --workspace /opt/openclaw/workspace --workspace-id main --ack-plugin-install
# restart and verify the OpenClaw gateway before activation
bun scripts/kg-v3-live-ingress.ts activate --workspace /opt/openclaw/workspace --workspace-id main \
  --approved-by '<authority>' --ack-gateway-restarted --ack-live-ingress
bun scripts/kg-v3-live-ingress.ts status --workspace /opt/openclaw/workspace --workspace-id main
```

Rollback disables only the local live projection and preserves assertions,
operation journals, canary evidence, and the v3 read projection. Installing the
plugin globally never activates another workspace.
