# Topic Threads (Telegram topics as long-lived OpenClaw sessions)

A `topic-thread` domain is bound to a Telegram forum topic. Unlike
`dev-project` and `cron-task`, it has **NO spawned subagent** — the
topic itself is the long-lived OpenClaw session, and the domain gives
that session a separate memory contour (no bleed with other topics or
main sessions).

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
2. **Hook**: `engram-topic-domain-load` fires on `message:received`. It looks up the domain by matching the event's `chatId` and `topicId` (with three-way match for the leading-minus quirk). If found, it injects a `## Domain Context (auto)` block into today's daily note, just after the `# YYYY-MM-DD` line.
3. **Idempotency**: the block is keyed by a content hash of `decisions.md` + `status.md` + `changelog.md` (using mtime + size + content). If the latest block in the daily note has the same hash, the hook does nothing. The block is replaced on every change.
4. **QMD collections**: three collections are auto-created by `add-domain.js`:
   - `domains` (shared) — all domains, for cross-topic queries.
   - `domain-{slug}` (per-domain) — just this domain, the default for topic-agents.
   - `life-projects-{slug}` (per-entity, opt-in via `--kg-entity`) — just the bound KG entity.
5. **Files**: `decisions.md` (pinned facts, append-only on explicit markers), `status.md` (handover, update on thematic block close or explicit `статус?`), `changelog.md` (curated log of significant exchanges). `workflow.md` is NOT created for topic-thread.

## Lifecycle

- **Create**: `bun skills/engram/scripts/add-domain.js --domain <slug> --type topic-thread --topic <chatId:topicId> [--kg-entity <path>]`.
  - **Auto-suggest**: hook `engram-topic-auto-domain-suggest` injects a `## engram:auto-suggest` block into the daily note once a topic accumulates ≥2 user messages without a bound domain. The agent mediates the offer via `message` tool (one Telegram message to the user; user replies with name/slug or decline). One suggestion per UTC day per topic (sentinel `<!-- engram:auto-suggest-shown:YYYYMMDD -->`).
- **Archive**: `bun skills/engram/scripts/domains-runner.js --workspace <path> --stale-days 60 --archive` (also called from heartbeat). For each `type=topic-thread` domain with `staleAfterDays` exceeded (default 60, per-domain override in registry), the runner:
  1. Sets `archived: true`, `archivedAt: <ISO>`, `archivePath: archives/{slug}` in registry.json (atomic write).
  2. Renames `memory/domains/{slug}/` → `memory/domains/archives/{slug}/` (atomic FS rename).
  3. Emits an alert of kind `archived`. `dev-project` and `cron-task` are NEVER archived by this path.
- **Unarchive**: when `engram-topic-domain-load` fires for a topic whose domain has `archived: true`, the hook clears the flag and re-injects the Domain Context + Domain AGENTS blocks. The actual files stay in `archives/{slug}/` (the link is a registry pointer; the runner does not move them back automatically). To fully restore, the user (or a tool) renames `archives/{slug}/` → `{slug}/` and clears `archivePath`. For most cases the in-memory restoration is enough.
- **Delete**: never. Supersede only.

## QMD usage (topic-agent)

The default QMD behavior and write/read rules for a topic-agent are encoded
in the per-domain `memory/domains/{slug}/agents.md` file, which the
`engram-topic-domain-load` hook injects as a `## Domain AGENTS (auto)` block
at the top of the daily note. The agent should follow those rules verbatim.

Reference patterns (in case the agent needs to look them up outside the block):

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
