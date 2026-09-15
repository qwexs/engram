---
name: engram-session-start
description: "Append <!-- session:start:{ISO} --> to today's daily note on agent bootstrap."
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

Runs on `agent:bootstrap` and creates today's note lazily for this concrete
session when it does not exist. Gateway startup does not pre-create notes for
historical session directories.

The hook does not create topic domains or change Memory Worker bindings. Topic
creation is an explicit `add-domain.js` operation; in an active project workspace
that operation also configures the exact QMD collections and Worker binding.
