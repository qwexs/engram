# Engram Watchdog

Engram Watchdog is a **read-only workspace auditor**. It checks drift around an
Engram workspace and reports what needs human attention. It does not fix,
migrate, delete, archive, create QMD collections, or edit cron jobs.

Use it when `validate.js` is clean but the workspace still looks suspicious:
QMD collections missing, registry and domain folders disagree, topic sessions are
not tracked, KG seed files use old fields, or cron drift checks are disabled.

## CLI

```bash
# Audit one workspace
bun skills/engram/scripts/watchdog.js --workspace /path/to/workspace

# Machine-readable report
bun skills/engram/scripts/watchdog.js --workspace /path/to/workspace --json

# Write report to a file
bun skills/engram/scripts/watchdog.js \
  --workspace /path/to/workspace \
  --json \
  --output /path/to/workspace/ops/watchdog/latest.json

# Audit several explicit workspaces
bun skills/engram/scripts/watchdog.js \
  --workspace /path/to/workspace-a \
  --workspace /path/to/workspace-b \
  --json

# Discover workspaces under an explicit directory
bun skills/engram/scripts/watchdog.js \
  --all \
  --workspaces-dir /path/to/workspaces \
  --json
```

`--all` is intentionally explicit: public installs should not assume a global
`/opt/openclaw/workspaces` path. You can also set `ENGRAM_WORKSPACES_DIR` and
then pass `--all`.

## Options

| Option | Purpose |
|---|---|
| `--workspace <path>` | Workspace to audit. Can be repeated. |
| `--all` | Audit every workspace discovered under `--workspaces-dir`. |
| `--workspaces-dir <path>` | Root directory for `--all`. |
| `--json` | Print a machine-readable report. |
| `--output <path>` | Write the same report to a file. |
| `--no-core` | Skip the `validate.js` wrapper check. Useful for focused tests. |
| `--no-qmd` | Skip QMD collection checks. Useful when QMD is unavailable. |
| `--no-hooks` | Skip runtime hook drift checks. Useful in isolated CI fixtures without OpenClaw. |
| `--exit-zero-on-warn` | Return exit code `0` for warnings-only reports. Useful for cron/reporting jobs. |

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | Clean, or warnings-only with `--exit-zero-on-warn`. |
| `1` | Errors found. |
| `2` | Warnings only. |
| `3` | Invalid args / no workspace. |

## Report format

```json
{
  "schema": "engram.watchdog.v1",
  "generatedAt": "2026-07-15T00:00:00.000Z",
  "workspace": "/path/to/workspace",
  "status": "warn",
  "summary": {
    "errors": 0,
    "warnings": 2,
    "info": 0,
    "findings": 2,
    "fixed": 0,
    "readOnly": true
  },
  "findings": [
    {
      "code": "WD-QMD-004",
      "level": "error",
      "message": "QMD collection reference is missing but canonical domain-prefixed candidate exists: project-general",
      "path": "engram.json",
      "fixable": false,
      "details": {
        "source": "engram",
        "domain": "project-general",
        "collection": "project-general",
        "candidate": "domain-project-general"
      }
    }
  ]
}
```

`fixed` is always `0` in the auditor. `fixable` is currently informational and
remains `false` until a separate explicit repair tool exists.

## Checks

### Core validation

`WD-CORE-001` runs existing `validate.js` as an additive check. Watchdog does not
parse human output for repairs; it treats non-zero exit as a core error.

### Runtime hook drift

- `WD-HOOK-000` — hook drift check skipped because source/runtime hooks directory could not be found.
- `WD-HOOK-001` — Engram source hook exists but runtime hook is missing or not built; run `install-hooks.js --force` and restart OpenClaw.
- `WD-HOOK-002` — runtime `handler.js` appears older than source `handler.ts`; reinstall hooks and restart OpenClaw.
- `WD-HOOK-003` — runtime hook is missing `HOOK.md`.

### QMD registry consistency

- `WD-QMD-000` — QMD command unavailable or `qmd collection list` failed.
- `WD-QMD-001` — referenced QMD collection is missing.
- `WD-QMD-004` — unprefixed collection is missing, but `domain-{slug}` exists.
- `WD-QMD-005` — domain folder exists, but `domain-{slug}` collection is missing.
- `WD-QMD-007` — referenced QMD collection exists but indexes zero files.

Sources checked:

- `memory/domains/registry.json -> domains.*.qmdCollections`
- `engram.json -> qmd.collection`
- `engram.json -> domains.*.qmdCollections`

### Domain registry ↔ filesystem

- `WD-DOMAIN-000` — registry missing/invalid or `registry.domains` has wrong shape.
- `WD-DOMAIN-001` — registry domain has no folder.
- `WD-DOMAIN-002` — folder has no registry entry.
- `WD-DOMAIN-003` — meta-domain has no `qmdCollections`.
- `WD-DOMAIN-004` — chat-bound domain is missing its binding.
- `WD-DOMAIN-005` — expected domain file is missing.
- `WD-DOMAIN-006` — meta-domain search contour does not include a child domain collection directly or via an aggregate `*-domains` / `domains` collection.

Expected files follow current domain templates:

- all domains: `README.md`, `decisions.md`, `status.md`, `changelog.md`
- `dev-project` / `cron-task`: plus `workflow.md`
- chat/meta domains: plus `agents.md`

### Heartbeat state ↔ session dirs

- `WD-SESSION-000` — `heartbeat-state.json` missing or invalid.
- `WD-SESSION-001` — session directory exists but state has no entry.
- `WD-SESSION-002` — state references a missing session directory.
- `WD-SESSION-003` — stale `openai-*` session dir outside active state.
- `WD-SESSION-004` — topic-bound domain has no matching session dir/state yet (informational for dormant topics).
- `WD-SESSION-005` — session state is older than 30 days.

### KG schema and likely pollution

- `WD-KG-001` — invalid `items.json` or missing required v2 fields.
- `WD-KG-002` — legacy/old seed fields (`title`/`content` without `fact`).
- `WD-KG-003` — non-canonical category.
- `WD-KG-004` — likely test pollution by path, tags, or text.

This is deliberately conservative: likely pollution is a warning, not a delete
instruction. Engram's no-deletion rule still applies.

### Cron drift visibility

- `WD-CRON-006` — `engram.json` has no `cron.expectedJobName`, so deeper cron
  drift checks are limited/disabled.

The auditor does not call OpenClaw cron APIs or modify jobs. Cron repair, if ever
added, should be a separate explicitly-invoked tool or guarded phase.

## Read-only guarantee

The auditor only reads files and invokes read-only commands (`validate.js` and
`qmd collection list`). It does not:

- edit workspace files;
- edit KG facts;
- create/remove QMD collections;
- archive session directories;
- install/update cron jobs;
- restart OpenClaw.

## Scheduling recommendation

If scheduled, run as a reporting job, not inside the heartbeat critical path.
Use `--exit-zero-on-warn` when the scheduler should treat warnings as a
successful audit run and rely on the JSON report / notification layer for human
attention.

```bash
bun skills/engram/scripts/watchdog.js \
  --workspace /path/to/workspace \
  --json \
  --output /path/to/workspace/ops/watchdog/latest.json \
  --exit-zero-on-warn
```
