# Topic Threads (Telegram topics as long-lived OpenClaw sessions)

A `topic-thread` domain is bound to a Telegram forum topic. Unlike
`dev-project` and `cron-task`, it has **NO spawned subagent** — the
topic itself is the long-lived OpenClaw session, and the domain gives
that session a separate memory contour (no bleed with other topics or
main sessions).

> **Spec sync v3.5** (2026-07-11): delivery mechanism changed from
> write-then-hope (daily note + sentinel) to **system-event delivery**
> via `_lib/system-event.ts → enqueueSystemEventToSession()`. Daily note
> is no longer touched on every `message:received`. See [§ How it works](#how-it-works)
> for the new pipeline. Detailed migration notes in `memory/tmp/engram-v35-addendum.md`
> (workspace canonical spec).
>
> **v3.5 changes at a glance:**
> - `enqueueSystemEventToSession()` (system-event channel) replaces `writeFileSync` + sentinels.
> - Marker `<!-- engram-system-event-hash:[a-f0-9]{8} -->` in daily note (cold-start only).
> - Hash format: 8 hex (was 12 hex).
> - `engram-topic-domain-load` rewrite on top of `_lib/domain-inject.ts` (R1 HIGH closed).
> - Sibling hook `engram-peer-domain-load` handles `peer-direct` and `group-direct` domains
>   via shared `_lib/domain-resolve.ts` resolver.

> This file is about full-fledged long-lived agents. For spawned
> short-lived workers, see `references/subagent-memory.md`.

## When to use

- A Telegram forum topic that has accumulated enough context to warrant a curated memory (≥2 messages on the same theme).
- When you want topic-specific `decisions.md`, `status.md`, `changelog.md` that are NOT shared with the parent group or other topics.

## When NOT to use

- One-off questions in a topic — no need for a domain, daily note is enough.
- Topics with no clear thematic focus (general chat) — let daily notes handle it.

## How it works

1. **Binding**: a topic-thread domain has `registry.domains[slug].topic = { chatId, topicId }`. The chatId is stored with the leading `-` (e.g. `"-100XXXXXXXXXX"`); topicId is the forum topic id.
2. **Hook**: `engram-topic-domain-load` fires on `message:received`. It looks up the domain by matching the event's `chatId` and `topicId` via the shared `_lib/domain-resolve.ts` resolver (3 fallback layers, sign-symmetric chatId lookup, kinds filter for `topic-thread`). If found, it builds a Domain Context + Domain AGENTS payload via `_lib/domain-inject.ts → buildDomainPayload()` and delivers it to the agent via `_lib/system-event.ts → enqueueSystemEventToSession()`.
3. **Delivery channel**: `openclaw system event --mode now --session-key <agent:apriori-tech:telegram:group:<chatId>:topic:<topicId>> --text <9146-char payload> --timeout 10000`. The gateway enqueues the system event for delivery in the current/next agent iteration. **v3.5 changed this from `writeFileSync` blocks in the daily note** (write-then-hope anti-pattern, see `memory/tmp/engram-v35-addendum.md` §2).
4. **Idempotency**: 
   - Cold-start marker `<!-- engram-system-event-hash:[a-f0-9]{8} -->` is written to the daily note **once** (on first hook fire per session) for debugging. The hash is `computeContextHash(agentsMd, decisionsMd, statusMd, changelogMd)` truncated to 8 hex.
   - Subsequent fires in the same session are deduplicated by the OpenClaw session queue (system-event is delivered once per session until context compaction).
   - The hook never replaces or updates the daily note on hot-path (only cold-start marker write). The daily note's `LastWriteTime` should NOT change on `message:received` after cold-start.
5. **QMD collections**: three collections are auto-created by `add-domain.js`:
   - `domains` (shared) — all domains, for cross-topic queries.
   - `domain-{slug}` (per-domain) — just this domain, the default for topic-agents.
   - `life-projects-{slug}` (per-entity, opt-in via `--kg-entity`) — just the bound KG entity.
6. **Files**: `decisions.md` (pinned facts, append-only on explicit markers), `status.md` (handover, update on thematic block close or explicit `статус?`), `changelog.md` (curated log of significant exchanges). `workflow.md` is NOT created for topic-thread.

## Lifecycle

- **Create**: `bun skills/engram/scripts/add-domain.js --domain <slug> --type topic-thread --topic <chatId:topicId> [--kg-entity <path>]`.
  - **Auto-suggest**: hook `engram-topic-auto-domain-suggest` fires on `message:received` once a topic accumulates ≥2 user messages without a bound domain. **v3.9+ uses Telegram inline_keyboard (side-effect-delivered)** — the hook calls `fetch('https://api.telegram.org/bot{TOKEN}/sendMessage')` with `reply_markup={inline_keyboard: [{text: "Create domain", callback_data: "..."}, ...]}` directly. Channel completion = Telegram, not the agent model. **No daily-note block is written.** Deduplication per UTC day per topic (sentinel `<!-- engram-auto-suggest-shown:YYYYMMDD -->` in daily note for audit, but the user-facing delivery is the inline_keyboard).
- **Archive**: `bun skills/engram/scripts/domains-runner.js --workspace <path> --stale-days 60 --archive` (also called from heartbeat). For each `type=topic-thread` domain with `staleAfterDays` exceeded (default 60, per-domain override in registry), the runner:
  1. Sets `archived: true`, `archivedAt: <ISO>`, `archivePath: archives/{slug}` in registry.json (atomic write).
  2. Renames `memory/domains/{slug}/` → `memory/domains/archives/{slug}/` (atomic FS rename).
  3. Emits an alert of kind `archived`. `dev-project` and `cron-task` are NEVER archived by this path.
- **Unarchive**: when `engram-topic-domain-load` fires for a topic whose domain has `archived: true`, the hook clears the flag and re-delivers Domain Context + Domain AGENTS via system-event (v3.5; was block re-injection in v3.4 and earlier). The actual files stay in `archives/{slug}/` (the link is a registry pointer; the runner does not move them back automatically). To fully restore, the user (or a tool) renames `archives/{slug}/` → `{slug}/` and clears `archivePath`. For most cases the in-memory restoration is enough.
- **Delete**: never. Supersede only.

## QMD usage (topic-agent)

The default QMD behavior and write/read rules for a topic-agent are encoded
in the per-domain `memory/domains/{slug}/agents.md` file. v3.5+ delivers
the agents.md content to the agent via the `engram-topic-domain-load` hook
as a system-event payload (`openclaw system event --mode now`). In v3.4
and earlier the rules appeared inline in the daily note as a
`## Domain AGENTS (auto)` block — that block is **no longer written** on
the hot path. The agent should follow the rules delivered via system-event verbatim.

Reference patterns (in case the agent needs to look them up outside the system-event payload):

```bash
# Default: own domain + own session notes
qmd --index <index> query "<topic>" -c domain-{slug} -c openclaw-memory-agent-<agent-id>-{sessionKey}

# Cross-topic (explicit opt-in only)
qmd --index <index> query "<term>" -c domains

# Own KG entity (if --kg-entity was set)
qmd --index <index> query "<term>" -c life-projects-{slug}
```

**Boundary rules** (enforced via `agents.md`):
- Use `domain-{slug}` + own session notes for default queries. Do **not** use
  `domains` (cross-topic) or `life` (cross-KG, the workspace-level KG collection)
  without explicit OK.
- Read access: own daily note + own domain files. Other domains and
  workspace-level `MEMORY.md`/`AGENTS.md` are off-limits in default flow.
- Write access: own daily note + own domain files (`decisions.md` on explicit
  markers, `status.md` on handover, `changelog.md` curated). Never write to
  `life/`, other domains, or workspace-level files without explicit OK.

If `agents.md` is missing, the hook uses a built-in minimal fallback so the
topic-agent is never without rules. Use
`bun skills/engram/scripts/backfill-domain-agents.js` to create it from the
template.

## Registry fields specific to topic-thread

| Field | Required | Description |
|-------|----------|-------------|
| `topic` | yes for `topic-thread` | `{ chatId, topicId }` binding to Telegram topic |
| `archived` | no | `true` if idle-archived by heartbeat |
| `staleAfterDays` | no | Per-domain override for archive threshold (default 60) |
| `kgEntity` | no | Link to Knowledge Graph entity (auto-creates `life-projects-{slug}` QMD collection if `life/{entity}/` exists) |

The other registry fields (`type`, `description`, `created`) are shared
with all domain types — see `references/subagent-memory.md` for the
full table.
