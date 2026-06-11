---
name: engram-topic-domain-load
description: "On Telegram topic message, inject bound-domain context (decisions, status, changelog) into today's daily note"
metadata:
  {
    "openclaw": {
      "emoji": "🧠",
      "events": ["message:received"],
      "export": "default"
    }
  }
---

# engram-topic-domain-load

When a message arrives in a Telegram topic session, look up the domain bound to
that topic via `memory/domains/registry.json` (entry has `topic: { chatId, topicId }`)
and inject a `## Domain Context (auto)` block at the top of today's daily note.

The block contains:
- Domain name and type
- Link to KG entity
- Status.md content (current state of the conversation)
- Last changelog.md entry (what was done/decided)
- Count of decisions in decisions.md

**Idempotency**: block is keyed by content hash of (decisions + status + changelog).
If the latest block has the same hash, the hook does nothing. The block is replaced
on every change.

**Session path**: the hook computes the daily-note path deterministically as
`memory/agent-{agentId}/telegram-group--{absChatId}-topic-{topicId}/YYYY-MM-DD.md`
(e.g. `memory/agent-<agentId>/telegram-group--<absChatId>-topic-<topicId>/YYYY-MM-DD.md`).
The path does NOT depend on `event.context.sessionKey` — the hook resolves the
chatId/topicId from `event.context.topicId` + `event.context.chatId` (or as a
fallback from `event.context.conversationId = "telegram:{chatId}:topic:{topicId}"`).
The hook fires only when both topicId and chatId are present; regular group
sessions (no topic) and subagent/cron sessions don't match.

**Output location**: top of `memory/agent-{id}/{session}/YYYY-MM-DD.md`, right after
the `# YYYY-MM-DD` heading. The agent reads the daily note at session start and
sees the domain context first.

**Pair with**: engram-daily-note (creates the daily note), engram-session-start
(records the session marker). This hook is the third in that chain.
