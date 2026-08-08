---
name: engram-topic-domain-load
description: "On agent:bootstrap, resolve domain via registry.domains[slug].topic and inject Domain Context + AGENTS into the bootstrap event's messages array."
metadata:
  {
    "openclaw": {
      "emoji": "🧠",
      "events": ["agent:bootstrap"],
      "export": "default"
    }
  }
---

# engram-topic-domain-load (v4 — bootstrap delivery)

On `agent:bootstrap`, if the session is a Telegram topic bound to a
domain in `memory/domains/registry.json`, inject the Domain Context +
AGENTS payload into the bootstrap event's `messages` array.

> **v4 (2026-07-12).** v3.5 fired on `message:received` and delivered
> via `openclaw system event --mode now`. That created a separate agent
> turn, causing visible spam in the chat. v4 fires on `agent:bootstrap`
> and pushes to `event.messages` — the payload becomes part of the
> initial system context, same mechanism `engram-session-start` uses.
> No system event, no extra turn, no spam.

## When it fires

On `agent:bootstrap`, if:
- The session key matches `agent:<id>:telegram-group-<chatId>-topic-<topicId>`,
- AND a matching `topic: {chatId, topicId}` entry exists in
  `memory/domains/registry.json` (sign-symmetric on chatId),
- AND `event.messages` is an array (present on bootstrap events).

If any of those fail, the hook returns silently.

## What it injects

The combined Domain Context + AGENTS payload built by
`_lib/domain-inject.ts → buildDomainPayload()` is pushed into
`event.messages`. The gateway includes bootstrap messages in the
agent's initial context, so the agent sees the domain context as
part of its startup context — not as a separate message requiring
a reply.

No idempotency hash check is needed: bootstrap fires once per session.

## Pair with

- `engram-peer-domain-load` (sister — peer-DM + group-direct bindings)
- `engram-session-start` (also fires on `agent:bootstrap`, creates
  the daily note and auto-creates domains for unbound topics)
- `engram-daily-note` (creates daily notes on gateway startup)

## Out of scope

- Mid-session context refresh: if `status.md` or `changelog.md` change
  during a session, the agent won't get an automatic update until the
  next bootstrap (`/new`). This is acceptable — the agent can read the
  files directly when needed.
- System-event delivery (`openclaw system event`): removed in v4.