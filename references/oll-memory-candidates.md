# OLL memory candidate compiler

> **Status:** Phase 1 compiler, Phase 2 inert shadow integration, the isolated
> Phase 3 candidate store/materialization APIs, the Phase 4 runtime, and Phase
> 5 rollout/rollback tooling are implemented. In active adaptation mode the
> Phase 4 runtime now uses optimistic apply: a candidate-derived rule is made
> active immediately, a numbered post-factum notification is queued, and a
> reply can suspend selected items. The older review-only artifacts remain
> readable for recovery. The clean-install compiler default is `disabled`.

## Purpose

The nightly coordinator can consider durable memory evidence in addition to
explicit behavioral feedback. It does not feed raw memory to the model. A
deterministic compiler admits, ranks, bounds, and scopes candidates first.

## Positive admission contract

The first safe source set is deliberately narrow:

- `Decisions` and `Learnings` from exact, deployment-allowlisted daily sessions;
- explicit retrieval cards;
- domain `decisions.md` and explicitly marked `PROPOSAL` changelog entries;
- active KG v3 `decision`, `preference`, and `constraint` assertions.

Daily events, heartbeat reports, active-thread markers, archives, test or
incognito sessions, and unknown sessions are excluded. KG access and decay are
ranking metadata only; they are never standalone learning evidence.

Every source has a maximum scope. The applicator requires an exact match and
rejects scope broadening. Credential-like text is filtered before persistence.

## Separate evidence and behavior contracts

`oll.memory-evidence-occurrence.v1` is not an `oll.adaptation-signal.v1`.
Candidate IDs are deterministic per semantic scope cluster. The candidate store
remains isolated from the coordinator/model path: Phase 1 creates no candidate
state and Phase 2 never invokes the store.

`oll.rethink-handoff.v3` separates `sourceSignals` from `sourceCandidates`.
Memory evidence can only support `propose_rule`; the model cannot directly
activate, supersede, suspend, write KG, or perform an external action. In
active adaptation mode the deterministic applicator promotes the proposal to
an active, scoped rule and queues its rollback notification. In observe-only
mode the legacy proposal + review path remains available for compatibility.
Every candidate receives `consumed`, `ignored`, or `deferred`. A rejected
proposal is forced back to `deferred` rather than silently consuming evidence.

## Report-only bounds

The explicit CLI freezes one snapshot timestamp and returns a validated,
deterministic report in stdout. It creates no report, lock, candidate, operation,
or coordinator state. Source quotas, a candidate limit, and a byte budget
prevent noisy sources from starving rarer evidence.

## Inert shadow integration

When a frozen workspace config explicitly selects `shadow`, includes the
trusted scope registry, and has a matching read-back rollout projection, the
nightly coordinator persists only a compilation attempt, verified report, and
content-free metrics under its batch state root.
The model still receives the legacy `oll.nightly-context.v1`, produces the
legacy `oll.rethink-handoff.v2`, and cannot see candidate IDs or statements.
Compiler or shadow-artifact failure is diagnostic only and cannot block an
ordinary behavioral rethink. Missing or `disabled` config invokes no compiler
and creates no candidate artifacts.

## Materialize runtime

Phase 4 adds an explicit candidate context builder, a handoff-v3 applicator,
and the sole candidate-review reconciler. The nightly coordinator invokes this
path only for a frozen, projection-consistent `materialize` config: it persists
the compiler report and ledger, sends a bounded `oll.nightly-context.v2`, and
accepts only `oll.rethink-handoff.v3`. The applicator records a whole-plan WAL,
reserves the complete candidate set before publishing a proposal or review,
In active adaptation mode it writes the canonical rule under
`memory-state/oll/rules/<rule-uuid>.json` with status `active`, moves consumed
candidates directly from `reserved` to `evaluated`, and creates a durable
`oll.rule-activation-notification.v1` outbox record. The scheduler sends a
friendly numbered message to the exact source session and stores the returned
message ID. A rollback command resolves that message plus item numbers and
changes the corresponding rules to `suspended`; rules and audit history are
never deleted. Existing proposal/review WALs continue through the legacy
reconciler so interrupted older runs remain recoverable.

## Guarded rollout and rollback

Phase 5 adds `scripts/oll-memory-candidate-rollout.ts` with read-only `plan`,
`status`, and `barrier` commands plus acknowledgement-gated `apply` and
`rollback`. Evidence is byte-digest bound. An enabled config without a matching
local projection fails closed. Rollback retains reports, ledgers, plans,
reservations, reviews, and quarantine evidence.

```bash
bun scripts/oll-memory-candidate-rollout.ts plan \
  --request-file /private/reviewed-shadow-request.json

bun scripts/oll-memory-candidate-rollout.ts apply \
  --request-file /private/reviewed-shadow-request.json --ack-rollout

bun scripts/oll-memory-candidate-rollout.ts barrier \
  --request-file /private/reviewed-rollback-request.json

bun scripts/oll-memory-candidate-rollout.ts rollback \
  --request-file /private/reviewed-rollback-request.json --ack-rollback
```

The synthetic drill proves tooling behavior only. It does not count as one of
the required real shadow cycles.

## Rollout

1. Run report-only inventory with a deployment-specific policy:

   ```bash
   bun scripts/oll-memory-candidates.ts \
     --workspace /absolute/workspace \
     --policy-file /private/reviewed-policy.json \
     --scope-registry-file /private/trusted-scope-registry.json \
     --snapshot-at 2026-08-14T12:00:00Z \
     --batch-id report-only:2026-08-14T12:00:00Z
   ```

2. Review raw/eligible/selected counts, scope rejects, bytes, projected spawns,
   and review backlog. Report-only never writes candidate state.
3. After separate rollout approval for an exact workspace/policy/scope/evidence
   request, enable `shadow` for one canary. Shadow persists only the immutable
   batch report and does not make candidates actionable.
4. When the operator chooses to advance, submit a separate exact-policy,
   exact-scope `materialize` request and explicitly acknowledge it. Shadow
   cycle counts and health metrics remain diagnostic rather than blocking.
5. Set adaptation mode to `active` to enable immediate scoped promotion,
   post-factum notification, and numbered rollback. The historical rollout
   projection name `materialize_review_only` is retained for on-disk
   compatibility until a separate projection-schema migration.

Stop on scope leakage, replay drift, excessive spawn/review volume, or source
starvation. Rollback sets the compiler to `disabled`; evidence and audit state
are retained.
