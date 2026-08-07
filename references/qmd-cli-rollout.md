# Engram QMD CLI rollout and rollback

This runbook releases the read-only CLI without switching existing hooks, scripts, cron jobs or workspace configs.

## Preconditions

- The candidate commit is reviewed and tagged.
- Production uses Bun `>=1.3.0 <2`.
- QMD reports the capabilities required by `engram qmd capabilities`.
- Existing workspace configs and SQLite indexes are backed up through the normal host process.
- No call-site migration is bundled with this rollout.

## 1. Release gate in the candidate checkout

```bash
bun test
bun run typecheck
bun test scripts/watchdog.test.js scripts/vertical-qmd-audit.test.js

bun bin/engram --help
bun bin/engram --version
bun scripts/install-cli.js --dry-run
```

The worktree must remain clean after the gate. The gate must not modify production configs, cron jobs or QMD SQLite files.

## 2. Merge and tag

Merge the reviewed PR without changing the production checkout. Create a release tag only on the verified merge commit. Record the commit and tag in the release note.

## 3. Update the production checkout

Update the production Engram checkout to the release tag. Do not install the launcher yet. Confirm that `bin/engram` resolves inside the expected checkout:

```bash
git rev-parse HEAD
bun bin/engram --version
```

## 4. Read-only canary

Choose the main workspace and one isolated leaf workspace. For each workspace:

```bash
WORKSPACE=/path/to/workspace

bun bin/engram --workspace "$WORKSPACE" qmd resolve
bun bin/engram --workspace "$WORKSPACE" qmd capabilities
bun bin/engram --workspace "$WORKSPACE" qmd status
bun bin/engram --workspace "$WORKSPACE" qmd doctor --strict
bun bin/engram --workspace "$WORKSPACE" \
  qmd search "canary" -c <workspace-readable-collection> --limit 3
```

Verify that:

- canonical workspace and physical index match the current deployment;
- named indexes retain `--index <name>` before the QMD command;
- `status` matches the resolved physical SQLite path;
- `doctor --strict` has no failures or warnings;
- a read without `-c` and a read outside the allowlist fail before QMD starts;
- direct `qmd status`, run with the selector shown by `resolve`, reports the same index;
- watchdog findings do not regress.

## 5. Install the launcher

```bash
bun scripts/install-cli.js --dry-run
bun scripts/install-cli.js
engram --version
```

The installer must point to the production checkout. If the destination already contains a foreign file or symlink, stop: do not replace it manually as part of this rollout.

Repeat the main and leaf canary through `engram` rather than `bun bin/engram`.

## 6. Observation gate

Observe at least four heartbeat cycles before changing call sites. During this window:

- leave hooks, scripts, cron payloads and workspace configs unchanged;
- compare heartbeat and watchdog results with the pre-release baseline;
- confirm that the CLI creates no state and does not touch QMD maintenance;
- treat any physical-index mismatch, policy bypass or unexplained heartbeat regression as a rollback trigger.

Passing this gate validates the operator CLI only. It does not authorize `update` or `embed` migration.

## Rollback

1. Remove the launcher only through the installer from the same release checkout:

   ```bash
   bun scripts/install-cli.js --uninstall --dry-run
   bun scripts/install-cli.js --uninstall
   ```

2. Return the production checkout to the previous release tag.
3. Re-run the existing watchdog and one normal heartbeat cycle.

Legacy hooks and scripts continue using their previous QMD paths throughout rollout, so rollback requires no call-site changes. CLI v1 creates no state. Workspace configs and SQLite indexes need no migration or restoration.

## After the canary

Build dirty-state coordination first, then a host governor for embed concurrency. Migrate legacy call sites only in separate PRs with feature flags and explicit rollback.
