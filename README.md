# 🧠 Engram (beta)

**Agent infrastructure for memory, automation, and organization.**

Engram is an [OpenClaw](https://github.com/openclaw/openclaw) skill that
turns an agent into a long-lived system: persistent knowledge graph,
deterministic memory maintenance, and a domain layer that organizes
multi-agent work.

> **Why Engram?** Naive memory = load everything every session. That's
> `O(days)` — it grows forever. Engram flips this: summaries are
> `O(entities)`, QMD queries are `O(relevance)`. The longer you run, the
> more you save.
>
> | Approach              | Tokens/session | Growth             |
> |-----------------------|----------------|--------------------|
> | Naive (all daily notes) | ~27k+          | Linear with time ↑ |
> | Engram summaries      | ~8k            | Flat (entity count) |
> | Engram QMD query      | ~600           | Flat (top-K results) |
>
> Subagents and cron-triggered agents start fresh every run, but their
> knowledge lives in domain files and the Knowledge Graph — not in chat
> history. After compaction or restart, one QMD query restores working
> context in **~600 tokens** instead of replaying thousands of lines.

---

## Three Pillars

```
┌──────────────────────────────────────────────────────┐
│  🧠 MEMORY                                            │
│  Daily notes → Knowledge Graph → curated MEMORY.md    │
│  QMD hybrid search (BM25 + vectors + rerank)          │
├──────────────────────────────────────────────────────┤
│  ⚡ HEARTBEAT                                         │
│  Deterministic runner with isolated subagents         │
│  extraction · synthesis · domains · OLL review        │
├──────────────────────────────────────────────────────┤
│  🏗️ DOMAINS                                           │
│  Persistent memory for subagents and topic sessions   │
│  dev-project · cron-task · topic-thread               │
└──────────────────────────────────────────────────────┘
```

The three pillars are independent. You can use only memory, only domains,
or any combination.

---

## Capabilities

### Knowledge Graph with decay

A flat `life/` folder (people, projects, areas, archives) with atomic
facts in v2 schema (confidence, abstraction level, tags, supersede chain).
Summaries stay short via **memory decay** — Hot (≤7d) / Warm (≤30d) /
Cold (>30d), with modifiers for low-confidence or high-access facts. The
**derived-facts layer** mirrors every active fact to one markdown file
so QMD sees 100% of the KG, not just the curated top-K.

### Real-time extraction

Every message is classified in <10ms (regex, no LLM). High-signal
preferences, decisions, corrections, and milestones go straight to the
KG with dedup, contradiction check, and QMD update. Low-signal chatter
goes to the daily note and is extracted later by the heartbeat.

### Deterministic heartbeat

A **single cron entrypoint** (`heartbeat-runner.js`) does the full cycle
without an LLM: lock, daily-note rotation, watermark-based extraction,
weekly summary rebuild, domain scan, maintenance, report. Heavy phases
(extraction, synthesis, domain scan, OLL review) spawn isolated
subagents — one failure doesn't stop the rest.

### Operational Learning Loop (OLL)

The system observes its own friction, surprises, and patterns. Pending
observations and tensions accumulate, and a `hb-rethink` subagent is
spawned when the weighted score crosses a threshold. Promoted
observations become KG facts (with backlink); archived ones drop.

### Three domain types

| Type           | What it is                                      | Lifecycle                          |
|----------------|--------------------------------------------------|------------------------------------|
| `dev-project`  | Development project, spawned on demand           | Long-lived, hand-managed           |
| `cron-task`    | Periodic background task                         | Long-lived, re-spawned by cron     |
| `topic-thread` | Telegram forum topic as a long-lived session     | Auto-suggested, idle-archived      |

A **topic-thread** domain gives a Telegram topic its own memory
contour (decisions, status, changelog) and QMD collection — no bleed
with other topics or main sessions. Unbound topics are auto-suggested
once they accumulate enough context, and idle ones are archived after
`staleAfterDays` (default 60).

### Configurable subagent models

The model for each heartbeat subagent is resolved at spawn time from
`ENGRAM_MODEL_<LABEL>` env var, then `engram.json`, then per-label
defaults. The protocol is model-agnostic; deployments tune cost vs
quality without code changes.

### Cross-platform

All scripts work on Linux and Windows (path normalization, `qmd.cmd`
default on Windows, timezone via `ENGRAM_TZ`).

---

## OpenClaw Hooks

Engram ships 8 hooks that automate mechanical session tasks. Agents do
**not** repeat these steps manually.

| Hook                                | Event                          | Purpose                                                |
|-------------------------------------|--------------------------------|--------------------------------------------------------|
| `engram-daily-note`                 | `gateway:startup`              | Create today's daily note for all sessions             |
| `engram-session-start` / `-end`     | `agent:bootstrap` / `command:*`| Mark session boundaries                                 |
| `engram-bootstrap-qmd`              | `agent:bootstrap`              | Refresh QMD index (TTL + lock, silent skip if busy)    |
| `engram-message-log`                | `message:received`             | Log raw messages to `workspace/message-log/`           |
| `engram-session-memory`             | `command:new`, `command:reset` | Save session transcript (QMD-indexed)                  |
| `engram-topic-domain-load`          | `message:received`             | Inject `## Domain Context` for bound topic-thread      |
| `engram-topic-auto-domain-suggest`  | `message:received`             | Suggest creating a domain for unbound topics (≥2 msgs) |

Disable the built-in `session-memory` hook when enabling
`engram-session-memory` — they write to different locations.

### Installing the hooks

Hooks live in two places:

- **Source** (`skills/engram/hooks/<name>/handler.ts`) — what you read,
  what you edit, what Git tracks. **Only `.ts` files are committed**;
  there are no pre-built `.js` artifacts in the repo.
- **Runtime** (`<workspace>/hooks/<name>/handler.js`) — what OpenClaw
  actually loads. **Only `.js` files live here**, plus `HOOK.md`.

The runtime bundle is derived from source via `bun build` and copied
into place by `scripts/install-hooks.js`. Because the build needs
[bun](https://bun.sh), install-time bun is the only hard dependency for
hooks — once installed, the runtime is plain Node.js.

```bash
# Install all 8 engram-* hooks into OpenClaw's runtime hooks dir.
# Default target: ~/clawd/hooks/ (the gateway's managedHooksDir).
bun skills/engram/scripts/install-hooks.js

# Multi-workspace: each OpenClaw workspace has its own hooks dir.
# install-hooks.js autodetects via `openclaw hooks info` but that
# always returns the gateway's primary workspace. To install into
# additional workspaces (or per-workspace junctions), pass --hooks-dir:
cd ~/workspace-b
bun skills/engram/scripts/install-hooks.js --hooks-dir ~/workspace-b/hooks
cd ~/workspace-c
bun skills/engram/scripts/install-hooks.js --hooks-dir ~/workspace-c/hooks
cd ~/workspace-d
bun skills/engram/scripts/install-hooks.js --hooks-dir ~/workspace-d/hooks

# Re-install (after editing handler.ts, after `git pull`, after adding
# a new hook). --force backs up existing entries to _pre-install-<ts>/
# before replacing them. Default is a no-op when content matches.
bun skills/engram/scripts/install-hooks.js --force

# Preview without writing anything.
bun skills/engram/scripts/install-hooks.js --dry-run
```

After any hook change, restart the gateway so the loader picks up the
new `handler.js`:

```bash
openclaw gateway restart
```

`init.js` already calls `install-hooks.js` for you during first-time
setup; you only need to run it manually after pulling new hook code,
adding a new hook, or modifying an existing `handler.ts`.

---

## Quick Start

```bash
# 1. Install QMD (hybrid search engine)
bun skills/engram/scripts/install-qmd.js

# 2. Initialize memory system + hooks
bun skills/engram/scripts/init.js
openclaw gateway restart

# 3. (Optional) Add a session
bun skills/engram/scripts/add-session.js --platform telegram --id <groupId>

# 4. (Optional) Add a domain
bun skills/engram/scripts/add-domain.js --domain <name> --type cron-task \
  --description "Daily digest"
```

See [`SKILL.md`](./SKILL.md) for the full protocol, architecture, and
the full script index. Detailed per-feature docs live in
[`references/`](./references/).

---

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) agent
- [Bun](https://bun.sh) runtime
- QMD — installed via `scripts/install-qmd.js`:
  - **Local** (GPU/CPU): `npm i -g @nicepkg/qmd`
  - **Cloud** (no GPU): `npm i -g @qwexs/qmd`

---

## Roadmap

### Agent Teams

Domain layer is the foundation for multi-agent orchestration
(orchestrators + ephemeral executors). `topic-thread` is the first
long-lived session type beyond `dev-project` and `cron-task` — a partial
implementation at the session level. Full mesh is blocked by
[openclaw#5813](https://github.com/openclaw/openclaw/issues/5813).

### LLM Hook Extraction

OpenClaw `llm_input`/`llm_output` hooks would enable automatic fact
extraction from every LLM call, transparently, without inline signal
scans.

---

## Methodologies

flat three-folder KG (Tiago Forte) · tiered retrieval · no-deletion
supersede chain · memory decay · session isolation · QMD hybrid search
· derived-facts layer · deterministic heartbeat · Operational Learning
Loop · confidence scoring · abstraction ladder (episode → pattern →
principle) · PROPOSAL mechanism for subagent-driven rule changes.

## Inspiration

- [RAPTOR](https://arxiv.org/abs/2401.18059) — hierarchical
  summarization
- [Synapse](https://arxiv.org/abs/2601.01948) — spreading activation
  for memory retrieval
- [A-MEM](https://arxiv.org/abs/2409.15335) — Zettelkasten-style
  agentic memory
- [openclaw-engram](https://github.com/joshuaswarren/openclaw-engram) —
  signal detection
- [arscontexta](https://github.com/agenticnotetaking/arscontexta) —
  Three-Space model and Operational Learning Loop

## License

MIT
