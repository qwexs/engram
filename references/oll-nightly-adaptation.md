# OLL Nightly Adaptation — implementation contract

> **Status:** runtime and rollout tooling implemented; production activation is
> operator-gated. New and upgraded workspaces remain `observe-only` with
> `nightly.enabled=false` until an operator approves a deployment-specific
> rollout and its read-back projection.

## Boundary

This document describes the portable Engram core. It contains no deployment
inventory, account IDs, filesystem layout, model provider, schedule, workspace
list, canary evidence, or customer policy. Those belong in the operator's
private deployment repository.

The core may write only its configured workspace adaptation store and the
operator-configured fleet state root. It does not create a live cron, enable a
workspace, or select a deployment profile by itself.

## Purpose

OLL turns authorized corrections, preferences, and workflow feedback into
auditable, scoped rule proposals:

1. capture a signal with evidence and scope;
2. reconcile memory and build an immutable context snapshot;
3. let `hb-rethink` propose typed actions;
4. revalidate every action in deterministic code;
5. activate only an authorized low-risk local rule, or create a review record;
6. inject matching active rules at the next bootstrap.

The model is proposal-only. It is never an authorization decision.

## Core invariants

- One fleet coordinator processes one workspace to a terminal disposition
  before starting the next.
- `phase` is semantic identity (for example, `hb-rethink`); `label` is a
  workspace-scoped identity; `runtimeLabel` and `runId` identify one run.
  Model resolution uses `phase` only.
- A durable batch has a fenced global lease, immutable registry and context
  snapshots, bounded retries, and an idempotent action journal.
- A handoff is complete only after its typed correlation envelope is validated
  and its actions reach a terminal journal disposition.
- Invalid, ambiguous, untrusted, broad, or policy-sensitive actions fail
  closed to review. Unknown semantics are never auto-activated.
- Rule resolution is scoped, deterministic, bounded in size, and contributes
  to the bootstrap context hash.
- Signals, handoffs, reviews, and journals are retained for audit; rollback
  suspends changes rather than deleting evidence.

## Core data contracts

The executable TypeScript interfaces in `src/oll/contracts.ts`, plus the
parsers and guards in `src/oll/*`, are the authoritative core contract. They
cover registry snapshots, batch/lease state, handoffs, actions, reviews,
operation journals, rollout projections, and rule context.

There is intentionally no inert JSON-Schema directory. If Engram later offers
machine-readable contracts as a public integration surface, it must add a
runtime validator and validate every ingress and persisted state transition;
publishing files that are not executed is not a safety boundary.

## Workspace lifecycle

`init.js` and the upgrader install the configuration, state directories, legacy
admission marker, full hook set, and deterministic heartbeat. A clean install
does not install a second OLL scheduler. The heartbeat performs non-OLL
maintenance only after cutover; it cannot admit or apply legacy rethink work.

An operator supplies a registry adapter and any deployment profile outside the
canonical repository. A profile can provide exact model mapping, timezone,
allowed roots, and regulated-domain vocabulary. A profile is configuration,
not an activation grant.

## Nightly coordinator

For every eligible entry in its immutable registry snapshot, the coordinator:

1. performs deterministic memory reconciliation;
2. collects actionable signals since the successful watermark;
3. creates and persists a context snapshot;
4. skips durably when no action is needed;
5. dispatches exactly one `hb-rethink` run when actionable;
6. waits for an already-written or atomically-created handoff without polling;
7. validates, journals, applies, or routes each action to review;
8. advances the watermark only after a terminal recorded outcome.

The next invocation resumes a durable incomplete batch. It does not create an
overlapping batch or repeat a completed side effect.

## Derived candidate producer (proposed)

This proposed ingress is deliberately a quiet continuation of the existing
heartbeat extraction, not a new task for the conversational agent and not a
message listener.  It exists to surface already-filtered learning candidates
without retaining raw user messages or creating a second stream of agent work.

### Inputs and boundary

After a successful deterministic extraction pass, the producer may inspect
only derived, workspace-local artifacts: bounded Events and Decisions in daily
notes, conservatively written KG facts, and operational observations or
tensions.  It may create a typed candidate only for an explicit correction,
preference, or workflow instruction already represented by those artifacts.
Ambiguous inference, sentiment, and reconstructed conversational detail are
skipped.

The candidate records the derived artifact reference and a digest, not raw
message text, transport metadata, or a message log.  `engram-message-log` is
not an input and is not required by this design.

### Safety and lifecycle

Derived provenance is not an authorization grant.  Every candidate from this
producer is `review_required`; it cannot directly create, activate, broaden,
or suspend a rule.  The producer is deterministic, watermark-driven, and
idempotent: it emits at most one candidate for a normalized assertion and
source digest, then records the disposition for later audit.  It must run only
after its source artifact is durably written, and a failure to produce a
candidate must not affect heartbeat maintenance.

The nightly coordinator consumes all pending candidates accumulated since the
workspace's successful evaluation watermark in one sequential workspace run.
With no candidates or other actionable context, it records a durable skip and
does not invoke a model.  This preserves one nightly decision point rather
than reacting to each memory write.

### Weekly view

Weekly mode is the Monday window of the same coordinator, not a second
scheduler or agent.  It aggregates the preceding local week of unresolved
candidates, observations, and tensions and considers the full rule lifecycle
to identify repetition and drift.  Derived candidates remain review-only in
both daily and weekly mode.

### Non-goals and activation

This design does not capture raw incoming messages, analyze message logs,
require an extra agent prompt or tool call, or auto-activate any adaptation.
It is a proposed core contract only: implementation, migration, tests, and a
separate observe-only rollout gate are required before any workspace enables
it.

## Risk and authorization

Core automatic activation is restricted to a low-risk, reversible local rule
with an exact trusted-actor grant. Workspace/company/global scope, missing or
ambiguous identity, permission changes, security/privacy changes, legal/safety
semantics, and external actions require review.

Deployment-specific regulated vocabulary must be enforced by the trusted
deployment boundary before the core captures a signal. This keeps the core
portable while preserving a fail-closed default: anything outside the
deterministic low-risk class is review-only.

## Rollout and rollback

The operator must perform the following sequentially:

1. run cutover preflight and quarantine or drain legacy OLL records;
2. create a reviewed workspace registry and scheduler declaration;
3. use `install-oll-nightly-cron.ts --action plan` and review its digest,
   roots, backup, and intended payload;
4. install only with the explicit acknowledgement flag;
5. enable one workspace in observe-only mode and read back state, scheduler,
   hook delivery, batch report, and rollback evidence;
6. approve active mode separately, after the canary gate passes.

Rollback returns adaptation to observe-only, disables the new scheduled action,
and suspends rules from the rollout batch. It preserves signals, handoffs, and
journal evidence. It never silently restores the legacy heartbeat owner.

## Verification

Required automated coverage includes phase-based model resolution, strict FIFO,
lease fencing, watcher recovery, handoff correlation, action-journal replay,
authorization revalidation, scoped context injection, legacy cutover, fresh
init, scheduler plan/install/read-back/rollback, and the no-live-activation
boundary. Run `bun run typecheck` and `bun test` before any deployment gate.

Operator evidence is private to the deployment. It must record the exact
release, registry/config digests, scheduler read-back, batch result, and
rollback result without copying raw user content.
