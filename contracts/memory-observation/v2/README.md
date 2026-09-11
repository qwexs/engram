# Contextual memory v2 (opt-in)

This extension reuses the existing source ledger, batch evaluator, daily-note
applicator, domain consumer and QMD handoff. It is not a new writer, a KG ingress,
or an automatic current-state projection. The default remains v1.

## Evidence and interpretation

`engram.memory-contextual-output.v2` contains assertions and an explicit
disposition for every input. Assertions separate a self-contained interpretation
from exact source spans. A unique exact quote is converted to UTF-16 offsets by
code; invented/ambiguous quotations are rejected. Scope and actor checks are
independent of model confidence. Context spans can identify an object without
making their speaker the approving actor. An explicit transport reply takes
precedence. With v2 active and no resolved reply, at most three exact-scope
candidates admitted before the current request and within two hours are copied
as bounded prefixes (2,048 code points per role, 16 KiB total). They are historical
context, not a reply relation or a fresh assertion. `episodeContextRef` spans must
be context-only and cite a pinned message digest. Conflicting candidates stay
ambiguous. The completed source seals that snapshot; recovery does not rescan
newer messages. Missing, expired or corrupt candidates cannot block capture.

The contextual request uses the same configured model with explicit `thinking: medium`,
bound into its request and evaluation-policy digests. Legacy v1 requests retain
their existing thinking default. Provider resolution is checked; missing usage
or cost telemetry is not fabricated.

Statuses are `proposed`, `requested`, `decided`, `reported_done`, `accepted`,
`failed`, `unknown`. An agent's completion report is not independently verified.
A missing referent stays explicit; adjacent conversation alone is not authority.
Known embedded documents cannot establish direct user approval.

Canonical `engram.memory-batch-observation.v2` preserves v1 envelope/provenance
fields, adding `context` (subject, resolution, status, spans, chronology). Source
message time, source completion time and observation time are separate. Unknown
source message time is not invented. Both daily and domain text expose status,
subject and quotes for retrieval. The old v1 validator and renderer remain strict.

Each source disposition (`asserted`, `supports`, `duplicate`, `skip`, `unresolved`)
has a reason and exact assertion links. Unresolved is a visible debt, not a
successful semantic skip. The one-pass v2 producer does not repeatedly defer
unchanged evidence: established facts are written; unresolved input is retained
in terminal accounting for explicit later recovery. Universal episode joining
and historical re-evaluation are separate work.

## Delivered finals

The optional plugin setting `completionMirrorCapture` defaults to false. When
true, a tool-bearing turn without an explicit final waits on a durable exact
source identity. The supported `session-transcript-runtime` SDK supplies visible
transcript deltas; only host delivery mirrors with a final source-reply marker
qualify. Tool arguments, timestamp proximity, and the last assistant message do
not establish delivery. A per-session cursor and matched final are persisted
before admission. Consumers survive restart and validate the current branch
anchor before admitting. Branch reset discards old matches and replays the new
host-provided initial cursor; scope mismatch is blocked.

Reads are bounded to two 4 MB pages per wake. Over-budget entries and ambiguous
finals remain visible failures. Missing finals wait 25 minutes; an already found
but unvalidated match has at most twice that budget. The source can then be
admitted without an invented outcome, with a separate unresolved-final receipt.
Later historical recovery must use exact source identity; no TTL extension or
silent mutation of already admitted evidence is performed.

## Transition and producer rollback

`quality-rollout.json` is a private, digest-checked sidecar under the existing
memory-observation state root. It binds the workspace, exact scopes, installed
plugin digest, base evaluation policy, source policy and original `applyAfter`.
It records a read-only transition inventory digest. Do not publish deployment
values. `qualityTransitionInventory` enumerates unfinished evaluator rows,
immutable jobs, consumer rows and unconsumed observations without mutating them.

`mode: active` selects v2 for new work in the exact allowlist. Existing v1 jobs
finish under v1. The contextual policy digest includes the original policy and
prompt version. Both producer digests remain readable by the same consumer.
Unknown pending policies block only that scope's evaluation, not its writer.

`mode: drain` is a producer-only rollback: new work uses v1; an existing cached v2
result can finish, but a v2 job needing a new model call stays queued. Removing the
sidecar or reverting to a pre-dual-reader binary is NOT a supported rollback.
Neither mode advances `applyAfter`, relabels old observations, resets attempts,
or clears historical failures. Source queues needed by unconsumed v2 effects are
retained during ordinary sidecar retention.

## Release gates

Unit tests establish identity, crash recovery, idempotency and compatibility—not
semantic truth. Use the synthetic tuning/held-out episodes under
`tests/fixtures/memory-observation/contextual/` and a private real-episode replay.
Review negation, object, actor, status, source coverage and meaningful omissions.
Schema acceptance alone is insufficient. Runtime activation also requires an
exact final -> source admission -> canonical receipt/read-back -> explicit QMD
retrieval check, plus delivery ordering and restart checks on the supported SDK.
Do not report live readiness from cron `ok` or a successful empty run.
