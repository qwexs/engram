# 🧠 Engram OpenClaw

**Agent infrastructure for memory, automation, and organization.**

Engram is an [OpenClaw](https://github.com/openclaw/openclaw) Skill — a complete infrastructure layer for AI agents. Not just a place to store facts, but a system that **automates** memory maintenance and **organizes** multi-agent work through persistent domains.

> **Why Engram?** Naive memory = load everything every session. That's `O(days)` — it grows forever.
> Engram flips this: summaries are `O(entities)`, QMD queries are `O(relevance)`. The longer you run, the more you save.
>
> | Approach | Tokens/session | Growth |
> |----------|---------------|--------|
> | Naive (all daily notes) | ~27k+ | Linear with time ↑ |
> | Engram summaries | ~8k | Flat (entity count) |
> | Engram QMD query | ~600 | Flat (top-K results) |
>
> Real numbers from 10 days of production use (25 entities, 183 facts).
> After 1 month: **60–100x** token savings. After 6 months: the naive approach is unbearable — Engram stays the same.
>
> **Context-free agents:** Subagents don't depend on the context window at all. Cron-triggered agents start fresh every run — their knowledge lives in domain files and the Knowledge Graph, not in chat history. After compaction or restart, one QMD query restores working context in **~600 tokens** instead of replaying thousands of lines. The context window becomes a scratchpad, not a memory.

---

## Three Pillars

```
┌──────────────────────────────────────────────────────┐
│  🧠 MEMORY LAYER                                    │
│  Three-layer storage: daily notes → KG → MEMORY.md  │
│  QMD hybrid search (BM25 + vectors + rerank)         │
├──────────────────────────────────────────────────────┤
│  ⚡ HEARTBEAT LAYER                                  │
│  Phased orchestrator with isolated subagents:        │
│  extraction → synthesis → domain scan → maintenance  │
├──────────────────────────────────────────────────────┤
│  🏗️ DOMAIN LAYER                                    │
│  Persistent memory for cron tasks and dev projects.  │
│  Foundation for multi-agent team organization.       │
└──────────────────────────────────────────────────────┘
```

---

## Memory Layer

### Three-Space Architecture

Every piece of content belongs to one of three spaces — mixing them degrades search quality and bloats init context:

```
┌─────────────────────────────────────────────┐
│  self   MEMORY.md, SOUL.md                 │
│         Curated identity, principles        │
├─────────────────────────────────────────────┤
│  notes  life/ (Knowledge Graph)             │
│         PARA entities, atomic facts v2      │
│         confidence · abstraction · decay    │
├─────────────────────────────────────────────┤
│  ops    memory/ (Daily Notes)               │
│         Session-isolated raw events         │
└─────────────────────────────────────────────┘
         ↕ QMD hybrid search
```

Content flows one-way only: **ops → notes → self**. Facts are never demoted back.

### Session Isolation

Each chat session is a memory silo — personal sessions cannot access group memory and vice versa:

```
memory/agent-main/
├── main/               # Personal session
│   └── YYYY-MM-DD.md
├── telegram-{id}/      # Telegram groups
└── discord-{id}/       # Discord channels
```

### PARA Knowledge Graph

Structured long-term knowledge in `life/` using Tiago Forte's PARA method, extended with atomic facts:

```
life/
├── projects/     # Active projects
├── areas/        # Ongoing areas (people, groups, tools)
├── resources/    # Reference material
└── archives/     # Inactive entities
```

Each entity has a `summary.md` (hot facts, loaded at session start) and `items.json` (full fact store, loaded on demand).

### Fact Schema v2

```json
{
  "id": "entity-001",
  "fact": "Human-readable statement",
  "category": "relationship|milestone|status|preference|context|decision|correction",
  "confidence": 0.85,
  "abstractionLevel": "episode|pattern|principle",
  "tags": ["tag1", "tag2"],
  "timestamp": "2026-02-08",
  "status": "active|superseded"
}
```

**No-Deletion Rule:** Facts are never deleted — only superseded with full history chain.

### Memory Decay

| Tier | Recency | In summary? | Notes |
|------|---------|-------------|-------|
| 🔴 Hot | ≤7 days | ✅ Prominent | Front-of-mind |
| 🟡 Warm | 8-30 days | ✅ Lower priority | Available but secondary |
| 🔵 Cold | 30+ days | ❌ | Searchable via QMD |

**Modifiers:**
- `confidence < 0.5` → Cold in 14 days instead of 30
- `accessCount >= 10` → resists decay (Cold bumps to Warm)
- `principle` (L3) → always in summary, ignores decay
- `pattern` (L2) → in summary if Warm or better

### Real-Time Extraction

High-signal facts are extracted **inline during conversations**, not just at heartbeat:

```
Message arrives → Signal Scan (regex, <10ms) → Classify
    │
    ├── HIGH (preference, decision, correction, milestone, instruction, identity)
    │       → Dedup check (SHA-256) → Contradiction check → Write to KG → QMD update
    │
    ├── LOW (context, work discussion)
    │       → Record in daily note → Heartbeat extracts later
    │
    └── NONE (casual chat, greetings, reactions)
            → Skip
```

```bash
bun scripts/memory-signal.js --text "Я предпочитаю TypeScript"
# → { "signal": "high", "categories": ["preference"], "confidence": 0.88 }

bun scripts/memory-write.js \
  --entity "areas/people/sergey" \
  --fact "Prefers Bun over Node.js" \
  --category preference \
  --confidence 0.9 \
  --abstraction pattern \
  --source "2026-02-16" \
  --semantic-check
```

`--semantic-check` catches near-duplicates (same fact, different wording) that content-hash dedup misses.

---

## Heartbeat Layer

The heartbeat is a **phased orchestrator** running on a schedule (default: every 30 min). Each heavy phase runs in an isolated subagent — if one fails, others continue.

### Phases

```
Phase 0: Fast Init
  └── Read state, create daily note, decide what to run

Phase 1: Extraction (subagent: hb-extract)
  └── Read daily note from watermark → extract facts → write to KG

Phase 2: Synthesis (subagent: hb-synthesis, Mondays only)
  └── Weekly summary of all entities → update summary.md files

Phase 3: Domain Scan (subagent: hb-domains)
  └── Check domain status, liveness, PROPOSALs

Phase 4: Maintenance (inline)
  └── validate-kg.js --fix → qmd update

Phase 5: Report + Unlock
  └── Write heartbeat report → release lock → HEARTBEAT_OK
```

### Fault Isolation

- Concurrent-run protection via lock with stale-lock auto-reset (>10 min)
- If one phase fails, others continue
- Watermark prevents re-processing already-extracted content
- Orchestrator is the **sole watermark writer** — subagents must not write watermarks

### Handoff Protocol

Every subagent communicates results back via a structured block:

```
=== HB-EXTRACT HANDOFF ===
Status: ok
Summary: extracted 3 facts from 2026-02-24.md (L47->L89)
Stats: {"facts_written": 3, "new_watermark": "L89"}
Alerts: []
=== END ===
```

Subagent templates live in `references/HB-EXTRACT.md`, `HB-SYNTHESIS.md`, `HB-DOMAINS.md` — loaded and filled by the orchestrator before spawning.

---

## Operational Learning Loop (OLL)

**Self-observation layer** — system captures its own friction, surprises, and quality issues for review.

```
ops/
├── observations/          # Operational observations
│   ├── index.json        # Registry
│   └── obs-0001.json    # {id, observation, category, status, timestamps}
└── tensions/            # Contradictions between facts
    ├── index.json        # Registry
    └── tension-0001.json # {id, tension, factRefs, status, timestamps}
```

### Capturing Observations

```bash
bun scripts/memory-observe.js --observation "KG extraction missed facts" --category friction
bun scripts/memory-observe.js --observation "Code quality improved" --category quality
bun scripts/memory-observe.js --observation "Unexpected behavior" --category surprise
```

**Categories:** `friction` (slowdown), `surprise` (unexpected), `quality` (code/content issues)

**Features:**
- **Novelty check:** Jaccard similarity >0.7 with recent observations → rejected as duplicate
- **Review loop:** pending → promoted to KG as patterns/principles, or archived

### Capturing Tensions

```bash
bun scripts/memory-tension.js \
  --tension "Two facts contradict each other" \
  --fact1 "sergey-001" \
  --fact2 "sergey-005"
```

### Threshold Alerts

Heartbeat checks pending counts:
- **>20 pending observations** → alert
- **>5 pending tensions** → alert

This enables **system-level feedback** — patterns of friction accumulate until reviewed.

---

## Domain Layer

Domains are **persistent memory units** for subagents. A subagent spawned with `cleanup: "delete"` loses all context when done — domains solve this.

```
memory/domains/{domain}/
├── decisions.md    # WHAT: rules, thresholds, constraints (read-only for subagent)
├── workflow.md     # HOW: scripts, APIs, scope, sources (optional)
├── status.md       # Current state (written by subagent)
├── changelog.md    # Append-only action log
└── archives/       # Changelog rotation when >1000 lines
```

### Two Domain Types

| Type | Description | Spawned |
|------|-------------|---------|
| `dev-project` | Development project, linked to KG entity | On-demand |
| `cron-task` | Periodic background tasks | Via cron schedule |

### Separation of Concerns

| File | Responsibility | Who writes |
|------|---------------|------------|
| `decisions.md` | Rules, constraints | Main Agent |
| `workflow.md` | Scripts, APIs, scope | Main Agent |
| Spawn template | Task to execute | Main Agent (per-spawn) |
| `status.md` | Current state | Subagent |
| `changelog.md` | Action history | Subagent |

**PROPOSAL mechanism:** When a subagent needs a rule change, it writes `PROPOSAL:` to `decisions.md` or `changelog.md`. The heartbeat domain scan surfaces it to the main agent for review.

```bash
# Create a cron-task domain
bun scripts/add-domain.js --domain digest --description "Daily digest"

# Create a dev-project domain linked to KG
bun scripts/add-domain.js --domain engram --type dev-project --kg-entity projects/engram --description "Memory skill"
```

---

## Quick Start

```bash
# 1. Install QMD search engine
bun scripts/install-qmd.js

# 2. Initialize memory system
bun scripts/init.js

# 3. Add a group session (optional)
bun scripts/add-session.js --platform telegram --id 1234567890
```

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) agent
- [Bun](https://bun.sh) runtime
- QMD — installed via `scripts/install-qmd.js`:
  - **Local** (GPU/CPU): `npm i -g @nicepkg/qmd`
  - **Cloud** (no GPU required): `npm i -g @qwexs/qmd` ([source](https://github.com/qwexs/qmd))

### QMD Provider Configuration

By default, QMD runs models locally (~2GB GGUF download on first use). To use cloud APIs instead:

```sh
# OpenAI
export QMD_LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-proj-xxx

# — or —

# Jina AI
export QMD_LLM_PROVIDER=jina
export JINA_API_KEY=jina_xxxxxxxxxxxx
```

> Full reference: [qwexs/qmd README](https://github.com/qwexs/qmd#environment-variables)

## Scripts

| Script | Purpose |
|--------|---------|
| `install-qmd.js` | Interactive QMD installer (local or Jina variant) |
| `init.js` | Full initialization (dirs, templates, QMD collections) |
| `add-session.js` | Add new session (Telegram group, Discord channel, etc.) |
| `add-domain.js` | Create subagent domain with persistent memory |
| `validate.js` | Check integrity of memory structure (`--fix` to auto-repair) |
| `migrate-v2.js` | Migrate facts to v2 schema (confidence, abstraction, tags) |
| `memory-signal.js` | Signal detector — classifies messages as high/low/none |
| `memory-dedup.js` | Content-hash deduplication (SHA-256), `--seed` to index existing facts |
| `memory-write.js` | Write facts to KG with safe dedup, validation, QMD update |
| `memory-contradict.js` | Find contradicting facts (intra-entity + `--cross-entity` via QMD) |

## Cross-Platform

All scripts work on **Linux and Windows**:
- Path normalization: backslash → forward slash everywhere
- QMD flatten paths handled (Windows outputs `areas-people-sergey` instead of `areas/people/sergey`)
- Timezone configurable via `ENGRAM_TZ` or `TZ` env var (default: `Europe/Moscow`)

---

## Roadmap

### Agent Teams

Domain layer provides the foundation for multi-agent orchestration:

```
         Main Agent (personality, KG, strategy)
        /         |          \
      L1a        L1b         L1c          ← Orchestrators (persistent via domain files)
   dev-proj   monitoring   content
       |         |        /    |    \
      L2        L2      L2a  L2b  L2c    ← Executors (ephemeral, cleanup: delete)
```

Currently blocked by [openclaw#5813](https://github.com/openclaw/openclaw/issues/5813) (L2↔L2 mesh communication). Domain layer and PROPOSAL mechanism are already implemented and ready.

**What's needed for full agent teams:**
- L2↔L2 direct inter-agent coordination without routing through orchestrator
- Smart delegation: Main classifies task complexity → chooses spawn mode
- Cross-domain awareness in heartbeat scan

### LLM Hook Extraction

OpenClaw `llm_input`/`llm_output` hooks enable **automatic fact extraction from any LLM call** — without explicit agent instruction or signal detection. Every response becomes a potential source for the Knowledge Graph.

Planned integration:
- Hook fires on each LLM output → signal scan → high-signal facts extracted automatically
- Zero overhead for the agent (no inline extraction steps)
- Enables extraction from subagents and cron tasks transparently

---

## Methodologies

1. **PARA Method** (Tiago Forte) — four-bucket entity organization
2. **Tiered Retrieval** — summary first, details on demand
3. **No-Deletion Rule** — full history via supersede chains
4. **Memory Decay** — Hot/Warm/Cold with human-like forgetting
5. **Session Isolation** — privacy-first memory silos
6. **QMD Hybrid Search** — BM25 + vectors + rerank
7. **Heartbeat Automation** — extraction → synthesis → domains → maintenance
8. **Confidence Scoring** — metacognitive certainty levels
9. **Abstraction Ladder** — RAPTOR-inspired (episode → pattern → principle)
10. **Tags** — flexible categorization for search

## Inspiration

- [RAPTOR](https://arxiv.org/abs/2401.18059) (Stanford, ICLR 2024) — hierarchical summarization
- [Synapse](https://arxiv.org/abs/2601.01948) (UGA, 2026) — spreading activation for memory retrieval
- [A-MEM](https://arxiv.org/abs/2409.15335) (NeurIPS 2025) — Zettelkasten-style agentic memory
- [openclaw/openclaw#13991](https://github.com/openclaw/openclaw/issues/13991) — Associative Hierarchical Memory
- [Memory Supersystem v1.0](https://github.com/ktao732084-arch/openclaw_memory_supersystem-v1.0) — neuroscience-based approach
- [openclaw-engram](https://github.com/joshuaswarren/openclaw-engram) — signal detection approach
- [arscontexta](https://github.com/agenticnotetaking/arscontexta) — Three-Space model (self/notes/ops), fresh context per phase, Operational Learning Loop

## License

MIT
