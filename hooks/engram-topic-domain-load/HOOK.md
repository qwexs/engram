---
name: engram-topic-domain-load
description: "On Telegram topic message, inject bound-domain context (decisions, status, changelog) and operational AGENTS ruleset into today's daily note"
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
and inject **TWO blocks** at the top of today's daily note.

## Block 1 — Domain Context (state)

Header: `## Domain Context (auto)`

Contains:
- Domain name and type
- Link to KG entity
- Status.md content (current state of the conversation)
- Last changelog.md entry (what was done/decided)
- Count of decisions in decisions.md

**Source hash**: `sha256(decisions.md + status.md + changelog.md)` (path + mtime + size + content).
Idempotency keyed on this hash.

## Block 2 — Domain AGENTS (ruleset)

Header: `## Domain AGENTS (auto)`

Contains:
- The full body of `memory/domains/{slug}/agents.md` (per-domain operational ruleset:
  QMD default, read/write rules, when to expand beyond the domain, etc.).
- A built-in **fallback** when `agents.md` is missing (so the topic-agent is never
  without rules). A `⚠️` warning note is added to the block when fallback is in use.

**Source hash**: `sha256(domainName + source + agentsBody)`. Stable per source.

## Idempotency

Each block has its own hash and is replaced only when its source changes.
If **both** latest markers in the daily note match their respective hashes, the
hook does nothing. Otherwise, both existing blocks are removed and re-injected.

Sentinel formats:
```
<!-- domain-context:{slug}:{hash} -->
...
<!-- /domain-context -->

<!-- domain-agents:{slug}:{hash} -->
...
<!-- /domain-agents -->
```

## Session path

Daily-note path is computed deterministically as
`memory/agent-{agentId}/telegram-group--{absChatId}-topic-{topicId}/YYYY-MM-DD.md`.

The path does NOT depend on `event.context.sessionKey` — the hook resolves the
chatId/topicId from `event.context.topicId` + `event.context.chatId` (or as a
fallback from `event.context.conversationId = "telegram:{chatId}:topic:{topicId}"`).
The hook fires only when both topicId and chatId are present; regular group
sessions (no topic) and subagent/cron sessions don't match.

## Output location

Top of `memory/agent-{id}/{session}/YYYY-MM-DD.md`, right after
the `# YYYY-MM-DD` heading. Order: Domain Context (state) first, then Domain
AGENTS (ruleset).

## When agents.md is missing

The hook uses a **built-in minimal fallback** so the topic-agent is never
without QMD/write rules. The fallback includes:
- Role declaration (Topic-agent of `{slug}`, session key)
- Default QMD query: `qmd --index <workspace-index> query "<topic>" -c domain-{slug} -c openclaw-memory-agent-{agentId}-{sessionKey}`
- Boundary rules (do NOT use `domains` or `life` without explicit OK)
- Write rules summary

The block shows a `⚠️` warning pointing at
`bun skills/engram/scripts/backfill-domain-agents.js` so the operator knows
they can promote to the full template.

## Backfill

To create `agents.md` for all existing topic-thread domains (or to apply an
updated template to all of them):
```bash
bun skills/engram/scripts/backfill-domain-agents.js             # create missing
bun skills/engram/scripts/backfill-domain-agents.js --force     # overwrite all
bun skills/engram/scripts/backfill-domain-agents.js --domain engram  # one
```

Manual edits in `agents.md` are preserved by default — the backfill script
skips existing files unless `--force` is passed.

## Pair with

- `engram-daily-note` (creates the daily note)
- `engram-session-start` (records the session marker)
- `engram-topic-auto-domain-suggest` (sibling, suggests domain creation for unbound topics)

This hook is the third in that chain.
