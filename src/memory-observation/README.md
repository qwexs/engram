# Memory Observation Layer — ledger, episodic evaluator, and daily-note canary

This module implements the storage boundary defined by the PR0 contract pack.
The ledger and runtime adapter remain transport-neutral and independently
testable. ISS-7 PR1 adds a strict episodic `write|skip` evaluator on the
existing evaluator queue. The OpenClaw integration keeps inference behind the
local `maxInferenceCalls=1` gate. A separately gated canary may apply future
typed event observations, or transfer event-and-decision capture ownership,
for one exact daily-note partition. Projection v3 additionally permits one
bounded `agent:<id>:*` family selector; every admitted source and canonical
write still retains its exact runtime session scope.

## Implemented

- exact workspace/session trusted-source admission;
- minimal immutable envelope and evidence records under
  `memory-state/memory-observation/v1/`;
- deterministic credential redaction (authorization, JWT, Telegram, GitHub,
  AWS, Slack, private-key, assignment, and credential-URI forms) and
  fail-closed denial of raw tool outcomes, media, and attachments;
- crash-safe no-replace publication with idempotent reconciliation;
- atomic pre-admission checkpoints from the first accepted `message_received`
  hook, restart-safe correlation across persisted/run/completion stages, and
  immutable content-free terminal gap receipts for unrecoverable candidates;
- evaluator queue state with `nextAttemptAt`, bounded retry, one worker lease,
  and due-time selection that avoids head-of-line starvation;
- high-water limits for jobs, bytes, queue age, and a binary inference gate;
- autonomous lifecycle purge: raw evidence and links at 72 hours, terminal
  envelopes/observations at 30 days, and traces/receipts at 180 days;
- immutable transport-message links for both sides of a completed pair, used
  only to resolve same-session `reply_to` ancestry up to five prior pairs;
- one isolated model completion per claimed attempt, with no tools;
- exact provider/model read-back against the projection and plugin model
  allowlist, with no fallback or agent override authority;
- one plugin-owned autonomous runner per exact workspace/session, plus a
  sealed one-call batch-cron worker for bounded agent-family canaries, with a
  single active inference, due-queue drain, and retry timers driven by
  `nextAttemptAt` rather than later user turns;
- a reviewed `evaluateAfter` boundary that terminalizes older admission-only
  jobs without sending them to the model;
- strict JSON `write|skip`, one `events|decisions` candidate maximum, admitted
  evidence refs only, causal evaluation without future supersession, explicit
  novelty checks against bounded reply context, and bounded semantic/technical
  reasons;
- immutable typed `engram.memory-observation.v1` records for `write`;
- durable `observation_skipped` trace records for `skip`;
- crash resume from a typed observation or evaluator-attributed skip trace,
  including a crash on the final allowed inference attempt, without rerunning
  the model;
- trace progression `source_completed → observation_admitted|observation_skipped`;
- a separate daily-note consumer queue that accepts only future admitted
  `episodic.event` observations, or an explicitly ownership-gated ordered pair
  of `episodic.event` and `episodic.decision`, from one exact source scope;
- deterministic Markdown anchors, immutable apply receipts indexed by
  operation and destination entry, and `canonical_applied` trace events;
- apply-time projection read-back, immediate kill switch, one apply per wake,
  source-timezone date routing, destination read-back, and crash recovery
  without duplicate Markdown entries;
- one cross-process destination lock shared with inline daily-note append and
  session lifecycle writers, preventing stale replace from losing their data.
- apply-time batch producer/trace reauthorization and full canonical runtime
  observation validation;
- prompt-v9 actor-aligned grounding: every batch assertion must cite an exact
  current source-turn whose `source` or `outcome` segment matches the asserted
  user or assistant actor; reply-context citations are supporting evidence only;
- crash-safe bounded terminal recovery with staged authorization, exact
  evidence snapshots, and stale-owner lock recovery;
- exact-session QMD dirty handoff with durable retry; family canaries require
  a pinned registry-slice resolver that maps each exact runtime session to
  exactly one owned/readable `*.md` collection and rejects every fallback;
- read-only Recall Authority compilation for immediate and multi-assertion
  batch receipts;
- receipt-joined Decision-to-OLL admission gated by exact producer, scope,
  evaluator policy, destination read-back, and rollout state.

## Deliberately absent

- KG canonical mutation and domain consumers;
- aggregate or name-derived family-wide QMD binding without an exact
  per-session collection mapping;
- fleet activation or cross-agent/workspace bindings;
- discovery of host-persisted turns for which `message_received` never reached
  the plugin; bounded public transcript-SDK recovery remains report-only work
  tracked below.

Observer-authored Decisions are anchored and receipt-backed. The OLL bridge
accepts only explicitly allowlisted batch Decisions whose receipt, source
producer, scope, evaluator policy, destination read-back, and rollout state all
match. Missing/invalid sidecars, direct observations, Events, and policy or
scope drift remain denied. Unanchored operator-authored Decisions retain their
existing admission path.

The separately reviewed PR2 runtime adapter is present below. Live rollout is
gated by `memory-state/memory-observation/projection.json`, exact installed
plugin-byte read-back, and an exact session or bounded agent-family binding.

## PR2 runtime adapter

`runtime-adapter.ts` is the OpenClaw edge for the neutral admission port.
It correlates server-owned message, persisted-turn, run, and completion
identities, then emits one `TrustedCompletedTurn`. Ordinary assistant turns
complete through successful `agent_end`; terminal message-tool replies complete
through provider-settled `message_sent` carrying exact source-turn correlation. It never imports
an evaluator or canonical writer. The PR1 ledger remains independently
callable by a future MCP/API/CLI transport.

For a bound turn, the adapter synchronously writes
`pre-admission/checkpoints/<candidate>.json` before process-local correlation.
Checkpoint stages are monotonic: `received → persisted → run_attached →
completion_observed`. Restart recovery either resumes the sealed completed
spool, records `ledger_admitted`, or publishes one immutable
`receipts/admission-gap/<receipt>.json`. Gap receipts carry only identities,
scope, producer, digests, a closed reason code, and timestamps. They never carry
user/assistant text, transcript fragments, or tool output. Terminal checkpoints
and spools erase evidence payloads; lifecycle maintenance retains content-free
terminal checkpoints, spools, and receipts for the same 180-day replay window.
The first receipt publication is authoritative if a crash occurs before its
checkpoint update; reconciliation repairs that checkpoint without changing the
original reason. A workspace-local per-candidate disposition lock makes ledger
admission and gap publication mutually exclusive across processes. Before
issuing any later gap, recovery verifies the immutable ledger envelope, queue,
and source trace; a partial ledger admission is retained for repair, while a
complete admission prevents a second terminal outcome. Invalid or digest-stale
projection reads are retained for retry and are not interpreted as an explicit
scope revocation. Admission inspection maps only a verified content mismatch to
identity conflict; read, permission, and malformed-sidecar failures retain the
spool for diagnosis and retry. Legacy v1 completed spools are validated, sanitized, and
upgraded to v2 before replay; without an old checkpoint they remain retained if
their binding is unavailable rather than being terminalized without a receipt.

This guarantee starts after the first checkpoint is durably committed. A host
failure before hook invocation remains outside the Engram boundary and is not
silently described as recovered.

When an inbound turn carries trusted `replyToId`, the adapter asks the local
reply-context store for at most five prior completed pairs. Links for both the
inbound user message and delivered assistant message point to the same pair,
so replying to either side resolves identically. Context stays inside the exact
workspace/session/channel binding, is stored as structured ancestry rather
than concatenated text, and expires with the referenced evidence. Missing,
expired, cyclic, or truncated ancestry is explicit in `replyContext` and never
falls back to a broader transcript scan.

The adapter itself does not install or register an OpenClaw plugin. The separate
`engram-memory-observation` rollout integration wires trusted runtime hooks to
the adapter, independently purges bounded state, and may run one
tool-free episodic evaluation at a time only when the exact local projection
sets `maxInferenceCalls=1` and its provider/model boundary is explicitly
authorized. A plugin service drains immediate work and owns bounded retry
timers; batch mode uses the reviewed deterministic cron entrypoint. With the
default value `0`, the integration remains an admission-only ledger. `shadow`
excludes every consumer. `canary`
adds the daily-note applicator and requires a forward-only `applyAfter`. Its
baseline mode remains event-only; the separately acknowledged ownership mode
admits events and decisions and disables foreground daily-note capture after
the same exact boundary. QMD handoff uses either a preflighted exact-session
binding or a family resolver pinned to the current workspace's registry slice.
The resolver rechecks the exact canonical session root, `*.md` mask, owner,
readability, named physical index and index key before any note mutation and
again before publishing a dirty generation. Missing, ambiguous, broad-mask,
symlinked or drifted mappings remain recoverable as `qmd_pending`; no primary,
prefix or aggregate-root fallback exists. Observer Decisions reach OLL only
through the receipt-joined bridge. Each immutable apply receipt also seals the
concrete QMD binding used at write time. If the registry or physical index is
rotated after the receipt, retry may use the newly authorized binding only when
its canonical session root is identical; Recall Authority verifies the same
continuity before compiling a retrieval manifest.
KG canonical mutation and recall telemetry remain off.

Known pre-admission recovery gaps and the public transcript-runtime research
plan are tracked in [`RECOVERY-GAPS.md`](./RECOVERY-GAPS.md). That backlog does
not authorize direct SQLite access, runtime changes, or scope expansion.
