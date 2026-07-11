# Engram

Memory for long-lived AI agents. An [OpenClaw](https://github.com/openclaw/openclaw) skill that gives a stateless agent a Knowledge Graph, decay-aware retrieval, and self-maintaining heartbeat — without growing context cost over time.

Production-deployed since v1. Currently v3.5.

---

## What it solves

| Problem | Without Engram | With Engram |
|---------|----------------|-------------|
| Agent forgets everything on `/new` or compaction | Starts from zero each time | QMD query (~600 tokens) restores working context |
| Loading history doesn't scale | O(days) — grows forever | O(1) — bounded by entity count, not time |
| Subagents start cold | No project context | Domain contour injected at spawn — 0-token bootstrap |
| Memory turns to noise | Junk drawer or aggressive cleanup | Hot/Warm/Cold decay + supersede chains — nothing deleted, everything ranked |

Token cost per session stays flat. The KG index mirrors all active facts into a derived layer, so search sees everything — not just the curated top-K.

---

## Architecture

Three independent layers. Use any combination.

```
MEMORY          Daily notes → Knowledge Graph → QMD hybrid search
                Atomic facts with confidence, decay, supersede chains
                BM25 + vector embeddings + reranker (local / Jina / Ollama)

HEARTBEAT       10-phase cron pipeline, every 30 min
                Mechanical phases inline · LLM phases as isolated subagents
                Extracts facts, validates KG, rebuilds summaries, runs OLL

DOMAINS         Persistent memory contours for subagents and chat sessions
                Telegram topics, DMs, groups, dev projects, cron tasks
```

**Session isolation is enforced in scripts, not convention.** Group chats can't see main-session memory. Every retrieval scopes to a session.

---

## Memory

Three storage layers, each answering a different question:

**Daily notes** — raw session log. Rotated at 1000 lines; archive stays QMD-searchable.

**Knowledge Graph** — atomic facts grouped into entities (`people/`, `projects/`). Every fact carries confidence, abstraction level (episode → pattern → principle), tags, and a supersede chain. Nothing is deleted — old facts get `status: "superseded"` and linked to the replacement.

**Curated summaries** — `summary.md` per entity, decay-aware:

| Tier | Recency | In summary | Searchable |
|------|---------|------------|------------|
| Hot | ≤7 days | ✅ Prominent | ✅ |
| Warm | 8-30 days | ✅ Lower priority | ✅ |
| Cold | 30+ days | ❌ | ✅ via QMD |

Retrieval is hybrid: BM25 for keyword hits, vector embeddings for semantic match, reranker for relevance. Three embedder providers — local GPU, Jina cloud, Ollama REST — cover different cost/privacy trade-offs.

## Heartbeat

A single cron entrypoint runs 10 phases every 30 minutes. Mechanical work (locking, rotation, validation, QMD indexing) runs inline. Judgment work (extraction, synthesis, domain review) spawns isolated subagents.

| Phase | What | Runs |
|------:|------|------|
| 0 | Init: lock, state | inline |
| 0.5 | Rotate oversized daily notes | inline |
| 1 | Extract facts from new notes | `hb-extract` subagent |
| 1.5 | Summarize rotated archives | inline |
| 2 | Weekly synthesis (Mondays) | `hb-synthesis` subagent |
| 3 | Domain status check | `hb-domains` subagent |
| 3.5 | Apply pending changelogs | `hb-domains-write` subagent |
| 4 | Validate KG, update QMD | inline |
| 5 | OLL triggers (rethink/autoresearch) | inline |
| 6 | Report + unlock | inline |

One phase failing doesn't kill the rest. Subagent models are configurable per phase via `engram.json`. The cron is idempotent — re-running never double-writes.

## Domains

Subagents are ephemeral. Domains give them persistent memory contours anchored to the KG.

Five types, one protocol:

| Type | Binding | Use case |
|------|---------|----------|
| `dev-project` | KG entity | Development project, spawned on demand |
| `cron-task` | — | Periodic background task |
| `topic-thread` | Telegram topic | Forum topic as memory contour |
| `peer-direct` | Telegram DM | Private memory contour |
| `group-direct` | Telegram group | Group without topics |

Every domain has the same shape: `decisions.md` (read-only rules), `workflow.md` (how it works), `status.md` (current state), `changelog.md` (append-only history). The main agent reads the contour, spawns a clean subagent with that context — the subagent starts informed, not from zero.

## Operational Learning Loop

The system observes its own behavior — friction, surprises, patterns — and feeds those signals back. `hb-rethink` reviews accumulated observations during heartbeat Phase 5, generates proposals, and auto-executes low-risk improvements. Over time the agent gets better at being itself.

---

## Quick start

```bash
# Install QMD (hybrid search engine)
bun skills/engram/scripts/install-qmd.js

# Bootstrap memory system + heartbeat cron
bun skills/engram/scripts/init.js --with-cron

# Activate hooks
openclaw gateway restart
```

For an existing workspace:

```bash
bun skills/engram/scripts/install-cron.js install \
  --workspace /path/to/workspace --agent-id main --schedule '*/30 * * * *'
```

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) agent runtime
- [Bun](https://bun.sh) — script runtime
- QMD — installed automatically by bootstrap; choose `local` (GPU/CPU), `jina` (cloud), or `ollama` (local REST)

## Documentation

| Topic | File |
|-------|------|
| Skill protocol (canonical) | [`SKILL.md`](./SKILL.md) |
| Heartbeat full spec | `references/HEARTBEAT.md` |
| Heartbeat flow + cron | `references/heartbeat-flow.md` |
| Scripts reference | `references/scripts.md` |
| OLL details | `references/oll.md` |
| Hooks | `references/hooks.md` |
| Subagent domains | `references/subagent-memory.md` |
| Telegram topic-thread | `references/topic-thread.md` |
| Fact schema | `references/fact-schema.md` |
| Memory decay | `references/decay-rules.md` |
| Architecture | `references/architecture.md` |
| Setup guide | `references/setup.md` |
| QMD setup | `references/qmd-setup.md` |

## License

MIT