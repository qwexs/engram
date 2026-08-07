# Global QMD maintenance coordinator

> Status: implementation plan for `feat/qmd-global-maintenance`.
> Scope: coordinator/core only; production call sites and index migration remain disabled.

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
