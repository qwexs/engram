# 🧠 Engram OpenClaw

**Etalon memory architecture for AI agents.**

Engram is an [OpenClaw](https://github.com/openclaw/openclaw) Skill that sets up a production-ready memory system for AI agents — from scratch, in one command.

## What it does

Deploys a three-layer memory architecture:

```
┌─────────────────────────────────────────────┐
│  Layer 3: MEMORY.md (Curated Wisdom)        │
│  Distilled long-term insights, principles   │
├─────────────────────────────────────────────┤
│  Layer 2: Knowledge Graph (life/)           │
│  PARA entities with atomic facts v2         │
│  confidence · abstraction · decay           │
├─────────────────────────────────────────────┤
│  Layer 1: Daily Notes (memory/)             │
│  Session-isolated raw events                │
└─────────────────────────────────────────────┘
         ↕ QMD hybrid search (BM25 + vectors + rerank)
```

## Key Features

- **PARA Knowledge Graph** — Projects, Areas, Resources, Archives with tiered retrieval (summary.md → items.json)
- **Session Isolation** — each chat session is a memory silo (personal ≠ group ≠ channel)
- **Memory Decay** — Hot/Warm/Cold tiers with frequency resistance, like human forgetting
- **Confidence Scoring** — 0.0–1.0 metacognition (low-confidence facts decay faster)
- **Abstraction Ladder** — episode → pattern → principle (principles never decay)
- **Three-Layer Rotation** — Archive (full) → Stub (auto-summary with line refs) → QMD index (zero data loss)
- **Subagent Persistent Memory** — domain-based memory for cron subagents (decisions.md + status.md + changelog.md)
- **Heartbeat Automation** — extraction, weekly synthesis, domain supervisor scan, maintenance on autopilot
- **QMD Hybrid Search** — BM25 + vector embeddings + rerank, 96% token reduction vs full-file loading
- **Dual QMD Support** — local GPU (Vulkan) or cloud (Jina AI API, free tier)

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
  - **Jina Fork** (cloud, no GPU): `npm i -g @qwexs/qmd` ([source](https://github.com/qwexs/qmd))

## Subagent Memory

Persistent memory for subagents with `cleanup: "delete"` via **domains**:

```
memory/domains/{domain}/
├── decisions.md    # Rules (read-only for subagent, PR model)
├── status.md       # Current state (written by subagent)
├── changelog.md    # Append-only action log
└── archives/       # Changelog rotation when >1000 lines
```

**Key rules:**
- One domain = one active subagent
- One QMD collection `domains` for all domains
- Subagent does not write to daily notes or life/
- PROPOSAL for rule changes → review during heartbeat
- **Domain Supervisor Scan** in heartbeat: PROPOSAL review, liveness check, changelog rotation, KG extraction

```bash
# Create a domain
bun scripts/add-domain.js --domain monitoring --description "Monitoring"
```

Details: [references/subagent-memory.md](references/subagent-memory.md)

## Scripts

| Script | Purpose |
|--------|---------|
| `install-qmd.js` | Interactive QMD installer (local or Jina variant) |
| `init.js` | Full initialization (dirs, templates, QMD collections) |
| `add-session.js` | Add new session (Telegram group, Discord channel, etc.) |
| `add-domain.js` | Create subagent domain with persistent memory |
| `validate.js` | Check integrity of memory structure (`--fix` to auto-repair) |
| `migrate-v2.js` | Migrate facts to v2 schema (confidence, abstraction, tags) |

## Fact Schema v2

Each fact in the Knowledge Graph:

```json
{
  "id": "entity-001",
  "fact": "Human-readable statement",
  "category": "relationship|milestone|status|preference|context",
  "confidence": 0.85,
  "abstractionLevel": "episode|pattern|principle",
  "tags": ["tag1", "tag2"],
  "timestamp": "2026-02-08",
  "status": "active|superseded",
  "relatedEntities": ["areas/people/someone"],
  "lastAccessed": "2026-02-08",
  "accessCount": 1
}
```

**No-Deletion Rule:** Facts are never deleted — only superseded with full history chain.

## Memory Decay

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

## Architecture

```
workspace/
├── MEMORY.md                          # Curated long-term memory
├── HEARTBEAT.md                       # Automated maintenance flow
├── memory/
│   ├── heartbeat-state.json           # Per-session tracking
│   ├── weekly-synthesis-tracker.json  # Synthesis schedule
│   ├── templates/group-knowledge/     # Templates for new groups
│   ├── domains/                       # Subagent persistent memory
│   │   └── {domain}/
│   │       ├── decisions.md           # Rules (read-only for subagents)
│   │       ├── status.md              # Current state (subagent writes)
│   │       ├── changelog.md           # Append-only action log
│   │       └── archives/              # Rotated changelogs
│   └── agent-main/
│       ├── main/                      # Personal session
│       │   └── YYYY-MM-DD.md          # Daily notes
│       ├── telegram-{id}/             # Telegram groups
│       └── discord-{id}/              # Discord channels
└── life/                              # Knowledge Graph (PARA)
    ├── projects/
    ├── areas/
    │   ├── people/
    │   ├── groups/
    │   └── companies/
    ├── resources/
    ├── archives/
    └── index.md                       # Master entity index
```

## Methodologies

Built on 10 proven methodologies:

1. **PARA Method** (Tiago Forte) — four-bucket entity organization
2. **Tiered Retrieval** — summary first, details on demand
3. **No-Deletion Rule** — full history via supersede chains
4. **Memory Decay** — Hot/Warm/Cold with human-like forgetting
5. **Session Isolation** — privacy-first memory silos
6. **QMD Hybrid Search** — BM25 + vectors + rerank
7. **Heartbeat Automation** — extraction → synthesis → maintenance
8. **Confidence Scoring** — metacognitive certainty levels
9. **Abstraction Ladder** — RAPTOR-inspired (episode → pattern → principle)
10. **Tags** — flexible categorization for search

## Inspiration

- [RAPTOR](https://arxiv.org/abs/2401.18059) (Stanford, ICLR 2024) — hierarchical summarization
- [Synapse](https://arxiv.org/abs/2601.01948) (UGA, 2026) — spreading activation for memory retrieval
- [A-MEM](https://arxiv.org/abs/2409.15335) (NeurIPS 2025) — Zettelkasten-style agentic memory
- [openclaw/openclaw#13991](https://github.com/openclaw/openclaw/issues/13991) — Associative Hierarchical Memory
- [Memory Supersystem v1.0](https://github.com/ktao732084-arch/openclaw_memory_supersystem-v1.0) — neuroscience-based approach

## License

MIT
