---
name: engram-daily-note
description: "Create today's daily note for all agents on gateway startup"
metadata:
  {
    "openclaw": {
      "emoji": "📅",
      "events": ["gateway:startup"],
      "export": "default"
    }
  }
---

# engram-daily-note

On gateway startup, scans `memory/agent-*/` directories and creates today's daily note for each agent's `main` session if it doesn't exist.

Supports session isolation: creates notes in `memory/agent-{id}/main/YYYY-MM-DD.md`.
