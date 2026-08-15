# Operational Learning Loop (OLL)

> v3.5. System observes its own friction — what worked, what failed, what patterns emerged — and accumulates these observations for review.

> **PR 2–6 runtime boundary:** workspaces owned by the nightly scheduler reject
> legacy heartbeat rethink/rethink2/autoresearch dispatch and application.
> PR 3 adds managed capture and review; PR 4 adds a strict proposal-only handoff
> and deterministic applicator; PR 5 adds the resumable strict-FIFO coordinator;
> PR 6 adds scoped rule resolution and the generic bootstrap hook. Fresh init
> now enables nightly and active rule delivery by default; authorization and
> scope checks still fail closed.

## Storage Structure

```
workspace/ops/
├── observations/          # Operational observations
│   ├── index.json         # Registry of all observations
│   └── obs-0001.json      # Individual observation files
└── tensions/              # Contradictions between facts
    ├── index.json         # Registry of all tensions
    └── tension-0001.json  # Individual tension files

memory-state/oll/             # Non-indexed managed adaptation state
├── signals/                 # oll.adaptation-signal.v1 projections
├── rules/                   # oll.adaptation-rule.v1 projections
├── reviews/                 # explicit human review lifecycle
├── operations/              # oll.adaptation-operation.v1 idempotency records
├── audit/                   # immutable privacy-minimized events
├── context-conflicts/       # idempotent pending-review rule conflicts
├── handoffs/{incoming,applied,rejected}/
└── apply-journal/<runId>/events/ # immutable applicator transitions
```

## Adaptation capture (PR 3, observe-only)

The trusted runtime/operator adapter uses `oll-adaptation.ts`. Transport actor
identity is consumed only from `trustedActorContext`; sender-like text inside a
message is never authority. Evidence is stored as a stable reference and
SHA-256 digest, not copied into audit events.

```bash
bun skills/engram/scripts/oll-adaptation.ts capture \
  --workspace /path/to/workspace --state-root /var/lib/engram \
  --request-file /trusted/runtime-envelope.json

bun skills/engram/scripts/oll-adaptation.ts pending \
  --workspace /path/to/workspace --state-root /var/lib/engram
```

Explicit authorized corrections enter `pending` exactly once. Unknown actors,
reconstructed evidence, ambiguous group scope, inferred preferences, and
broad/company scope fail closed to review. Legal/security/permission
and external-action semantics are deterministically high risk. Review approval
revalidates the current actor registry binding and revision. In
`observe-only`, an otherwise eligible low-risk local rule records
`policyDisposition=observe_only`; it is neither activated nor sent to review
merely because rollout is disabled.

## Typed rethink handoff and applicator (PR 4)

`src/oll/handoff-v2.ts` implements RFC 8785 canonicalization, recomputes the
handoff and action digests, rejects unknown policy fields, and verifies the
exact batch/workspace/evaluation/run/attempt/policy/context/path correlation.
The proposal prompt embeds the immutable signal-revision snapshot, allowed
actions, policy boundaries, and absolute handoff target.

`src/oll/handoff-applicator.ts` is the deterministic enforcement boundary. It
revalidates source revisions, scope, risk, and current actor authority; writes
an operation intent before each effect; journals immutable transitions; and
quarantines invalid handoffs. Re-entry after any journal transition converges
by `operationId` without repeating a rule activation. Low-risk authorized
local proposals may activate only when the workspace is explicitly in
`active` mode. Broad or regulated actions remain `review_pending`.

Legacy observation/tension maintenance is available only through the explicit
versioned compatibility adapter. Experiments, rethink2, and autoresearch are
not admitted by `oll.rethink-handoff.v2`.

## Durable nightly coordinator (PR 5, deployment candidate)

`src/oll/nightly-coordinator.ts` owns one durable batch at a time. It consumes
a versioned workspace registry adapter, freezes registry/config/context
digests, reconciles memory, performs deterministic preflight, and processes
each actionable workspace through spawn → watcher → applicator → terminal
outcome before the next spawn. Empty preflight is persisted as `skipped` and
uses no model call.

Coordinator state lives below the configured state root in `oll-nightly/`:
renewable fenced lease, CAS `batch.json`, immutable transition events, frozen
registry snapshot, and per-workspace context snapshots. Interrupted runs
resume the current batch; retries keep the evaluation/context but use a fresh
`runId`. The handoff helper uses a pre-check, parent-directory filesystem
watcher, and post-check—never interval polling. Per-run and whole-batch
timeouts are bounded.

`src/oll/trusted-runtime.ts` is the deployment boundary for the single trusted
`sessions_spawn` call. It reconciles an exact `runtimeLabel` before spawning
and fails closed on label or resolved-model drift. Deployment declarations and
live scheduler evidence remain outside the canonical repository.

## Scoped bootstrap rule context (PR 6, rollout-gated)

`src/oll/rule-context.ts` resolves the complete active projection for the
current company, workspace, domain, and person target. Resolution is
deterministic by scope precedence, optional priority, activation time, and
rule ID. Proposed, suspended, superseded, expired, foreign, and unmatched
rules are excluded. A person rule requires one exact actor-registry binding
and is never injected into a multi-person group or topic.

The context hash is SHA-256 over canonical sorted
`{ruleId, scope, revision, contentDigest}` identities. The existing domain
hash remains unchanged and is composed with the rule hash only for the final
bootstrap marker. Conflicting positive/negative directives block both rules
and write one `oll.rule-context-conflict.v1` review artifact. The complete
rendered block must fit `maxInjectedRuleBytes`; it is never truncated.

`engram-rule-context-load` runs on `agent:bootstrap` for main/direct, bound
peer/group, and topic sessions, but only when `oll.adaptation.mode=active`.
It publishes the resolved payload as an inline virtual bootstrap file through
`event.context.bootstrapFiles`; no generated rule file is persisted.
The shipped template starts in `active` mode. An empty or unauthorized rule
store still yields no injected directives; only matching active rules that pass
the existing actor/scope policy are delivered.

## Canary rollout and rollback tooling (PR 7)

`src/oll/rollout.ts` and `scripts/oll-rollout.ts` provide a dry-run-first,
explicitly acknowledged operator boundary. Observe-only canary activation
requires evidence for synthetic tests, legacy cutover, absence of the legacy
dispatcher/applicator, hook source, scheduler candidate, and a
non-privileged target. Active mode additionally requires a passed observe-only
canary. The manager updates workspaces sequentially, keeps config and
`oll-nightly-state.v1` aligned, writes per-workspace rollout projections,
backs up source files with digests, and emits immutable events plus a release
marker containing the exact scheduler job/payload revision.

The deployment Phase 0 is executable rather than declarative:
`install-oll-nightly-cron.ts` builds and hashes the exact OpenClaw script,
backs up/restores the previous scheduler payload, and produces CLI read-back
evidence required by `oll-rollout`. `oll-nightly-runtime.ts` supplies the
durable request/ack bridge with exact-label recovery. Discovery admits an
enabled workspace only when config, nightly state, and rollout projection
agree; the config activation bit is published last. The script preserves
daily reconciliation for the full declared fleet before evaluating only
rollout-enabled OLL workspaces.

Rollback sets adaptation to observe-only, disables nightly rethink, suspends
rules from the rollout batch through the canonical CAS writer, preserves all
signals/handoffs/audit, and never restores legacy heartbeat ownership.
Deterministic reconciliation configuration is left intact. The synthetic
canary proves authorized local rule delivery on the next matching bootstrap
and removal after rollback. No live workspace or scheduler is changed merely
by publishing this tooling; the real non-privileged canary remains an explicit
operator step.

## Capturing Observations

Only the agent writes observations — subagents return `Flags:` in handoffs for the agent to review.

```bash
bun skills/engram/scripts/memory-observe.js --observation "KG extraction missed facts about email" --category friction
bun skills/engram/scripts/memory-observe.js --observation "..." --category surprise --description "Why this matters"
```

**Categories:** `friction` (weight ×3), `surprise` (weight ×2), `pattern` (weight ×1)

## Capturing Tensions

Tensions are created only by an explicit operator action. The retired v2 writer
no longer performs automatic contradiction creation:

```bash
bun skills/engram/scripts/memory-tension.js \
  --tension "Fact A contradicts fact B" \
  --fact1 "alice-001" --fact2 "alice-005" \
  --type factual \
  --confidence 0.8 \
  --description "Context about the contradiction"
```

**Types:** `factual` (default), `temporal`, `priority`

## Archiving Observations

```bash
bun skills/engram/scripts/memory-promote.js --archive \
  --obs-id obs-0003 --reason "domain status report, not friction"
```

Observation → KG promotion is retired. A durable assertion requires explicit
typed KG v3 ingress from an authorized user turn.

## OLL Rethink Trigger (Heartbeat Phase 5 + Phase 5.5)

The following section is legacy compatibility behavior only. It runs solely
while heartbeat remains the OLL schedule owner; PR 2 cutover makes every listed
spawn/apply path inert.

Phase 5 computes weighted score и решает, какой subagent spawn'ить:

| Subagent | Trigger condition | Phase |
|----------|-------------------|-------|
| `hb-rethink` | weighted≥15 OR pending tensions≥3 OR weekly cadence (≥7 days since last rethink AND lastWeeklySynthesis within 24h) | 5 (direct spawn) |
| `hb-rethink2` | hb-rethink returned alert OR weights не распустились | 5.5 (queued) |
| `hb-autoresearch` | после успешного rethink, для self-experiment PROPOSAL | 5.5 (queued) |

Phase 5 пытается direct spawn через `sessions_spawn`; если не получилось — ставит в очередь через `spawn-pump.js`. Phase 5.5 drain'ит queue через `spawn-claim.js`.

**Historical only:** pre-cutover cron payloads could include
`--spawn-rethink --spawn-rethink2`. New and nightly-owned workspaces never
emit these flags. The compatibility runner retains the parser solely for
auditable migration and rejects scheduling/application after the durable
cutover boundary.

`--force-rethink-once` is a one-shot escape hatch — bypasses the 7-day gate AND weekly-synthesis proximity check for a single run when the weekly cadence isn't satisfied, queues hb-rethink anyway. Used during init / cold-start or for ad-hoc reviews.

`--apply-low-risk-proposals` is audit-only: after rethink handoff apply, scan the latest `done/` rethink handoff for `[PROPOSAL:low-risk]` / `[PROPOSAL:human-review]` blocks and write `workspace/ops/heartbeat-spawns/rethink-applied-{timestamp}.json`. Does not auto-edit source files.

## Auto-seed from Maintenance

When `validate.js` produces ≥1 `❌` error OR ≥5 non-benign `⚠️` warnings AND no auto-seed fired in the last 24h (`lastAutoSeedAt` in `heartbeat-state.json`), `hb-runner` writes a friction observation via `memory-observe.js`.

**Benign warning ignore-list** (added 2026-07-26 per hb-rethink proposal): timing warnings (`Last run Xm ago`), session dir checks, hooks dir checks, lightContext drift, schedule drift — these never auto-seed. Only real errors and non-benign warnings (≥5) become observations.

**Why:** before the filter, auto-seed produced only noise — timing warnings archived by rethink before becoming patterns. The filter ensures auto-seed is a safety net for real issues, not a noise generator.

**Primary signal source:** the agent itself, writing observations via `memory-observe.js` when it encounters friction/surprise/pattern during sessions. Auto-seed is secondary.

`hb-rethink` (model from `engram.json → models.heartbeat.subagents["hb-rethink"]`) reviews observations + tensions, identifies patterns, decides on actions, and returns a `HB-RETHINK HANDOFF` block with business-language rationale for each action. `process-handoff.js` **auto-executes** all actions (archive, promote, resolve tensions, create experiments) and then **surfaces a business-language report to the user** explaining what was done, why, and what improves as a result. The user sees the outcome and can react or revert — agent acts, then explains.

## Resolving Tensions

```bash
# Resolved: one fact supersedes the other
bun skills/engram/scripts/memory-tension-resolve.js \
  --id tension-0001 --resolution "fact-abc superseded by fact-xyz"

# Dissolved: not actually contradictory
bun skills/engram/scripts/memory-tension-resolve.js \
  --id tension-0001 --dissolved \
  --resolution "facts are scope-dependent (work vs personal context)"
```

## Schemas

**Observation:**
```json
{
  "id": "obs-0001",
  "observation": "KG extraction missed facts about email",
  "category": "friction",
  "status": "pending | promoted | implemented | archived",
  "createdAt": "2026-02-25T12:00:00.000Z",
  "promotedAt": null,
  "archivedAt": null,
  "kgFactId": null,
  "accessCount": 0
}
```

**Tension:**
```json
{
  "id": "tension-0001",
  "tension": "Possible contradiction: ...",
  "type": "factual | temporal | priority",
  "confidence": 0.72,
  "fact1": "alice-001",
  "fact1Text": "Prefers Bun over Node.js",
  "fact2": "alice-005",
  "fact2Text": "Uses Node.js for all projects",
  "description": "Auto-detected (Jaccard 0.72, 4 common words)",
  "status": "pending | resolved | dissolved",
  "createdAt": "2026-03-03T15:00:00.000Z"
}
```

**index.json stats:**
```json
{
  "observations": ["obs-0001", ...],
  "lastId": 10,
  "stats": { "total": 10, "pending": 1, "promoted": 2, "implemented": 1, "archived": 6 }
}
```

For full OLL details, see [references/HEARTBEAT.md](HEARTBEAT.md) (Phase 5) and [references/HB-RETHINK.md](HB-RETHINK.md).
