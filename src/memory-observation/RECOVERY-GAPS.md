# Memory Observation recovery gaps and transcript-runtime research backlog

Status: research and remediation backlog

Recorded: 2026-09-01

Scope: OpenClaw Memory Observation runtime adapter and pre-admission recovery

## Decision boundary

The current Engram ledger, evaluator, applicator, leases, retries, read-back,
and receipts remain authoritative. OpenClaw session storage must not replace
them. A future integration may use the public
`openclaw/plugin-sdk/session-transcript-runtime` API as:

1. a bounded recovery source for completed turns lost before durable
   admission; and
2. a rehydration source that can eventually reduce permanent duplication of
   full turn text.

Direct SQL against `openclaw-agent.sqlite` is out of scope. Transcript
adjacency alone is not proof of a completed, authorized, user-triggered turn.

## Findings

### MOG-REC-1 — pre-admission state is volatile (confirmed, high)

`OpenClawObservationRuntimeAdapter` keeps `pending`, `adopted`, `runs`, and
`completed` correlations in process-local `Map` objects and expires them by
TTL. A restart or crash before `binding.admit(...)` can therefore lose a turn
even when OpenClaw has durably persisted the session transcript. The ledger is
crash-safe after `admit`, but there is no durable reconciler for the earlier
window.

Source anchors:

- `src/memory-observation/runtime-adapter.ts`: adapter maps, `sweep`, and
  `admitCompletedTurn`;
- `integrations/openclaw-memory-observation/index.ts`: hook registration and
  in-process adapter lifecycle.

### MOG-REC-2 — capture gaps have no durable disposition (confirmed, high)

Hook and admission exceptions fail closed through `safe(...)`, but the failure
is represented only in runtime logging. There is no durable gap receipt keyed
to the source/completion identity. Operators cannot prove that every eligible
completed turn was admitted or explicitly rejected after a restart or hook
contract mismatch.

Required outcome: every discovered eligible completion must end as admitted,
terminally excluded with a reason, or an explicit gap receipt such as
`missing`, `pruned`, `digest_mismatch`, `scope_revoked`, or
`identity_ambiguous`.

### MOG-REC-3 — one pre-run slot per runtime session (confirmed, medium)

`pending` and `adopted` are keyed only by `runtimeSessionKey`. Two inbound
turns that overlap before run attachment produce `AMBIGUOUS_TURN`. Telegram is
normally serialized, but queued/burst delivery, restart boundaries, and future
transports need executable proof rather than that assumption.

### MOG-REC-4 — completion and branch identity is incomplete (confirmed, medium)

`runId` participates in in-memory correlation but is not preserved as a
separate durable completion identity in the admitted job. The durable model
does not yet define `completionId`, transcript terminal anchors,
branch/generation, or fork/rewind policy. A cursor may be a recovery checkpoint
but must never become turn identity.

### MOG-REC-5 — completion versus delivery semantics needs a decision (confirmed, medium)

Ordinary replies complete at successful `agent_end`; terminal message-tool
replies complete only after successful `message_sent`. The system must state
whether memory records completed agent work or content successfully delivered
to the source transport. If delivery is required, the ordinary reply path
needs a delivery-aware completion receipt or an explicit `completionKind` that
preserves the distinction.

## Target recovery shape

Hooks continue to establish authority and should durably publish the exact
completion identity and terminal anchors. A reconciler may scan the public
transcript runtime with a bounded overlap window to recover crash-before-hook
or crash-before-admission gaps. For each candidate it must:

1. reauthorize exact agent, workspace, session, scope, owner, producer, and
   policy epoch;
2. bind immutable `sourceTurnId`, `runId`, separate `completionId`,
   `completionKind`, branch/generation, `completedAt`, terminal transcript
   anchors, and available transport message IDs;
3. read only the exact bounded source and terminal assistant records;
4. sanitize the reconstructed payload and compare its digest with the hook or
   admission digest;
5. refuse broad transcript search when evidence is missing, pruned, ambiguous,
   or mismatched; and
6. emit a durable terminal gap receipt for every unrecoverable candidate.

During retries, keep sealed bounded evidence so repeated evaluation is
reproducible. Delete it only after terminal processing plus a declared grace
period. Session retention is not an implicit Engram durability guarantee.

## Research and remediation sequence

### R0 — freeze the OpenClaw 2026.8.1 public contract

- inspect the installed `session-transcript-runtime` exports and lifecycle hook
  payloads;
- identify stable session, event, branch/generation, run, completion, and
  transport anchors;
- document compaction, pruning, reset, fork, rewind, and retention behavior;
- do not design against direct SQLite tables or the earlier
  `2026.7.2-beta.7` runtime.

### R1 — executable failure-model fixtures

Cover restart between every pre-admission stage, duplicate hooks,
same-identity/different-digest conflict, two queued inbound turns, failed
delivery, tool-delivered final replies, media-only turns, compaction, pruning,
reset, fork, rewind, TTL expiry, and scope revocation.

### R2 — report-only reconciler

Implement bounded SDK scanning with a persisted cursor plus overlap. The cursor
is only a checkpoint. Produce candidate and gap reports without admission or
canonical mutation. Prove deterministic replay after restart.

### R3 — dual-read shadow

For newly completed turns, compare the current hook evidence digest with the
SDK-rehydrated digest. Require exact identity and digest agreement, zero
cross-scope reads, and an accounted disposition for every eligible completion.

### R4 — guarded recovery and storage reduction

First allow exact gap recovery behind a kill switch. Only after restart,
reset/fork/rewind, compaction, tool/media, and retention tests pass may the
system remove permanent duplicated `redactedEvidence.payload` or reply-context
text. Keep durable admission, provenance, queue state, leases, retries,
terminal dispositions, digests, and apply receipts.

## Acceptance gates

- every eligible completion is admitted or has one durable terminal gap
  receipt;
- crash/restart at each pre-admission stage loses no turn silently;
- same identity plus same digest is idempotent;
- same identity plus a different digest, scope, branch, or generation fails
  closed as conflict;
- no direct SQLite access and no broad transcript fallback;
- no cross-agent, cross-workspace, cross-session, or cross-branch evidence;
- current hook and SDK evidence match digest-to-digest in shadow;
- missing, pruned, expired, and delivery-failed cases remain attributable;
- rollback disables reconciler admission without changing existing ledger,
  evaluator, applicator, or foreground ownership behavior.

## Non-goals

- replacing the Engram ledger with OpenClaw session storage;
- inferring owner authority or successful completion from neighboring
  transcript messages;
- treating cursor position as identity;
- deleting retry evidence before deterministic replay is proven;
- expanding beyond the existing exact-session canary as part of this work.
