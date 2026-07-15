# Engram

**Memory that stays sharp while agents and teams scale.**

An [OpenClaw](https://github.com/openclaw/openclaw) skill that gives long-lived agents a real memory system:

- Knowledge Graph with confidence, decay, and supersede chains
- Hybrid search (BM25 + embeddings + rerank)
- Self-maintaining heartbeat
- Domain contours for projects, chats, and teams

**MIT · OpenClaw · v3.5 · production since v1**

![Engram Memory Stack](assets/readme/engram-memory-stack-hot-cold-light.jpg)

*Three layers + fact temperature: Daily Notes → Knowledge Graph (Hot / Warm / Cold) → Hybrid Search. Heartbeat keeps it healthy.*

---

## The problem

Stateless agents forget on every `/new` and compaction.

Dumping chat history does not scale — tokens grow with days, signal drowns in noise.

**Engram keeps working context cheap and history complete.**

Token cost per session stays roughly flat. Memory quality does not collapse over time.

| Problem | Without Engram | With Engram |
|---------|----------------|------------|
| Agent forgets on `/new` or compaction | Starts from zero | Hybrid query restores working context |
| Loading history doesn't scale | O(days) forever | O(1) — ranked by recency + confidence |
| Subagents start cold | No project context | Domain contour at spawn |
| Memory turns to noise | Junk drawer or aggressive cleanup | Hot / Warm / Cold + supersede — nothing deleted, everything ranked |

---

## What it enables

| Capability | Why it matters |
|---|---|
| **Long-lived personal agent** | Preferences, decisions, corrections — without stuffing the prompt |
| **Project subagents with continuity** | Ephemeral workers get a domain contour; start informed, leave status behind |
| **Team / forum memory** | Each topic, DM, or group is an isolated contour; no bleed by default |
| **Role-scoped shared context** | Managers join overlaps and see selected collections — not full personal memory |
| **Self-improving ops** | Heartbeat + OLL observe friction and propose fixes |

---

## Mental model

Three systems. One skill.

```
MEMORY     daily notes → KG facts → QMD hybrid search
HEARTBEAT  10-phase cron: extract, synthesize, validate, OLL
DOMAINS    persistent contours for subagents + chat sessions
```

**Session isolation is enforced in scripts, not convention.**

Main session, project domains, and chat contours do not silently mix.

---

## Memory quality over time

Facts live in the Knowledge Graph with temperature:

| Tier | Recency | In summary | Searchable |
|------|---------|------------|------------|
| **Hot** | ≤7 days | Yes, prominent | Yes |
| **Warm** | 8–30 days | Yes, lower priority | Yes |
| **Cold** | 30+ days | No (principles kept) | Yes via QMD |

Facts are **never deleted**. Old facts are **superseded** and linked to replacements.

Retrieval is hybrid:

- BM25 for exact keywords
- embeddings for semantic match
- reranker for relevance

Local GPU or Jina cloud — pick the privacy/cost trade-off.

---

## Domain memory for teams

Subagents are ephemeral. Domains give them — and people — persistent memory contours.

![Domain Memory for Teams](assets/readme/engram-domain-teams-light.jpg)

Five domain types, one protocol:

| Type | Binding | Typical role |
|------|---------|--------------|
| `topic-thread` | Forum topic | Project channel with curated memory |
| `peer-direct` | DM | Private 1:1 agent contour |
| `group-direct` | Group | Shared group contour |
| `dev-project` | KG entity | Engineering work + spawnable subagents |
| `cron-task` | Schedule | Background workers with durable state |

Every domain has the same shape:

| File | Who writes | Role |
|------|------------|------|
| `decisions.md` | owners | WHAT is allowed |
| `workflow.md` | owners | HOW work is done |
| `status.md` | workers | current state |
| `changelog.md` | workers | append-only history + proposals |

---

## Shared contours (the team story)

Engram models team memory as **overlapping project contours**.

![Shared Contours](assets/readme/engram-shared-contours-projects.jpg)

Read the diagram like org design, not like a chat dump:

- **Inside one contour, no overlap** → executors / individual contributors
- **In the overlap** → managers / coordinators who bridge projects
- **Shared context** lives at the joins, not in a global “everyone sees everything” pool

### Vertical access (role-scoped collections)

Managers do not get “all employee memory”.

They get **selected collections** needed for coordination:

- project domain status / decisions / changelogs
- scoped work notes bound to the project
- optional opt-in collections for handoff

Private agent contours and personal context stay private unless explicitly joined.

> Engram models team memory as overlapping project contours: isolation by default, shared context only at the joins.

---

## Heartbeat

A single cron entrypoint runs every 30 minutes.

Mechanical work runs inline. Judgment work spawns isolated subagents.

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
| 5.5 | OLL spawn queue | inline |
| 6 | Report + unlock | inline |

One phase failing doesn't kill the rest. Models are configured per workspace in `engram.json`. The pipeline is idempotent.

---

## Operational Learning Loop

The system observes its own behavior — friction, surprises, patterns — and feeds those signals back. `hb-rethink` reviews accumulated observations during heartbeat Phase 5, generates proposals, and can auto-execute low-risk improvements. Over time the agent gets better at being itself.

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

Existing workspace:

```bash
bun skills/engram/scripts/install-cron.js install \
  --workspace /path/to/workspace --agent-id main --schedule '*/30 * * * *'
```

Audit workspace drift without changing anything:

```bash
bun skills/engram/scripts/watchdog.js --workspace /path/to/workspace --json
```

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) agent runtime
- [Bun](https://bun.sh) — script runtime
- QMD — installed automatically by bootstrap; choose `local` (GPU/CPU) or `jina` (cloud)

## Documentation

| Topic | File |
|-------|------|
| Skill protocol (canonical) | [`SKILL.md`](./SKILL.md) |
| Heartbeat full spec | `references/HEARTBEAT.md` |
| Heartbeat flow + cron | `references/heartbeat-flow.md` |
| Scripts reference | `references/scripts.md` |
| Workspace watchdog auditor | `references/watchdog.md` |
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
