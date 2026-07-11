---
name: engram
description: Etalon memory architecture with Knowledge Graph, session isolation, memory decay, and QMD hybrid search (Local/Jina/Ollama)
---

# Engram Memory System

> v3.5 (2026-07-11). Skill is read-only — copy scripts to your workspace, do not edit.
> Changelog: workspace `CHANGELOG.md` · Spec addenda: `memory/tmp/engram-v35-addendum.md`
> For script reference: [references/scripts.md](references/scripts.md)

## Quick Start

```bash
# Initialize complete memory system
bun skills/engram/scripts/init.js --agent-id main --qmd-variant auto

# With heartbeat cron (recommended)
bun skills/engram/scripts/init.js --agent-id main --qmd-variant auto --with-cron

# Force merge into existing workspace
bun skills/engram/scripts/init.js --force
```

## Architecture Overview

```
workspace/
├── life/                    # Knowledge Graph (entities, facts, summaries)
│   ├── people/sergey/
│   │   ├── items.json        # Facts array (v2 schema)
│   │   └── summary.md        # Quick-context (Hot/Warm/Cold tiers)
│   └── projects/engram/
├── memory/                   # Operational memory
│   ├── sessions/             # Daily notes (per-session)
│   │   └── main/2026-02-08.md
│   ├── domains/              # Subagent domains
│   │   ├── registry.json     # Domain registry
│   │   └── {slug}/
│   ├── heartbeat-state.json  # Phase tracker
│   └── memory-state/         # Dedup hashes
├── ops/                      # OLL: observations + tensions
└── engram.json               # Workspace config (models, QMD)
```

Three-layer storage: **Daily Notes** (ephemeral, rotated) → **Knowledge Graph** (durable facts, tiered retrieval) → **QMD** (hybrid search: BM25 + embeddings + rerank).

For full architecture: [references/architecture.md](references/architecture.md)

## Memory Rules

### Session Isolation

**Golden Rule: Memory is isolated by session.**

| Session Type | Memory Scope | KG Access | Daily Notes |
|---|---|---|---|
| Main (direct chat) | Full KG + all collections | ✅ Write | ✅ |
| Group (topic) | Domain context only | ❌ | ✅ (own session) |
| Subagent (cleanup:delete) | Domain only | ❌ | ❌ (uses changelog) |

- **NEVER** cross-reference one project's memory from another project's session.
- Group chats **CANNOT** see `MEMORY.md` or `life/` — only main session has full KG access.
- **Always** specify `-c <collection>` in QMD queries — never query without a collection flag.

### Every Session Startup (automated by hooks)

- `engram-session-start` → creates sessionDir + daily note, writes `<!-- session:start -->`
- `engram-bootstrap-qmd` → refreshes QMD index
- `engram-daily-note` → creates daily note template on `gateway:startup`
- For topic-thread: `engram-topic-domain-load` injects Domain Context + AGENTS via system-event

### Writing Memory

**NEVER write `items.json` directly.** Always use `bun skills/engram/scripts/memory-write.js`. Direct writes bypass dedup, validation, and hash registration, causing schema mismatches. No exceptions.

**Pipeline:** content-hash dedup → optional contradiction/semantic check → write fact → validate KG → update QMD.

```bash
bun skills/engram/scripts/memory-write.js \
  --entity "people/sergey" --fact "Prefers Bun over Node.js" \
  --category preference --confidence 0.9 --abstraction pattern \
  --tags "tools,runtime" --source "2026-02-16"
```

### Daily Notes (Three-Layer Rotation)

- Daily notes capture session activity in sections: `events`, `decisions`, `learnings`, `threads`, `next`
- **Three-Layer Rotation**: when daily note >1000 lines → Archive (QMD-indexed) → Stub (10-20 lines) → QMD reindex
- Write via `daily-note-append.js` — never edit daily notes directly
- Record as you go, not at session end

```bash
bun skills/engram/scripts/daily-note-append.js \
  --session main --section events --text "Fixed 44 semantic duplicates in KG"
```

### Knowledge Graph

- **Tiered retrieval**: `summary.md` first (quick context), `items.json` on demand (full facts)
- **Entity creation**: when 2+ facts reference same entity, create KG entity
- **No-Deletion Rule**: facts are NEVER deleted. Set `status: "superseded"` and link via `supersededBy`.
- Fact Schema: [references/fact-schema.md](references/fact-schema.md)

### Memory Decay

| Tier | Recency | In summary? |
|------|---------|-------------|
| Hot | ≤7 days | ✅ Prominent |
| Warm | 8-30 days | ✅ Lower priority |
| Cold | 30+ days | ❌ (searchable via QMD) |

Full decay rules: [references/decay-rules.md](references/decay-rules.md)

### QMD Search

QMD = hybrid search engine (BM25 + embeddings + rerank). Three providers: local (Vulkan), jina (cloud), ollama (REST).

**Query triggers:**

🔴 **Always search QMD when:**
- User asks "what do you know about…" / "найди…" / "remember when…"
- User references a person/project/entity by name
- User asks to recall, find, or check memory

🟡 **Consider searching QMD when:**
- User mentions a topic that might have related facts
- You need context for a decision
- Current conversation might benefit from historical context

**Commands:**
```bash
qmd search "query" -c <collection>              # BM25, <1s
qmd query "query" -c <collection>                # Hybrid (embeddings + rerank), ~3s
qmd query "query" -c <coll1> -c <coll2>          # Multi-collection
```

For QMD installation: [references/qmd-setup.md](references/qmd-setup.md)

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

### Contradiction Detection

```bash
# Intra-entity (fast, no QMD)
bun skills/engram/scripts/memory-contradict.js --fact "Uses Node.js" --entity "people/sergey"

# Cross-entity (via QMD BM25)
bun skills/engram/scripts/memory-contradict.js --fact "Uses Node.js" --entity "people/sergey" \
  --cross-entity --collections "life,openclaw-memory-takeron-main"
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

### When to record

- **Topic completed** — a task/discussion block finishes (every 5-10 messages)
- **Decision made** — any explicit decision → `--section decisions`
- **Topic shift** — conversation moves to a new subject
- **Significant result** — something was built, fixed, or discovered

```bash
bun skills/engram/scripts/daily-note-append.js \
  --session main --section events --text "Fixed 44 semantic duplicates in KG"
```

### Rules

- Keep entries brief (1-2 lines each)
- Record facts, not feelings ("Fixed X" not "Had a great session")
- Operational events → `events`, explicit choices → `decisions`, insights → `learnings`
- Do NOT wait for session end — record as you go

## Heartbeat

10-фазный оркестратор, запускается cron'ом каждые 30 минут. LLM-фазы spawn'ят subagent'ов; механические — inline.

| Phase | Kind | Назначение |
|-------|------|-----------|
| 0 | inline | Fast Init: state, lock, check |
| 0.5 | inline | Rotation: daily notes >1000 lines |
| 1 | subagent | Extraction: hb-extract |
| 1.5 | inline | Stub Summary |
| 2 | subagent | Synthesis: hb-synthesis (Mon only) |
| 3 | subagent | Domains Status: hb-domains |
| 3.5 | subagent | Domains Write: hb-domains-write |
| 4 | inline | Maintenance: validate, qmd update/embed |
| 5 | inline | OLL Check: rethink triggers |
| 5.5 | inline | OLL Spawn Queue |
| 6 | inline | Report + Unlock |

For full heartbeat flow, cron provisioning, and subagent model resolution: [references/heartbeat-flow.md](references/heartbeat-flow.md) · [references/HEARTBEAT.md](references/HEARTBEAT.md)

## Operational Learning Loop (OLL)

System observes its own friction and accumulates observations for review.

**Write observations:**
```bash
bun skills/engram/scripts/memory-observe.js --observation "KG extraction missed facts" --category friction
```

**Categories:** `friction` (weight ×3), `surprise` (weight ×2), `pattern` (weight ×1)

**Tensions** are auto-created when contradiction check finds Jaccard ≥0.5 + ≥3 common keywords, or manually:
```bash
bun skills/engram/scripts/memory-tension.js --tension "..." --fact1 <id> --fact2 <id>
```

**hb-rethink** reviews observations + tensions during heartbeat Phase 5, generates proposals. `process-handoff.js` auto-executes low-risk actions and surfaces ALERTs.

For full OLL details (triggers, schemas, spawn queue): [references/oll.md](references/oll.md)

## Subagent Memory

Pattern for subagents with `cleanup: "delete"` and long-term memory via domains.

### Domain Types

| Type | Binding | Use case |
|------|---------|----------|
| `dev-project` | `kgEntity` in registry | Development, linked to KG, subagent on demand |
| `cron-task` | — | Periodic tasks, subagent on schedule |
| `topic-thread` | `topic: {chatId, topicId}` | Telegram topic as memory contour |
| `peer-direct` | `peer: {chatId}` | Telegram DM as memory contour |
| `group-direct` | `group: {chatId}` | Telegram group without topics |

### Key Rules

1. **One domain = one active subagent** at any given time
2. `decisions.md` — read-only for subagents; changes via PROPOSAL in changelog
3. Subagent does NOT write to daily notes or `life/`
4. QMD: one `domains` collection for all domains
5. **Always use a spawn template** — don't write prompts manually

### Domain Structure

```
memory/domains/{domain}/
├── decisions.md    # Rules (read-only for subagent)
├── workflow.md     # HOW the domain works (optional)
├── status.md       # Current state (written by subagent)
├── changelog.md    # Append-only log
└── archives/       # Changelog rotation
```

For full subagent memory, spawn workflow, templates: [references/subagent-memory.md](references/subagent-memory.md) · [references/topic-thread.md](references/topic-thread.md)

## OpenClaw Hooks

Engram ships 8 hooks that automate session tasks. **Agents do NOT need to repeat these manually.**

| Hook | Event | What it does |
|------|-------|--------------|
| `engram-daily-note` | `gateway:startup` | Creates today's daily note |
| `engram-session-start` | `agent:bootstrap` | Session start marker + auto-bind topics |
| `engram-session-end` | `command:new/reset` | Session end marker |
| `engram-session-memory` | `command:new/reset` | Archive session transcript |
| `engram-bootstrap-qmd` | `agent:bootstrap` | Refresh QMD index |
| `engram-message-log` | `message:received` | Log messages (opt-in) |
| `engram-topic-domain-load` | `message:received` | Inject topic domain context |
| `engram-peer-domain-load` | `message:received` | Inject DM/group domain context |

For hook installation, race-condition guard, side-effect-delivered pattern: [references/hooks.md](references/hooks.md)

## Scripts

~55 scripts in `skills/engram/scripts/`. Run via `bun skills/engram/scripts/<name>.js [args]`.

**Most-used by agent:**
- `memory-write.js` — unified KG write pipeline (dedup, validate, QMD update)
- `daily-note-append.js` — record session activity
- `memory-signal.js` — classify text signal (high/low/none)
- `memory-observe.js` — capture OLL observation
- `memory-contradict.js` — contradiction detection

**Infrastructure (run by hooks/cron, not agent):**
- `heartbeat-runner.js` — heartbeat entrypoint
- `init.js`, `install-hooks.js`, `install-cron.js`, `install-qmd.js` — setup
- `add-domain.js`, `add-session.js` — provisioning
- `validate.js`, `memory-repair.js`, `derive-facts.js` — maintenance

Full script reference: [references/scripts.md](references/scripts.md)