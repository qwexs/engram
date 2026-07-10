---
name: engram-topic-domain-load
description: "On Telegram topic-bound message, resolve domain via registry.domains[slug].topic and inject Domain Context + AGENTS via OpenClaw's system-event channel."
metadata:
  {
    "openclaw": {
      "emoji": "🧠",
      "events": ["message:received"],
      "export": "default"
    }
  }
---

# engram-topic-domain-load (v3.5 — system-event delivery)

On `message:received`, if the inbound message is in a Telegram topic
session, look up the domain bound to that topic in
`memory/domains/registry.json` and inject the Domain Context + AGENTS
payload via the OpenClaw gateway `system event` channel.

> **Refactored 2026-07-10 (ISS-15).** v3.3 wrote two HTML blocks to
> the daily note (`<!-- domain-context:{slug}:{hash} -->` and
> `<!-- domain-agents:{slug}:{hash} -->`) and relied on the LLM to
> read the file and call `message`. That was the canonical
> write-then-hope anti-pattern explicitly named in SKILL.md §10.9 —
> production repeatedly showed agents finishing on filesystem state
> and forgetting to send the reply. Symptom: "обновлял engram, но в
> тред не отправил". v3.5 hands the payload directly to the gateway
> via `openclaw system event --mode now`, identical to the peer
> hook's v2 pipeline. Shares `_lib/domain-inject.ts` for payload
> construction, hash computation, and idempotency.

## When it fires

On `message:received`, if:
- a non-empty `topicId` is present (resolved from
  `event.context.topicId`, `event.context.metadata.threadId`,
  `event.threadId`, or conversationId `telegram:{chat}:topic:{topic}`),
- AND a non-empty `chatId` is present (same fallback chain
  + `metadata.to`/`metadata.originatingTo`),
- AND a matching `topic: {chatId, topicId}` entry exists in
  `memory/domains/registry.json` (sign-symmetric on chatId — `-100xxx`
  vs `+100xxx` both match),
- AND the resolved domain-context hash differs from the last-injected
  `<!-- engram-system-event-hash:<8-hex> -->` marker in today's daily
  note (when present; absence ⇒ always inject).

If any of those fail, the hook returns silently. No logs, no retries —
the next message re-evaluates.

## What it injects

A single `openclaw system event --mode now --session-key <key> --text <text>`
call via `_lib/system-event.ts → enqueueSystemEventToSession()` with
the combined Domain Context + AGENTS payload built by
`_lib/domain-inject.ts → buildDomainPayload({sessionKind: "topic-thread"})`.

Idempotency marker (second line of payload):
```
<!-- engram-system-event-hash:<8-hex> -->
```

The agent that receives the system event is expected to write this
marker into today's daily note as confirmation. The hook reads it on
the next event for short-circuit.

Example payload shape:
```
🧠 Engram Domain Context (auto) · topic-thread
<!-- engram-system-event-hash:abc12345 -->

Domain: `engram` (project)
Session: chat `1003971800777`, topic `60`
KG entity: `projects/engram`

<details><summary>Status (...)</summary>
  ...status.md (first 40 lines)...
</details>

<details><summary>Последняя запись changelog.md</summary>
  ...
</details>

---

🧭 Domain AGENTS (auto)
[⚠️ fallback if agents.md missing]

...agents.md body OR fallback...

---

auto-injected by engram v2 (system-event delivery) · hash=abc12345 · source=file|fallback · session=topic-thread
```

## Pair with

- `engram-session-start` (sibling — silent auto-bind for unbound topics
  on first bootstrap, ISS-10 piggy-back; replaces the removed
  `engram-topic-auto-domain-suggest` hook)
- `engram-peer-domain-load` (sister — peer-DM + group-direct bindings; same pipeline)
- `engram-daily-note` (creates the daily note the agent may receive the
  hash marker in; this hook no longer writes to it)
- `engram-session-start` / `engram-session-end` (record session markers)

## Activation

Already registered as `~/.openclaw/openclaw.json →
hooks.internal.entries['engram-topic-domain-load']` with `enabled: true`.

## Migration notes (from v3.3 file-then-hope)

Operators upgrading should expect:
- no more `## Domain Context (auto)` / `## Domain AGENTS (auto)`
  blocks appended to today's daily note on `message:received` — these
  are now inert cruft from prior versions, rotated out naturally via
  `scripts/rotate-notes.js` (>1000 lines).
- the new marker is `<!-- engram-system-event-hash:<8-hex> -->` (was
  `<!-- domain-context:{slug}:{12-hex} -->` + `<!-- domain-agents:{slug}:{12-hex} -->`
  in v3.3). The agent receiving the system event writes this into the
  daily note as confirmation. The hook reads it for idempotency.
- the agent's downstream behavior is unchanged — same Domain Context +
  AGENTS body, just delivered via system event instead of daily-note blocks.
- on failure (gateway down, exit≠0): the hook logs
  `[engram-topic-domain-load] system-event injection failed for "<slug>"...`
  and returns silently. **Next message retries** via the same hash
  mismatch check. No in-memory buffer.

## Idempotency & failure model

| Step                                         | Behaviour                                                                                          |
|----------------------------------------------|----------------------------------------------------------------------------------------------------|
| Hash unchanged (already injected this hash)   | Skip silently. No log.                                                                             |
| Hash changed (context file edited)           | Build payload, send system event, log success.                                                     |
| Daily note missing entirely                  | Inject (system event doesn't need note to exist — race resolved).                                  |
| `agents.md` missing                          | Inject with built-in fallback body + ⚠️ note. `source: "fallback"` in the success log.             |
| Registry corrupt / missing / no match        | Bail silently. No log. Re-check on next message.                                                   |
| Gateway unreachable / spawn throws / exit≠0  | Log warning, return silent. **Retry next message** (hash mismatch, no marker written).              |
| Archived domain + matching binding           | Clear `archived` flag in registry.json, reactivate, then inject.                                  |
| Multiple matching domains                    | First match in `registry.domains` wins (matches v3.3 behaviour).                                    |

## Out of scope (per ISS-15 acceptance criteria)

- `ensureSessionReady()` — race disappears with system-event delivery;
  deferred to v3.5.1+ if any hook still needs it.
- Scrubbing `<!-- domain-context:* -->` blocks from existing daily
  notes — they are inert cruft; rely on the existing three-layer
  rotation pipeline (>1000 lines → archive).
