---
name: engram
description: Etalon memory architecture with Knowledge Graph, session isolation, memory decay, and QMD hybrid search (Local/Jina)
---

# Engram Memory System

> v3.5 (2026-07-11). Skill is read-only — copy scripts to your workspace, do not edit.
> Changelog: [CHANGELOG.md](CHANGELOG.md) · Script reference: [references/scripts.md](references/scripts.md) · Watchdog: [references/watchdog.md](references/watchdog.md)

## Quick Start

```bash
# Initialize complete memory system
bun skills/engram/scripts/init.js --agent-id main --qmd-variant auto

# With heartbeat cron (recommended)
bun skills/engram/scripts/init.js --agent-id main --qmd-variant auto --with-cron

# Force merge into existing workspace
bun skills/engram/scripts/init.js --force

# Read-only workspace audit (no fixes)
bun skills/engram/scripts/watchdog.js --workspace /path/to/workspace --json
```

## Engram QMD CLI

CLI запускается на Bun прямо из TypeScript-исходников и использует тот же QMD core, что и будущие внутренние интеграции. Runtime dependencies и build step не нужны.

```bash
bun bin/engram --help
bun bin/engram --workspace /path/to/workspace qmd resolve
bun bin/engram --workspace /path/to/workspace qmd doctor --strict
bun bin/engram --workspace /path/to/workspace \
  qmd search "query" -c workspace-memory
```

Правила первой версии:

- `resolve`, `capabilities`, `status` и `doctor` ничего не изменяют;
- `search`, `query` и `vsearch` требуют хотя бы одну явную `-c` и проверяют коллекции против workspace allowlist;
- `--json` пишет в stdout ровно один envelope; verbose details появляются только с `--verbose`;
- CLI не публикует generic passthrough, `update` или `embed`;
- operator CLI не считается OS security boundary и не принимает пользовательский `--scope`;
- agent-facing режим не включён до появления trusted caller context.

Внутренний maintenance coordinator доступен как core API и через закрытый
operator entrypoint `scripts/qmd-maintenance-coordinator.ts`: он хранит
dirty generations вне индексируемого workspace, сериализует один physical
index lease и запускает index-wide `update` перед scoped incremental `embed`.
Обычный цикл никогда не использует `-f`. Hooks, cron и production topology
переключаются отдельным rollout после canary. Workspace heartbeat в
`coordinated` mode не обслуживает QMD и делегирует единому scheduler; см.
[`references/qmd-global-maintenance.md`](references/qmd-global-maintenance.md).

Безопасная установка launcher:

```bash
bun scripts/install-cli.js --dry-run
bun scripts/install-cli.js
engram --version
```

По умолчанию installer использует `$BUN_INSTALL/bin` или `~/.bun/bin`. Он идемпотентен и удаляет только launcher с точным managed body, созданным из этого checkout.

Полный контракт: [references/qmd-cli.md](references/qmd-cli.md). Rollout и rollback: [references/qmd-cli-rollout.md](references/qmd-cli-rollout.md).

## Architecture Overview

```
workspace/
├── life/                         # Knowledge Graph (entities, facts, summaries)
│   ├── people/{name}/
│   │   ├── items.json            # Facts array (v2 schema)
│   │   └── summary.md            # Quick-context (Hot/Warm/Cold tiers)
│   └── projects/{slug}/
├── memory/                       # Operational memory
│   ├── agent-{id}/               # Per-agent session silo (e.g. agent-main)
│   │   └── {session}/YYYY-MM-DD.md   # Daily notes (main, telegram-…)
│   ├── domains/                  # Subagent domains
│   │   ├── registry.json
│   │   └── {slug}/
│   ├── heartbeat-state.json      # Phase tracker
│   └── memory-state/             # Dedup hashes
├── ops/                          # OLL: observations + tensions
└── engram.json                   # Workspace config (models, QMD)
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

**NEVER write `items.json` directly.** In a KG v3-enabled workspace, use only
`engram_memory_save` / `engram_memory_retract` inside the trusted source turn.
The typed pipeline validates source-turn ownership, registry admission,
replacement, projection and receipt before commit.

`memory-write.js` is a compatibility entrypoint only for workspaces that have
not entered the typed rollout. Once `memory-state/kg-v3/live-ingress.json` is
enabled, it must fail closed and must never be used as a fallback.

```bash
bun skills/engram/scripts/memory-write.js \
  --entity "people/alice" --fact "Prefers Bun over Node.js" \
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

For an explicitly high-signal event (a decision, material fix, or delivered
artifact), optionally add a concise retrieval card alongside the canonical
daily-note entry:

```bash
bun skills/engram/scripts/daily-note-append.js \
  --session main --section events --text "Fixed stale heartbeat lock" \
  --retrieval-id heartbeat-lock-repair \
  --retrieval-title "Heartbeat lock repair"
```

The card is an opt-in QMD retrieval aid, not a second source of truth: it
links to the daily note and is indexed by the same memory collection. Do not
generate cards automatically, backfill ordinary notes, or add a cron for them.

### Knowledge Graph

- **Tiered retrieval**: `summary.md` first (quick context), `items.json` on demand (full facts)
- **Entity creation**: when 2+ facts reference same entity, create KG entity
- **No-Deletion Rule**: facts are NEVER deleted. Set `status: "superseded"` and link via `supersededBy`.
- Fact Schema: [references/fact-schema.md](references/fact-schema.md)
- Topic/project sessions remain domain-only. Automatic heartbeat promotion to
  `life/` is retired and cannot be restored with configuration.

### Memory Decay

| Tier | Recency | In summary? |
|------|---------|-------------|
| Hot | ≤7 days | ✅ Prominent |
| Warm | 8-30 days | ✅ Lower priority |
| Cold | 30+ days | ❌ (searchable via QMD) |

Full decay rules: [references/decay-rules.md](references/decay-rules.md)

### QMD Search

QMD = hybrid search engine (BM25 + embeddings + rerank). Two providers: local (Vulkan), jina (cloud).

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

> **KG v3 cutover note:** when the runtime exposes `engram_memory_save` and
> the workspace has an enabled `memory-state/kg-v3/live-ingress.json`, that
> typed tool is the sole inline KG writer. Use it at most once for an explicit
> durable user assertion. Do not run `memory-signal.js`, `memory-write.js`, or
> mechanical extraction for the same KG intent. Operational/progress/test/status
> material still goes to daily/domain stores. If the tool is absent or rejects
> an unregistered entity/predicate, do not bypass it with the legacy writer.

Automatic session/daily/domain/OLL → KG promotion is retired. High-signal
facts enter canonical memory only through the typed tool inside the source turn.

```
Message → explicit durable intent?
  ├── YES + registered typed assertion → engram_memory_save/retract → KG v3
  ├── YES but unregistered → daily/domain store; extend registry separately
  └── operational/progress/test/status/casual → daily/domain store or skip
```

### Signal Detection (diagnostic only)

```bash
bun skills/engram/scripts/memory-signal.js --text "Я предпочитаю TypeScript"
# → { "signal": "high", "categories": ["preference"], "confidence": 0.88 }
```

Supports **Russian and English**. Six categories: `correction`, `preference`,
`decision`, `identity`, `instruction`, `milestone`. This classifier does not
authorize or perform a KG write.

### Contradiction Detection

```bash
# Intra-entity (fast, no QMD)
bun skills/engram/scripts/memory-contradict.js --fact "Uses Node.js" --entity "people/alice"

# Cross-entity (via QMD BM25)
bun skills/engram/scripts/memory-contradict.js --fact "Uses Node.js" --entity "people/alice" \
  --cross-entity --collections "life,openclaw-memory-agent-main-main"
```

### Rules for Inline Extraction

- Only an authorized primary/meta session receives the typed KG capability.
- One source turn may perform at most one typed KG mutation.
- Missing entity/predicate admission is not a reason to use a legacy writer.
- Mechanical extraction only advances watermarks and reports suppressed counts.
- Duplicate/replacement behavior belongs to the v3 writer and operation journal.

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

Для legacy workspace heartbeat остаётся 10-фазным оркестратором. После PR 2
cutover чистая установка оставляет в heartbeat только не-OLL обслуживание;
weekly synthesis и OLL ownership переходят единому nightly coordinator.

| Phase | Kind | Назначение |
|-------|------|-----------|
| 0 | inline | Fast Init: state, lock, check |
| 0.5 | inline | Rotation: daily notes >1000 lines |
| 1 | inline | Cursor maintenance only; no content classification or KG writes |
| 1.5 | inline | Stub Summary |
| 2 | legacy-only subagent | Synthesis: hb-synthesis (Mon only) |
| 3 | subagent | Domains Status: hb-domains |
| 3.5 | subagent | Domains Write: hb-domains-write (primary durable path for topics) |
| 4 | inline | Maintenance: validate, qmd update/embed |
| 5 | legacy-only inline | OLL Check: rethink triggers |
| 5.5 | legacy-only inline | OLL Spawn Queue |
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

Legacy **hb-rethink** behavior remains available only before PR 2 cutover.
Cut-over workspaces use the PR 3–6 managed adaptation path: authorized
corrections/preferences/workflow/quality signals, trusted actor/scope grants,
CAS rule/review projections, strict proposal-only `oll.rethink-handoff.v2`,
the deterministic operation-journal applicator, a resumable strict-FIFO
nightly coordinator with fenced lease, immutable registry/context snapshots,
bounded filesystem watcher, and batch timeout, plus scoped active-rule
resolution for generic bootstrap sessions. The trusted runtime adapter is a
deployment boundary. The live `target` observe-only canary and scheduler/
workspace rollback drills passed; the live scheduler was then restored to the
deterministic reconciliation command and `target` to `nightly.enabled=false`.
Production rule injection remains disabled until a separate active-mode gate.

For current OLL runtime details (legacy compatibility plus PR 2–7 managed path/tooling): [references/oll.md](references/oll.md). PR 2 disables heartbeat-owned rethink admission/application and moves scheduling state into `oll-nightly-state.v1`; PR 3 adds trusted capture/authorization/review; PR 4 validates and applies typed handoffs idempotently; PR 5 provides durable discovery, orchestration, recovery, and strict FIFO; PR 6 resolves scoped active rules and injects them only at matching bootstrap when adaptation is explicitly active; PR 7 provides guarded rollout/rollback tooling plus synthetic and live observe-only evidence. Active-mode production rollout remains pending: [references/oll-nightly-adaptation.md](references/oll-nightly-adaptation.md).

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
| `meta-domain` | `topic` / `peer` / `group` | Vertical QMD access across lower-level workspaces. Uses `qmdCollections` array. Auto-propagates new domain collections. |

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

For full subagent memory, spawn workflow, templates: [references/subagent-memory.md](references/subagent-memory.md) · [references/topic-thread.md](references/topic-thread.md) · [references/meta-domain.md](references/meta-domain.md)

## OpenClaw Hooks

Engram ships 10 hooks that automate session tasks. **Agents do NOT need to repeat these manually.**

| Hook | Event | What it does |
|------|-------|--------------|
| `engram-daily-note` | `gateway:startup` | Creates today's daily note |
| `engram-session-start` | `agent:bootstrap` | Session start marker + auto-bind topics |
| `engram-session-end` | `command:new/reset` | Session end marker |
| `engram-session-memory` | `command:new/reset` | Archive session transcript |
| `engram-bootstrap-qmd` | `agent:bootstrap` | Declares scheduler ownership; performs no QMD maintenance |
| `engram-message-log` | `message:received` | Log messages (opt-in) |
| `engram-topic-domain-load` | `agent:bootstrap` | Inject topic domain context |
| `engram-peer-domain-load` | `agent:bootstrap` | Inject bound DM/group domain context |
| `engram-rule-context-load` | `agent:bootstrap` | Inject matching active OLL rules when rollout mode is active |
| `engram-kg-context-load` | `agent:bootstrap` | Inject only the guarded KG v3 current projection during an authorized canary |

For hook installation, race-condition guard, side-effect-delivered pattern: [references/hooks.md](references/hooks.md)

## Scripts

~55 scripts in `skills/engram/scripts/`. Run via `bun skills/engram/scripts/<name>.js [args]`.

**Most-used by agent:**
- `engram_memory_save` / `engram_memory_retract` — canonical KG v3 write tools
- `memory-write.js` — pre-cutover compatibility only; blocked by KG v3 authority
- `daily-note-append.js` — record session activity
- `memory-signal.js` — classify text signal (high/low/none)
- `memory-observe.js` — capture OLL observation
- `memory-contradict.js` — contradiction detection

**Infrastructure (run by hooks/cron, not agent):**
- `heartbeat-runner.js` — heartbeat entrypoint
- `init.js`, `install-hooks.js`, `install-deterministic-heartbeat-cron.js`, `install-qmd.js` — clean-install setup
- `install-cron.js` — pre-cutover compatibility only
- `add-domain.js`, `add-session.js` — provisioning
- `validate.js`, `derive-facts.js` — read/projection maintenance
- `memory-repair.js` — pre-cutover compatibility; write mode blocked by KG v3 authority

Full script reference: [references/scripts.md](references/scripts.md)
