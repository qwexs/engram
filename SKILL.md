---
name: engram
description: Etalon memory architecture with Knowledge Graph, session isolation, memory decay, and QMD hybrid search
---

> ⚠️ **READ-ONLY SKILL**: This skill is a reference implementation. Do not edit files directly.
> When installing, copy scripts to your workspace folder:
> ```bash
> # Scripts → workspace scripts/
> cp skills/engram/scripts/*.js scripts/
> ```
> Templates and assets remain in the skill folder. Specify the path via env:
> ```bash
> export ENGRAM_SKILL_DIR=skills/engram  # or absolute path
> bun skills/engram/scripts/init.js
> ```
> Without `ENGRAM_SKILL_DIR`, scripts look for assets relative to `../` from their location.

# Memory System

Three-layer memory architecture for OpenClaw agents: curated long-term memory (MEMORY.md), structured knowledge graph (life/), and session-isolated daily notes (memory/).

## Quick Start

```bash
# 1. Install QMD (if not installed)
bun skills/engram/scripts/install-qmd.js

# 2. Initialize everything
bun skills/engram/scripts/init.js

# Add a group session
bun skills/engram/scripts/add-session.js --platform telegram --id 3382546134

# Validate integrity
bun skills/engram/scripts/validate.js

# Migrate to v2 schema
bun skills/engram/scripts/migrate-v2.js --dry-run
```

## Architecture Overview

```
┌─────────────────────────────────────────────┐
║  Layer 3: MEMORY.md (Curated Wisdom)        ║
║  Long-term personal insights, decisions     ║
├─────────────────────────────────────────────┤
║  Layer 2: Knowledge Graph (life/)           ║
║  KG entities with atomic facts              ║
├─────────────────────────────────────────────┤
║  Layer 1: Daily Notes (memory/)             ║
║  Raw session notes, per-session isolation   ║
└─────────────────────────────────────────────┘
```

**Data flows upward:** Daily notes → extracted to Knowledge Graph → distilled to MEMORY.md

For full architecture details, see [references/architecture.md](references/architecture.md).

## Memory Rules

### Session Isolation

**Golden Rule: Memory is isolated by session.**

| Session Type | Memory Path | QMD Collection | Access |
|-------------|-------------|----------------|--------|
| Main (personal) | `memory/agent-{id}/main/` | `openclaw-memory-agent-{id}-main` | Full: MEMORY.md + life/ |
| Telegram group | `memory/agent-{id}/telegram-{gid}/` | `openclaw-memory-agent-{id}-telegram-{gid}` | Own daily notes ONLY |
| Discord channel | `memory/agent-{id}/discord-{cid}/` | `openclaw-memory-agent-{id}-discord-{cid}` | Own daily notes ONLY |

**Rules:**
- **NEVER cross-reference** memory between sessions
- Group chats **CANNOT see** MEMORY.md or life/
- Always specify `-c <collection>` in QMD queries

### Every Session Startup (Fast/Full Init)

**First, detect init mode** based on the incoming message:
- If the message matches the **heartbeat prompt** → **Fast Init**
- Otherwise → **Full Init**

#### Fast Init (Heartbeat)

Heartbeats need speed, not full context. SOUL.md and USER.md are typically already in project context (OpenClaw loads them automatically).

> **Automated by hooks** (do NOT repeat manually):
> - Daily note creation → `engram-daily-note` (gateway:startup)
> - `<!-- session:start -->` marker → `engram-session-start` (agent:bootstrap)
> - QMD index refresh → `engram-bootstrap-qmd` (agent:bootstrap)

1. Determine session
2. Read `memory/heartbeat-state.json`
3. Proceed to HEARTBEAT.md

**Skipped:** SOUL.md, USER.md, yesterday's daily note, MEMORY.md, QMD query — none needed for heartbeat flow.

#### Full Init (Interactive)

> **Automated by hooks** (do NOT repeat manually):
> - SOUL.md / USER.md → injected via OpenClaw project context
> - Daily note creation → `engram-daily-note` (gateway:startup)
> - `<!-- session:start -->` marker → `engram-session-start` (agent:bootstrap)
> - `<!-- session:end -->` marker → `engram-session-end` (command:new/reset)
> - QMD index refresh → `engram-bootstrap-qmd` (agent:bootstrap)

1. Determine session (main, telegram group, discord channel, etc.)
2. Read session memory:
   - **Main**: today's daily note (full) + yesterday's daily note (tail from `## Active Threads` onwards, or last 80 lines if marker absent)
   - **Group**: today + yesterday daily notes only (same tail rule for yesterday)
3. **Knowledge Graph** (main session only): run `qmd query "<topic of first user message>" -c life` **once, on the first substantive user message** — not on every message, not during startup before the user speaks
   - Extract the main topic/entity from the user's first request and query it
   - If message is a greeting or vague → defer to QMD Query Triggers below
   - ⚠️ This step fires exactly once per session; subsequent queries follow QMD Query Triggers rules

### QMD Query Triggers

> Apply **during a session** (after Full Init). Run `qmd query` whenever a trigger fires.
> Main session only — group chats do not have access to the Knowledge Graph (`life/`).

#### 🔴 Mandatory Triggers (always run)

| Trigger | Condition | Query |
|---------|-----------|-------|
| **First substantive request** | User's first non-greeting message in a session | `qmd query "<topic>" -c life` |
| **Named entity appears** | Project, person, or system mentioned **for the first time** in this session | `qmd query "<entity name>" -c life` |
| **Decision requested** | User asks for advice, recommendation, or "what should I do" | `qmd query "<topic>" -c life` + check `memory/domains/` if relevant |

#### 🟡 Situational Triggers (use judgment)

| Trigger | Condition |
|---------|-----------|
| **Topic shift** | Conversation moves to a clearly different domain (e.g. dev → infra → marketing) |
| **Long session + new subject** | >20 messages in session and a new subject appears |
| **"We did this before"** | Request that could have history in prior sessions/notes |
| **Contradiction detected** | Something the user says conflicts with what you believe you know |

#### How to run

```bash
# Combined KG + session memory (recommended)
qmd query "topic" -c life -c openclaw-memory-agent-{id}-main

# KG only (when session memory not relevant)
qmd query "topic" -c life
```

Use the most specific term you can extract. If multiple entities are relevant, run separate queries.

### Daily Notes

- Path: `memory/agent-{id}/{session}/YYYY-MM-DD.md`
- Header: `# YYYY-MM-DD`
- **Three-Layer Rotation** (>1000 lines during heartbeat):
  1. **Archive** — full file moved to `archives/YYYY-MM/` (nothing lost)
  2. **Stub** — auto-summary (10-20 lines) with line refs to archive and KG links
  3. **QMD index** — archive indexed for granular search via `qmd query`
  - Run rotation AFTER KG Extraction to minimize stub duplication

### Knowledge Graph

Structured memory in `life/` using a flat three-folder structure (people/projects/archives):

```
life/
├── people/<name>/    # People (summary.md + items.json)
├── projects/<name>/  # Active work, tools, groups, AI agents (summary.md + items.json)
├── archives/<name>/  # Inactive entities
└── index.md          # Master entity index
```

**Tiered retrieval:**
1. `qmd query "topic" -c life` — search first
2. Read `summary.md` — quick context (~90% sufficient)
3. Read `items.json` — only for granular detail

**Entity creation rules:**
- Mentioned **3+ times** across conversations
- Has a **direct relationship** to the user
- Is a **significant project, person, or company**

For the atomic fact schema (v2), see [references/fact-schema.md](references/fact-schema.md).

### Writing Memory

| Type | Destination |
|------|-------------|
| Operational lesson | TOOLS.md or AGENTS.md |
| Personal insight | MEMORY.md (main session only) |
| Event/fact | Today's daily note |
| Durable knowledge | Knowledge Graph (life/) |

**When someone says "remember this":**
1. Determine the type
2. Write to the appropriate file
3. Run `qmd update`

### QMD Search

```bash
# Hybrid search (BM25 + vectors + rerank)
qmd query "search text" -c <collection>

# Multi-collection search (searches across multiple collections)
qmd query "search text" -c life -c openclaw-memory-agent-main-main

# BM25-only search (no GPU required, faster)
qmd search "search text" -c <collection>

# Update index after changes
qmd update          # BM25 (instant)
qmd embed           # Vectors (heartbeat only)
```

**Strategy:**
- Always use `-c` flag for session isolation
- Multi-collection (`-c col1 -c col2`) for cross-cutting searches (e.g., KG + daily notes)
- Use `qmd search` (BM25-only) when GPU is busy or unavailable
- Top 2-3 results usually sufficient
- Run `qmd update` after writing memory
- Do NOT run `qmd embed` manually (heartbeat handles it)

For QMD installation and configuration, see [references/qmd-setup.md](references/qmd-setup.md).

## Heartbeat Integration

Add to your HEARTBEAT.md:

```
## Heartbeat Flow (every 30 minutes)

0. Three-Layer Rotation check (daily note creation → handled by engram-daily-note hook)
1. Monday? → Weekly Synthesis
2. Knowledge Graph Extraction (if notes changed)
3. Memory Maintenance (every few days)
3.5. Domain Supervisor Scan (if domains exist)
4. QMD Index Update (qmd update + qmd embed)
```

### Weekly Synthesis (Mondays)

Rewrites `summary.md` with memory decay applied:
- **Hot** (7 days) — prominent in summary
- **Warm** (8-30 days) — lower priority
- **Cold** (30+ days) — omitted from summary (stays in items.json)

Modifiers:
- `confidence < 0.5` → Cold threshold is 14 days
- `accessCount >= 10` → bumps Cold to Warm
- `principle` (L3) → always in summary
- `pattern` (L2) → in summary if Warm+

For full decay rules, see [references/decay-rules.md](references/decay-rules.md).

### Knowledge Graph Extraction

During heartbeats, scan daily notes for durable facts:
- **Watermark-based incremental parsing**: Check for `<!-- extracted:L{N}:{timestamp} -->` at the end of each daily note. If found, only parse lines after the last watermark. No watermark = parse entire file (backward compatible).
- Relationships, milestones, status changes, decisions, preferences
- Write to entity `items.json` with confidence and abstraction level
- Update `summary.md` for new Hot facts
- Create new entities when creation rules are met
- **After extraction**, append watermark: `<!-- extracted:L{lastLine}:{ISO timestamp} -->`
- **Only heartbeat writes watermarks** — inline extraction does NOT (dedup handles overlap)
- **After rotation**, watermark moves to archive with the original file; the stub has no watermark and is parsed entirely (cheap, 10-20 lines)
- Skip casual chat and transient requests

For the complete heartbeat flow, see [references/HEARTBEAT.md](references/HEARTBEAT.md).

### Domain Supervisor Scan

If subagent domains exist (`memory/domains/`), heartbeat acts as supervisor:

1. **PROPOSAL review** — `qmd query "PROPOSAL" -c domains` → auto-approve low-risk, alert user for high-risk
2. **Liveness check** — read each domain's `status.md`, alert if missed >2x schedule
3. **Changelog rotation** — rotate `changelog.md` >1000 lines to `archives/`
4. **KG extraction** — extract significant facts from changelogs to Knowledge Graph

For full details, see [references/HEARTBEAT.md](references/HEARTBEAT.md) and [references/subagent-memory.md](references/subagent-memory.md).

## Memory Decay

Facts decay based on recency, with modifiers for confidence, frequency, and abstraction:

| Tier | Recency | In summary? |
|------|---------|-------------|
| Hot | ≤7 days | ✅ Prominent |
| Warm | 8-30 days | ✅ Lower priority |
| Cold | 30+ days | ❌ (searchable via QMD) |

Full rules: [references/decay-rules.md](references/decay-rules.md)

## Operational Learning Loop (OLL)

System observes its own friction — what worked, what failed, what patterns emerged — and accumulates these observations for review.

### Storage Structure

```
workspace/ops/
├── observations/          # Operational observations
│   ├── index.json         # Registry of all observations
│   └── obs-0001.json      # Individual observation files
└── tensions/              # Contradictions between facts
    ├── index.json         # Registry of all tensions
    └── tension-0001.json  # Individual tension files
```

### Capturing Observations

```bash
# Basic observation (friction, surprise, quality)
bun skills/engram/scripts/memory-observe.js --observation "KG extraction missed facts about email" --category friction

# With description
bun skills/engram/scripts/memory-observe.js --observation "..." --category quality --description "Why this matters"

# Extended category (requires --extended flag)
bun skills/engram/scripts/memory-observe.js --observation "..." --category process --extended
```

**Categories:**
- `friction` — something that slowed work down
- `surprise` — unexpected outcome
- `quality` — code/content quality issue
- `process`, `methodology` — requires `--extended` flag

### Capturing Tensions

```bash
bun skills/engram/scripts/memory-tension.js \
  --tension "Two facts contradict each other" \
  --fact1 "sergey-001" \
  --fact2 "sergey-005" \
  --description "Context about the contradiction"
```

### Threshold Alerts

Heartbeat checks pending counts:
- **>20 pending observations** → alert
- **>5 pending tensions** → alert

Alerts appear in daily note report.

### Observation Schema

```json
{
  "id": "obs-0001",
  "observation": "KG extraction missed facts about email",
  "category": "friction",
  "description": "Why this matters",
  "status": "pending",
  "createdAt": "2026-02-25T12:00:00.000Z",
  "promotedAt": null,
  "archivedAt": null,
  "accessCount": 0
}
```

### Rules

- **Novelty check:** Jaccard similarity >0.7 with recent observations → rejected as duplicate
- **Review loop:** observations stay `pending` until reviewed → promoted to life/ or archived
- **Content promotion:** durable observations → promoted to Knowledge Graph as patterns/principles

For full OLL details, see [references/HEARTBEAT.md](references/HEARTBEAT.md) (Phase 5).

## Fact Schema v2

Each fact in `items.json` includes:

```json
{
  "id": "<entity>-NNN",
  "fact": "Human-readable statement",
  "category": "relationship|milestone|status|preference|context|decision|correction",
  "confidence": 0.85,
  "abstractionLevel": "episode|pattern|principle",
  "tags": ["tag1"],
  "timestamp": "2026-02-08",
  "source": "2026-02-07",
  "status": "active|superseded",
  "supersededBy": null,
  "relatedEntities": ["people/sergey"],
  "lastAccessed": "2026-02-08",
  "accessCount": 1
}
```

**No-Deletion Rule:** Facts are NEVER deleted. Set `status: "superseded"` and link via `supersededBy`.

**Write Pipeline Rule:** NEVER write `items.json` directly. Always use `bun skills/engram/scripts/memory-write.js`. Direct writes bypass dedup, validation, and hash registration, causing schema mismatches (e.g., `content` vs `fact`, `created` vs `timestamp`). This applies to heartbeats, inline extraction, and entity creation. No exceptions.

Full schema: [references/fact-schema.md](references/fact-schema.md)

## Subagent Memory

Pattern for subagents with `cleanup: "delete"` and long-term memory via domains.

### Quick Start

```bash
# Create a domain
bun skills/engram/scripts/add-domain.js --domain monitoring --description "Server monitoring"

# Configure rules in decisions.md
# Launch subagent with prompt from templates/spawn-prompt.md
```

### Domain Structure

```
memory/domains/{domain}/
├── decisions.md    # Rules (read-only for subagent)
├── workflow.md     # HOW the domain works: scripts, scope, tools (optional)
├── status.md       # Current state (written by subagent)
├── changelog.md    # Append-only log (written by subagent)
├── archives/       # Changelog rotation
└── README.md
```

**workflow.md** — optional file describing the domain's infrastructure (scripts, API, task scope, wiki links). Recommended for domains with 2+ task types. Simple domains (single task) can work without it.

Separation of concerns:
- **decisions.md** — WHAT can be done (rules, thresholds, constraints)
- **workflow.md** — HOW the domain works (scripts, API, scope, links)
- **Template (spawn-prompt)** — WHICH specific task to execute

### Rules

1. **One domain = one active subagent** at any given time
2. `decisions.md` — read-only for subagents; changes via PROPOSAL in changelog
3. Subagent does NOT write to daily notes or life/
4. QMD: one `domains` collection for all domains
5. Heartbeat: review PROPOSAL, rotate changelog, optionally KG extraction

### Project Domains

Domains can be linked to projects in the Knowledge Graph (`life/projects/`). This provides a two-way binding:

- **KG entity** (`life/projects/{name}/`) — what the bot knows about the project (facts, summary)
- **Domain** (`memory/domains/{name}/`) — context for the subagent (decisions, status, changelog)

The binding is defined via the domain registry (`memory/domains/registry.json`):

```json
{
  "domains": {
    "engram": {
      "type": "dev-project",
      "kgEntity": "projects/engram",
      "description": "Memory architecture skill",
      "subagentLabel": "engram",
      "spawnTemplate": "dev-project.md"
    },
    "monitoring": {
      "type": "cron-task",
      "description": "Server monitoring",
      "subagentLabel": "monitoring",
      "spawnTemplate": "cron-task.md"
    }
  }
}
```

**Registry fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `type` | ✅ | `dev-project` or `cron-task` |
| `description` | ✅ | Brief description |
| `spawnTemplate` | ⚠️ recommended | File from `templates/spawn-prompts/` |
| `subagentLabel` | ⚠️ recommended | Fixed label for sessions_spawn |
| `kgEntity` | no | Link to Knowledge Graph entity |

**Domain types:**
- `dev-project` — development, linked to KG entity, subagent on demand
- `cron-task` — periodic tasks, subagent on schedule

### Spawn Templates

**Rule: always use a template.** Don't write prompts manually — use `spawnTemplate` from the registry. This ensures the subagent receives the Domain Lifecycle (paths to decisions, status, changelog).

Templates are in `templates/spawn-prompts/`:
- `dev-project.md` — for development (decisions + status + changelog tail)
- `cron-task.md` — for periodic tasks (decisions + status)

Templates use placeholders: `{{domain}}`, `{{task}}`, `{{workflow}}`, `{{decisions}}`, `{{status}}`, `{{changelog_tail}}`.

Context chain: Template → workflow.md → decisions.md → wiki (if needed) → execution.

**Workflow:**
1. User gives a project task
2. Main bot finds the domain via `registry.json`
3. Loads the template from `spawnTemplate`
4. Injects domain context (decisions, status, changelog)
5. Spawns subagent with `subagentLabel` and `cleanup: "delete"`
6. Subagent determines where to work (repo, API, scripts — depends on the task)
7. After completion, main bot updates the domain (changelog, status)

**Where to work** — not specified in the domain. The bot determines the working directory from its memory and conversation context.

### Spawn Workflow

The main agent (not a script) handles spawning:

1. Find domain in `registry.json` → get `spawnTemplate`, `subagentLabel`
2. Read `status.md` + `changelog.md` (tail) → understand current state
3. Formulate exact task based on user request + domain context
4. Read `decisions.md` + `workflow.md` → include verbatim in prompt
5. Load template from `templates/spawn-prompts/{spawnTemplate}`
6. Replace `{{domain}}`, `{{decisions}}`, `{{workflow}}`, `{{task}}`
7. Spawn with `sessions_spawn(label: subagentLabel, cleanup: "delete", task: <prompt>)`

**Key principle:** the agent's judgment in interpreting status/changelog and formulating a precise task IS the value. Templates provide structure, not automation.

Detailed documentation: [references/subagent-memory.md](references/subagent-memory.md)

## Real-Time Extraction

Instead of waiting for heartbeats (up to 30 min), extract high-signal facts **inline during conversations**.

```
Message → Signal Scan (regex, <10ms) → Classify
  ├── HIGH (preference, decision, correction, milestone, instruction, identity)
  │     → Dedup (SHA-256) → Contradiction check → Write to KG → QMD update
  ├── LOW (context, work) → Daily note → Heartbeat extracts later
  └── NONE (casual) → Skip
```

### Signal Detection

```bash
bun skills/engram/scripts/memory-signal.js --text "Я предпочитаю TypeScript"
# → { "signal": "high", "categories": ["preference"], "confidence": 0.88 }
```

Supports **Russian and English**. Six categories: `correction`, `preference`, `decision`, `identity`, `instruction`, `milestone`.

### Write with Dedup + Contradiction Check

```bash
bun skills/engram/scripts/memory-write.js \
  --entity "people/sergey" \
  --fact "Prefers Bun over Node.js" \
  --category preference \
  --confidence 0.9 \
  --abstraction pattern \
  --tags "tools,runtime" \
  --source "2026-02-16"

# With contradiction detection
bun skills/engram/scripts/memory-write.js --entity "..." --fact "..." --category ... \
  --check-contradictions --cross-entity

# With semantic similarity check (BM25)
bun skills/engram/scripts/memory-write.js --entity "..." --fact "..." --category ... \
  --semantic-check --search-collections "life,openclaw-memory-agent-main-main"
```

Automatically: content-hash dedup → optional contradiction/semantic check → write fact → validate KG → update QMD.

### Contradiction Detection

```bash
# Intra-entity (fast, no QMD)
bun skills/engram/scripts/memory-contradict.js --fact "Uses Node.js" --entity "people/sergey"

# Cross-entity (via QMD BM25, searches all entities)
bun skills/engram/scripts/memory-contradict.js --fact "Uses Node.js" --entity "people/sergey" \
  --cross-entity --collections "life,openclaw-memory-agent-main-main"
```

### Rules for Inline Extraction

- Only in **main session** (group chats don't touch KG)
- HIGH signal → extract immediately via `memory-write.js`
- LOW signal → daily note only (heartbeat extracts later)
- Do NOT write extraction watermarks during inline extraction (heartbeat only)
- Dedup is automatic — duplicates from inline + heartbeat silently skipped

## Session Recording

Daily notes capture session activity. Two-level protection:

```
Level 1: Agent inline (primary)     — best quality, during session
         ↓ forgot?
Level 2: Compaction memoryFlush     — safety net before context compression
```

### Level 1: Agent Inline (Primary)

Record to daily note when:
- **Topic completed** — a task/discussion block finishes (every 5-10 messages)
- **Decision made** — any explicit decision → `--section decisions`
- **Topic shift** — conversation moves to a new subject
- **Significant result** — something was built, fixed, or discovered

```bash
bun skills/engram/scripts/daily-note-append.js \
  --session main --section events --text "Fixed 44 semantic duplicates in KG"

bun skills/engram/scripts/daily-note-append.js \
  --session main --section decisions --text "Jaccard ≥ 0.5 now blocks writes (was warning-only)"
```

### Level 2: Compaction memoryFlush

Configured in OpenClaw (`agents.defaults.compaction.memoryFlush`). Before context compression, the agent receives a prompt to write lasting notes to memory files. Configure with a specific instruction:

```json
{
  "memoryFlush": {
    "enabled": true,
    "prompt": "Write session events/decisions/learnings to today's daily note via: bun skills/engram/scripts/daily-note-append.js --session main --section <section> --text '<text>'. Then reply NO_REPLY.",
    "systemPrompt": "Session nearing compaction. Record substantive work to daily note now."
  }
}
```

### Rules

- Keep entries brief (1-2 lines each)
- Record facts, not feelings ("Fixed X" not "Had a great session")
- Operational events → `events`, explicit choices → `decisions`, insights → `learnings`
- Do NOT wait for session end — record as you go
- Session-End Checklist (AGENTS.md) handles `threads` and `next` sections

## Scripts

### install-qmd.js — Install QMD search engine

```bash
bun skills/engram/scripts/install-qmd.js [--variant local|jina] [--jina-key <key>]
```

Interactive installer for QMD. Two variants:
- **local** — GPU/CPU embeddings via Vulkan/llama.cpp (recommended for desktop)
- **jina** — Cloud embeddings via Jina AI API, free tier 1M tokens/month (recommended for Docker/VPS)

Handles npm install, API key configuration, .env file creation, and verification.

### init.js — Initialize memory system

```bash
bun skills/engram/scripts/init.js [--agent-id main] [--qmd-variant auto|local|jina] [--force]
```

Creates complete directory structure, copies templates, sets up QMD collections, runs initial index. Use `--force` to merge with existing directories.

### add-session.js — Add new session

```bash
bun skills/engram/scripts/add-session.js --platform telegram --id <groupId> [--agent-id main]
```

Creates session directory, copies group-knowledge templates, adds QMD collection, updates heartbeat-state.json.

### add-domain.js — Create subagent domain

```bash
bun skills/engram/scripts/add-domain.js --domain <name> [--description "Description"]
```

Creates `memory/domains/{domain}/` with decisions.md, status.md, changelog.md, README.md. Registers QMD collection `domains` (one for all domains). Warns if >20 domains.

### validate.js — Check integrity

```bash
bun skills/engram/scripts/validate.js [--fix] [--agent-id main]
```

Checks directory structure, required files, items.json validity, v2 schema compliance, ID uniqueness, supersededBy references. Use `--fix` to auto-repair.

### migrate-v2.js — Migrate to v2 schema

```bash
bun skills/engram/scripts/migrate-v2.js [--dry-run]
```

Adds missing v2 fields (confidence, abstractionLevel, tags) to all items.json files with sensible defaults.

### memory-signal.js — Signal detection

```bash
bun skills/engram/scripts/memory-signal.js --text "I prefer TypeScript"
```

Classifies text as high/low/none signal. Regex-based, no LLM, <10ms. Returns categories, keywords, confidence.

### memory-write.js — Unified write pipeline

```bash
# Write a fact
bun skills/engram/scripts/memory-write.js --entity <path> --fact <text> --category <cat> \
  [--confidence 0.9] [--abstraction pattern] [--tags "a,b"] [--source "2026-02-16"] \
  [--description "Why this fact matters (max 150 chars)"] \
  [--entity-create] [--check-contradictions] [--cross-entity] \
  [--semantic-check] [--search-collections "life,collection2"]

# Track access (updates lastAccessed + accessCount for decay)
bun skills/engram/scripts/memory-write.js --access --entity <path> --id <fact-id>
```

Single entry point for all KG writes. Handles dedup, validation, QMD update, optional contradiction/semantic checks. Use `--entity-create` to create new entities on the fly. Use `--access` mode to bump a fact's recency (important for decay tiers).

### memory-dedup.js — Deduplication index

```bash
bun skills/engram/scripts/memory-dedup.js --seed    # Index all existing facts
bun skills/engram/scripts/memory-dedup.js --check --hash <sha256>  # Check if exists
```

Manages `workspace/memory-state/fact-hashes.json`. Run `--seed` after initial setup or weekly synthesis.

### memory-contradict.js — Contradiction detection

```bash
bun skills/engram/scripts/memory-contradict.js --fact <text> --entity <path> \
  [--cross-entity] [--collections "life,other"]
```

Finds conflicting facts via Jaccard similarity. Intra-entity by default; `--cross-entity` discovers related entities via QMD BM25.

### memory-observe.js — Capture operational observations

```bash
bun skills/engram/scripts/memory-observe.js --observation "text" --category friction [--description "desc"] [--extended] [--dry-run]
```

Captures observations about system friction, surprises, or quality issues. Includes novelty check (Jaccard similarity >0.7 rejects duplicates).

### memory-tension.js — Capture contradictions

```bash
bun skills/engram/scripts/memory-tension.js --tension "text" --fact1 <id> --fact2 <id> [--description "desc"] [--dry-run]
```

Captures tensions between two facts. Validates that both fact IDs exist in KG before creating tension. Includes Jaccard novelty check (>0.7 similarity → skips duplicate).

### daily-note-append.js — Record session activity to daily note

```bash
bun skills/engram/scripts/daily-note-append.js \
  --session main --agent-id main --section events --text "Fixed 44 semantic duplicates in KG"
```

Atomically appends a bullet entry to a named section of today's daily note. Creates the note from template if it doesn't exist. Sections: `events`, `decisions`, `learnings`, `threads`, `next`. Never overwrites existing content, never touches watermarks or Heartbeat Report.

### rebuild-summaries.js — Rebuild summary.md from items.json

```bash
bun skills/engram/scripts/rebuild-summaries.js [--dry-run] [--entity people/sergey] [--apply-decay]
```

Deterministically regenerates `summary.md` for all entities in `life/` from their `items.json`. No LLM involved.

**Without `--apply-decay`**: groups active facts by category, lists top 5 by confidence, shows counts per category and superseded stats. Outputs `{ "updated": N, "skipped": N, "errors": N }`.

**With `--apply-decay`**: applies Memory Decay tiers (Hot/Warm/Cold) based on `lastAccessed`/`createdAt`/`source` date. Summary format changes to tiered sections: `## Current (Hot)`, `## Background (Warm)`, `## Enduring (Principles)`. Cold facts (except principles) are excluded from summary but remain in items.json. Outputs `{ "updated": N, "skipped": N, "errors": N, "hot": N, "warm": N, "coldExcluded": N }`.

Decay algorithm: see `references/decay-rules.md`. Used by `HB-SYNTHESIS.md` subagent during Monday heartbeat.

Use `--dry-run` to preview diffs without writing. Use `--entity` to process one entity.

### rotate-notes.js — Three-Layer Rotation

```bash
bun skills/engram/scripts/rotate-notes.js --check --session main              # Check if daily note needs rotation
bun skills/engram/scripts/rotate-notes.js --check-domains                      # Check all domain changelogs
bun skills/engram/scripts/rotate-notes.js --rotate --file <path> --type daily  # Rotate daily note (>1000 lines)
bun skills/engram/scripts/rotate-notes.js --rotate --file <path> --type changelog  # Rotate changelog
# exit 0: nothing to rotate / done | exit 10: needs rotation (--check mode)
```

Handles Three-Layer Rotation for daily notes (archive + stub + QMD index) and simple rotation for domain changelogs. Called by heartbeat Phase 0.5. Daily note stubs contain a `<!-- STUB: ... -->` marker for the agent to fill with a summary later.

### heartbeat-state.js — State management

```bash
bun skills/engram/scripts/heartbeat-state.js --get-all
bun skills/engram/scripts/heartbeat-state.js --set pendingObservations 5
```

Atomic read/write of `memory/heartbeat-state.json`. All heartbeat phase trackers (`lastExtraction`, `lastDomainScan`, `subagentRuns`, etc.) must be updated via this script — never edit the JSON directly.

### heartbeat-report.js — Daily note report section

```bash
bun skills/engram/scripts/heartbeat-report.js --session main --date 2026-02-27 \
  --extraction "spawned (result pending)" \
  --synthesis  "skipped (not Monday)" \
  --domains    "spawned (result pending)" \
  --maintenance "ok — validate-kg.js: 0 errors"
```

Creates or updates `## Heartbeat Report` section in a daily note. Called by heartbeat orchestrator in Phase 6 (initial write) and by `process-handoff.js` (status update after subagent handoff). Omit any flag to preserve its current value.

### process-handoff.js — HB subagent handoff processor

```bash
printf '%s' "<handoff block>" | bun skills/engram/scripts/process-handoff.js --session main --date 2026-02-27
# exit 0: ok | exit 1: error | exit 2: alerts present ([ALERT] lines in stdout)
```

Processes `=== HB-* HANDOFF ===` blocks from subagent results. Handles HB-EXTRACT (watermark advance, lastExtraction, facts count), HB-DOMAINS (lastDomainScan), HB-SYNTHESIS (lastWeeklySynthesis). Updates heartbeat-state.json, advances watermark in daily note, and calls heartbeat-report.js automatically. Called by the heartbeat orchestrator Handoff Handler — do not call manually.

## OpenClaw Hooks

Engram ships 5 OpenClaw hooks that automate mechanical session tasks. Hooks run automatically — agents do NOT need to repeat these steps manually.

| Hook | Event | What it does |
|------|-------|--------------|
| `engram-daily-note` | `gateway:startup` | Creates today's daily note for all sessions |
| `engram-session-start` | `agent:bootstrap` | Appends `<!-- session:start:{ISO} -->` to daily note |
| `engram-session-end` | `command:new`, `command:reset` | Appends `<!-- session:end:{ISO} -->` to daily note |
| `engram-bootstrap-qmd` | `agent:bootstrap` | Runs `qmd update` (15s timeout, silent skip if unavailable) |
| `engram-message-log` | `message:received` | Logs messages to `workspace/message-log/YYYY-MM-DD.jsonl` |

### Execution order on `/new`

1. `engram-session-end` fires on `command:new` → writes `<!-- session:end -->`
2. New agent session starts → `agent:bootstrap` fires
3. `engram-session-start` → writes `<!-- session:start -->`
4. `engram-bootstrap-qmd` → refreshes QMD index

### Installation

Hooks are installed automatically by `scripts/init.js` (copies `skills/engram/hooks/engram-*` → `hooks/engram-*` in workspace root, only if not already present).

**Manual installation:**
```bash
# Copy hooks to workspace
cp -r skills/engram/hooks/engram-* hooks/

# Restart Gateway to activate
openclaw gateway restart
```

Hook source files are in `skills/engram/hooks/`. The workspace `hooks/` directory contains the live copies — do not edit skill source directly.

### Configuration

Hooks use `ENGRAM_TZ` (or `TZ`) environment variable for timezone. Default: `UTC`.

```bash
# Set in OpenClaw config (env.vars) or shell:
export ENGRAM_TZ="Europe/Moscow"   # or America/New_York, Asia/Tokyo, etc.
```
