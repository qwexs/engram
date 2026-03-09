# Engram Setup Guide

## Prerequisites
- OpenClaw installed and running
- QMD installed (`bun skills/engram/scripts/install-qmd.js`)
- Engram init run (`bun skills/engram/scripts/init.js`)

## Heartbeat via Cron (Recommended)

Engram's heartbeat orchestrator runs best as an isolated OpenClaw cron job.
This keeps the heartbeat in a separate context window, away from the main session.

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
  "name": "Heartbeat (isolated)",
  "schedule": { "kind": "every", "everyMs": 1800000 },
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "message": "You are the heartbeat orchestrator. Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
    "model": "claude-sonnet-4-6",
    "timeoutSeconds": 300
  },
  "delivery": { "mode": "announce" }
}
```

The heartbeat prompt matches the built-in heartbeat prompt — OpenClaw recognizes `HEARTBEAT_OK` responses.

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
