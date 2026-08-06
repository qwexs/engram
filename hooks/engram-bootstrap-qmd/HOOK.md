---
name: engram-bootstrap-qmd
description: "Run qmd update before interactive agent bootstrap to ensure fresh search indexes"
metadata:
  {
    "openclaw": {
      "emoji": "🔍",
      "events": ["agent:bootstrap"],
      "export": "default",
      "requires": {
        "anyBins": ["qmd"]
      }
    }
  }
---

# engram-bootstrap-qmd

Runs `qmd update` synchronously before bootstrap files are injected into an interactive agent session, ensuring BM25 indexes are fresh for any QMD queries during the session.

Cron, heartbeat, subagent, and other ephemeral runtime sessions are skipped. Cron-driven Engram heartbeat performs its single `qmd update` in Phase 4; running bootstrap maintenance as well would duplicate the same update in one heartbeat turn.

Timeout: 15s. If qmd is unavailable or fails — silently skips (no error).
