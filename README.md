# 🧠 Engram

**Memory, automation, and organization for long-lived AI agents.**

Engram is an [OpenClaw](https://github.com/openclaw/openclaw) skill that
turns a stateless agent into a system with real memory. Production-deployed
since v1.

---

## The problem

Every long-running agent runs into the same four walls:

- **Stateless by default.** Restart, compaction, or a `/new` command wipes
  the slate. The next session starts from zero.
- **Naive memory doesn't scale.** Loading every daily note every session is
  `O(days)` — it grows forever, and you pay for it on every turn.
- **Subagents start cold.** Spawn a worker for a sub-task and it knows
  nothing about your project, your preferences, or what you decided
  last week.
- **Memory gets noisy.** Without decay, the KG becomes a junk drawer.
  With aggressive cleanup, you lose the things that matter.

The cost curve, measured:

| Approach                       | Tokens per session | Growth curve                             |
| ------------------------------ | ------------------ | ---------------------------------------- |
| Naive (load every daily note)  | ~27k+              | Linear with time, unbounded              |
| Engram curated summaries       | ~8k                | Flat — bounded by entity count           |
| Engram QMD query (top-K)       | ~600               | Flat — bounded by relevance, not history |

The longer you run it, the cheaper each session gets.

---

## What Engram is

One skill, three independent layers. Use any combination:

```
┌──────────────────────────────────────────────────────────────────┐
│  🧠  MEMORY                                                       │
│  Daily notes → Knowledge Graph → curated MEMORY.md                │
│  Hot / Warm / Cold decay · hybrid retrieval (BM25 + vectors)     │
├──────────────────────────────────────────────────────────────────┤
│  ⚡  HEARTBEAT                                                    │
│  Deterministic 10-phase pipeline · LLM only where it counts     │
│  Mechanical phases run inline · heavy work as isolated subagents │
├──────────────────────────────────────────────────────────────────┤
│  🏗️  DOMAINS                                                      │
│  Long-lived memory for subagents, cron tasks, and chat sessions   │
│  Telegram topics · DMs · groups · dev projects · recurring work   │
└──────────────────────────────────────────────────────────────────┘
```

Memory gives the agent facts that age, not files that grow. Heartbeat
keeps memory fresh and the system self-maintaining. Domains give every
long-lived worker its own memory contour, so subagents carry project
context across compaction and restart.

---

## 🧠 Memory: facts that age, not files that grow

Three layers, each shaped for the kind of question it answers:

- **Daily notes** — raw session log, per session. Rotated when it gets
  long; the day's archive stays searchable.
- **Knowledge graph** — atomic facts grouped into entities (`people/`,
  `projects/`, `archives/`). Every fact has confidence, an abstraction
  level, tags, and a supersede chain. Nothing is ever deleted, only
  superseded.
- **Curated wisdom** — distilled into `MEMORY.md` and per-entity
  `summary.md`. Decay-aware: hot facts are prominent, warm ones
  secondary, cold ones are searchable but won't waste your context.

The retrieval side uses a hybrid index (BM25 + vector embeddings +
reranker) so the right fact surfaces whether you ask in plain words,
named entities, or fuzzy intent. Three embedder providers — local GPU,
Jina cloud, Ollama — cover different cost and privacy trade-offs.

> The KG index mirrors all active facts into a derived layer, so the
> search engine sees everything — not just the curated top-K.

One hard rule: **sessions don't share memory**. Group chats can't see
your main-session memory. Every retrieval explicitly scopes to a session.
This is enforced in scripts, not just convention.

---

## ⚡ Heartbeat: a 10-phase pipeline

Memory maintenance runs on a single cron entrypoint. The mechanical
phases — lock handling, daily-note rotation, watermark-based extraction,
KG validation, QMD indexing — run without an LLM. The phases that
actually need judgment spawn isolated subagents:

| Phase | What happens                                       | Who runs it      |
| ----: | ------------------------------------------------- | ---------------- |
|     0 | Fast Init: lock, read state, pick what to run     | inline           |
|   0.5 | Rotate daily notes that crossed the size threshold | inline           |
|     1 | Extract facts from notes since last watermark     | `hb-extract`     |
|   1.5 | Summarize rotated archives into stubs             | inline           |
|     2 | Weekly synthesis (Mondays only)                   | `hb-synthesis`   |
|     3 | Domain status check                               | `hb-domains`     |
|   3.5 | Apply pending domain changelogs                   | `hb-domains-write` |
|     4 | Validate KG · QMD update · embed                  | inline           |
|     5 | Operational Learning Loop triggers                | inline           |
|   5.5 | Drain queued OLL subagents                        | inline           |
|     6 | Heartbeat report + unlock                         | inline           |

One phase failing doesn't kill the rest. Subagent models are configurable
per phase — tune cost vs. quality without code changes. The cron is
idempotent: re-running never double-writes.

---

## 🏗️ Domains: long-lived memory for every worker

Subagents and chat sessions are ephemeral by nature. Engram gives them
persistent memory contours — folders with a contract, anchored to the
Knowledge Graph.

Five types, one shared protocol:

| Type             | What it is                                                |
| ---------------- | --------------------------------------------------------- |
| `dev-project`    | Development project, spawned on demand                    |
| `cron-task`      | Periodic background task, re-spawned by the cron          |
| `topic-thread`   | Telegram forum topic as its own memory contour            |
| `peer-direct`    | Telegram DM as a private memory contour                  |
| `group-direct`   | Telegram group without topics as a shared contour         |

Every domain has the same shape: `decisions.md` (read-only rules),
`workflow.md` (how it works), `status.md` (current state), `changelog.md`
(append-only history). The main agent reads the contour, formulates a
precise task, and spawns a clean subagent — that subagent starts with
the context it needs, not from zero.

> After `/new`, compaction, or a fresh cron tick: a single QMD query
> (~600 tokens) restores working context. No replay, no
> re-summarization.

---

## Why this works

Four ideas, drawn from running Engram in production:

**1. System events, not file-and-hope.**
When the system needs to tell the agent something — a domain loaded,
a session resumed, a watchlist hit — it pushes that into OpenClaw's
guaranteed event stream. It doesn't leave a note in a file and pray
the next model pass picks it up. Daily notes and curated memory are
not messaging channels.

**2. Idempotent by design.**
Every script, phase, and hook can be re-run without side effects. If
a heartbeat is interrupted mid-flight, the next tick continues cleanly.
Nothing gets double-written, nothing gets corrupted.

**3. Race-safe.**
Concurrent sessions, parallel agents, and overlapping chat threads don't
fight over the same files. The safety is built into the system, not left
to each script to be careful.

**4. Operational Learning Loop.**
The system watches its own behavior — what surprised it, where it
stumbled, what pattern emerged — and turns those signals into
improvements. Over time, the agent gets better at being itself.

---

## Quick start

```bash
# 1. Install QMD (hybrid search engine)
bun skills/engram/scripts/install-qmd.js

# 2. Bootstrap the full memory system in one command
bun skills/engram/scripts/init.js --with-cron --auto-detect-sessions

# 3. Restart the gateway (Engram hooks take effect here)
openclaw gateway restart
```

For a fresh workspace in production:

```bash
bun skills/engram/scripts/install-cron.js install \
  --workspace /path/to/workspace \
  --agent-id main \
  --schedule '*/30 * * * *'
```

The cron ticks, the hooks handle session lifecycle, and the KG starts
building from day one.

---

## For users

If you're wiring this into an existing OpenClaw workspace:

- **Production checklist**: see `references/setup.md`
- **Heartbeat cycle**: see `references/HEARTBEAT.md`
- **Operational Learning Loop**: see `references/HB-RETHINK.md`
- **Subagent domains**: see `references/subagent-memory.md`
- **Telegram topic-thread**: see `references/topic-thread.md`
- **Fact schema**: see `references/fact-schema.md`

---

## For contributors

- **Skill protocol**: [`SKILL.md`](./SKILL.md) — the canonical contract.
  Read it first. SKILL.md is the source of truth for the public API.
- **Architecture deep-dive**: `references/architecture.md`
- **Memory decay rules**: `references/decay-rules.md`
- **Working spec notes**: this repo is read-only for skill consumers.
  When installing, copy `scripts/` to your workspace and set
  `ENGRAM_SKILL_DIR`. Templates and assets stay in the skill folder.

---

## Requirements

- **[OpenClaw](https://github.com/openclaw/openclaw)** agent runtime
- **[Bun](https://bun.sh)** as the script runtime
- **QMD** for the hybrid index — installed automatically by the
  bootstrap; choose `local` (GPU/CPU), `jina` (cloud free tier), or
  `ollama` (local REST) depending on your hardware

---

## License

MIT