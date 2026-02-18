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
├── status.md       # Current state (updated by subagent)
├── changelog.md    # Append-only action log
├── archives/       # Changelog rotation >1000 lines
└── README.md       # Domain description
```

## Architecture

### Four Files — Four Roles

| File | Who writes | Mode | Purpose |
|------|-----------|------|---------|
| `decisions.md` | Main agent | Read-only for subagent | Rules, thresholds, constraints (WHAT is allowed) |
| `workflow.md` | Main agent | Read-only for subagent | Scripts, API, scope, external sources (HOW to work) |
| `status.md` | Subagent | Overwrite | Current state, metrics |
| `changelog.md` | Subagent | Append-only | Log of all actions |

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

## Subagent Lifecycle

```
1. spawn → cleanup: "delete"
2. Read workflow.md (domain context: scripts, scope, tools)
3. Read decisions.md (rules)
4. Read status.md (previous state)
5. Execute work
6. Update status.md (new state)
7. Append entry to changelog.md
8. Complete → session deleted, files remain
```

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
| `type` | ✅ | `dev-project` or `cron-task` |
| `description` | ✅ | Brief description |
| `spawnTemplate` | ⚠️ recommended | File from `templates/spawn-prompts/` |
| `subagentLabel` | ⚠️ recommended | Fixed label for sessions_spawn |
| `kgEntity` | no | Link to Knowledge Graph entity |
| `created` | no | Creation date |

### Domain Types

| Type | Description | Subagent |
|------|-----------|----------|
| `dev-project` | Development, linked to KG entity | On user request |
| `cron-task` | Periodic tasks | On schedule via cron |

### KG Binding

- **KG entity** (`life/projects/{name}/`) — what the bot knows about the project (facts, summary)
- **Domain** (`memory/domains/{name}/`) — context for the subagent (decisions, status, changelog)
- Binding is set via the `kgEntity` field in registry.json

### Workflow for dev-project

1. User gives a project task
2. Main bot finds the domain via `registry.json`
3. Loads the template from `spawnTemplate`
4. Reads domain context: **workflow.md** (if present), decisions.md, status.md, changelog (tail)
5. Injects placeholders: `{{domain}}`, `{{task}}`, `{{workflow}}`, `{{decisions}}`, `{{status}}`, `{{changelog_tail}}`
6. Spawns subagent with `cleanup: "delete"` and a fixed label
7. Subagent determines where to work
8. After completion, main bot updates the domain

**Rule: always use a template.** Don't write prompts manually — use `spawnTemplate` from the registry. This ensures the subagent receives the Domain Lifecycle (paths to decisions, status, changelog).

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

## 2026-02-15 14:30
**Action**: server metrics check
**Result**: all normal, CPU 45%, Disk 62%

## 2026-02-15 13:30
**Action**: server metrics check
**Result**: CPU spike 78% (compilation), passed
```

## Spawn Templates

Ready-made templates in `templates/spawn-prompts/`:
- `dev-project.md` — for development (workflow + decisions + status + changelog tail)
- `cron-task.md` — for periodic tasks (workflow + decisions + status)

Placeholders: `{{domain}}`, `{{task}}`, `{{workflow}}`, `{{decisions}}`, `{{status}}`, `{{changelog_tail}}`.
