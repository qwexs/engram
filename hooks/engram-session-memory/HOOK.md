---
name: engram-session-memory
description: "Save session transcript to memory/agent-{id}/{session}/sessions/ on /new or /reset. Replaces the built-in session-memory hook."
metadata:
  {
    "openclaw": {
      "emoji": "💾",
      "events": ["command:new", "command:reset"],
      "export": "default"
    }
  }
---

# engram-session-memory

Saves the last N messages of a session to `memory/agent-{id}/{session}/sessions/YYYY-MM-DD-{slug}.md`
when `/new` or `/reset` is issued.

**Why**: The built-in `session-memory` hook writes to `memory/` root, outside QMD collections.
This hook writes inside `memory/agent-main/main/sessions/` so the files are indexed by QMD
and searchable via `qmd query "topic" -c openclaw-memory-agent-main-main`.

## Configuration

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

## Output path

```
memory/
  agent-main/
    main/
      sessions/
        2026-03-08-batch-tool-integration.md
        2026-03-07-cloudflare-code-mode.md
```

## Slug generation

Slug is derived from the **first user message** of the session (lowercase, spaces→dashes, 40 chars max).
No LLM call needed — deterministic and fast.

## Notes

- Skips subagent and cron sessions
- Skips sessions with no content
- Does not overwrite existing files with same slug/date (append timestamp suffix if needed)
- `messages` config controls how many messages to include (default: 40)
