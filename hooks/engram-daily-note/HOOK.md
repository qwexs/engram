---
name: engram-daily-note
description: "Reconcile existing daily-note state on gateway startup without creating empty notes"
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

On gateway startup, scans `memory/agent-*/` directories and reconciles
`lastDailyNoteCreated` only for today's notes that already exist.

It never creates notes for historical or inactive session directories. The
`engram-session-start` hook creates `memory/agent-{id}/{session}/YYYY-MM-DD.md`
lazily when that session actually bootstraps.
