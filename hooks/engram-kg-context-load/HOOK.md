---
name: engram-kg-context-load
description: Guarded KG v3 current context injection for authorized primary bootstrap sessions
metadata:
  openclaw:
    events: ["agent:bootstrap"]
---

Injects only the guarded `life/v3/current-summary.md` projection. Missing or
invalid authority/context manifests, non-primary sessions, archive references,
and oversized projections are terminal no-ops. The hook projects the bounded
context through `context.bootstrapFiles` for current OpenClaw/Codex runtimes
and retains the legacy `event.messages` carrier.
