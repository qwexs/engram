# Engram Setup Guide

## Prerequisites
- OpenClaw installed and running
- QMD installed (`bun skills/engram/scripts/install-qmd.js`)
- Engram init run:
  ```bash
  bun skills/engram/scripts/init.js --with-cron --auto-detect-sessions
  ```
  This single invocation creates the full memory structure (directories,
  templates, registry defaults, QMD collections, hooks), auto-detects
  sessions from `openclaw.json` → `bindings[]`, installs the heartbeat
  cron job, restarts the gateway, and verifies that all canonical hooks are
  registered and the OLL rule/rollback hooks are eligible and loadable. It
  also runs `validate.js --quality` as a final integrity check. Use `--dry-run` to
  preview the plan without executing. Use `--with-sample-domain` to also
  scaffold a `getting-started` domain for onboarding.
  Run from the target workspace or pass `--workspace /path/to/workspace`.
  Init creates and verifies `skills/engram` as a symlink to the canonical
  skill so the generated cron entrypoints are available immediately.

## OLL clean-install contract

`init.js` is the canonical workspace installer. A successful fresh init:

- writes the OLL configuration with `scheduleOwner=nightly`,
  `nightly.enabled=true`, and `adaptation.mode=active`;
- writes matching `oll-nightly-state.v1` and
  `oll.workspace-rollout-state.v1` fresh-init projections;
- creates the managed adaptation state directories and immutable fresh-init
  legacy-admission marker;
- installs all 11 Engram hooks, including `engram-rule-context-load` and
  `engram-rule-rollback`;
- restarts the gateway and fails the init if either required OLL hook is absent,
  ineligible, or unloadable in `openclaw hooks list --json`;
- optionally installs only the deterministic non-OLL heartbeat cron through
  `--with-cron`.

Fresh init deliberately does **not** create deployment-specific actor/fleet
registries or install a second nightly scheduler. It publishes the workspace as
enabled/active so the deployment-owned scheduler can discover it immediately
after registry enrollment. Candidate-memory materialization remains separately
disabled and rollout-gated.

## Heartbeat via Cron (Recommended)

Engram's heartbeat runner should run as an isolated OpenClaw cron job.
The cron turn should execute `scripts/heartbeat-runner.js` directly and should
not ask an LLM to interpret `HEARTBEAT.md`. This keeps critical state writes,
watermarks, reports, validation, and QMD indexing deterministic.

### 1. Disable native heartbeat

In `openclaw.json`:
```json
{
  "agents": {
    "defaults": {
      "heartbeat": { "every": "0" }
    }
  }
}
```

### 2. Install the deterministic workspace heartbeat

Do not hand-author the cron payload. Use the canonical installer so fresh
workspaces cannot inherit legacy OLL flags:

```bash
bun skills/engram/scripts/install-deterministic-heartbeat-cron.js \
  --workspace /path/to/workspace \
  --agent-id PLACEHOLDER_AGENT_ID \
  --schedule '*/30 * * * *'
```

The generated job runs only deterministic per-workspace maintenance (including
`hb-domains-write`). It deliberately omits legacy rethink, rethink2,
autoresearch, and stale-OLL-lock recovery flags. Nightly OLL is provisioned once
at fleet level through `install-oll-nightly-cron.ts`, with explicit deployment
acknowledgement; it is never added as a second per-workspace cron.

The deterministic heartbeat payload does not pin a model. Any child phases
that remain enabled resolve models by canonical phase through
`engram.json → models.heartbeat.subagents`; see SKILL.md §Subagent Model
Resolution.

`HEARTBEAT.md` remains the detailed protocol/reference for agents and future
runner phases. It is not the production cron entrypoint.

### Runner behavior

`scripts/heartbeat-runner.js` currently handles:

- heartbeat lock and stale-lock reset
- canonical daily note creation and extraction watermark update
- immutable v2 archive checks; weekly summary rebuild is retired
- heartbeat report updates
- `validate.js --fix`, `qmd update`, and `qmd embed`

Use `--no-embed` for diagnostics or constrained machines. Use `--no-fix` when
you want validation to report without applying automatic repairs.

### Workspace-level heartbeat

For workspaces with multiple active sessions, run the same deterministic runner
with `--all-active-sessions`. The runner reads `activeSessions` from
`memory/heartbeat-state.json`, runs extraction and heartbeat reports for each
listed session, then runs workspace phases once: synthesis, domains, OLL,
validation, `qmd update`, and `qmd embed`.

```json
{
  "activeSessions": ["main", "telegram-group--123", "telegram-bot-456"]
}
```

```bash
bun skills/engram/scripts/heartbeat-runner.js \
  --workspace /path/to/workspace \
  --agent-id my-agent \
  --session main \
  --all-active-sessions \
  --label-prefix my-agent-hb \
  --timeout-ms 300000
```

Use `--active-sessions main,telegram-group--123` to override the state file for
one diagnostic run.

If a workspace uses a named QMD index or needs collection scoping, configure it
in `engram.json`:

```json
{
  "agent": "agent-my-agent",
  "qmd": {
    "command": "qmd",
    "index": "my-index",
    "collections": ["life", "openclaw-memory-agent-my-agent-main"]
  }
}
```

On Windows cron/node environments, set `qmd.command` to the absolute `qmd.cmd`
path if `qmd` is available in an interactive shell but not visible to the
runner.

## Hooks

Engram ships 11 hooks under `skills/engram/hooks/`:

- `engram-bootstrap-qmd`, `engram-daily-note`, `engram-message-log`
- `engram-session-start`, `engram-session-end`, `engram-session-memory`
- `engram-topic-domain-load`, `engram-peer-domain-load`,
  `engram-rule-context-load`, `engram-rule-rollback`, `engram-kg-context-load`

OpenClaw loads hooks from its **managed hooks directory** (`managedHooksDir`
in `openclaw hooks list --json`, normally `CONFIG_DIR/hooks`). The loader scans that path on
gateway startup; hooks that exist there as **regular directories** with
`handler.js` + `HOOK.md` register as `openclaw-managed` source.

### Source vs runtime layout

Hooks live in two places with intentionally different layouts:

- **Source** (`skills/engram/hooks/<name>/handler.ts`) — what you read,
  edit, and commit. **Only `.ts` files live here**; there are no
  pre-built `.js` artifacts in the repo. Keeping the source `.ts`-only
  means no consistency work between two parallel files per hook.
- **Runtime** (`<managedHooksDir>/<name>/handler.js` + `HOOK.md`) —
  what OpenClaw actually loads. **Only `.js` files live here**, plus
  `HOOK.md`. `.ts` files in the runtime dir are not loaded and are
  actively cleaned up by `install-hooks.js`.

The runtime `handler.js` is derived from source via
`bun build --target=node --format=esm`. The build happens inside
`install-hooks.js`, in a per-hook temp dir (`os.tmpdir()`), and the
resulting `.js` is copied into the runtime hooks dir. The temp dir is
removed after install; nothing derived is ever written to source.

Because the build step needs **bun** at install time, bun is the only
hard runtime dependency for hooks. Once installed, the runtime is
plain Node.js — OpenClaw's loader does not need bun.

### Install (recommended)

Use `scripts/install-hooks.js` to mirror the skill's hooks into the discovered
managed hooks directory. Default mode is **regular copy**.

```bash
bun skills/engram/scripts/install-hooks.js            # install all 11 on a fresh target
bun skills/engram/scripts/install-hooks.js --dry-run  # preview, no changes
bun skills/engram/scripts/install-hooks.js --force    # overwrite existing entries
openclaw gateway restart
bun scripts/install-hooks.js --dry-run                # should enumerate 11 managed Engram hooks
openclaw hooks list --json                            # should include rule and KG context loaders
```

After `openclaw gateway restart`, `openclaw hooks list --json` must include all
11 Engram entries. `engram-rule-context-load` and `engram-rule-rollback` must
be eligible and loadable. `engram-message-log` may remain disabled by
configuration; the context loaders inject only in their independently
authorized modes.

`init.js --with-cron --auto-detect-sessions` already calls
`install-hooks.js` for you during first-time setup (and restarts the
gateway so new hooks take effect immediately). You only need to run
`install-hooks.js` manually after `git pull`, after editing
`handler.ts`, or after adding a new hook.

### Multi-workspace install

Gateways sharing one OpenClaw state directory share one managed hook set. If
you run isolated OpenClaw state roots on the same host, execute the installer
inside each gateway environment or pass its exact hooks directory explicitly:

```bash
cd ~/workspace-b
bun skills/engram/scripts/install-hooks.js --hooks-dir ~/workspace-b/hooks
cd ~/workspace-c
bun skills/engram/scripts/install-hooks.js --hooks-dir ~/workspace-c/hooks
cd ~/workspace-d
bun skills/engram/scripts/install-hooks.js --hooks-dir ~/workspace-d/hooks
```

Use synthetic placeholders like `workspace-b/c/d` if you're writing
docs for a public repo — the personal-data linter (`.githooks/pre-commit`)
rejects workspace-specific names like `<agent-a>` or `<agent-b>` as
`reserved-agent-id` patterns.

### Install

Always use the installer. Source hooks are TypeScript; it builds the runtime
`handler.js`, backs up an existing managed entry, and installs the complete
eleven-hook set. A direct `cp -r` from the source tree is unsupported and can
leave stale or missing runtime handlers:

```bash
bun skills/engram/scripts/install-hooks.js --force
openclaw gateway restart
```

### Why not junctions?

An earlier design (`install-hooks.js --link`, and a 2f7c6c6-era
`scripts/init.js`) created **NTFS junctions** instead of copies. Empirically
this did NOT load on OpenClaw 2026.6.6 — the gateway reported the hooks as
registered, but `"loaded N internal hook handlers"` stayed at the bundled
count and `engram-topic-domain-load` (the hook this skill depends on) never
fired. Cause: OpenClaw's loader + dynamic `import()` cache-busting do not
follow the reparse point consistently on Windows. `--link` was removed;
regular copy is the only supported mode.

### Why not `hooks.internal.load.extraDirs`?

Do NOT add `~/.openclaw/openclaw.json` → `hooks.internal.load.extraDirs`.
The schema accepts the value and `validate` is clean, but **the gateway
crashes on startup** when `extraDirs` is set on Windows 2026.6.6. This is a
known runtime crash, not a config error. Keep `extraDirs` empty and rely on
the managed hooks directory.

### Enable / disable individual hooks

In `~/.openclaw/openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": { "enabled": false },
        "engram-session-memory": {
          "enabled": true,
          "messages": 40
        },
        "engram-message-log": { "enabled": false },
        "engram-topic-domain-load": { "enabled": true }
      }
    }
  }
}
```

The skill's `engram-session-memory` hook replaces the built-in
`session-memory` hook and saves transcripts inside
`memory/agent-{id}/{session}/sessions/` (QMD-indexed).

### Verify

After install + restart, both should be true:

```bash
openclaw hooks list --json   # all 11 hooks; OLL rule/rollback pair loadable
bun scripts/validate.js      # Errors: 0
```

## Troubleshooting

### Legacy rethink lock remains before cutover

This section applies only to a pre-cutover legacy workspace. Do not repair it
by installing a new heartbeat payload with legacy OLL flags. Run the reviewed
`oll-legacy-cutover.ts` plan/apply flow so the old state is backed up and
quarantined before nightly ownership is established.

Manual fix:
```bash
python3 -c "
import json
with open('memory/heartbeat-state.json','r') as f: s=json.load(f)
s['rethinkInProgress']=False; s['rethinkStartedAt']=None
with open('memory/heartbeat-state.json','w') as f: json.dump(s,f,indent=2)+'\n'
"
```

### activeSessions empty — extraction not running

If `activeSessions` in `heartbeat-state.json` is `[]` or missing,
`--all-active-sessions` falls back to `["main"]` and extraction looks
in the wrong session directory. The `engram-session-start` hook now
auto-registers sessions on first message, but for pre-existing sessions
you need to add them manually:

```bash
python3 -c "
import json
with open('memory/heartbeat-state.json','r') as f: s=json.load(f)
if 'activeSessions' not in s: s['activeSessions']=[]
if 'telegram-direct-<USER_ID>' not in s['activeSessions']:
    s['activeSessions'].append('telegram-direct-<USER_ID>')
with open('memory/heartbeat-state.json','w') as f: json.dump(s,f,indent=2)+'\n'
"
```

### Domain files (decisions/status/changelog) empty

Domain files are written by the **agent itself** during conversations,
not by the heartbeat runner. The `engram-topic-domain-load` and
`engram-peer-domain-load` hooks inject Domain Context + AGENTS (including
write rules) into the session via system event. If files stay empty:

1. Check the domain is registered in `memory/domains/registry.json`
2. Check the hook is enabled in `openclaw.json`
3. Check the agent received the system event (look for `<!-- engram-system-event-hash:... -->` in the daily note)
4. Ensure the model/provider is working (subagent failures prevent writing)

### Cron payload still contains legacy OLL admission flags

Replace it with the deterministic heartbeat installer:
```bash
bun skills/engram/scripts/install-deterministic-heartbeat-cron.js \
  --agent-id <id> --workspace <path> --schedule <expr>
```
The generated script must not contain `--spawn-rethink`, `--spawn-rethink2`,
`--spawn-autoresearch`, or `--recover-stale-oll-locks`.
