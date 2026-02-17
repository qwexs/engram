---
name: engram
description: Etalon memory architecture with Knowledge Graph (PARA), session isolation, memory decay, and QMD hybrid search
---

> ⚠️ **READ-ONLY SKILL**: Этот skill - reference implementation. Не редактируйте файлы напрямую.
> При установке скопируйте скрипты в свою рабочую папку:
> ```bash
> # Скрипты → workspace scripts/
> cp skills/engram/scripts/*.js scripts/
> ```
> Шаблоны и assets остаются в skill-папке. Укажите путь к ней через env:
> ```bash
> export ENGRAM_SKILL_DIR=skills/engram  # или абсолютный путь
> bun scripts/init.js
> ```
> Без `ENGRAM_SKILL_DIR` скрипты ищут assets относительно `../` от своего расположения.

# Memory System

Three-layer memory architecture for OpenClaw agents: curated long-term memory (MEMORY.md), structured knowledge graph (life/), and session-isolated daily notes (memory/).

## Quick Start

```bash
# 1. Install QMD (if not installed)
bun skills/engram/scripts/install-qmd.js

# 2. Initialize everything
bun skills/engram/scripts/init.js

# Add a group session
bun skills/engram/scripts/add-session.js --platform telegram --id 3382546134

# Validate integrity
bun skills/engram/scripts/validate.js

# Migrate to v2 schema
bun skills/engram/scripts/migrate-v2.js --dry-run
```

## Architecture Overview

```
в"Њв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"ђ
в"'  Layer 3: MEMORY.md (Curated Wisdom)        в"'
в"'  Long-term personal insights, decisions     в"'
в"њв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"¤
в"'  Layer 2: Knowledge Graph (life/)           в"'
в"'  PARA entities with atomic facts            в"'
в"њв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"¤
в"'  Layer 1: Daily Notes (memory/)             в"'
в"'  Raw session notes, per-session isolation   в"'
в""в"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"Ђв"
```

**Data flows upward:** Daily notes в†' extracted to Knowledge Graph в†' distilled to MEMORY.md

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

### Every Session Startup

1. Determine session (main, telegram group, discord channel, etc.)
2. Create today's daily note if not exists: `memory/agent-{id}/{session}/YYYY-MM-DD.md`
3. Read session memory:
   - **Main**: today + yesterday daily notes + `MEMORY.md` + `life/index.md`
   - **Group**: today + yesterday daily notes only
4. Use `qmd query "topic" -c <collection>` for deeper context

### Daily Notes

- Path: `memory/agent-{id}/{session}/YYYY-MM-DD.md`
- Header: `# YYYY-MM-DD`
- **Three-Layer Rotation** (>1000 lines during heartbeat):
  1. **Archive** вЂ" full file moved to `archives/YYYY-MM/` (nothing lost)
  2. **Stub** вЂ" auto-summary (10-20 lines) with line refs to archive and KG links
  3. **QMD index** вЂ" archive indexed for granular search via `qmd query`
  - Run rotation AFTER KG Extraction to minimize stub duplication

### Knowledge Graph (PARA)

Structured memory in `life/` using Projects/Areas/Resources/Archives:

```
life/
в"њв"Ђв"Ђ projects/<name>/     # Active work (summary.md + items.json)
в"њв"Ђв"Ђ areas/people/<name>/ # People (summary.md + items.json)
в"њв"Ђв"Ђ areas/groups/<name>/ # Groups
в"њв"Ђв"Ђ resources/<topic>/   # Reference material
в"њв"Ђв"Ђ archives/            # Inactive entities
в""в"Ђв"Ђ index.md             # Master entity index
```

**Tiered retrieval:**
1. `qmd query "topic" -c life` вЂ" search first
2. Read `summary.md` вЂ" quick context (~90% sufficient)
3. Read `items.json` вЂ" only for granular detail

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

# Update index after changes
qmd update          # BM25 (instant)
qmd embed           # Vectors (heartbeat only)
```

**Strategy:**
- Always use `-c` flag for session isolation
- Top 2-3 results usually sufficient
- Run `qmd update` after writing memory
- Do NOT run `qmd embed` manually (heartbeat handles it)

For QMD installation and configuration, see [references/qmd-setup.md](references/qmd-setup.md).

## Heartbeat Integration

Add to your HEARTBEAT.md:

```
## Heartbeat Flow (every 30 minutes)

0. Create today's daily note + Three-Layer Rotation check
1. Monday? в†' Weekly Synthesis
2. Knowledge Graph Extraction (if notes changed)
3. Memory Maintenance (every few days)
3.5. Domain Supervisor Scan (if domains exist)
4. QMD Index Update (qmd update + qmd embed)
```

### Weekly Synthesis (Mondays)

Rewrites `summary.md` with memory decay applied:
- **Hot** (7 days) вЂ" prominent in summary
- **Warm** (8-30 days) вЂ" lower priority
- **Cold** (30+ days) вЂ" omitted from summary (stays in items.json)

Modifiers:
- `confidence < 0.5` в†' Cold threshold is 14 days
- `accessCount >= 10` в†' bumps Cold to Warm
- `principle` (L3) в†' always in summary
- `pattern` (L2) в†' in summary if Warm+

For full decay rules, see [references/decay-rules.md](references/decay-rules.md).

### Knowledge Graph Extraction

During heartbeats, scan daily notes for durable facts:
- Relationships, milestones, status changes, decisions, preferences
- Write to entity `items.json` with confidence and abstraction level
- Update `summary.md` for new Hot facts
- Create new entities when creation rules are met
- Skip casual chat and transient requests

For the complete heartbeat flow, see [references/heartbeat.md](references/heartbeat.md).

### Domain Supervisor Scan

If subagent domains exist (`memory/domains/`), heartbeat acts as supervisor:

1. **PROPOSAL review** вЂ" `qmd query "PROPOSAL" -c domains` в†' auto-approve low-risk, alert user for high-risk
2. **Liveness check** вЂ" read each domain's `status.md`, alert if missed >2x schedule
3. **Changelog rotation** вЂ" rotate `changelog.md` >1000 lines to `archives/`
4. **KG extraction** вЂ" extract significant facts from changelogs to Knowledge Graph

For full details, see [references/heartbeat.md](references/heartbeat.md) and [references/subagent-memory.md](references/subagent-memory.md).

## Memory Decay

Facts decay based on recency, with modifiers for confidence, frequency, and abstraction:

| Tier | Recency | In summary? |
|------|---------|-------------|
| Hot | в‰¤7 days | вњ… Prominent |
| Warm | 8-30 days | вњ… Lower priority |
| Cold | 30+ days | вќЊ (searchable via QMD) |

Full rules: [references/decay-rules.md](references/decay-rules.md)

## Fact Schema v2

Each fact in `items.json` includes:

```json
{
  "id": "<entity>-NNN",
  "fact": "Human-readable statement",
  "category": "relationship|milestone|status|preference|context",
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

Full schema: [references/fact-schema.md](references/fact-schema.md)

## Subagent Memory

Паттерн для субагентов с `cleanup: "delete"` и долгосрочной памятью через домены.

### Quick Start

```bash
# Создать домен
bun skills/engram/scripts/add-domain.js --domain monitoring --description "Мониторинг сервера"

# Настроить правила в decisions.md
# Запустить субагент с промптом из templates/spawn-prompt.md
```

### Структура домена

```
memory/domains/{domain}/
├── decisions.md    # Правила (read-only для субагента)
├── status.md       # Текущее состояние (пишет субагент)
├── changelog.md    # Append-only лог (пишет субагент)
├── archives/       # Ротация changelog
└── README.md
```

### Правила

1. **Один домен = один активный субагент** в любой момент времени
2. `decisions.md` — read-only для субагентов; изменения через PROPOSAL в changelog
3. Субагент НЕ пишет в daily notes или life/
4. QMD: одна коллекция `domains` на все домены
5. Heartbeat: review PROPOSAL, ротация changelog, опционально KG extraction

### Project Domains

Домены могут быть привязаны к проектам в Knowledge Graph (`life/projects/`). Это даёт двустороннюю связку:

- **KG entity** (`life/projects/{name}/`) — что бот знает о проекте (факты, summary)
- **Domain** (`memory/domains/{name}/`) — контекст для субагента (decisions, status, changelog)

Связка задаётся через `kgEntity` в реестре доменов (`memory/domains/registry.json`):

```json
{
  "domains": {
    "engram": {
      "type": "dev-project",
      "kgEntity": "projects/engram",
      "description": "Memory architecture skill",
      "subagentLabel": "engram"
    },
    "monitoring": {
      "type": "cron-task",
      "description": "Server monitoring"
    }
  }
}
```

**Типы доменов:**
- `dev-project` — разработка, привязка к KG entity, субагент по запросу
- `cron-task` — периодические задачи, субагент по расписанию

**Workflow для dev-project:**
1. Пользователь даёт задачу по проекту
2. Главный бот находит домен через registry
3. Читает контекст домена (decisions, status, changelog)
4. Спавнит субагента с label из registry и `cleanup: "delete"`
5. Передаёт в task: контекст домена + задачу
6. Субагент сам определяет где работать (repo, API, скрипты — зависит от задачи)
7. После завершения главный бот обновляет домен

**Где работать** — не прописывается в домене. Бот определяет рабочую папку из своей памяти и контекста разговора. Проект может быть связан с кодом, API, документацией — workflow одинаковый.

### Пример spawn

```javascript
sessions_spawn({
  label: "engram",        // фиксированный label из registry
  cleanup: "delete",      // чистый контекст каждый раз
  task: `## Контекст домена engram
  
### Decisions
${decisions_md_content}

### Status  
${status_md_content}

### Changelog (последние записи)
${recent_changelog}

## Задача
${user_task}`
})
```

Полный шаблон промпта: `templates/spawn-prompt.md`
Подробная документация: [references/subagent-memory.md](references/subagent-memory.md)

## Scripts

### install-qmd.js вЂ" Install QMD search engine

```bash
bun skills/engram/scripts/install-qmd.js [--variant local|jina] [--jina-key <key>]
```

Interactive installer for QMD. Two variants:
- **local** вЂ" GPU/CPU embeddings via Vulkan/llama.cpp (recommended for desktop)
- **jina** вЂ" Cloud embeddings via Jina AI API, free tier 1M tokens/month (recommended for Docker/VPS)

Handles npm install, API key configuration, .env file creation, and verification.

### init.js вЂ" Initialize memory system

```bash
bun skills/engram/scripts/init.js [--agent-id main] [--qmd-variant auto|local|jina] [--force]
```

Creates complete directory structure, copies templates, sets up QMD collections, runs initial index. Use `--force` to merge with existing directories.

### add-session.js вЂ" Add new session

```bash
bun skills/engram/scripts/add-session.js --platform telegram --id <groupId> [--agent-id main]
```

Creates session directory, copies group-knowledge templates, adds QMD collection, updates heartbeat-state.json.

### add-domain.js вЂ" Create subagent domain

```bash
bun skills/engram/scripts/add-domain.js --domain <name> [--description "РћРїРёСЃР°РЅРёРµ"]
```

Creates `memory/domains/{domain}/` with decisions.md, status.md, changelog.md, README.md. Registers QMD collection `domains` (one for all domains). Warns if >20 domains.

### validate.js вЂ" Check integrity

```bash
bun skills/engram/scripts/validate.js [--fix] [--agent-id main]
```

Checks directory structure, required files, items.json validity, v2 schema compliance, ID uniqueness, supersededBy references. Use `--fix` to auto-repair.

### migrate-v2.js вЂ" Migrate to v2 schema

```bash
bun skills/engram/scripts/migrate-v2.js [--dry-run]
```

Adds missing v2 fields (confidence, abstractionLevel, tags) to all items.json files with sensible defaults.
