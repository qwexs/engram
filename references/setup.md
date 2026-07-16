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
  cron job, restarts the gateway so new hooks take effect, and runs
  `validate.js --quality` as a final integrity check. Use `--dry-run` to
  preview the plan without executing. Use `--with-sample-domain` to also
  scaffold a `getting-started` domain for onboarding.

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

### 2. Create a cron job

Use OpenClaw's cron system (`/cron add` or via API):

```json
{
  "name": "Heartbeat (Engram runner)",
  "schedule": { "kind": "every", "everyMs": 1800000 },
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "agentTurn",
    "message": "Run the engram heartbeat runner for the target workspace.\n\nCall the exec tool with:\n- command: `bun skills/engram/scripts/heartbeat-runner.js --workspace /path/to/workspace --agent-id PLACEHOLDER_AGENT_ID --session main --all-active-sessions --label-prefix PLACEHOLDER_LABEL_PREFIX --timeout-ms 300000 --recover-stale-oll-locks`\n- workdir: `/path/to/workspace`\n- timeout: 900 seconds\n\nThe runner is self-contained and deterministic. After exec returns, post a one-line summary in this format:\n\n`status=... extraction=... domains=... oll=... maintenance=...`\n\nIf exec fails, report the error message verbatim and stop.",
    "timeoutSeconds": 900,
    "lightContext": true
  },
  "delivery": { "mode": "none" }
}
```

Replace `/path/to/workspace`, `--agent-id`, `--session`, and `--label-prefix`
for the target agent/workspace. The runner prints `HEARTBEAT_OK` when it
finishes, so the cron job can stay silent unless the OpenClaw cron layer reports
an execution failure.

`payload.model` is intentionally omitted from the example. When unset, the
agent turn uses the workspace's active model (whatever model the agent would
pick for any other turn). To pin a specific model for the cron turn, add a
`"model": "<model-id>"` field using a model id available in your OpenClaw
runtime, or set `engram.json → models.heartbeat.orchestrator` when using
`install-cron.js`. Note that the heartbeat **subagents** (hb-extract, hb-synthesis,
hb-domains, hb-rethink, hb-autoresearch, hb-rethink2) pick their own models
separately via `engram.json → models.heartbeat.subagents` or the
`ENGRAM_MODEL_<LABEL>` env vars; see SKILL.md §Subagent Model Resolution.

`HEARTBEAT.md` remains the detailed protocol/reference for agents and future
runner phases. It is not the production cron entrypoint.

### Runner behavior

`scripts/heartbeat-runner.js` currently handles:

- heartbeat lock and stale-lock reset
- canonical daily note creation and extraction watermark update
- weekly summary rebuild on Mondays via `rebuild-summaries.js --apply-decay`
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

Engram ships 8 hooks under `skills/engram/hooks/`:

- `engram-bootstrap-qmd`, `engram-daily-note`, `engram-message-log`
- `engram-session-start`, `engram-session-end`, `engram-session-memory`
- `engram-topic-domain-load`, `engram-peer-domain-load`

OpenClaw 2026.6.6 loads hooks from its **managed hooks directory** —
`~/clawd/hooks/` on Windows (`%USERPROFILE%\clawd\hooks\`,
`CONFIG_DIR/hooks` in OpenClaw terms). The loader scans that path on
gateway startup; hooks that exist there as **regular directories** with
`handler.js` + `HOOK.md` register as `openclaw-workspace` source.

### Source vs runtime layout

Hooks live in two places with intentionally different layouts:

- **Source** (`skills/engram/hooks/<name>/handler.ts`) — what you read,
  edit, and commit. **Only `.ts` files live here**; there are no
  pre-built `.js` artifacts in the repo. Keeping the source `.ts`-only
  means no consistency work between two parallel files per hook.
- **Runtime** (`<workspace>/hooks/<name>/handler.js` + `HOOK.md`) —
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

Use `scripts/install-hooks.js` to mirror the skill's hooks into
`~/clawd/hooks/`. Default mode is **regular copy** — this is the mode
that actually loads on OpenClaw 2026.6.6.

```bash
bun skills/engram/scripts/install-hooks.js            # install all 8
bun skills/engram/scripts/install-hooks.js --dry-run  # preview, no changes
bun skills/engram/scripts/install-hooks.js --force    # overwrite existing entries
openclaw gateway restart
bun scripts/install-hooks.js --dry-run                # should report 'created: 8' (idempotent)
openclaw hooks list                                   # should show 11/13 ready
```

After `openclaw gateway restart`, `openclaw hooks list` should report
13 entries (5 bundled + 8 engram-workspace, 11 ready — `session-memory`
and `engram-message-log` are disabled by config).

`init.js --with-cron --auto-detect-sessions` already calls
`install-hooks.js` for you during first-time setup (and restarts the
gateway so new hooks take effect immediately). You only need to run
`install-hooks.js` manually after `git pull`, after editing
`handler.ts`, or after adding a new hook.

### Multi-workspace install

If you run multiple OpenClaw workspaces on the same host (each with its
own `hooks/`), the script autodetects the target via
`openclaw hooks info`, which always returns the gateway's primary
workspace (`~/clawd/hooks`). To install into additional workspaces,
pass `--hooks-dir` explicitly:

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

### Install (manual)

If you cannot run the script, copy by hand:

```bash
cp -r skills/engram/hooks/engram-* ~/clawd/hooks/
openclaw gateway restart
```

This is the same operation the script performs under `--dry-run=false`.

### Why not junctions?

An earlier design (`install-hooks.js --link`, and a 2f7c6c6-era
`scripts/init.js`) created **NTFS junctions** instead of copies. Empirically
this did NOT load on OpenClaw 2026.6.6 — the gateway reported the hooks as
registered, but `"loaded N internal hook handlers"` stayed at the bundled
count and `engram-topic-domain-load` (the hook this skill depends on) never
fired. Cause: OpenClaw's loader + dynamic `import()` cache-busting do not
follow the reparse point consistently on Windows. `--link` is preserved as
an opt-in escape hatch for future OpenClaw releases but is **not the default**.

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
openclaw hooks list          # 11/13 ready, engram-* hooks show openclaw-workspace
bun scripts/validate.js      # Errors: 0, "All 8 engram hooks installed in …"
```

## Troubleshooting

### Rethink stuck (rethinkInProgress: true for >2h)

If `heartbeat-state.json` shows `rethinkInProgress: true` with a stale
`rethinkStartedAt` (more than 2 hours ago), the rethink subagent failed
without producing a handoff. The heartbeat runner includes
`--recover-stale-oll-locks` which auto-clears stale locks after a 2h TTL.

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

### Cron payload missing --recover-stale-oll-locks

Re-install the cron to get the latest payload:
```bash
bun skills/engram/scripts/install-cron.js install --agent-id <id> --workspace <path> --schedule <expr>
```
The install script is idempotent and will update the payload message
without touching schedule, model, or delivery settings.
