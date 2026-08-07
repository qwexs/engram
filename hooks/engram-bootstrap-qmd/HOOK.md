---
name: engram-bootstrap-qmd
description: "Declare bootstrap QMD ownership without running maintenance"
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

Never runs QMD maintenance. Interactive and ephemeral bootstrap events leave
index freshness to the configured workspace/global scheduler so lifecycle
hooks cannot race a physical-index coordinator.

Timeout: 15s. If qmd is unavailable or fails — silently skips (no error).
