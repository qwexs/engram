# Memory Architecture

## Three-Layer Model

The memory system uses three layers, each serving a different purpose:

```
┌─────────────────────────────────────────────┐
│  Layer 3: MEMORY.md (Curated Wisdom)        │
│  Long-term personal insights, decisions     │
│  Main session only                          │
├─────────────────────────────────────────────┤
│  Layer 2: Knowledge Graph (life/)           │
│  Structured entities with atomic facts      │
│  Flat three-folder structure (people/projects/archives), tiered retrieval  │
│  Main session only                          │
├─────────────────────────────────────────────┤
│  Layer 1: Daily Notes (memory/)             │
│  Raw session notes, per-session isolation   │
│  All sessions (main, telegram, discord)     │
└─────────────────────────────────────────────┘
```

### Layer 1: Daily Notes

Raw session notes stored per-session in `memory/agent-{id}/{session}/YYYY-MM-DD.md`.

- Created automatically at session start or during heartbeat
- Rotated to archives when exceeding 1000 lines
- Indexed by QMD for search
- Each session is fully isolated (see Session Isolation)

### Layer 2: Knowledge Graph

Structured long-term memory in `life/` using the flat three-folder structure (people/projects/archives):

- **people/** — People entities
- **projects/** — Active work: tools, groups, AI agents, projects
- **archives/** — Inactive items

Each entity has:
- `summary.md` — Quick context (load first, ~90% of queries)
- `items.json` — Atomic facts with schema v2 (load on demand)

See [fact-schema.md](fact-schema.md) for the full schema specification.

### Layer 3: MEMORY.md

Curated personal wisdom distilled from daily notes during memory maintenance:
- Significant events, decisions, lessons learned
- Updated periodically during heartbeats
- Lives in workspace root, main session only

## Session Isolation

**Golden Rule: Memory is isolated by session.**

| Session Type | Memory Path | QMD Collection | Access |
|-------------|-------------|----------------|--------|
| Main (personal) | `memory/agent-{id}/main/` | `openclaw-memory-agent-{id}-main` | Full: MEMORY.md + life/ + all collections |
| Telegram group | `memory/agent-{id}/telegram-{groupId}/` | `openclaw-memory-agent-{id}-telegram-{groupId}` | ONLY own daily notes |
| Discord channel | `memory/agent-{id}/discord-{channelId}/` | `openclaw-memory-agent-{id}-discord-{channelId}` | ONLY own daily notes |

**Rules:**
- Each session = isolated memory silo
- **NEVER cross-reference** memory between sessions
- Group chats **CANNOT see** main session memory (MEMORY.md or life/)
- Main session has full access to everything
- Always specify `-c <collection>` flag in QMD queries

## Data Flow

```
Session Activity
    ↓ daily-note-append.js (during session, explicit recording)
Daily Notes (raw input)
    ↓ heartbeat extraction (watermark-based incremental parsing)
Knowledge Graph (structured facts)
    ↓ memory maintenance
MEMORY.md (curated wisdom)
    ↓ weekly synthesis
summary.md (decay-aware summaries)
```

**Session Recording:** During active sessions, use `daily-note-append.js` to write events, decisions, and learnings directly to the daily note. Without explicit recording, notes remain empty despite active work. See `## Session Recording` in SKILL.md.

**Extraction Watermark:** Heartbeat extraction appends `<!-- extracted:L{N}:{timestamp} -->` at the **end** of each daily note after a successful run. The marker means “extract completed for this note version”, not a mid-file scan cursor.

`daily-note-append.js` writes Events / Decisions / Learnings into named sections near the **top** of the file; Heartbeat Report + watermark sit at the **bottom**. Therefore extract always rescans high-signal sections in full. Already-promoted bullets are skipped by `memory-write.js` hash/semantic dedup (same path as inline extraction). Heartbeat Report and `## Next` are never extraction candidates.

### Domain-first write policy

Consumer sessions do **not** all feed the Knowledge Graph:

| Session | Primary durable memory | KG extract (`life/`) |
|---------|------------------------|----------------------|
| `main` | daily + KG + MEMORY.md | **yes** |
| `meta-domain` (e.g. General topic) | domain files + QMD search | **yes** (cross-cutting) |
| `topic-thread` / project domains | **domain** `decisions` / `status` / `changelog` | **no** (default) |
| unbound chat sessions | daily notes | **no** (default) |

Override: `engram.json` → `extraction.kgPolicy`: `domain-first` (default) | `all` | `main-only`.

Topic signal is promoted by `hb-domains-write`, not by dumping every bullet into `life/`.

### Real-Time Extraction

In addition to heartbeat extraction, high-signal facts are extracted **inline during conversations** (no 30-min delay):

```
Message → Signal Scan (regex, <10ms) → HIGH/LOW/NONE
  HIGH → Dedup → Write to KG → QMD update
  LOW  → Daily note → Heartbeat extracts later
  NONE → Skip
```

Inline extraction does NOT write watermarks — heartbeat handles that. Dedup (`memory-write.js`) prevents duplicates from both paths.

### Write Destinations

| Type | Destination |
|------|-------------|
| Operational lesson (tool, workflow) | TOOLS.md or AGENTS.md |
| Personal insight (preference, opinion) | MEMORY.md (main session only) |
| Event/fact (conversation, decision) | Today's daily note |
| Durable knowledge (person, project) | Knowledge Graph (life/) |

## QMD Integration

QMD provides hybrid search (BM25 + vectors + rerank) across all memory layers.

```bash
# Search by collection
qmd query "topic" -c openclaw-memory-agent-main-main
qmd query "topic" -c life

# Multi-collection search
qmd query "topic" -c life -c openclaw-memory-agent-main-main

# BM25-only search (no GPU required)
qmd search "topic" -c life

# Update index after changes
qmd update          # BM25 (instant)
qmd embed           # Vector embeddings (GPU/Jina)
```

See [qmd-setup.md](qmd-setup.md) for installation and configuration.

## Methodologies

| Method | Purpose |
|--------|---------|
| Three-folder KG | Entity organization (people/projects/archives) |
| Tiered Retrieval | summary.md first, items.json on demand |
| No-Deletion Rule | Facts are superseded, never deleted |
| Memory Decay | Hot/Warm/Cold tiers based on recency |
| Session Isolation | Security boundary per session |
| QMD Hybrid Search | 96% token reduction via indexed search |
| Heartbeat Automation | Extraction → synthesis → maintenance cycle |
| Confidence Scoring | 0.0-1.0 metacognition per fact |
| Abstraction Ladder | episode → pattern → principle (RAPTOR-inspired) |
| Tags | Free-form categorization for search and filtering |
