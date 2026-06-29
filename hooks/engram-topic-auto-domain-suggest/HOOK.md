---
name: engram-topic-auto-domain-suggest
description: "On Telegram topic message, when topic is unbound and ≥2 user messages accumulated, inject a 'create a domain' suggestion block into the daily note for the agent to mediate"
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

Suggests creating a domain for a Telegram topic that has accumulated user messages
without being bound to any. The agent (the topic session, or main if main processes
the message) reads the suggestion block on its next iteration and offers the user
to create a domain via the `message` tool (inline buttons or free text).

This hook is a **sibling** to `engram-topic-domain-load`:
- `engram-topic-domain-load` injects the `## Domain Context (auto)` block **when a
  domain already exists** for the topic (the daily note gets a tail of decisions /
  status / changelog).
- `engram-topic-auto-domain-suggest` injects a `## engram:auto-suggest` block
  **when no domain exists** but ≥2 user messages have accumulated (asking the
  user to create one).

## When it fires

On `message:received` in a Telegram topic session, if:
- the topic has no bound domain in `memory/domains/registry.json`, AND
- ≥2 inbound user messages have been counted for today (via per-session
  counter file `.engram-msg-count-YYYYMMDD` incremented on each fire;
  intentionally **not** based on `- ` bullets in the daily note, since those
  represent agent-written events and would never accumulate for unbound
  topics with no agent memory), AND
- no `<!-- engram:auto-suggest-shown:YYYYMMDD -->` sentinel exists in the note
  (one suggestion per UTC day, per topic).

## What it injects

A `## engram:auto-suggest` block at the top of the daily note (after
`# YYYY-MM-DD`), containing:
- chatId / topicId
- suggested slug (`topic-{chatIdShort}-{topicId}`)
- available KG projects (if `life/projects/` exists)
- instructions for the agent to use `message` tool to ask the user
- copy-pasteable `add-domain.js` command

The block is keyed by a short content hash (sha256 of chatId+topicId+messageCount+today).
Re-injects only when the hash changes (e.g. message count grows). Atomic write
via temp + rename (no race with engram-session-start).

## Idempotency

- Bound topics: no-op (skipped before the count).
- Same day, same message count: no-op (hash matches, day sentinel matches).
- Same day, count grew: re-inject with new hash.
- Next day: day sentinel changes → suggestion can fire again if topic still unbound.

## Pair with

- `engram-daily-note` (creates the daily note with `## Events` section this
  hook reads).
- `engram-topic-domain-load` (the bound counterpart).
- The agent (in its session prompt / `workspace/topic-domain-conventions.md`)
  needs to know to read the auto-suggest block and act on it.

## Lifecycle

When the user accepts, the agent runs `add-domain.js` with the topic binding.
The new domain is then picked up by `engram-topic-domain-load` on the next
message. The auto-suggest block stays in the daily note for that day (or is
manually cleared by the agent on accept/decline).
