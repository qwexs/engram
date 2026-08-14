# OLL Memory Candidate Compiler — implementation specification

> **Status:** Phase 0A/0B contracts, Phase 1 report-only compiler, Phase 2 inert
> shadow integration, the isolated Phase 3 candidate store, the isolated
> Phase 4 review-only runtime, and Phase 5 guarded rollout/rollback tooling are
> implemented. Synthetic per-phase rollback evidence is green. A repaired real
> `main` shadow canary is active. Its post-repair daily-mode execution on
> 2026-08-14 admitted four canonical daily candidates (one decision and three
> learnings), while producing zero actual dispatch, review, or action effects.
> The earlier zero-candidate cycle exposed a producer/parser/policy mismatch
> and does not count toward the observation window. Completion of the
> seven-daily-plus-one-weekly observation window and any later materialize
> activation remain separately gated.
> **Baseline:** Engram `c134c7f8b45c56fd753541ca2acf2aba0c2c615c` plus the local, uncommitted OLL candidate-compiler worktree reviewed on 2026-08-14.
> **Decision boundary:** Phase 1 through Phase 5 tooling was explicitly
> authorized on 2026-08-14. Tooling completion does not itself authorize a
> workspace/config mutation, real canary activation, or production rollout.

## 1. Goal

Add durable memory evidence to nightly OLL without turning memory into an
automatic rule-writing channel. The compiler must deterministically discover,
admit, normalize, rank, bound, persist, and disposition evidence before any
model sees it.

The target flow is:

```text
allowlisted sources
  -> side-effect-free stable read, parsing, and admission attempt
  -> provenance normalization and semantic clustering
  -> decay/access-informed ranking
  -> immutable compiler report
  -> mode gate
       disabled:     legacy nightly path only
       report-only:  return report, write nothing
       shadow:       persist report/metrics only
       materialize:  candidate ledger -> v3 handoff -> mandatory review
  -> recoverable applicator journal
  -> terminal candidate disposition
```

KG access/decay is an upstream advisory input only:

```text
trusted retrieval receipts -> access-state reconciliation -> decay projection
                                                     |
                                                     v
                                      compiler ranking snapshot
```

Compiler reads must never create access receipts or update decay state.

## 2. Non-goals

- No automatic KG write, external action, rule activation, supersession, or
  suspension from a memory candidate.
- No import of legacy `observations`, `tensions`, rethink runs, or handoffs.
- No semantic inference by an LLM during source admission, identity creation,
  ranking, or recovery.
- No protocol migration for workspaces where the candidate compiler is
  disabled.
- No replacement of the existing KG access/decay subsystem.
- No production activation as part of implementing these contracts.

## 3. Frozen evidence baseline

The reviewed worktree already contains useful primitives: bounded source
quotas, byte budgets, deterministic candidate IDs, a rolling candidate store,
handoff v3 parsing, exact disposition coverage, proposal-only candidate
actions, mandatory review, and replay journals.

The current implementation is not rollout-ready because the review confirmed:

1. `shadow` candidates enter actionable context but are not materialized, so a
   normal behavioral rethink can fail while applying dispositions after earlier
   actions have already produced effects.
2. Canonical domain decision and proposal templates are not parsed by the
   implemented parsers.
3. `disabled` still switches new nightly batches to context v2 and handoff v3.
4. Resume from `compiling` recompiles mutable sources instead of reading a
   verified persisted report.
5. A candidate consumed into a later rejected or expired human review is not
   returned to a defined non-terminal state.
6. Source ACLs, KG scope mapping, symlink isolation, and sensitive-text
   filtering are incomplete.
7. Materialization does not fully validate report, candidate identity, content,
   or an existing operation payload.
8. `forwardOnlySince` is applied at day precision rather than timestamp
   precision.
9. Decay is recorded but does not lower admission or ranking for cold KG facts;
   stored pending rankings can become stale; duplicate boosts can count multiple
   projections of one provenance root as independent evidence.

Relevant targeted tests currently pass (33/33), but they primarily prove the
existing implementation and do not close these target contracts.

Legacy state has a clean boundary: the three former pending observations are
archived as historical records; pending legacy observations and tensions are
zero. They are not candidate-compiler inputs.

## 4. Ownership and authoritative state

### 4.1 Owners

- The nightly coordinator owns batch ordering, phase transitions, frozen time,
  and selection of the protocol path.
- The compiler owns source parsing, admission, provenance normalization,
  ranking, and the immutable compiler report.
- The candidate store owns candidate lifecycle revisions and is the only writer
  of candidate projections and reservation overlays.
- The handoff applicator owns validation and the recoverable application
  journal. No other component may apply candidate-derived actions.
- `CandidateReviewReconciler` is the only consumer of authorized asynchronous
  review outcomes and the only component allowed to continue candidates from
  `review_pending`.
- The existing KG reconciliation path remains the only writer of access state.

### 4.2 Single-writer rule

Candidate state may be changed only through candidate-store operations. Direct
projection edits and secondary lifecycle writers are unsupported. Correctness
does not depend on a removable timeout lock: the authoritative store is an
append-only, revision-numbered event journal. A transition from revision `N`
is first written completely to a unique same-filesystem temporary file opened
with `O_CREAT|O_EXCL`, then file-fsynced. It is published to the canonical
revision `N+1` path with an atomic no-replace primitive (`link` or
`renameat2(RENAME_NOREPLACE)`), followed by parent-directory fsync. Unsupported
filesystems fail closed; replace-style rename is not a fallback. Orphan temp
files are ignored and garbage-collected only after recovery proves that they
are not canonical. The canonical revision path is therefore never partially
visible, exactly one competing writer wins publication, and replay verifies a
byte-equivalent event payload.

Projection files are non-authoritative caches. Every read verifies their
revision/digest against the highest contiguous valid journal revision and
rebuilds a missing, stale, or overwritten projection before use. A stale process
may at worst write an invalid cache that readers reject; it cannot replace a
committed journal revision. Workspace locks may reduce contention, but are not a
safety boundary. Multi-candidate reservation uses a sorted plan, revision CAS
per cluster, and a WAL; partial reservation before any effect is released by
that same plan, while a conflict after an effect is quarantined.

## 5. Mode contract

The deployment mode is part of policy and is evaluated before protocol
selection.

| Mode | Compiler | Durable writes | Nightly context | Handoff | Model/action effect |
|---|---|---|---|---|---|
| `disabled` | Not invoked | None | Existing legacy schema/path | Existing v2 path | None from candidates |
| `report-only` | Invoked by explicit CLI | None | Not built | None | None |
| `shadow` | Invoked by coordinator | Immutable report and metrics only | Candidate-free legacy context; report summary may be operational metadata outside the model payload | Existing v2 path | None |
| `materialize` | Invoked by coordinator | Report, operations, candidate ledger | v2 context containing materialized pending candidates | v3 | Proposal-only, mandatory review |

Normative invariants:

1. Installing code with no `candidateCompiler` config is behaviorally and
   protocol compatible with the pre-compiler nightly path.
2. `shadow` never places candidate IDs, statements, revisions, or dispositions
   in model/actionable context and never invokes candidate-store transitions.
3. A behavioral signal may still trigger normal rethink in `shadow`, but that
   rethink uses the legacy context and handoff contracts.
4. A shadow compiler/report error is recorded as a bounded content-free
   diagnostic and does not fail or delay the ordinary legacy rethink. An
   invalid or partial shadow report is never published.
5. Mode and policy digest are frozen when a workspace batch is created.
6. Only `materialize` may create or mutate candidate ledger entries.
7. Active rule adaptation remains a separate deployment decision; materialized
   candidate proposals remain review-only in every rollout stage.

## 6. Policy and source registry

Replace broad source booleans with exact, versioned allowlists.

```ts
type Scope =
  | { level: "self"; subject: string }
  | { level: "domain"; subject: string }
  | { level: "workspace"; subject: string };

interface CandidateLimits {
  maxCandidatesPerRun: number;
  maxContextBytes: number;
  maxOccurrencesPerCluster: number;
  sourceQuotas: Record<SourceClass, number>;
}

interface CandidateDecayPolicy {
  schema: "oll.memory-candidate-decay-policy.v1";
  hotDays: 7;
  warmDays: 30;
  accessCountCap: 10;
  warmScorePenalty: number;
  coldKgContribution: "provenance-only";
  trustedAccessEventSchema: "engram.kg-v3-access-event.v1";
}

interface CandidateSourcePolicyV2 {
  schema: "oll.memory-candidate-policy.v2";
  mode: "disabled" | "shadow" | "materialize";
  forwardOnlySince: string; // exact ISO instant
  daily: Array<{
    session: string;
    sections: Array<"decisions" | "learnings" | "retrieval-cards">;
    scopeCeiling: Scope;
  }>;
  domains: Array<{
    domainId: string;
    formats: Array<"canonical-decisions-v1" | "canonical-proposals-v1">;
    scopeCeiling: { level: "domain"; subject: string };
  }>;
  kg: Array<{
    entityPrefix: string;
    kinds: Array<"decision" | "preference" | "constraint">;
    admittedScopes: string[];
    scopeMapping: Record<string, Scope>;
  }>;
  limits: CandidateLimits;
  decayPolicy: CandidateDecayPolicy;
  sensitiveTextPolicyVersion: string;
}
```

Unknown fields, source types, formats, kinds, scope mappings, or policy
versions fail closed. `forwardOnlySince <= observedAt <= snapshotAt` uses exact
parsed instants.

Source authority is not created by this policy. The compiler first derives an
authoritative scope from the trusted workspace/session/domain/KG registry. A
policy entry may only narrow that scope. The labels
`self <= domain <= workspace` are not sufficient by themselves: a signed/trusted
registry revision must contain the concrete containment edges proving that the
named self belongs to the named domain and that the domain belongs to the named
workspace. Same-level subjects are comparable only when identical. Missing or
changed containment makes scopes incomparable. The effective scope of a cluster
is the greatest safe intersection of all cited occurrence scopes. Incomparable
scopes produce separate clusters; if a safe split is impossible, admission
fails closed. KG entity matchers are anchored namespace patterns, not string
prefix tests.

Review authorization uses the existing trusted actor/grant registry. The review
request freezes required action/grant, effective scope, registry digest/revision,
and expected review revision. It freezes an actor only when the operator has
explicitly assigned a reviewer. The outcome records the actual actor ID and
grant digest and revalidates current authority for the frozen scope; the callback
must match the expected review revision.

### 6.1 Workspace isolation

For every filesystem source:

1. Validate the lexical relative path.
2. Walk components with `lstat`; reject symlinks and non-regular final files.
3. Resolve the canonical root and file with `realpath`; require the file to be
   below the canonical allowed root.
4. Open without following a replaced symlink where the platform supports it.
5. Compare device, inode, size, and modification time before and after read.
6. Record a digest of the exact bytes admitted.

Unstable or escaping sources are rejected with reason codes, not skipped
silently.

### 6.2 Canonical parsers

- Daily notes: only the canonical `Decisions` and `Learnings` sections and
  explicit retrieval-card schema.
- Domain decisions: parse the heading/field structure shipped in
  `templates/domain/decisions.md` and
  `templates/domain/topic-thread/decisions.md`.
- Domain proposals: parse the canonical `## <date> — PROPOSAL` block and its
  `**Proposal**` field documented in `references/subagent-memory.md`.
- KG: only active KG v3 assertions matching an exact entity/kind/scope mapping.

Tests must use copies of the production templates as fixtures. Synthetic-only
formats are insufficient.

### 6.3 Timestamp contract

All new canonical source records carry RFC3339 timestamps with an explicit
offset. Workspace policy names one IANA timezone for parsing versioned legacy
date-only formats. A date-only decision maps to local `00:00:00` at that date;
an offset-free local proposal time is accepted only by an explicitly enabled
legacy parser version and is resolved in the workspace timezone, including a
declared daylight-saving ambiguity rule. Otherwise ambiguous timestamps fail
closed. No parser may invent noon UTC. Every report records original timestamp,
normalized UTC instant, timezone, and parser version.

### 6.4 Sensitive-text admission

Admission uses a versioned, fail-closed policy shared with repository privacy
checks where possible. It must detect at least labeled and unlabeled credential
patterns, bearer credentials, PEM blocks, provider-token formats, private keys,
private paths, and configured PII patterns. Rejection records only a reason code
and digest-safe metadata; rejected raw text must not be persisted in reports or
logs. The source class may impose a stricter maximum length or character set.

## 7. Evidence, cluster identity, and provenance

The compiler separates immutable evidence from the candidate shown to the
model:

```ts
interface EvidenceOccurrenceV1 {
  schema: "oll.memory-evidence-occurrence.v1";
  occurrenceId: Digest;
  workspaceId: string;
  sourceClass: SourceClass;
  sourceRef: string;             // opaque or workspace-relative only
  sourceVersionDigest: Digest;
  contentDigest: Digest;
  provenanceRootId: Digest | null;
  semanticKey: Digest;
  authoritativeScope: Scope;
  effectiveScope: Scope;
  observedAt: string;
  canonicalStatement: string;
}

interface CandidateClusterV1 {
  schema: "oll.memory-candidate-cluster.v1";
  candidateId: Digest;
  workspaceId: string;
  evaluationEpoch: number;
  semanticKey: Digest;
  effectiveScope: Scope;
  canonicalStatement: string;
  occurrenceIds: Digest[];
  distinctProvenanceRootIds: Digest[];
  evidenceSetDigest: Digest;
  ranking: RankingSnapshot;
  lifecycle: CandidateLifecycle;
}
```

- `occurrenceId` identifies one admitted structured occurrence in one immutable
  source version.
- `provenanceRootId` identifies the originating user decision/event/fact when
  lineage is known.
- `semanticKey` is the versioned normalized meaning cluster.
- `candidateId = hash(schema + workspaceId + normalizerVersion + semanticKey +
  effectiveScope)` identifies one cluster, not one source copy.

The compiler emits exactly one cluster per candidate identity into context.
Occurrences are ordered by `observedAt`, then `occurrenceId`. The canonical
statement is chosen deterministically from the narrowest-scope occurrence, then
the newest occurrence, then lowest `occurrenceId`; it is never model-generated.

New occurrences join a cluster through append-only set union under expected
cluster revision. Existing occurrence IDs must be byte-equivalent; new IDs are
added in canonical order and produce a new `evidenceSetDigest` and cluster
revision. Replay of the same set is a verified no-op. Repetition score counts
distinct non-null `provenanceRootId` values only. A daily decision, its retrieval
card, and a KG assertion derived from that decision therefore occupy one cluster,
one context slot, and at most one proposal/review. Unknown-lineage occurrences
do not count as independent corroboration.

Set-union is allowed only while the cluster is `pending` or `deferred` and not
reserved by a plan. Evidence arriving while `reserved`, `review_pending`, or in
a terminal state is written to a separate append-only pending-evidence inbox;
it cannot change the evidence set, revision, statement, or scope cited by an
existing review. After the owning outcome is terminal, a later nightly batch may
merge the inbox under CAS and increment an `evaluationEpoch` only when the inbox
contains a new distinct provenance root and a versioned reopen policy admits it.
Otherwise the inbox is deduplicated/audited without reopening. Prior review and
operation correlations remain bound to their original epoch and evidence digest.

Aggregation is deterministic: start from the highest eligible base score among
occurrences, add bounded recency and distinct-root boosts once per cluster,
apply decay penalties per Section 8, and clamp to `[0,100]`. Quotas are charged
once to the canonical occurrence's source class; per-source occurrence caps and
the total cluster byte budget prevent hidden source flooding.

Normalization rules, Unicode form, case folding, punctuation handling, scope
intersection, maximum statement length, ordering, aggregation weights, and
canonicalization are versioned and covered by golden fixtures.

## 8. Decay and access interaction

Decay influences priority, never authority or scope.

The compiler freezes:

- `snapshotAt`;
- KG assertion-set digest/revision;
- reconciled access-state revision and digest;
- decay-policy version.

It then ranks each KG assertion from this snapshot:

| KG state | Default treatment |
|---|---|
| active `constraint` | Eligible if scope-mapped; decay may lower priority but cannot remove enforcement from KG itself |
| hot `decision`/`preference` | Eligible normally |
| warm `decision`/`preference` | Eligible with a documented score penalty |
| cold `decision`/`preference` | Provenance-only: contributes no eligibility, score, or repetition boost; another eligible independent root may still make the cluster eligible |
| superseded/retracted/invalid | Ineligible |

Exact weights and thresholds live in the frozen policy and are emitted as reason
codes. The initial defaults follow the native KG projection: hot through seven
days, warm through thirty days, an access-count cap of ten, and cold as above.
Only schema-valid, reconciled `engram.kg-v3-access-event.v1` events created by
the trusted retrieval boundary count. Their session must be admitted by the
authoritative registry. Compiler reads, model-context construction, report
inspection, and OLL review do not create access receipts. Thus OLL cannot make
its own evidence hotter.

Pending clusters keep their original evidence ranking for audit. Selection in a
batch creates a deterministic `selectionAssessment` using only that batch's
report-frozen assertion/access snapshot and policy:

```text
assessmentId = hash(candidateId + candidateRevision + lifecycleInputsDigest
                    + accessStateRevision + decayPolicyDigest + batchId)
```

It reapplies lifecycle/source validity, cluster and source quotas, ranking, and
byte limits, then selects, defers, or invalidates the cluster. Replay of the same
assessment is a verified no-op and does not increment revisions. A new access
state may be considered only by a new nightly batch; it cannot change an
in-flight batch. `deferred -> pending` occurs only when a later, different
assessment admits the cluster.

Frozen and live inputs have different authority. Content, ranking, access,
corroboration, quota, and positive admission use only the report-frozen snapshot.
Immediately before context construction, the selector revalidates current
lifecycle and authorization for every source class. This live check may only
narrow scope, remove an occurrence, defer, invalidate, or reject; it can never
add evidence, broaden scope, increase score, or make an ineligible cluster
eligible.

A KG assertion must remain active; a daily/domain/session source must remain
authorized by the current trusted registry and policy. Revocation,
supersession, retraction, scope drift, or parser-policy withdrawal removes that
occurrence. A cluster with no eligible occurrence transitions to `invalidated`;
an unchanged effective scope may retain a reduced eligible evidence set under
CAS before selection. Because effective scope is part of `candidateId`, any
scope narrowing invalidates the old cluster identity. The current batch does not
substitute a new candidate; a later batch may materialize a new cluster with the
narrower scope and therefore a new `candidateId`.
The applicator repeats the same fail-closed live authorization/lifecycle check
immediately before the first effect commit. Drift after reservation may only
cancel before effects or quarantine after an effect; it never widens the frozen
plan.

## 9. Compilation attempt and immutable report

Compilation before report publication is side-effect-free. No durable raw
source snapshot is created, because it could retain content that has not passed
privacy admission. The coordinator durably records a content-free attempt
envelope containing `compilationAttemptId`, batch/workspace identity,
`snapshotAt`, mode/policy digest, KG assertion digest/revision, access-state
digest/revision, and status. The sources and their raw content are not stored in
the envelope. Stable-read checks reject concurrent file changes.

The first candidate-specific durable artifact is one atomically published,
verified report containing only admitted normalized occurrences and content-free
rejection metadata. A crash before atomic publication abandons that attempt; the
next invocation creates a new attempt ID and snapshot. Because no candidate,
operation, context, dispatch, or model effect exists before report publication,
abandoning the attempt is safe and is not treated as replay of the old attempt.
Recovery can identify the durable envelope and transition it to `abandoned`.
A crash during atomic rename either leaves no report or a complete report.

The report schema must contain:

- policy digest and compiler/normalizer/parser versions;
- exact snapshot time;
- admitted normalized occurrences with opaque/workspace-relative source refs,
  stable source version digest, authoritative/effective scope, and parser;
- KG assertion-set and access-state revisions/digests;
- considered/eligible/selected/rejected counts and reason codes;
- bounded selected candidates;
- projected context bytes, model spawns, and review backlog;
- digest over canonical report content excluding only `reportDigest`.

Raw rejected content and absolute/private source paths are excluded. Report
creation is write-once for a compilation attempt and workspace. Any existing
artifact is read, schema-validated, digest-validated, and correlated to the
batch/attempt; it is never regenerated from current sources. After publication,
all compilation, materialization, selection, context construction, and recovery
use the report's normalized occurrences and frozen revisions for every positive
decision. The only live exception is the fail-closed lifecycle/authorization
narrowing defined in Section 8 and repeated before effect commit.

`report-only` returns the same report in memory/stdout without writing report,
candidate, operation, lock, or coordinator state.

## 10. Candidate ledger and lifecycle

Required states:

```text
pending
  -> deferred            (not selected, model deferred, policy/review retry)
  -> reserved            (one non-terminal apply plan owns the cluster)
  -> dismissed           (explicit ignore or terminal rejection policy)
  -> invalidated         (source/scope/lifecycle no longer valid)

deferred -> pending      (a new deterministic assessment admits retry)
reserved -> review_pending   (proposal and mandatory review durably created)
reserved -> pending          (plan cancelled before any effect)
review_pending -> evaluated  (authorized review accepted; rule remains proposed)
review_pending -> deferred   (review rejected/expired when policy permits retry)
review_pending -> dismissed  (review rejected/expired under terminal policy)
```

Every transition declares allowed source state, expected revision, terminality,
reason code, correlation IDs, reservation owner, and idempotent replay result.
Unknown transitions fail closed. A `consumed` handoff disposition is not
equivalent to successful human review; after plan validation it authorizes
reservation by one apply operation. The later review outcome completes the
lifecycle.

A reserved cluster is excluded from every selector while its apply plan is
non-terminal. Quarantine retains the reservation until explicit operator
resolution, preventing a second proposal/review. Whole-handoff validation
failure before plan intent creates no reservation and changes no lifecycle.

Candidate records retain evidence identity and original ranking. Assessments,
handoff disposition, review outcome, and invalidation are append-only operation
events projected into current lifecycle state.

### 10.1 Asynchronous review continuation

Each candidate-derived review stores immutable `operationId`, `actionId`,
`ruleId`, exact candidate IDs and reserved revisions, effective scope, actor
requirement and registry digest/revision, any explicit reviewer assignment, and
expected review revision. The outcome records the actual actor and grant digest.
`CandidateReviewReconciler` accepts only an authorized canonical review outcome,
revalidates current actor authority, writes an append-only outcome event, and
CAS-transitions every cited cluster:

- approved -> `evaluated`; the rule remains `proposed`, and activation is a
  separate explicitly authorized action;
- rejected/expired with retryable reason -> `deferred`;
- rejected/expired with terminal reason -> `dismissed`.

The retryable/terminal reason table is a versioned policy. An identical duplicate
outcome is a verified no-op. A changed, stale, unauthorized, or out-of-order
outcome is quarantined. Multi-candidate review transitions use one journaled
plan: recovery finishes the same outcome for all candidates or retains their
ownership hold; it never starts a different proposal. Policy rejection before
review creation releases reservations to `deferred` or `dismissed` according to
the same reason table.

## 11. Validation before materialization

Before any candidate write, materialization must:

1. Validate report schema, workspace, mode, compiler version, policy digest,
   frozen revisions, counts, byte budget, and `reportDigest`.
2. Recompute every occurrence identity/content digest, cluster semantic key,
   effective scope, provenance-root set, candidate ID, evidence-set digest,
   canonical statement, ranking, ordering, and serialized byte count.
3. Enforce exact scope mapping and source allowlist again.
4. Validate lifecycle initialization and reject terminal/pre-mutated candidates.
5. Derive the operation identity from report digest, candidate ID,
   evidence-set digest, and target workspace.
6. If an operation or occurrence already exists, require canonical payload
   equality. For an existing cluster, require equality of immutable identity
   core (`schema`, workspace, normalizer version, semantic key, effective scope,
   and candidate ID). Legitimate new occurrences expand the evidence set only
   through a journaled CAS set-union at the expected cluster revision. A changed
   immutable core, changed payload for an existing occurrence ID, non-monotonic
   evidence removal, or mismatched operation intent is a hard conflict.

Materialization first records the full immutable operation intent, then appends
the occurrence/cluster revision event, rebuilds the verified projection, and
marks the operation committed. Recovery completes or
verifies that exact intent; it never substitutes new report content.

## 12. Handoff v3 and applicator recovery

Handoff v3 is used only for `materialize`. It carries the exact immutable
candidate and signal revision maps from context. Every included source receives
exactly one disposition. Candidate-derived actions are limited to
`propose_rule`, must cite their candidate IDs, must remain within every cited
authoritative/effective scope (`actionScope <= each cited scope` in the lattice),
and always create mandatory review. Incomparable scopes cannot share an action.

The applicator uses a write-ahead journal:

1. Validate the entire handoff and derive a canonical apply plan.
2. Record immutable plan intent and per-effect identities.
3. CAS-reserve every cited candidate cluster under that plan before any effect.
4. Create/replay rule proposal and review effects idempotently.
5. Record each effect as committed and transition reservations to
   `review_pending`.
6. Apply signal dispositions and non-proposal candidate dispositions using
   expected revisions.
7. Record the operation terminal only when every effect and transition is
   verified.

No unjournaled effect is permitted. On crash, replay starts from the persisted
plan and verifies existing payloads before continuing. It does not reparse a
new handoff or regenerate a new plan. If a conflict is detected after a partial
effect, the batch is quarantined for operator review rather than applying a
different payload. Reservations owned by a non-terminal or quarantined plan are
not selectable by another batch. Each projection write verifies the persistent
revision journal described in Section 4.2; projection cache state is never used
as transition authority.

## 13. Coordinator phases and resume contract

Candidate-aware phases are:

```text
reconciling
  -> compilation_attempt
  -> report_persisted
  -> materializing       (materialize only)
  -> candidate_preflight
  -> dispatching
  -> awaiting_handoff
  -> validating
  -> applying
  -> completed | skipped | failed | quarantined | cancelled
```

Phase invariants:

- The coordinator freezes mode and policy digest once per workspace batch.
- Each pre-report `compilation_attempt` freezes its own `snapshotAt`, assertion
  revision, and access revision but persists no source content or candidate
  effect.
- If recovery finds an attempt without a complete verified report, it marks the
  attempt abandoned and starts a new attempt identity. It never claims replay of
  the abandoned snapshot.
- Resume at or after `report_persisted` reads the verified report.
- Resume at or after `materializing` reads and verifies operation intents and
  candidate projections.
- Resume at or after `dispatching` uses the frozen context digest and handoff
  correlation.
- Source, access, or decay changes after report publication do not change that
  attempt or any downstream batch effect. A later nightly batch may create a new
  assessment from its newly frozen report/access revision.
- Exactly one workspace is active in the FIFO coordinator at a time; the
  workspace candidate store separately enforces its fenced writer.

Each durable phase has a fault-injection test immediately before and after its
write. Compilation tests additionally crash before atomic report publication,
during rename, and after publication but before the coordinator phase update.

## 14. Compatibility and migration

1. Land schemas, fixtures, validators, and tests before coordinator changes.
2. Preserve the existing disabled context/handoff path byte-for-byte where
   practical and semantically exactly otherwise.
3. Do not import historical observations, tensions, rethink runs, or handoffs.
   Archived legacy observations remain readable history only.
4. Existing candidate artifacts from experimental code are not assumed valid.
   A preflight inventory must either prove them absent or quarantine them; no
   automatic conversion is allowed without a separately reviewed migration.
5. A code rollback must understand and ignore newer candidate artifacts without
   deleting them.
6. Candidate reports, ledgers, reservations, and journals live under an isolated
   versioned root not scanned by legacy readers. Binary rollback requires either
   a tested compatibility reader for every in-flight phase or a zero-in-flight
   cutover barrier.

## 15. Observability

Every report and terminal batch summary exposes bounded, content-free metrics:

- counts by source class, domain/session allowlist entry, decay tier, and reason;
- selected count/bytes and quota utilization;
- distinct provenance roots versus raw occurrences;
- pending/deferred/review-pending/invalidated backlog and age;
- projected and actual model spawns and reviews;
- replay counts, payload conflicts, quarantines, and stale-lock recoveries;
- source/access snapshot revisions and policy/compiler versions.

No metric, log, or error includes raw rejected evidence or credential-like text.

## 16. Implementation phases

### Phase 0A — close architecture decisions

Scope: compilation-attempt abandonment, occurrence/cluster model, scope lattice,
timestamp parser rules, decay assessment fingerprint, review-outcome ownership,
candidate reservation, append-only revision CAS, and in-flight rollback barrier.

Gate: every decision is normative in this document and has no unresolved High
finding in independent read-only review; no code/config/runtime changes.

### Phase 0B — executable contracts

Scope: complete JSON/TypeScript schemas for policy, occurrence, cluster, report,
assessment, operation, apply plan, reservation, review outcome, and projection;
reason-code registry; canonical source fixtures; lifecycle transition table;
scope/decay matrices; canonicalization and golden digests.

Gate: all known review blockers map to a normative clause and a failing test;
no coordinator or runtime behavior changes.

### Phase 1 — compiler and report-only CLI

Scope: exact allowlists, authoritative scope registry, canonical parsers,
filesystem isolation, privacy admission, occurrences/clusters, exact timestamp
boundary, decay snapshot, verified report, and projected-load metrics.

Gate: CLI performs zero writes; deterministic golden reports match across
replays; forged inputs and path/privacy bypasses fail closed.

### Phase 2 — inert shadow integration

Scope: coordinator compilation-attempt/report phases, failure isolation, and
operational metrics only.

Gate: shadow plus an ordinary behavioral signal follows the legacy model path;
there are no candidate IDs in context, no candidate transitions, no extra model
spawn, and no review/action effect.

### Phase 3 — candidate store and materialization

Scope: append-only revision-CAS store, validated operation intents, lifecycle projections,
selection assessments, all-source lifecycle/scope revalidation, reservation
overlay, and crash recovery. No model integration.

Gate: replay and source/access drift cannot change a persisted batch; forged
reports and existing-operation payload mismatches are quarantined.

### Phase 4 — handoff v3 review-only canary

Scope: candidate context, exact dispositions, whole-plan WAL, reservation before
effects, proposal/review exactly-once ownership, and the single review-outcome
reconciler.

Gate: candidate evidence cannot auto-apply; every effect and lifecycle outcome
is recoverable and exactly-once by payload; rejection/expiry follows the
declared lifecycle.

### Phase 5 — rollout evidence, not automatic activation

Scope: one explicitly approved canary in `shadow`, then separately approved
`materialize` review-only mode.

Gate: see Section 18. Active adaptation requires another explicit decision.

Implemented tooling produces a deterministic read-only plan, requires exact
evidence bytes plus an explicit apply/rollback acknowledgement, writes a local
rollout projection before exposing the config mode, and verifies config and
projection by read-back. Rollback disables new batches first, cancels
pre-effect plans, quarantines partial effects without releasing ownership,
retains pending reviews under their exact plan, and reports a separate binary
rollback barrier. Synthetic evidence is not real canary evidence.

## 17. Required verification matrix

At minimum, tests cover:

- missing config and explicit `disabled` preserve legacy context/handoff;
- `shadow` with and without behavioral signals produces no candidate action;
- shadow compiler/report failure cannot block ordinary legacy rethink;
- exact ISO boundary including same-day before/after values, IANA timezone,
  daylight-saving ambiguity, and rejection of unversioned local timestamps;
- canonical daily, retrieval, domain decision, domain proposal, and KG fixtures;
- unknown format/schema/kind/scope rejection;
- lexical escape, symlink escape, replacement race, non-regular files;
- credential, bearer, PEM, provider token, private path, and configured PII
  bypass attempts without raw-content leakage;
- cross-layer duplicates sharing a provenance root form one cluster/context
  slot/proposal and do not inflate repetition;
- scope narrowing invalidates the old identity and can only create a new
  candidate in a later batch;
- evidence arriving during reservation/review is inboxed and cannot mutate the
  reviewed epoch; reopen requires a new provenance root and policy admission;
- hot/warm/cold policy, access cap, no access receipt from compiler reads;
- KG supersession/retraction between materialization and selection;
- report digest, candidate ID/content/semantic identity, byte count, and existing
  operation payload forgery;
- crash before/during/after atomic report publication, followed by abandoned
  attempt or verified report recovery;
- crash/replay around report persistence, each candidate write,
  model dispatch acknowledgement, rule/review creation, dispositions, and
  terminal journal commit;
- reservation before effect, exclusion from concurrent selection, and
  quarantine ownership hold;
- authorized review approval/rejection/expiry, stale revision, duplicate,
  conflicting, and out-of-order callback;
- exclusive-create revision CAS, competing writers, stale owner/cache rebuild,
  crash before/after atomic no-replace publication, orphan temp handling,
  partial multi-candidate reservation, and FIFO continuation;
- source drift and access-state drift after report persistence;
- quotas, total byte budget, projected spawns/reviews, starvation metrics;
- policy/scope revocation for every source class;
- rollback to disabled before dispatch, after v3 acknowledgement, after handoff,
  during partial apply, and with review pending; binary rollback barrier and
  retained audit artifacts.

Run targeted suites, full `bun test`, `tsc --noEmit`, privacy lint, and the
deployment read-only status checks before each rollout gate. Legacy green tests
are evidence of compatibility, not evidence that new contracts are complete.

## 18. Rollout, stop, and rollback gates

### Shadow entry

- all Phase 0A–2 tests green;
- exact source allowlist and forward boundary reviewed for the canary;
- baseline inventory has no unexplained source class or scope;
- report contains no raw rejected content;
- explicit operator approval.

### Materialize entry

- at least seven daily and one weekly shadow cycles;
- zero scope/privacy escapes, replay drift, payload conflicts, or unexpected
  model/review effects;
- deterministic report replay for every sampled cycle;
- bounded projected candidate, model-spawn, and review backlog;
- no material source starvation and no cross-layer duplicate inflation;
- crash/recovery and rollback drills passed;
- separate explicit operator approval.

### Stop conditions

Immediately stop advancement and return the canary to `disabled` on scope or
privacy leakage, digest/replay drift, unjournaled/partial effects, duplicate
reviews, source starvation, unexpected model spawns, unbounded backlog, or
candidate/decay feedback behavior.

### Rollback

Mode changes affect new batches only. When switching to `disabled`:

- a candidate attempt before model dispatch is cancelled without candidate
  effect;
- a v3 dispatch that has been acknowledged is drained or quarantined under its
  frozen v3 protocol and policy;
- a received handoff with no plan is validated or quarantined, never reinterpreted
  as v2;
- a persisted apply plan, partial effect, reservation, or pending review is
  completed/reconciled under that exact plan while new batches use legacy mode.

Set new batches to `disabled`, preserve reports, candidate ledger, reservations,
journals, and reviews for audit, and complete or quarantine acknowledged
operations according to persisted plans. Binary rollback is allowed only after
the read-only in-flight barrier reports zero unsupported candidate phases, or to
a binary with a tested compatibility reader for those phases. Rollback does not
delete evidence and does not silently revert in-flight ownership.

## 19. Blocker traceability

| Review finding | Normative contract | Required evidence |
|---|---|---|
| Shadow becomes actionable/fails on absent candidates | Sections 5, 16 Phase 2 | Shadow + behavioral-signal integration test |
| Canonical domain sources return zero | Section 6.2 | Production-template fixture tests |
| Disabled migrates protocol | Sections 5, 14 | Legacy context/handoff compatibility test |
| Compile recovery drifts | Sections 9, 13 | Pre-publication abandonment and post-report source/access drift tests |
| Review rejection/expiry strands consumed candidate | Sections 10.1, 12 | Authorized async outcome lifecycle/replay tests |
| Broad ACL/KG scope/symlink/privacy gaps | Sections 6.1–6.4 | Registry/lattice, path, race, and privacy adversarial tests |
| Forged report/operation accepted | Section 11 | Digest/identity/payload mismatch tests |
| Day-only cutover | Sections 6, 17 | Same-day exact timestamp tests |
| Cold KG evidence not actually deprioritized | Section 8 | Hot/warm/cold admission matrix tests |
| Cross-layer copies inflate repetition | Section 7 | Shared provenance-root test |
| Stored candidate outlives source validity | Sections 8, 10 | KG supersession/retraction test |
| Report-only misses operational load | Sections 9, 15 | Projected spawn/review metrics tests |
| Candidate copies consume multiple slots/reviews | Section 7 | One cluster/context/proposal per semantic scope test |
| Effects precede candidate ownership | Sections 10, 12 | Reservation-before-effect and concurrent-selector tests |
| Scope config can broaden authority | Sections 6, 12 | Authoritative registry and scope-lattice tests |
| In-flight decay revision changes selection | Sections 8, 13 | Frozen assessment and next-batch reassessment tests |
| Shadow errors block legacy nightly | Sections 5, 16 | Shadow fault-isolation tests |
| Rollback strands v3/partial operations | Sections 14, 18 | Per-phase cutover/drain/quarantine drill |
| Live scope narrowing mutates candidate identity | Sections 7, 8 | Invalidate-old/later-new-identity test |
| Crash leaves a truncated canonical revision | Section 4.2 | Temp fsync + atomic no-replace crash test |
| New evidence mutates an in-review cluster | Sections 7, 10 | Pending-evidence inbox/evaluation-epoch tests |

## 20. Definition of implementation-ready

The architecture decisions are closed through Phase 0B. Phase 1 implements the
side-effect-free compiler and explicit report-only CLI; Phase 2 integrates only
inert shadow reporting outside model context. Phase 3 implements the isolated
candidate store and materialization API without coordinator or model integration.

The accurate status is: **Phase 5 guarded rollout/rollback tooling implemented;
synthetic per-phase barrier drill passed; the repaired exact-policy,
exact-scope `main` shadow canary is active and its first valid daily-mode cycle
admitted four canonical candidates with zero actual downstream effects.** The
earlier zero-candidate cycle is invalid rollout evidence and does not count
toward the observation window. `materialize` remains blocked until at least
seven daily and one weekly clean shadow cycles plus separate approval. Active
adaptation remains out of scope.
