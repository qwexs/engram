# Global QMD collection registry

The registry is the declarative preflight contract for migration to one named
physical QMD index. It does not provision collections or run maintenance.

```json
{
  "schema": "engram.qmd.global-registry.v1",
  "index": { "name": "engram-global" },
  "workspaces": [
    {
      "id": "main",
      "path": "/absolute/main",
      "kind": "technical",
      "parents": [],
      "readableCollections": ["main-memory", "main-life"]
    }
  ],
  "collections": [
    {
      "name": "main-memory",
      "path": "/absolute/main/memory/agent-main",
      "owner": "main",
      "mask": "**/*.md"
    }
  ]
}
```

## Rules

- the registry selects exactly one named index;
- workspace ids/paths and collection names/paths are canonical and unique;
- each collection has exactly one owner;
- each collection path is inside its owner workspace;
- exact canonical collection paths are unique;
- nested aggregate + child roots produce a warning: installed QMD keys vectors
  by unique content hash, so embedding compute is reused, but document rows and
  search hits can still be duplicated;
- every owner reads its own collections;
- a technical workspace reads only its own technical collections;
- a business workspace reads its own collections and collections owned by a
  descendant in the declared workspace DAG;
- siblings and descendants cannot read sideways or upward;
- all readable collections must exist in the registry.

The synthetic business DAG can express multiple parents: `leadership` may be a
child of both personal executive workspaces, `company` a child of `managers`,
and projects children of `company`. `main` stays outside that DAG.

## Read-only preflight

```bash
bun scripts/qmd-global-registry-audit.ts --registry /path/to/registry.json

bun scripts/qmd-global-registry-audit.ts \
  --workspace /path/to/workspace-a \
  --workspace /path/to/workspace-b \
  --json
```

The second form audits legacy ownership claims before migration. Repeated
generic names such as `life` and `ops` are blockers in a global index and must
be renamed to globally unique names. Exit code is `0` for a clean preflight and
`2` for any blocker. The command performs no QMD calls and no writes.

The regular workspace watchdog can merge the same registry findings once:

```bash
bun scripts/watchdog.js --workspace /path/to/main \
  --qmd-registry /path/to/registry.json --json
```

## Migration planner

Deployment manifests contain absolute paths, workspace identifiers and exact
config hashes. Keep them outside the repository (or under the ignored
`.engram-private/` directory). The public repository contains only synthetic
fixtures and the generic migration engine.

Dry-run is the default and performs no writes or QMD calls:

```bash
bun scripts/qmd-global-migrate.ts --manifest /private/path/migration.json
```

Apply requires three independent signals: `--apply`, a new backup directory
outside every indexed workspace, and the exact target index name:

```bash
bun scripts/qmd-global-migrate.ts \
  --manifest /private/path/migration.json \
  --apply \
  --backup-dir /private/backups/cutover-001 \
  --confirm-index sample-global
```

The backup manifest records each restore target plus before/after SHA-256.
Rollback restores only those targets and refuses to overwrite a file changed
after migration:

```bash
bun scripts/qmd-global-migrate.ts \
  --rollback /private/backups/cutover-001/manifest.json
```

This planner changes JSON configuration only. It never provisions collections
and never invokes QMD maintenance; `qmd update` and `qmd embed` remain explicit
cutover steps after config review.

## Named-index provisioning

Provisioning has its own dry-run and safety boundary. It reads the private
migration manifest, compares the exact name/path/mask registry with the target
SQLite, and reports `add` versus `present`. Unknown collections or path/mask
drift are blockers.

```bash
bun scripts/qmd-global-provision.ts --manifest /private/path/migration.json
```

Apply requires an exact index confirmation and a new external backup
directory. Existing targets are snapshotted with SQLite before the first
collection change; a newly created target is recorded as such for rollback.

```bash
bun scripts/qmd-global-provision.ts \
  --manifest /private/path/migration.json \
  --apply \
  --backup-dir /private/backups/provision-001 \
  --confirm-index sample-global
```

Rollback refuses a changed target and requires the same explicit index name:

```bash
bun scripts/qmd-global-provision.ts \
  --rollback /private/backups/provision-001/manifest.json \
  --confirm-index sample-global
```

If the provisioning process was terminated after writing its `prepared`
manifest but before completion, recovery also requires
`--recover-incomplete`. A leftover lock is never removed automatically;
verify that its recorded PID is dead before removing that exact lock file.

Provisioning only registers collection metadata. It never runs `qmd update`,
`qmd embed`, config migration, or workspace cutover. Those remain separately
observable operator gates.
