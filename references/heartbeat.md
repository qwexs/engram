# Heartbeat Integration

## Flow (every 30 minutes)

```
0. Daily Note Creation + Three-Layer Rotation
1. Weekly Synthesis (Mondays only)
2. Knowledge Graph Extraction (if notes changed)
3. Memory Maintenance (every few days)
3.5. Domain Supervisor Scan (if domains exist)
4. QMD Index Update
```

### Step 0: Daily Note Creation

- Check `memory/heartbeat-state.json` → `lastDailyNoteCreated[session]`
- If today's date differs, create `memory/agent-{id}/{session}/YYYY-MM-DD.md`
- Update `lastDailyNoteCreated[session]` to today
- **Three-Layer Rotation**: If any daily note >1000 lines:
  1. **Archive** (full preservation): Move original to `archives/YYYY-MM/YYYY-MM-DD.md` — nothing is lost
  2. **Stub with summary** (smart compaction): Replace with:
     - Header: `# YYYY-MM-DD` + `(full version: archives/YYYY-MM/YYYY-MM-DD.md)`
     - Auto-generated summary (10-20 lines): decisions, results, status changes, new entities
     - Each item references archive line (`→ L42`) or KG entity (`→ life/projects/xxx`)
     - Skip facts already in Knowledge Graph (no duplication)
     - When in doubt, include (redundancy > loss)
  3. **QMD index** (granular access): Archive indexed for detail retrieval via `qmd query`
  - Run rotation AFTER KG Extraction to minimize stub duplication

### Step 1: Weekly Synthesis (Mondays)

**Trigger**: Monday AND synthesis not done this week (check `weekly-synthesis-tracker.json`)

For each entity in `life/`:
1. Load `status: "active"` facts from `items.json`
2. Classify: Hot (7d), Warm (8-30d), Cold (30+d)
3. Low-confidence acceleration: `confidence < 0.5` → Cold at 14d
4. Frequency resistance: `accessCount >= 10` bumps Cold → Warm
5. Abstraction-aware inclusion:
   - `principle` (L3) — always include
   - `pattern` (L2) — include if Warm or Hot
   - `episode` (L1) — standard decay
6. Rewrite `summary.md` with included facts
7. Update `weekly-synthesis-tracker.json`

### Step 2: Knowledge Graph Extraction

Scan recent daily notes for durable facts:

**What to extract:**
- New people mentioned (relationships)
- Project milestones or status changes
- Decisions made
- Preferences discovered
- Important context

**How to extract:**
1. Read today's + yesterday's daily notes
2. For each durable fact:
   - Add to existing entity's `items.json` (or create new entity)
   - Set confidence using rubric
   - Set abstractionLevel (episode/pattern/principle)
   - Add tags
3. Update `summary.md` if new Hot facts added
4. Update `life/index.md` if new entities created

**Skip:** casual chat, transient requests, already-captured facts.

### Step 3: Memory Maintenance

Periodically (every few days):
1. Review recent daily notes for insights worth keeping in MEMORY.md
2. Update MEMORY.md with distilled learnings
3. Remove outdated info from MEMORY.md
4. Check `life/index.md` freshness

### Step 3.5: Domain Supervisor Scan

Проверка субагентных доменов (`memory/domains/`). **Пропустить если директория не существует.**

#### 3.5.1 PROPOSAL Review

```bash
qmd query "PROPOSAL" -c domains
```

- Если найден PROPOSAL → оценить:
  - **Low-risk** (добавить направление поиска, изменить формат) → обновить `decisions.md` автоматически
  - **High-risk** (изменить пороги алертов, убрать проверки) → сообщить пользователю
- После обработки: добавить запись в changelog что PROPOSAL принят/отклонён

#### 3.5.2 Liveness Check

Для каждого домена прочитать `status.md`:
- Проверить **последний запуск** — если пропущено >2x от расписания → алерт
- Проверить **результат** — если ошибка → алерт

Расписания указываются в `decisions.md` каждого домена или в heartbeat-state.json.

#### 3.5.3 Changelog Ротация

Для каждого домена проверить `changelog.md`:
- Если >1000 строк → переместить в `archives/changelog-YYYY-MM.md`
- Создать новый `changelog.md` с заголовком + ссылкой на archives

#### 3.5.4 KG Extraction (опционально)

```bash
qmd query "результат OR milestone OR решение" -c domains
```

- Извлечь значимые факты (milestone, pattern) в Knowledge Graph (`life/`)
- Только если changelog изменился с прошлого scan
- Пропускать рутинные записи ("проверка метрик, всё ОК")

### Step 4: QMD Index Update

At end of heartbeat:
```bash
qmd update    # BM25 index (instant)
qmd embed     # Vector embeddings (GPU/Jina, ~1-2s)
```

Run ONCE per heartbeat to reduce GPU load.

## Tracker Files

### heartbeat-state.json
```json
{
  "lastDailyNoteCreated": {
    "main": "2026-02-15",
    "telegram-XXXXXXXXXX": null
  },
  "lastChecks": {
    "email": null,
    "calendar": null,
    "weather": null
  },
  "lastDomainScan": null
}
```

### weekly-synthesis-tracker.json
```json
{
  "lastRun": "2026-02-09",
  "weekNumber": 6,
  "year": 2026,
  "executedAt": "2026-02-09T14:32:00Z",
  "results": {
    "entitiesProcessed": 11,
    "totalFacts": 65,
    "hotFacts": 65,
    "warmFacts": 0,
    "coldFacts": 0,
    "summariesUpdated": 0,
    "summariesAlreadyUpToDate": 11
  },
  "nextRun": "2026-02-16 (Monday, Week 7)"
}
```
