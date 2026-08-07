# Global QMD maintenance coordinator

> Status: coordinator core, shadow writers and runtime adapter implemented.
> Scope: production config cutover and initial vector backfill remain gated.

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
