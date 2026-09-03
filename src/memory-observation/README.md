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
- exact-session QMD dirty handoff with durable retry; family projections reject
  a single ambiguous QMD binding;
- read-only Recall Authority compilation for immediate and multi-assertion
  batch receipts;
- receipt-joined Decision-to-OLL admission gated by exact producer, scope,
  evaluator policy, destination read-back, and rollout state.

## Deliberately absent

- KG canonical mutation and domain consumers;
- family-wide QMD binding without an exact per-session collection mapping;
- fleet activation or cross-agent/workspace bindings;
- automatic pre-admission transcript recovery (tracked below).

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
the same exact boundary. QMD handoff is available only for exact-session
bindings; observer Decisions reach OLL only through the receipt-joined bridge.
KG canonical mutation and recall telemetry remain off.

Known pre-admission recovery gaps and the public transcript-runtime research
plan are tracked in [`RECOVERY-GAPS.md`](./RECOVERY-GAPS.md). That backlog does
not authorize direct SQLite access, runtime changes, or scope expansion.
