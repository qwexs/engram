---
name: engram-rule-context-load
description: "On agent:bootstrap, inject only active managed OLL rules matching the resolved company, workspace, domain, and person scope."
metadata:
  openclaw:
    events: ["agent:bootstrap"]
---

# Engram managed rule context

Runs only when `oll.adaptation.mode` is `active`. Resolves the bootstrap target
from runtime-owned session metadata, loads the complete matching active rule
set, blocks conflicts, enforces the configured byte cap without truncation,
and appends the resolved block to `event.messages`.

Person-private rules require one exact actor-registry binding and are never
injected into group or topic sessions. Conflict artifacts are written under
`memory-state/oll/context-conflicts/` for review.
