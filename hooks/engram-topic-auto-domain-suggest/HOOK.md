---
name: engram-topic-auto-domain-suggest
description: "On Telegram topic message, when topic is unbound, suggest creating a domain. Two triggers: (a) fast path on service-message 'topic created' (skips the counter, suggests on first user message), (b) slow path after ≥2 user messages accumulated."
metadata:
  {
    "openclaw": {
      "emoji": "💡",
      "events": ["message:received"],
      "export": "default"
    }
  }
---

# engram-topic-auto-domain-suggest

Suggests creating a domain for a Telegram topic that doesn't have one bound
yet. The agent (the topic session, or main if main processes the message)
reads the suggestion block on its next iteration and offers the user to
create a domain via the `message` tool (inline buttons or free text).

Two triggers, both with the same end effect (inject a `## engram:auto-suggest`
block into the daily note):

1. **Fast path** — service-message "X created the topic Y" (Telegram forum
   topic creation). The hook writes a one-shot hint file in `sessionDir`
   and returns; the NEXT `message:received` (the first user message in the
   new topic) consumes the hint and injects the suggest block immediately.
2. **Slow path** — ≥2 inbound user messages accumulated for today
   (counter file `.engram-msg-count-YYYYMMDD`).

The fast path exists so that a freshly-created topic doesn't have to wait
for the second user message to be asked. The slow path remains as a fallback
for topics that already exist (bot added to existing forum, no service
message seen at creation time).

This hook is a **sibling** to `engram-topic-domain-load`:
- `engram-topic-domain-load` injects the `## Domain Context (auto)` block **when a
  domain already exists** for the topic (the daily note gets a tail of decisions /
  status / changelog).
- `engram-topic-auto-domain-suggest` injects a `## engram:auto-suggest` block
  **when no domain exists**, asking the user to create one.

## When it fires

On `message:received` in a Telegram topic session, if:
- the topic has no bound domain in `memory/domains/registry.json`, AND
- the message is not from a bot (`event.context.fromBot !== true`; defensive
  for bot-initiated topic creations via `createForumTopic` action), AND
- one of:
  - **fast path** — the inbound `content` matches a Telegram topic-creation
    service-message pattern (English: `created (?:a |the )?topic`, Russian:
    `создал(?:а)? тему` etc.) AND `event.context.metadata.topicName` is set
    (openclaw populates this from its internal topic-name cache when the raw
    message has `forum_topic_created`). Hint file
    `.engram-topic-created-YYYYMMDD` is written in `sessionDir`; the next
    `message:received` consumes it and injects the block. OR
  - **slow path** — ≥2 inbound user messages counted for today (per-session
    counter file `.engram-msg-count-YYYYMMDD` incremented on each fire;
    intentionally **not** based on `- ` bullets in the daily note, since those
    represent agent-written events and would never accumulate for unbound
    topics with no agent memory), AND
- no `<!-- engram:auto-suggest-shown:YYYYMMDD -->` sentinel exists in the note
  (one suggestion per UTC day, per topic).

### Service-message detection

Telegram forum-topic creation produces a service message "X created the
topic \"Y\"" (locale-dependent). openclaw's hook context does NOT expose a
programmatic `is_topic_creation` flag — only the rendered text in
`event.context.content` plus `metadata.topicName`. We also require
`metadata.topicName` to be set, which openclaw populates from its internal
cache when the raw message has `forum_topic_created`. False positives are
extremely rare in practice; false negatives are caught by the slow path.

### Bot-initiated topics (R2 mitigation)

When the bot itself creates a topic via `createForumTopic` action, the
service-message arrives with `event.context.fromBot === true`. The hook
skips in that case (defensive — the bot already knows the binding, since
it just created the topic + ran add-domain).

## What it injects

A `## engram:auto-suggest` block at the top of the daily note (after
`# YYYY-MM-DD`), containing:
- chatId / topicId / topic name
- suggested slug (slugified topic name + `-{chatId}-{topicId}` suffix for
  uniqueness; falls back to `topic-{chatId}-{topicId}` for Cyrillic / empty
  / non-[a-z] starts)
- available KG projects (if `life/projects/` exists)
- instructions for the agent to use `message` tool to ask the user
- copy-pasteable `add-domain.js --pending` command

The block copy is different for fast-path vs slow-path triggers (fast-path
emphasizes "topic was just created", slow-path emphasizes "N messages
accumulated"). The hash includes `trigger=fast|slow` so the slow path
later in the day doesn't collide on the same hash.

The block is keyed by a short content hash
(sha256 of chatId+topicId+messageCount+today+trigger). Re-injects only when
the hash changes. Atomic write via temp + rename (no race with
engram-session-start).

## Idempotency

- Bound topics: no-op (skipped before the count).
- Bot-initiated events: skipped via `fromBot` check.
- Same day, same message count + same trigger: no-op (hash matches, day
  sentinel matches).
- Same day, count grew: re-inject with new hash.
- Next day: day sentinel changes → suggestion can fire again if topic still
  unbound.
- Hint file is one-shot: deleted on first consumption by a subsequent
  `message:received`.

## Pair with

- `engram-daily-note` (creates the daily note with `## Events` section this
  hook reads).
- `engram-topic-domain-load` (the bound counterpart).
- The agent (in its session prompt / `workspace/topic-domain-conventions.md`)
  needs to know to read the auto-suggest block and act on it.

## Lifecycle

When the user accepts the inline-button ask, the agent runs
`add-domain.js --pending --topic <chatId>:<topicId>` to create a domain
flagged `pending: true` in `registry.json`. The operator (or the user
themselves) later runs `promote-domain.js --domain <slug>` to remove the
pending flag once the topic has earned its domain. The new domain is then
picked up by `engram-topic-domain-load` on the next message. The auto-suggest
block stays in the daily note for that day (or is manually cleared by the
agent on accept/decline).

## Etalon-bootstrap semantics

On a clean install, this hook works out of the box: any Telegram forum topic
created by any user in any group the bot is in will trigger the fast path.
No per-workspace configuration needed. The bot-id check (R2) is a defensive
filter for `createForumTopic`-initiated topics and does not require any
workspace state.

If the operator wants to disable auto-suggest globally (e.g., for a
workspace that only ever uses manually-bound domains), they can:
- remove this hook via `openclaw hooks disable engram-topic-auto-domain-suggest`, or
- delete the hook directory entirely.
