# Project Domains — Субагенты с контекстом

Домены (`memory/domains/`) хранят персистентный контекст для субагентов. Реестр: `memory/domains/registry.json`.

## Два типа доменов

| Тип | Пример | Субагент |
|-----|--------|----------|
| `dev-project` | engram | Разработка в репо, фиксированный label |
| `cron-task` | openclaw-digest | Периодические задачи через cron |

## Четыре файла — разделение ролей

| Файл | Кто пишет | Кто читает | Назначение |
|------|-----------|------------|------------|
| `decisions.md` | Главный агент | Субагент (в промпте) | Правила, ограничения |
| `workflow.md` | Главный агент | Субагент (в промпте) | Скрипты, пути, инструменты |
| `status.md` | Субагент | Главный агент | Текущее состояние проекта |
| `changelog.md` | Субагент | Главный агент | История действий (append-only) |

## Spawn Label Rules

Before every `sessions_spawn`:

1. **Heartbeat pattern** (`hb-*`) → spawn directly, no domain check
2. **Otherwise** → check `memory/domains/registry.json`:
   - Label exists as `subagentLabel` → follow Pre-Spawn Checklist below
   - Label NOT in registry → decide:
     - **One-off task** (research, quick fix) → spawn without label or with descriptive label
     - **Iterative project** (will need context across sessions) → run `bun skills/engram/scripts/add-domain.js` first, then spawn with the new domain label

## Pre-Spawn Checklist (ОБЯЗАТЕЛЬНЫЙ)

Перед каждым `sessions_spawn` для проектной задачи:

1. **Найти домен**: проверить `memory/domains/registry.json`
   - Если нет → решить: нужен ли домен? Одноразовая задача → спавн без домена. Итеративная → создать через `add-domain.js`
2. **Прочитать status.md + changelog.md** → понять где проект, что делалось
3. **Сформулировать точную задачу** на основе контекста + запроса пользователя
4. **Прочитать decisions.md + workflow.md** → включить дословно в промпт субагента
5. **Собрать промпт**: decisions + workflow + задача + инструкция "после завершения"
6. **Спавнить**: `sessions_spawn(task: <промпт>, label: "{subagentLabel}", cleanup: "delete")`

## Структура промпта субагента

```markdown
# Domain: {domain}

## Правила (read-only)
{содержимое decisions.md}

## Инфраструктура
{содержимое workflow.md}

## Задача
{точная задача, сформулированная главным агентом}

## После завершения
1. Обнови memory/domains/{domain}/status.md (перезапись)
2. Добавь запись в memory/domains/{domain}/changelog.md (append в начало)
3. Если правило мешает — PROPOSAL в changelog, НЕ редактируй decisions.md
```

## Ключевой принцип

**Главный агент осмысляет контекст (status + changelog) и формулирует точную задачу.** Субагент получает только правила (decisions), инструменты (workflow) и задачу. Никаких скриптов-сборщиков — ценность в осмыслении контекста агентом.
