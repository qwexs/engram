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
┌─────────────────────────────────────────────┐
║  Layer 3: MEMORY.md (Curated Wisdom)        ║
║  Long-term personal insights, decisions     ║
├─────────────────────────────────────────────┤
║  Layer 2: Knowledge Graph (life/)           ║
║  PARA entities with atomic facts            ║
├─────────────────────────────────────────────┤
║  Layer 1: Daily Notes (memory/)             ║
║  Raw session notes, per-session isolation   ║
└─────────────────────────────────────────────┘
```

**Data flows upward:** Daily notes → extracted to Knowledge Graph → distilled to MEMORY.md

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
  1. **Archive** — full file moved to `archives/YYYY-MM/` (nothing lost)
  2. **Stub** — auto-summary (10-20 lines) with line refs to archive and KG links
  3. **QMD index** — archive indexed for granular search via `qmd query`
  - Run rotation AFTER KG Extraction to minimize stub duplication

### Knowledge Graph (PARA)

Structured memory in `life/` using Projects/Areas/Resources/Archives:

```
life/
├── projects/<name>/     # Active work (summary.md + items.json)
├── areas/people/<name>/ # People (summary.md + items.json)
├── areas/groups/<name>/ # Groups
├── resources/<topic>/   # Reference material
├── archives/            # Inactive entities
└── index.md             # Master entity index
```

**Tiered retrieval:**
1. `qmd query "topic" -c life` — search first
2. Read `summary.md` — quick context (~90% sufficient)
3. Read `items.json` — only for granular detail

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
1. Monday? → Weekly Synthesis
2. Knowledge Graph Extraction (if notes changed)
3. Memory Maintenance (every few days)
3.5. Domain Supervisor Scan (if domains exist)
4. QMD Index Update (qmd update + qmd embed)
```

### Weekly Synthesis (Mondays)

Rewrites `summary.md` with memory decay applied:
- **Hot** (7 days) — prominent in summary
- **Warm** (8-30 days) — lower priority
- **Cold** (30+ days) — omitted from summary (stays in items.json)

Modifiers:
- `confidence < 0.5` → Cold threshold is 14 days
- `accessCount >= 10` → bumps Cold to Warm
- `principle` (L3) → always in summary
- `pattern` (L2) → in summary if Warm+

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

1. **PROPOSAL review** — `qmd query "PROPOSAL" -c domains` → auto-approve low-risk, alert user for high-risk
2. **Liveness check** — read each domain's `status.md`, alert if missed >2x schedule
3. **Changelog rotation** — rotate `changelog.md` >1000 lines to `archives/`
4. **KG extraction** — extract significant facts from changelogs to Knowledge Graph

For full details, see [references/heartbeat.md](references/heartbeat.md) and [references/subagent-memory.md](references/subagent-memory.md).

## Memory Decay

Facts decay based on recency, with modifiers for confidence, frequency, and abstraction:

| Tier | Recency | In summary? |
|------|---------|-------------|
| Hot | ≤7 days | ✅ Prominent |
| Warm | 8-30 days | ✅ Lower priority |
| Cold | 30+ days | ❌ (searchable via QMD) |

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

**Write Pipeline Rule:** NEVER write `items.json` directly. Always use `bun scripts/memory-write.js`. Direct writes bypass dedup, validation, and hash registration, causing schema mismatches (e.g., `content` vs `fact`, `created` vs `timestamp`). This applies to heartbeats, inline extraction, and entity creation. No exceptions.

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

Связка задаётся через реестр доменов (`memory/domains/registry.json`):

```json
{
  "domains": {
    "engram": {
      "type": "dev-project",
      "kgEntity": "projects/engram",
      "description": "Memory architecture skill",
      "subagentLabel": "engram",
      "spawnTemplate": "dev-project.md"
    },
    "monitoring": {
      "type": "cron-task",
      "description": "Server monitoring",
      "subagentLabel": "monitoring",
      "spawnTemplate": "cron-task.md"
    }
  }
}
```

**Поля registry:**

| Поле | Обязательно | Описание |
|------|-------------|----------|
| `type` | ✅ | `dev-project` или `cron-task` |
| `description` | ✅ | Краткое описание |
| `spawnTemplate` | ⚠️ рекомендуется | Файл из `templates/spawn-prompts/` |
| `subagentLabel` | ⚠️ рекомендуется | Фиксированный label для sessions_spawn |
| `kgEntity` | нет | Привязка к Knowledge Graph entity |

**Типы доменов:**
- `dev-project` — разработка, привязка к KG entity, субагент по запросу
- `cron-task` — периодические задачи, субагент по расписанию

### Spawn Templates

**Правило: всегда через шаблон.** Не писать промпт от руки — использовать `spawnTemplate` из registry. Это гарантирует что субагент получит Domain Lifecycle (пути к decisions, status, changelog).

Шаблоны лежат в `templates/spawn-prompts/`:
- `dev-project.md` — для разработки (decisions + status + changelog tail)
- `cron-task.md` — для периодических задач (decisions + status)

Шаблоны используют плейсхолдеры: `{{domain}}`, `{{task}}`, `{{decisions}}`, `{{status}}`, `{{changelog_tail}}`.

**Workflow:**
1. Пользователь даёт задачу по проекту
2. Главный бот находит домен через `registry.json`
3. Загружает шаблон из `spawnTemplate`
4. Подставляет контекст домена (decisions, status, changelog)
5. Спавнит субагента с `subagentLabel` и `cleanup: "delete"`
6. Субагент сам определяет где работать (repo, API, скрипты — зависит от задачи)
7. После завершения главный бот обновляет домен (changelog, status)

**Где работать** — не прописывается в домене. Бот определяет рабочую папку из своей памяти и контекста разговора.

### Пример spawn

```javascript
// 1. Найти домен
const registry = readFile("memory/domains/registry.json")
const domain = registry.domains["engram"]

// 2. Загрузить шаблон
const template = readFile(`skills/engram/templates/spawn-prompts/${domain.spawnTemplate}`)

// 3. Подставить контекст
const task = template
  .replace("{{domain}}", "engram")
  .replace("{{task}}", userTask)
  .replace("{{decisions}}", readFile("memory/domains/engram/decisions.md"))
  .replace("{{status}}", readFile("memory/domains/engram/status.md"))
  .replace("{{changelog_tail}}", last20lines("memory/domains/engram/changelog.md"))

// 4. Spawn
sessions_spawn({
  label: domain.subagentLabel,  // из registry
  cleanup: "delete",
  task: task
})
```

Подробная документация: [references/subagent-memory.md](references/subagent-memory.md)

## Scripts

### install-qmd.js — Install QMD search engine

```bash
bun skills/engram/scripts/install-qmd.js [--variant local|jina] [--jina-key <key>]
```

Interactive installer for QMD. Two variants:
- **local** — GPU/CPU embeddings via Vulkan/llama.cpp (recommended for desktop)
- **jina** — Cloud embeddings via Jina AI API, free tier 1M tokens/month (recommended for Docker/VPS)

Handles npm install, API key configuration, .env file creation, and verification.

### init.js — Initialize memory system

```bash
bun skills/engram/scripts/init.js [--agent-id main] [--qmd-variant auto|local|jina] [--force]
```

Creates complete directory structure, copies templates, sets up QMD collections, runs initial index. Use `--force` to merge with existing directories.

### add-session.js — Add new session

```bash
bun skills/engram/scripts/add-session.js --platform telegram --id <groupId> [--agent-id main]
```

Creates session directory, copies group-knowledge templates, adds QMD collection, updates heartbeat-state.json.

### add-domain.js — Create subagent domain

```bash
bun skills/engram/scripts/add-domain.js --domain <name> [--description "РћРїРёСЃР°РЅРёРµ"]
```

Creates `memory/domains/{domain}/` with decisions.md, status.md, changelog.md, README.md. Registers QMD collection `domains` (one for all domains). Warns if >20 domains.

### validate.js — Check integrity

```bash
bun skills/engram/scripts/validate.js [--fix] [--agent-id main]
```

Checks directory structure, required files, items.json validity, v2 schema compliance, ID uniqueness, supersededBy references. Use `--fix` to auto-repair.

### migrate-v2.js — Migrate to v2 schema

```bash
bun skills/engram/scripts/migrate-v2.js [--dry-run]
```

Adds missing v2 fields (confidence, abstractionLevel, tags) to all items.json files with sensible defaults.
