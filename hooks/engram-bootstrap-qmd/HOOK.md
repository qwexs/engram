---
name: engram-bootstrap-qmd
description: "Run qmd update before agent bootstrap to ensure fresh search indexes"
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

Runs `qmd update` synchronously before bootstrap files are injected into the agent, ensuring BM25 indexes are fresh for any QMD queries during the session.

Timeout: 15s. If qmd is unavailable or fails — silently skips (no error).
