# Global QMD maintenance coordinator

## Current scheduler contract (2026-09-11)

The canonical installer now generates `payload.kind=script`: one synchronous
managed Gateway `exec`, `toolsAllow=["exec"]`, `toolBudget=1`, no model and no
background/process continuation. With the default 600-second coordinator limit,
exec has 650 seconds and the enclosing script 660 seconds. Nonzero exit or any
status other than `completed` throws and fails the cron. Secrets stay in the
managed exec environment; they are never copied into command env, script or files.
The simple `command` runner does not provide the same environment contract.

```bash
# Review; dry-run does not read/change cron or create files.
bun skills/engram/scripts/install-qmd-maintenance-cron.js \
  --workspace /path/to/coordinator --manifest /private/migration.json --dry-run

# Provision once, disabled on first install. Reinstall preserves ID/activation.
bun skills/engram/scripts/install-qmd-maintenance-cron.js \
  --workspace /path/to/coordinator --manifest /private/migration.json
```

The manifest is a global registry or migration wrapper, NOT a scheduler
specification. The installer writes `maintenance-scheduler.json` beside the
manifest only after live read-back agrees. `--declaration` overrides that path;
`--report` selects the coordinator result file (default
`maintenance-last-run.json` beside the manifest). Parent directories must exist.
It refuses ambiguous/pinned-missing/incomplete inventories and hosts without
script support. There is no automatic legacy payload fallback.

Before explicit `--enabled`: enroll the workspace in the one physical-index
registry, verify all workspace modes are `coordinated`, verify initial vector
backfill, validate managed-exec credentials without printing them, and obtain
operator activation authorization. These are deployment evidence gates, not
claims that the installer independently proves. Select a free UTC minute with
`--schedule`; `staggerMs=0` is fixed. A different minute alone is not a lock.

`init.js --qmd-manifest /private/migration.json` calls this same installer,
records the declaration pointer, and never creates another registry/index,
backfills, or auto-enables a new coordinator. `--workspace-only` forbids this
shared mutation. Without this option, init leaves enrollment/provisioning to
the deployment owner. Workspace scaffolding alone is not operational readiness.

Watchdog accepts `--qmd-scheduler /private/maintenance-scheduler.json` for a fleet,
or the workspace's `qmd.maintenance.schedulerDeclaration` pointer. It checks
exact pinned identity/payload/schedule/delivery, the fail-closed wrapper, recent
execution and the coordinator result/provenance. It never evaluates cron code.
An unavailable/partial inventory is **unverified**, not proof of a missing job.
A `clean` pass does not prove new embeddings; a deferred pass is not success
proof. Actual index generation/SQLite evidence and explicit scoped search are
still required for end-to-end acceptance.

Workshop collection reviews are host-owned, not Engram coordinators. On the
2026-09-11 deployment, their inherited Codex runtime fails the host's
Workshop-root containment guard. Engram must not patch the host, relax the guard,
or change shared models to conceal that failure. Watchdog reports observed
containment failures separately from never-run/unverified reviews.

## Coordinator design history

The core design below predates the deployment cutover. Its original PR scope
is historical; current scheduler installation is described above. Production
activation remains deployment-owned even though the reusable installer exists.

## Decision

Engram targets one global physical QMD SQLite index. Collection scope controls
which data a trusted caller may read or maintain; the physical index identity
controls coordination and locking.

Routine maintenance never uses `qmd embed -f`:

1. writers mark the global index and affected collections dirty;
2. one coordinator coalesces dirty generations;
3. `qmd update` runs once for the whole physical index;
4. `qmd embed -c ...` runs once for the explicit maintenance collection set;
5. QMD embeds only pending content hashes and holds its index-scoped embed lock.

`scope` and `lock` are separate controls. Scope prevents an Engram caller from
selecting unauthorized collections. The lock prevents concurrent embedding of
the same physical SQLite index.

## PR scope

This PR adds the reusable, disabled-by-default core needed before any runtime
or topology migration:

- a trusted `coordinator` caller kind;
- explicit coordinator embed scope, validated against its allowlist;
- persistent dirty generations and reasons keyed by canonical `indexKey`;
- atomic state writes and a cross-process coordinator lease;
- coalesced `update -> embed` execution through the existing QMD runner;
- failure semantics that preserve dirty state;
- recovery of stale leases;
- structured maintenance results suitable for future CLI/status output.

This PR does not:

- expose raw `engram qmd update` or `engram qmd embed` commands;
- modify hooks, heartbeat, writers, cron or production `engram.json` files;
- migrate isolated indexes into the global index;
- run a production backfill;
- use `-f` during normal maintenance.

## State model

State is stored outside indexed workspace content and keyed by physical index
identity. A dirty generation is monotonic. A successful maintenance run clears
only the generation it observed; writes that arrive during the run remain
dirty for the next pass.

The state records:

- current and completed generation;
- BM25/vector dirty flags;
- affected collections and bounded reasons;
- last successful update/embed timestamps;
- last error and run metadata.

## Coordination rules

1. `markDirty` is atomic and content writers call it only after a real write.
2. Concurrent marks merge collections/reasons and increment the generation.
3. A coordinator lease is acquired before the state is planned or mutated.
4. `update` is always index-wide and never receives `-c`.
5. `embed` receives explicit repeated `-c` values and never receives `-f`.
6. Embed runs only after a successful update for the observed generation.
7. Any update/embed failure preserves dirty state and records the error.
8. A write during maintenance is not lost when the earlier generation commits.
9. A live lease returns `deferred`; an expired lease can be recovered.
10. QMD's index-scoped embed lock remains the final duplicate-work defense.
11. After maintenance, source-specific index handoffs are reconciled per owner
    workspace. A `canonical_indexed` receipt requires the smaller of completed
    update/embed generations to cover the handoff and an exact physical-index
    read-back of collection root, document anchor, and canonical digest.
12. One corrupt or stale handoff is reported without blocking other handoffs;
    it never becomes proof that indexing completed.
13. Handoff publication rereads the immutable apply receipt and the exact dirty
    reason/generation from maintenance state. If a physical index rotates while
    the canonical collection root remains exact, the new index may satisfy the
    old handoff only through a fresh exact SQLite document read-back and an
    exact vector row for that document hash; generations from different
    physical indexes are never compared as if they shared a counter.
    A renamed collection is accepted only when the current registry allowlist
    and SQLite catalog resolve it uniquely to that same canonical root.
14. Apply receipts and handoffs are dependency-retained while a newer linked
    index provenance artifact remains inside its 180-day audit window.
15. Any failed handoff reconciliation makes the coordinator process fail so
    cron failure alerting cannot mistake a partial provenance pass for success.

Memory Observation family canaries add one gate before rule 1: an exact
runtime session must resolve through the pinned registry slice to one
owned/readable `*.md` collection. The applicator resolves before canonical
write and rechecks at apply time. `markWorkspaceQmdDirty` receives the resolved
`expectedIndexKey` and compares it with the current context before calling
`markDirty`; a mismatch therefore creates no generation. Missing or transient
resolution stays durably `qmd_pending` and is retried without a collection
fallback.

## Acceptance criteria

- 100 dirty marks coalesce into one maintenance pass.
- update argv contains no collection flags.
- embed argv contains the authorized collection set and no `-f`.
- unauthorized coordinator collections fail before `Bun.spawn`.
- two coordinators for one `indexKey` produce one executor.
- stale lease recovery is deterministic and audited.
- failed update does not run embed and does not clear dirty state.
- failed embed does not clear vector dirty state.
- marks arriving during a run remain pending.
- clean state launches neither update nor embed.
- tests use fake QMD and temporary state; production SQLite is never touched.
- a dirty mark alone never satisfies index provenance; exact generation and
  SQLite read-back are required.
- `bun test` and `bun run typecheck` pass.

## Follow-up rollout

After this core is merged and released, separate PRs will migrate writers and
hooks to `markDirty`, replace workspace heartbeat maintenance with one global
job, build the canonical global collection registry, migrate indexes with
backup/rollback, and remove the remaining raw QMD call allowlist.

## Shadow writer integration

Writer integration is controlled per workspace:

```json
{
  "qmd": {
    "maintenance": { "mode": "legacy" }
  }
}
```

- `legacy` (default) creates no coordinator state and preserves existing
  behavior exactly;
- `shadow` records a dirty generation after a successful write, but never
  launches `qmd update` or `qmd embed`;
- `coordinated` records the same state while workspace heartbeats delegate to
  the global coordinator. It is selected only by the shared-index migration
  after raw workspace maintenance has been removed; it does not create an
  extra public QMD command.

State lives under
`$OPENCLAW_STATE_DIR/engram/qmd-maintenance/<index-key-hash>/`, or under
`~/.openclaw/engram/qmd-maintenance/` when the state-dir override is absent.
It is outside indexed workspace content.

The first shadow call sites are:

- daily-note appends;
- successful KG fact writes (collection `life`);
- non-debounced `session:start` and `session:end` markers.

Duplicate/no-op paths return before marking. Requested collections must be
owned by the writing workspace. State errors are logged and returned as a
structured `error`, but are fail-open for the already completed content write.
Legacy raw maintenance remains active only during shadow observation. The
execution-cutover removes it before any config is switched to `coordinated`.

## Runtime ownership adapter

Lifecycle hooks never execute QMD maintenance:

- bootstrap records no write and defers freshness to the scheduler;
- session-end appends the marker and records the dirty generation only;
- workspace heartbeat calls the typed adapter rather than a shell command.

The adapter preserves legacy/shadow behavior through policy-authorized typed
`update` and `embed` invocations. In `coordinated` mode a workspace heartbeat
returns `delegated` without starting QMD. The single global scheduler invokes
`scripts/qmd-maintenance-coordinator.ts`, validates its private registry and
named-index identity, and then acquires the physical-index lease.

The coordinator job may be declared disabled before cutover. It must not be
enabled until every workspace is in coordinated mode and the initial vector
backfill has passed its separate operator gate.
