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

The Takeron business DAG can express multiple parents: `managers` may be a
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

Migration, collection provisioning, `qmd update`, incremental `qmd embed`,
backups, and production config changes belong to the next rollout PR.
