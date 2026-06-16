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

# 3. Install cron (optional): bun skills/engram/scripts/init.js --with-cron

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

### Subagent Model Resolution

The heartbeat spawns subagents (hb-extract, hb-synthesis, hb-domains, hb-rethink, hb-autoresearch, hb-rethink2). The model for each is **not hardcoded** in the protocol — it is resolved at spawn time by `scripts/config.js → resolveSubagentModel(workspace, label)`. Resolution order:

1. `process.env.ENGRAM_MODEL_<LABEL_UPPER>` (e.g. `ENGRAM_MODEL_HB_EXTRACT`)
2. `engram.json → models.heartbeat.subagents[<label>]` (e.g. `"hb-extract": "<model-id>"`)
3. Per-label default in `SUBAGENT_MODEL_DEFAULTS` (currently `sonnet-4-6` for all phases)
4. Generic fallback: `sonnet-4-6`

Example `engram.json` override:
```json
{
  "models": {
    "heartbeat": {
      "subagents": {
        "hb-extract": "<cheap-model>",
        "hb-synthesis": "<capable-model>"
      }
    }
  }
}
```

**Why configurable, not hardcoded:** Engram is model-agnostic. The protocol docs use `sonnet-4-6` as a sensible default so behavior is reproducible across deployments, but hardcoding deployment-specific aliases (e.g. `m3`, `m2.7`) in the protocol would leak private infra and break for other users.

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

Only the agent writes observations — subagents return `Flags:` in handoffs for the agent to review.

```bash
# Friction, surprise, or pattern (inline during session)
bun skills/engram/scripts/memory-observe.js --observation "KG extraction missed facts about email" --category friction
bun skills/engram/scripts/memory-observe.js --observation "..." --category surprise --description "Why this matters"
```

**Categories:** `friction` (weight ×3), `surprise` (weight ×2), `pattern` (weight ×1)

### Capturing Tensions

Tensions are auto-created when `memory-write.js --check-contradictions` finds Jaccard ≥0.5 + ≥3 common keywords. Manual creation:

```bash
bun skills/engram/scripts/memory-tension.js \
  --tension "Fact A contradicts fact B" \
  --fact1 "sergey-001" --fact2 "sergey-005" \
  --type factual \
  --confidence 0.8 \
  --description "Context about the contradiction"
```

**Types:** `factual` (default), `temporal`, `priority`

### Promoting or Archiving Observations

```bash
# Promote obs → KG fact (with backlink)
bun skills/engram/scripts/memory-promote.js \
  --obs-id obs-0002 --entity "projects/engram" \
  --fact "Extraction finds no facts in heartbeat-only daily notes" \
  --category context --confidence 0.8 --abstraction pattern \
  --tags "extraction,heartbeat" [--dry-run]

# Archive (noise, status report, resolved friction)
bun skills/engram/scripts/memory-promote.js --archive \
  --obs-id obs-0003 --reason "domain status report, not friction"
```

**Backlink:** promoted KG fact gets `source: obs-id`; obs file gets `kgFactId`.

### OLL Rethink Trigger (Heartbeat Phase 5)

Phase 5 computes weighted score and spawns `hb-rethink` when triggered:

| Condition | Threshold |
|-----------|-----------|
| Weighted score (f×3 + s×2 + p×1) | ≥ 15 |
| Pending tensions | ≥ 3 |
| Days since last rethink | ≥ 14 |

`hb-rethink` (sonnet-4-6) reviews observations + tensions, identifies patterns, generates proposals, and returns a `HB-RETHINK HANDOFF` block. `process-handoff.js` auto-executes low-risk actions (archive noise, promote facts) and surfaces an ALERT.

### Resolving Tensions

```bash
# Resolved: one fact supersedes the other
bun skills/engram/scripts/memory-tension-resolve.js \
  --id tension-0001 --resolution "fact-abc superseded by fact-xyz"

# Dissolved: not actually contradictory
bun skills/engram/scripts/memory-tension-resolve.js \
  --id tension-0001 --dissolved \
  --resolution "facts are scope-dependent (work vs personal context)"
```

### Schemas

**Observation:**
```json
{
  "id": "obs-0001",
  "observation": "KG extraction missed facts about email",
  "category": "friction",
  "status": "pending | promoted | implemented | archived",
  "createdAt": "2026-02-25T12:00:00.000Z",
  "promotedAt": null,
  "archivedAt": null,
  "kgFactId": null,
  "accessCount": 0
}
```

**Tension:**
```json
{
  "id": "tension-0001",
  "tension": "Possible contradiction: ...",
  "type": "factual | temporal | priority",
  "confidence": 0.72,
  "fact1": "sergey-001",
  "fact1Text": "Prefers Bun over Node.js",
  "fact2": "sergey-005",
  "fact2Text": "Uses Node.js for all projects",
  "description": "Auto-detected (Jaccard 0.72, 4 common words)",
  "status": "pending | resolved | dissolved",
  "createdAt": "2026-03-03T15:00:00.000Z"
}
```

**index.json stats:**
```json
{
  "observations": ["obs-0001", ...],
  "lastId": 10,
  "stats": { "total": 10, "pending": 1, "promoted": 2, "implemented": 1, "archived": 6 }
}
```

For full OLL details, see [references/HEARTBEAT.md](references/HEARTBEAT.md) (Phase 5) and [references/HB-RETHINK.md](references/HB-RETHINK.md).

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
| `type` | ✅ | `dev-project`, `cron-task`, or `topic-thread` |
| `description` | ✅ | Brief description |
| `spawnTemplate` | ⚠️ recommended | File from `templates/spawn-prompts/` |
| `subagentLabel` | ⚠️ recommended | Fixed label for sessions_spawn |
| `kgEntity` | no | Link to Knowledge Graph entity |

**Domain types:**
- `dev-project` — development, linked to KG entity, subagent on demand
- `cron-task` — periodic tasks, subagent on schedule
- `topic-thread` — Telegram topic as memory contour (not a subagent; the topic itself is the long-lived OpenClaw session), bound via `registry.domains[slug].topic = { chatId, topicId }`. Hook `engram-topic-domain-load` injects `## Domain Context` block into the topic session's daily note on `message:received`. Hook `engram-topic-auto-domain-suggest` injects a `## engram:auto-suggest` block in unbound topics once a topic accumulates ≥2 user messages. See `references/topic-thread.md` for the full contract. Heartbeat-runner archives stale topic-thread domains after `staleAfterDays` (default 60) to `memory/domains/archives/{slug}/` and sets `archived: true` + `archivedAt` + `archivePath` in the registry. Hook `engram-topic-domain-load` re-activates an archived domain automatically on the next `message:received` in its topic.

### Spawn Templates

**Rule: always use a template.** Don't write prompts manually — use `spawnTemplate` from the registry. This ensures the subagent receives the Domain Lifecycle (paths to decisions, status, changelog).

Templates are in `templates/spawn-prompts/`:
- `dev-project.md` — for development (decisions + AGENTS + status + changelog tail)
- `cron-task.md` — for periodic tasks (decisions + AGENTS + status)

Templates use placeholders: `{{domain}}`, `{{task}}`, `{{workflow}}`, `{{decisions}}`, `{{status}}`, `{{changelog_tail}}`, `{{agents}}`.

**`{{agents}}`** — runtime ruleset для subagent'а (QMD default, read/write rules, when to escalate). Rendered through `scripts/render-agents-section.js --domain <slug> --kg-entity <path> --spawn-type dev-project|cron-task`. Generic в `_shared/agents-section.template.md`, workspace-specific values (QMD index, agentId, operator) подставляются из `engram.json` + env vars. Обязателен: subagent без `{{agents}}` может дрифтить в cross-topic/cross-KG поиск.

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
7. Render `{{agents}}` via `bun skills/engram/scripts/render-agents-section.js --domain <slug> --kg-entity <path> --spawn-type dev-project|cron-task` (output captured into prompt)
8. Spawn with `sessions_spawn(label: subagentLabel, cleanup: "delete", task: <prompt>)`

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

### install-cron.js — Install heartbeat cron job

```bash
bun skills/engram/scripts/install-cron.js [install|uninstall|status] [options]
```

Provisions the OpenClaw cron job that drives the heartbeat (Phase 5.5: runner + spawn-claim + sessions_spawn). Idempotent: detects existing cron job by name, creates if missing, updates the payload to the current 4-step prose form if outdated. Does NOT touch agentId, schedule, model, or delivery config — only `name` and `payload.message`.

Use after `init.js`, or pass `--with-cron` to `init.js` to do both in one step.

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

For `type=topic-thread` (Telegram topic as memory contour), also creates:
- `agents.md` — operational ruleset for the topic-agent (QMD default, read/write rules). Injected into the daily note by `engram-topic-domain-load` as the `## Domain AGENTS (auto)` block.
- QMD collections: shared `domains`, per-domain `domain-{slug}`, per-entity `life-projects-{slug}` (opt-in if `--kg-entity` given).
- Telegram binding in `registry.json` (`topic: { chatId, topicId }`).

Example:
```bash
bun skills/engram/scripts/add-domain.js --domain engram \
  --type topic-thread \
  --topic <chatId>:<topicId> \
  --kg-entity projects/engram \
  --description "Engram memory architecture — design, RFC, decisions"
```

### backfill-domain-agents.js — Create/refresh agents.md for topic-thread domains

```bash
bun skills/engram/scripts/backfill-domain-agents.js             # create missing
bun skills/engram/scripts/backfill-domain-agents.js --force     # overwrite all
bun skills/engram/scripts/backfill-domain-agents.js --domain engram  # one domain
bun skills/engram/scripts/backfill-domain-agents.js --dry-run  # preview
```

Renders `templates/domain/topic-thread/agents.md` with substitutions and writes to `memory/domains/{slug}/agents.md`. Use to:
- Apply the current template to all existing topic-thread domains (one-off backfill).
- Apply an updated template to all domains (with `--force`, since manual overrides are preserved by default).
- Pre-create a single domain's agents.md (with `--domain`).

Idempotent: skips existing files unless `--force` is passed. Archival-archived domains are skipped unless explicitly named.

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
bun skills/engram/scripts/memory-observe.js --observation "text" --category friction [--description "desc"] [--dry-run]
```

Captures observations about system friction, surprises, or patterns. Categories: `friction`, `surprise`, `pattern`. Includes novelty check (Jaccard >0.7 rejects duplicates). Only the agent writes observations directly — subagents return `Flags:` in handoffs.

### memory-tension.js — Capture contradictions

```bash
bun skills/engram/scripts/memory-tension.js \
  --tension "text" --fact1 <id> --fact2 <id> \
  [--type factual|temporal|priority] [--confidence 0.8] [--description "desc"] [--dry-run]
```

Captures tensions between two KG facts. Validates both IDs exist in KG. Stores `fact1Text`/`fact2Text` from KG for hb-rethink review. Auto-created by `memory-write.js --check-contradictions` when Jaccard ≥0.5 + ≥3 common keywords. Novelty check (>0.7 → skip duplicate).

### memory-tension-resolve.js — Resolve or dissolve tensions

```bash
bun skills/engram/scripts/memory-tension-resolve.js --id tension-0001 --resolution "text"
bun skills/engram/scripts/memory-tension-resolve.js --id tension-0001 --dissolved --resolution "text"
```

Marks tension as `resolved` (contradiction fixed) or `dissolved` (not actually contradictory). Idempotent if already closed.

### memory-promote.js — Promote observation to KG or archive it

```bash
# Promote obs → KG fact (with backlink: obs.kgFactId ← fact.source = obs-id)
bun skills/engram/scripts/memory-promote.js \
  --obs-id obs-0002 --entity "projects/engram" --fact "text" \
  --category context --confidence 0.8 [--abstraction pattern] [--tags "..."] [--dry-run]

# Archive observation
bun skills/engram/scripts/memory-promote.js --archive --obs-id obs-0003 --reason "noise"
```

Updates `index.json stats` (total/pending/promoted/implemented/archived) after every status change.

### daily-note-append.js — Record session activity to daily note

```bash
bun skills/engram/scripts/daily-note-append.js \
  --session main --agent-id main --section events --text "Fixed 44 semantic duplicates in KG"
```

Atomically appends a bullet entry to a named section of today's daily note. Creates the note from template if it doesn't exist. Sections: `events`, `decisions`, `learnings`, `threads`, `next`. Never overwrites existing content, never touches watermarks or Heartbeat Report.

### rebuild-summaries.js — Rebuild summary.md from items.json

```bash
bun skills/engram/scripts/rebuild-summaries.js [--dry-run] [--entity people/sergey] [--apply-decay] [--max-cold-principles 12]
```

Deterministically regenerates `summary.md` for all entities in `life/` from their `items.json`. No LLM involved.

**Without `--apply-decay`**: groups active facts by category, lists top 5 by confidence, shows counts per category and superseded stats. Outputs `{ "updated": N, "skipped": N, "errors": N }`.

**With `--apply-decay`**: applies Memory Decay tiers (Hot/Warm/Cold) based on `lastAccessed`/`createdAt`/`source` date. Summary format changes to tiered sections: `## Current (Hot)`, `## Background (Warm)`, `## Enduring (Principles)`. Cold facts are excluded from summary unless selected by semantic priority. Cold principles are sorted by priority/access/confidence/date and capped by `--max-cold-principles` (default 12) so `summary.md` stays quick-context sized; omitted facts remain in items.json and searchable via QMD. Outputs include `{ "updated": N, "skipped": N, "errors": N, "hot": N, "warm": N, "coldExcluded": N, "omittedOperational": N, "omittedTestArtifacts": N, "includedByPriority": N, "limitedPrinciples": N }`.

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

### heartbeat-runner.js — Deterministic cron entrypoint

```bash
bun skills/engram/scripts/heartbeat-runner.js \
  --workspace /path/to/workspace \
  --agent-id main \
  --session main \
  --label-prefix hb
```

Runs the mechanical heartbeat path without relying on an LLM to interpret
`HEARTBEAT.md`: lock handling, daily note creation, extraction watermark,
weekly summary rebuild, heartbeat report, validation, `qmd update`, and
`qmd embed`. This is the recommended production cron target; see
`references/setup.md` for the OpenClaw cron payload.

Use `--all-active-sessions` for workspace-level heartbeat. It reads
`activeSessions` from `memory/heartbeat-state.json`, runs extraction/report for
each active session, then runs workspace maintenance once. Use `engram.json`
`qmd.index`, `qmd.collections`, and optional `qmd.command` when a workspace has a
named QMD index or needs a Windows-safe command path.

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

Engram ships 7 OpenClaw hooks that automate mechanical session tasks. Hooks run automatically — agents do NOT need to repeat these steps manually.

| Hook | Event | What it does |
|------|-------|--------------|
| `engram-daily-note` | `gateway:startup` | Creates today's daily note for all sessions |
| `engram-session-start` | `agent:bootstrap` | Appends `<!-- session:start:{ISO} -->` to daily note |
| `engram-session-end` | `command:new`, `command:reset` | Appends `<!-- session:end:{ISO} -->` to daily note |
| `engram-bootstrap-qmd` | `agent:bootstrap` | Runs `qmd update` (15s timeout, silent skip if unavailable) |
| `engram-message-log` | `message:received` | Logs messages to `workspace/message-log/YYYY-MM-DD.jsonl` |
| `engram-session-memory` | `command:new`, `command:reset` | Save session transcript to `sessions/` subdir (QMD-indexed). Replaces native `session-memory`. |
| `engram-topic-domain-load` | `message:received` | On Telegram topic, inject `## Domain Context (auto)` (decisions/status/changelog) **and** `## Domain AGENTS (auto)` (per-domain ruleset) blocks at the top of today's daily note. |
| `engram-topic-auto-domain-suggest` | `message:received` | Sibling of `engram-topic-domain-load`. In unbound topics, after ≥2 user messages, inject `## engram:auto-suggest` block offering domain creation. |

> **Note:** Disable the built-in `session-memory` hook when enabling `engram-session-memory` — they serve the same purpose but write to different locations.

### Execution order on `/new`

1. `engram-session-end` fires on `command:new` → writes `<!-- session:end -->`
2. New agent session starts → `agent:bootstrap` fires
3. `engram-session-start` → writes `<!-- session:start -->`
4. `engram-bootstrap-qmd` → refreshes QMD index

### Topic-thread message flow

1. `engram-message-log` fires on `message:received` → logs to `workspace/message-log/`
2. `engram-topic-domain-load` fires on `message:received` → injects Domain Context + Domain AGENTS blocks (idempotent per-block)
3. `engram-topic-auto-domain-suggest` fires on `message:received` (sibling) → if topic is unbound and ≥2 user messages, injects `## engram:auto-suggest` block

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
