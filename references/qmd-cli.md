# Engram QMD CLI

`engram qmd` is a thin operator interface over Engram's QMD core. The CLI parses arguments and formats output; workspace resolution, index identity, policy, invocation and process handling live in `src/qmd/`.

## Runtime and entrypoint

- Bun `>=1.3.0 <2`; release gate version: Bun 1.3.14.
- TypeScript runs directly. There is no production build step.
- Runtime dependencies are empty.
- Development and canary runs use `bun bin/engram`.

```bash
bun bin/engram --help
bun bin/engram --version
```

Workspace resolution order:

1. `--workspace <path>`;
2. `ENGRAM_WORKSPACE`;
3. current working directory.

The result must resolve through `realpath` to a directory with a valid `engram.json`.

## Commands

```text
engram [global-options] qmd resolve
engram [global-options] qmd capabilities
engram [global-options] qmd status
engram [global-options] qmd doctor [--strict]
engram [global-options] qmd search <query> -c <collection>... [--limit <n>]
engram [global-options] qmd query <query> -c <collection>... [--limit <n>]
engram [global-options] qmd vsearch <query> -c <collection>... [--limit <n>]
```

Global options:

- `--workspace <path>` — workspace root;
- `--json` — exactly one machine-readable object in stdout;
- `--timeout-ms <n>` — operation timeout;
- `--verbose` — include diagnostic details in JSON errors;
- `--help`, `--version`.

`resolve` does not run QMD. `capabilities`, `status` and `doctor` are read-only. `doctor --strict` fails when checks return warnings.

Read commands require one non-empty query and at least one explicit collection. Repeated `-c` enables multi-collection reads. `--limit` accepts an integer from 1 to 100. The core rejects collections outside the caller allowlist before spawning QMD.

## JSON protocol

Success schema: `engram.cli.result.v1`.

```json
{
  "schema": "engram.cli.result.v1",
  "ok": true,
  "command": "qmd.resolve",
  "meta": {
    "elapsedMs": 4,
    "workspace": "/srv/workspace"
  },
  "data": {}
}
```

Error schema: `engram.cli.error.v1`.

```json
{
  "schema": "engram.cli.error.v1",
  "ok": false,
  "error": {
    "code": "POLICY_DENIED",
    "message": "Collections are outside the caller's readable intersection: private"
  }
}
```

Human-readable output is for operators and is not a stable parsing API. In JSON mode stdout contains only the envelope. Diagnostics go to stderr; error `details` are included only with `--verbose`.

Exit codes:

| Code | Meaning |
|---:|---|
| 0 | success |
| 1 | internal error |
| 2 | usage error |
| 3 | configuration or context error |
| 4 | policy denied |
| 5 | dependency or QMD unavailable |
| 6 | QMD operation failed |
| 7 | timeout or cancelled |
| 8 | reserved for deferred or partial work |

## Trust and policy boundary

The local OS account is an operator and can already access QMD and SQLite. The CLI prevents accidental or architecturally invalid calls; it is not an OS security boundary.

Operator reads still require explicit collections and workspace policy. There is no `--scope admin` or another user-controlled privilege flag. Agent-facing calls remain disabled until OpenClaw or Engram can supply a trusted caller context.

The first release has no generic passthrough and no public `update` or `embed`. Maintenance commands will appear only as intent-level coordinator operations after dirty-state coordination and host-wide embed governance exist.

## Launcher installation

```bash
# Review target and body without changing files
bun scripts/install-cli.js --dry-run

# Install to $BUN_INSTALL/bin or ~/.bun/bin
bun scripts/install-cli.js

# Explicit destination, if needed
bun scripts/install-cli.js --bin-dir /custom/bin

engram --version
```

The launcher contains the canonical checkout path and Bun executable. Installation is idempotent. A foreign file or symlink at the destination is never overwritten.

Uninstall checks the exact managed launcher body before removal:

```bash
bun scripts/install-cli.js --uninstall --dry-run
bun scripts/install-cli.js --uninstall
```

Production rollout and rollback: [qmd-cli-rollout.md](qmd-cli-rollout.md).
