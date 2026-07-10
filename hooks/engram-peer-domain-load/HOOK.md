---
name: engram-peer-domain-load
description: "On Telegram DM or group-without-topics message, resolve domain via registry.domains[slug].peer or .group and inject Domain Context + AGENTS via OpenClaw's system-event channel."
metadata:
  {
    "openclaw": {
      "emoji": "🧠",
      "events": ["message:received"],
      "export": "default"
    }
  }
---

# engram-peer-domain-load (v3.5 — system-event delivery)

On `message:received`, if the inbound message is in a Telegram **direct
(DM) chat** or a **group without topics**, look up the domain bound to
that chat in `memory/domains/registry.json` and inject the Domain
Context + AGENTS payload via the OpenClaw gateway `system event` channel.

## When it fires

On `message:received`, if:
- The message is **not** in a topic session (no `topicId`),
- AND a non-empty `chatId` is present,
- AND the session kind resolves to:
  - `peer-direct` (positive chatId = user id → DM) with a matching
    `entry.peer = { chatId }` in registry, OR
  - `group-direct` (negative chatId, no topicId → group without topics)
    with a matching `entry.group = { chatId }` in registry,
- AND the resolved domain-context hash differs from the last-injected
  `<!-- engram-system-event-hash:<8-hex> -->` marker in today's daily
  note (when present; absence ⇒ always inject).

If any of those fail, the hook returns silently.

## What it injects

Same payload shape as `engram-topic-domain-load`, with `sessionKind`
set to `peer-direct` or `group-direct` instead of `topic-thread`.

The `sessionLabel` in the payload is:
- `peer-direct`: `DM \`{userId}\``
- `group-direct`: `group \`{chatId}\``

## Registry bindings

```
{
  "domains": {
    "elena-direct": {
      "type": "peer-direct",
      "peer": { "chatId": "205075873" },
      ...
    },
    "company-group": {
      "type": "group-direct",
      "group": { "chatId": "-1001234567890" },
      ...
    }
  }
}
```

## Session segments

| Kind | sessionSegment |
|------|----------------|
| `peer-direct` | `telegram-direct--{chatId}` |
| `group-direct` | `telegram-group--{absChatId}` |

## Pair with

- `engram-topic-domain-load` (sibling — topic-thread bindings)
- `engram-session-start` / `engram-session-end` (session markers)
- `engram-daily-note` (creates daily notes)

## Idempotency & failure model

Same as `engram-topic-domain-load` — see its HOOK.md for the full table.
Hash-based idempotency via `<!-- engram-system-event-hash:<8-hex> -->`,
silent retry on next message if delivery fails.