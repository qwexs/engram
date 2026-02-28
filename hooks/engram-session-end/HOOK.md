---
name: engram-session-end
description: "Append <!-- session:end:{ISO} --> to today's daily note when /new or /reset is called"
metadata:
  {
    "openclaw": {
      "emoji": "📕",
      "events": ["command:new", "command:reset"],
      "export": "default"
    }
  }
---

# engram-session-end

Writes a `<!-- session:end:{ISO} -->` watermark to the current daily note when a session ends via `/new` or `/reset`.

Uses `agentId` and `sessionKey` from event context. Falls back to `agent-main/main` if not available.
