---
name: engram-session-start
description: "Append <!-- session:start:{ISO} --> to today's daily note on agent bootstrap, and (ISS-10) silently auto-create a domain for unbound Telegram topics on first bootstrap."
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

## ISS-10 piggy-back: auto-create domain for Telegram topics

For session keys matching `telegram-group-<chatId>-topic-<topicId>`, the hook also:

1. Reads `<workspaceDir>/memory/domains/registry.json` (BOM-tolerant).
2. If no existing domain already binds `(chatId, topicId)` → spawns `bun ~/clawd/skills/engram/scripts/add-domain.js --type topic-thread --domain topic-<chatId>-<topicId> --topic <chatId>:<topicId> --description auto-bound`.
3. On success pushes a single neutral status string into `event.messages`:
   `🧠 Домен \`topic-...\` создан автоматически для этого топика.`

This piggy-backs on `agent:bootstrap` because it already fires reliably for every
new topic session (verified — see ISS-10). A separate `message:received` hook did
not get called for our group topics in practice, so we collapsed the feature here.
