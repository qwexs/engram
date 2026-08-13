---
name: engram-peer-domain-load
description: "On agent:bootstrap, resolve domain via registry.domains[slug].peer or .group and inject Domain Context + AGENTS into the bootstrap event's messages array."
metadata:
  {
    "openclaw": {
      "emoji": "🧠",
      "events": ["agent:bootstrap"],
      "export": "default"
    }
  }
---

# engram-peer-domain-load (v4 — bootstrap delivery)

On `agent:bootstrap`, if the session is a Telegram **direct (DM) chat**
or a **group without topics** bound to a domain in
`memory/domains/registry.json`, inject the Domain Context + AGENTS
payload into the bootstrap event's `messages` array.

> **v4 (2026-07-12).** v3.5 fired on `message:received` and delivered
> via `openclaw system event --mode now`. That created a separate agent
> turn, causing visible spam in the chat. v4 fires on `agent:bootstrap`
> and pushes to `event.messages` — the payload becomes part of the
> initial system context, same mechanism `engram-session-start` uses.
> No system event, no extra turn, no spam.

## When it fires

On `agent:bootstrap`, if:
- The session key matches:
  - `agent:<id>:telegram-direct-<chatId>` (DM)
  - `agent:<id>:telegram-group-<chatId>` (group without topics)
- AND a matching `peer: {chatId}` or `group: {chatId}` entry exists in
  `memory/domains/registry.json`,
- AND `event.messages` is an array (present on bootstrap events).

If any of those fail, the hook returns silently.

## What it injects

Same payload shape as `engram-topic-domain-load`, with `sessionKind`
set to `peer-direct` or `group-direct`. The payload is pushed into
`event.messages`, becoming part of the agent's initial context.

No idempotency hash check is needed: bootstrap fires once per session.

## Pair with

- `engram-topic-domain-load` (sibling — topic-thread bindings)
- `engram-session-start` (also fires on `agent:bootstrap`)
- `engram-daily-note` (reconciles existing note state on gateway startup)
