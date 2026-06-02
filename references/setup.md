# Engram Setup Guide

## Prerequisites
- OpenClaw installed and running
- QMD installed (`bun skills/engram/scripts/install-qmd.js`)
- Engram init run (`bun skills/engram/scripts/init.js`)

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
    "message": "Call the exec tool exactly once with this JavaScript source:\n\nconst out = await tools.shell_command({\n  command: \"bun ./skills/engram/scripts/heartbeat-runner.js --workspace /path/to/workspace --agent-id main --session main --label-prefix hb --timeout-ms 300000\",\n  workdir: \"/path/to/workspace\",\n  timeout_ms: 900000\n});\ntext(out);\n\nAfter exec completes, reply with the exact exec output only. Do not read HEARTBEAT.md. Do not run any other tool.",
    "model": "openai/gpt-5.5",
    "timeoutSeconds": 900
  },
  "delivery": { "mode": "none" }
}
```

Replace `/path/to/workspace`, `--agent-id`, `--session`, and `--label-prefix`
for the target agent/workspace. The runner prints `HEARTBEAT_OK` when it
finishes, so the cron job can stay silent unless the OpenClaw cron layer reports
an execution failure.

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

## Session Memory Hook

Engram ships `engram-session-memory` hook that replaces the built-in `session-memory` hook.
The difference: saves transcripts inside `memory/agent-main/{session}/sessions/` (QMD-indexed).

### Enable engram-session-memory

In `openclaw.json`:
```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": { "enabled": false },
        "engram-session-memory": {
          "enabled": true,
          "messages": 40
        }
      }
    }
  }
}
```

The hook is installed automatically by `scripts/init.js`. To install manually:
```bash
cp -r skills/engram/hooks/engram-* hooks/
```
