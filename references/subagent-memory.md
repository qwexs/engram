# Subagent Persistent Memory

Pattern for subagents with `cleanup: "delete"` and long-term memory via files + QMD.

## Problem

Subagents with `cleanup: "delete"` lose context after completion. They need persistent memory, isolated from the main session memory.

## Solution: Domains

Each subagent task is tied to a **domain** — a dedicated folder with its own files:

```
memory/domains/{domain}/
├── decisions.md    # WHAT: rules, thresholds (read-only for subagent)
├── workflow.md     # HOW: scripts, scope, tools (optional)
├── status.md       # Current state (written by subagent, read by main agent)
├── changelog.md    # Append-only action log (written by subagent, read by main agent)
├── archives/       # Changelog rotation >1000 lines
└── README.md       # Domain description
```

## Architecture

### Four Files — Four Roles

| File | Who writes | Who reads | Mode | Purpose |
|------|-----------|-----------|------|---------|
| `decisions.md` | Main agent | Subagent (via prompt) | Read-only for subagent | Rules, thresholds, constraints (WHAT is allowed) |
| `workflow.md` | Main agent | Subagent (via prompt) | Read-only for subagent | Scripts, API, scope, external sources (HOW to work) |
| `status.md` | Subagent | Main agent | Overwrite | Current state, metrics |
| `changelog.md` | Subagent | Main agent | Append-only | Log of all actions |

### Separation of Concerns

| File | Responsible for | Example |
|------|----------------|---------|
| `decisions.md` | WHAT can be done | "Do not change API endpoints without a PROPOSAL" |
| `workflow.md` | HOW the domain works | "Search script: `node smart-search.js`, endpoint: https://..." |
| Template (spawn-prompt) | WHICH task to execute | "Build the evening digest" |

**Context chain at launch:** Template → workflow.md → decisions.md → external sources (if specified in workflow) → execution.

`workflow.md` **is optional** — recommended for domains with 2+ task types. Simple domains (single task) work without it. When workflow.md is present, templates stay thin (~30-50 lines), and the domain's shared infrastructure is described in one place.

### QMD Namespace

One `domains` collection indexes all domains (`memory/domains/**/*.md`). Do not create a separate collection per domain.

```bash
# Search within one collection
qmd query "CPU monitoring" -c domains

# Multi-collection search (domains + Knowledge Graph)
qmd query "project status" -c domains -c life

# BM25-only fallback (no GPU)
qmd search "monitoring" -c domains
```

### PR Model for decisions.md

The subagent **cannot** edit `decisions.md`. If a rule change is needed:

1. The subagent writes a PROPOSAL in `changelog.md`:
   ```markdown
   ## 2026-02-15 14:30 — PROPOSAL
   **Proposal**: raise CPU alert threshold from 80% to 90%
   **Reason**: false positives during compilation
   ```

2. Main agent during heartbeat → review → updates `decisions.md`

### Race Condition

**Rule: one domain = one active subagent at any given time.**

Before spawn, verify that no active subagent exists for this domain.

## Main Agent Pre-Spawn Workflow

Before spawning a subagent, the main agent:

1. Reads `memory/domains/{domain}/status.md` — understands current project state
2. Reads `memory/domains/{domain}/changelog.md` (tail) — sees what was done recently
3. Formulates the exact task based on this context + user request
4. Reads `decisions.md` + `workflow.md` — includes them verbatim in the subagent prompt
5. Assembles the prompt: decisions + workflow + task + "after completion" instructions
6. Spawns with `sessions_spawn(task: <prompt>, label: <subagentLabel>)`

**Key principle:** The main agent interprets status/changelog to formulate a precise task. The subagent receives only decisions (rules), workflow (tools), and the task itself. No script needed — the agent's judgment in formulating the task IS the value.

## Subagent Lifecycle

```
1. spawn → cleanup: "delete"
2. Read workflow.md (domain context: scripts, scope, tools)  ← provided in prompt
3. Read decisions.md (rules)  ← provided in prompt
4. Execute work
5. Update status.md (new state)
6. Append entry to changelog.md
7. Complete → session deleted, files remain
```

> **Note:** The subagent does NOT read `status.md` or `changelog.md` at startup.
> The main agent reads these before spawning and injects the relevant context into the task description.

## Integration with Main Architecture

### Subagent does NOT write to:
- Daily notes (`memory/agent-{id}/`)
- Knowledge Graph (`life/`)
- MEMORY.md

### Heartbeat Integration

Optional heartbeat step:
1. `qmd query "PROPOSAL" -c domains` — find proposals
2. Review changelogs → update decisions.md
3. Rotate changelog >1000 lines → `archives/changelog-YYYY-MM.md`
4. Optionally: extract facts from changelogs → Knowledge Graph

### Changelog Rotation

When `changelog.md` exceeds 1000 lines:
1. Heartbeat moves contents to `archives/changelog-YYYY-MM.md`
2. New `changelog.md` starts with header + reference:
   ```markdown
   # Log: {domain}

   > Previous entries: see `archives/`
   ```

## Project Domains

Domains can be linked to projects in the Knowledge Graph (`life/projects/`). The domain registry is stored in `memory/domains/registry.json`:

```json
{
  "domains": {
    "engram": {
      "type": "dev-project",
      "kgEntity": "projects/engram",
      "description": "Memory architecture skill",
      "spawnTemplate": "dev-project.md",
      "subagentLabel": "engram",
      "created": "2026-02-17"
    },
    "monitoring": {
      "type": "cron-task",
      "description": "Server monitoring",
      "spawnTemplate": "cron-task.md",
      "subagentLabel": "monitoring",
      "created": "2026-02-17"
    }
  }
}
```

### Registry Fields

| Field | Required | Description |
|-------|----------|-------------|
| `type` | ✅ | `dev-project`, `cron-task`, or `topic-thread` |
| `description` | ✅ | Brief description |
| `spawnTemplate` | ⚠️ recommended | File from `templates/spawn-prompts/` (not used for `topic-thread`) |
| `subagentLabel` | ⚠️ recommended | Fixed label for sessions_spawn (not used for `topic-thread`) |
| `kgEntity` | no | Link to Knowledge Graph entity |
| `topic` | only for `topic-thread` | `{ chatId, topicId }` binding to Telegram topic |
| `archived` | no | `true` if idle-archived by heartbeat (only `topic-thread` for now) |
| `created` | no | Creation date |

### Domain Types

| Type | Description | Subagent |
|------|-----------|----------|
| `dev-project` | Development, linked to KG entity | On user request |
| `cron-task` | Periodic tasks | On schedule via cron |
| `topic-thread` | Telegram topic as memory contour | Long-lived OpenClaw session |

### KG Binding

- **KG entity** (`life/projects/{name}/`) — what the bot knows about the project (facts, summary)
- **Domain** (`memory/domains/{name}/`) — context for the subagent (decisions, status, changelog)
- Binding is set via the `kgEntity` field in registry.json

### Workflow for dev-project

1. User gives a project task
2. Main agent finds domain in `registry.json`
3. Main agent reads `status.md` + `changelog.md` tail → understands current state
4. Main agent formulates exact task based on context
5. Main agent reads `decisions.md` + `workflow.md` → includes verbatim in prompt
6. Spawns subagent with `cleanup: "delete"` and a fixed `subagentLabel`
7. Subagent executes, then updates `status.md` + `changelog.md`

**Rule: always read the domain before spawn.** The main agent's judgment in interpreting status/changelog and formulating a precise task is the core value of this workflow.

### Creating a Domain with KG Binding

```bash
bun skills/engram/scripts/add-domain.js --domain engram --type dev-project --kg-entity projects/engram --description "Memory architecture skill"
```

## Creating a Domain

```bash
bun skills/engram/scripts/add-domain.js --domain {domain} --description "Description"
bun skills/engram/scripts/add-domain.js --domain {domain} --type cron-task --description "Description"
```

## Example: Monitoring Domain

### decisions.md
```markdown
# Rules: monitoring

## CPU Alert
**Condition**: CPU > 80% for 5 minutes
**Action**: notify via Telegram

## Disk Alert
**Condition**: free space < 10%
**Action**: notify + run cleanup
```

### status.md
```markdown
# Status: monitoring

## Current State
- **Last run**: 2026-02-15 14:30
- **Result**: OK, all metrics normal
- **CPU**: 45% (1-hour avg)
- **Disk**: 62% free
- **Next run**: 2026-02-15 15:00
```

### changelog.md
```markdown
# Log: monitoring

## 2026-02-15 14:30 — Плановая проверка
**Action**: server metrics check
**Result**: all normal, CPU 45%, Disk 62%

## 2026-02-15 13:30 — Плановая проверка
**Action**: server metrics check
**Result**: CPU spike 78% (compilation), passed
```

## Spawn Templates

Ready-made templates in `skills/engram/templates/spawn-prompts/`:
- `dev-project.md` — for development projects
- `cron-task.md` — for periodic tasks

Both use the same minimal placeholders: `{{decisions}}`, `{{workflow}}`, `{{task}}`, `{{domain}}`.

> `{{status}}` and `{{changelog_tail}}` are **removed** from templates. The main agent reads these files
> before spawning and incorporates relevant context directly into the `--task` text when needed.


## Topic Threads (Telegram topics as domains)

A `topic-thread` domain is bound to a Telegram forum topic. Unlike `dev-project` and `cron-task`, it has NO spawned subagent — the topic itself is the long-lived OpenClaw session, and the domain gives that session a separate memory contour (no bleed with other topics or main sessions).

### When to use

- A Telegram forum topic that has accumulated enough context to warrant a curated memory (≥2 messages on the same theme, see the topic-thread contract documented in this file).
- When you want topic-specific `decisions.md`, `status.md`, `changelog.md` that are NOT shared with the parent group or other topics.

### When NOT to use

- One-off questions in a topic — no need for a domain, daily note is enough.
- Topics with no clear thematic focus (general chat) — let daily notes handle it.

### How it works

1. **Binding**: a topic-thread domain has `registry.domains[slug].topic = { chatId, topicId }`. The chatId is stored with the leading `-` (e.g. `"-1001234567890"`); topicId is the forum topic id.
2. **Hook**: `engram-topic-domain-load` fires on `message:received`. It looks up the domain by matching the event's `chatId` and `topicId` (with three-way match for the leading-minus quirk). If found, it injects a `## Domain Context (auto)` block into today's daily note, just after the `# YYYY-MM-DD` line.
3. **Idempotency**: the block is keyed by a content hash of `decisions.md` + `status.md` + `changelog.md` (using mtime + size + content). If the latest block in the daily note has the same hash, the hook does nothing. The block is replaced on every change.
4. **QMD collections**: three collections are auto-created by `add-domain.js`:
   - `domains` (shared) — all domains, for cross-topic queries.
   - `domain-{slug}` (per-domain) — just this domain, the default for topic-agents.
   - `life-projects-{slug}` (per-entity, opt-in via `--kg-entity`) — just the bound KG entity.
5. **Files**: `decisions.md` (pinned facts, append-only on explicit markers), `status.md` (handover, update on thematic block close or explicit `статус?`), `changelog.md` (curated log of significant exchanges). `workflow.md` is NOT created for topic-thread.

### Lifecycle

- **Create**: `bun skills/engram/scripts/add-domain.js --domain <slug> --type topic-thread --topic <chatId:topicId> [--kg-entity <path>]`.
  - **Auto-suggest**: hook `engram-topic-auto-domain-suggest` injects a `## engram:auto-suggest` block into the daily note once a topic accumulates ≥2 user messages without a bound domain. The agent mediates the offer via `message` tool (one Telegram message to the user; user replies with name/slug or decline). One suggestion per UTC day per topic (sentinel `<!-- engram:auto-suggest-shown:YYYYMMDD -->`).
- **Archive**: `bun skills/engram/scripts/domains-runner.js --workspace <path> --stale-days 60 --archive` (also called from heartbeat). For each `type=topic-thread` domain with `staleAfterDays` exceeded (default 60, per-domain override in registry), the runner:
  1. Sets `archived: true`, `archivedAt: <ISO>`, `archivePath: archives/{slug}` in registry.json (atomic write).
  2. Renames `memory/domains/{slug}/` → `memory/domains/archives/{slug}/` (atomic FS rename).
  3. Emits an alert of kind `archived`. `dev-project` and `cron-task` are NEVER archived by this path.
- **Unarchive**: when `engram-topic-domain-load` fires for a topic whose domain has `archived: true`, the hook clears the flag and re-injects the Domain Context block. The actual files stay in `archives/{slug}/` (the link is a registry pointer; the runner does not move them back automatically). To fully restore, the user (or a tool) renames `archives/{slug}/` → `{slug}/` and clears `archivePath`. For most cases the in-memory restoration is enough.
- **Delete**: never. Supersede only.

### QMD usage (topic-agent)

```bash
# Default: own domain + own session notes
qmd --index <index> query "<topic>" -c domain-{slug} -c openclaw-memory-agent-<agent-id>-{sessionKey}

# Cross-topic (explicit opt-in)
qmd --index <index> query "<term>" -c domains

# Own KG entity (if --kg-entity was set)
qmd --index <index> query "<term>" -c life-projects-{slug}
```

See the "Topic Threads" section above for the full contract.
