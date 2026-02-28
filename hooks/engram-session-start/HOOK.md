---
name: engram-session-start
description: "Append <!-- session:start:{ISO} --> to today's daily note on agent bootstrap"
metadata:
  {
    "openclaw": {
      "emoji": "📗",
      "events": ["agent:bootstrap"],
      "export": "default"
    }
  }
---

# engram-session-start

Writes a `<!-- session:start:{ISO} -->` watermark to today's daily note when a new agent session bootstraps.

Uses `agentId` and `sessionKey` from event context. Falls back to `agent-main/main` if not available.

Runs on `agent:bootstrap` — after `engram-daily-note` (gateway:startup) has already created the file.
