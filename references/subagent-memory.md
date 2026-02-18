# Subagent Persistent Memory

Паттерн для субагентов с `cleanup: "delete"` и долгосрочной памятью через файлы + QMD.

## Проблема

Субагенты с `cleanup: "delete"` теряют контекст после завершения. Им нужна persistent memory, изолированная от основной session memory.

## Решение: Домены

Каждая задача субагента привязана к **домену** — выделенной папке с собственными файлами:

```
memory/domains/{domain}/
├── decisions.md    # WHAT: правила, пороги (read-only для субагента)
├── workflow.md     # HOW: скрипты, scope, инструменты (опционален)
├── status.md       # Текущее состояние (обновляется субагентом)
├── changelog.md    # Append-only лог действий
├── archives/       # Ротация changelog >1000 строк
└── README.md       # Описание домена
```

## Архитектура

### Четыре файла — четыре роли

| Файл | Кто пишет | Режим | Назначение |
|------|-----------|-------|-----------|
| `decisions.md` | Main agent | Read-only для субагента | Правила, пороги, ограничения (ЧТО можно) |
| `workflow.md` | Main agent | Read-only для субагента | Скрипты, API, scope, внешние источники (КАК работать) |
| `status.md` | Субагент | Перезапись | Текущее состояние, метрики |
| `changelog.md` | Субагент | Append-only | Лог всех действий |

### Разделение ответственности

| Файл | Отвечает за | Пример |
|------|------------|--------|
| `decisions.md` | ЧТО можно делать | "Не менять API endpoints без PROPOSAL" |
| `workflow.md` | КАК домен работает | "Скрипт поиска: `node smart-search.js`, endpoint: https://..." |
| Шаблон (spawn-prompt) | КАКУЮ задачу выполнить | "Собери вечерний дайджест" |

**Цепочка контекста при запуске:** Шаблон → workflow.md → decisions.md → внешние источники (если указаны в workflow) → выполнение.

`workflow.md` **опционален** — рекомендуется для доменов с 2+ типами задач. Простые домены (одна задача) работают без него. Когда workflow.md присутствует, шаблоны остаются тонкими (~30-50 строк), а общая инфраструктура домена описана в одном месте.

### QMD namespace

Одна коллекция `domains` индексирует все домены (`memory/domains/**/*.md`). Не создавать отдельную коллекцию на каждый домен.

```bash
# Поиск по одной коллекции
qmd query "мониторинг CPU" -c domains

# Multi-collection поиск (домены + Knowledge Graph)
qmd query "статус проекта" -c domains -c life

# BM25-only fallback (без GPU)
qmd search "мониторинг" -c domains
```

### PR-модель для decisions.md

Субагент **не может** редактировать `decisions.md`. Если нужно изменить правило:

1. Субагент пишет PROPOSAL в `changelog.md`:
   ```markdown
   ## 2026-02-15 14:30 — PROPOSAL
   **Предложение**: поднять порог CPU алерта с 80% до 90%
   **Причина**: ложные срабатывания при компиляции
   ```

2. Main agent при heartbeat → review → обновляет `decisions.md`

### Race condition

**Правило: один домен = один активный субагент в любой момент времени.**

Перед spawn проверь, что нет активного субагента для этого домена.

## Жизненный цикл субагента

```
1. spawn → cleanup: "delete"
2. Прочитать workflow.md (контекст домена: скрипты, scope, инструменты)
3. Прочитать decisions.md (правила)
4. Прочитать status.md (предыдущее состояние)
5. Выполнить работу
6. Обновить status.md (новое состояние)
7. Добавить запись в changelog.md
8. Завершить → сессия удалена, файлы остаются
```

## Связь с основной архитектурой

### Субагент НЕ пишет в:
- Daily notes (`memory/agent-{id}/`)
- Knowledge Graph (`life/`)
- MEMORY.md

### Heartbeat интеграция

Опциональный шаг heartbeat:
1. `qmd query "PROPOSAL" -c domains` — найти предложения
2. Review changelogs → обновить decisions.md
3. Ротация changelog >1000 строк → `archives/changelog-YYYY-MM.md`
4. Опционально: извлечь факты из changelogs → Knowledge Graph

### Changelog ротация

Когда `changelog.md` превышает 1000 строк:
1. Heartbeat перемещает содержимое в `archives/changelog-YYYY-MM.md`
2. Новый `changelog.md` начинается с заголовка + ссылки:
   ```markdown
   # Журнал: {domain}

   > Предыдущие записи: см. `archives/`
   ```

## Project Domains

Домены могут быть привязаны к проектам в Knowledge Graph (`life/projects/`). Реестр доменов хранится в `memory/domains/registry.json`:

```json
{
  "domains": {
    "engram": {
      "type": "dev-project",
      "kgEntity": "projects/engram",
      "description": "Memory architecture skill",
      "spawnTemplate": "dev-project.md",
      "subagentLabel": "engram",
      "created": "2026-02-17"
    },
    "monitoring": {
      "type": "cron-task",
      "description": "Server monitoring",
      "spawnTemplate": "cron-task.md",
      "subagentLabel": "monitoring",
      "created": "2026-02-17"
    }
  }
}
```

### Registry поля

| Поле | Обязательно | Описание |
|------|-------------|----------|
| `type` | ✅ | `dev-project` или `cron-task` |
| `description` | ✅ | Краткое описание |
| `spawnTemplate` | ⚠️ рекомендуется | Файл из `templates/spawn-prompts/` |
| `subagentLabel` | ⚠️ рекомендуется | Фиксированный label для sessions_spawn |
| `kgEntity` | нет | Привязка к Knowledge Graph entity |
| `created` | нет | Дата создания |

### Типы доменов

| Тип | Описание | Субагент |
|-----|----------|----------|
| `dev-project` | Разработка, привязка к KG entity | По запросу пользователя |
| `cron-task` | Периодические задачи | По расписанию через cron |

### Связка с KG

- **KG entity** (`life/projects/{name}/`) — что бот знает о проекте (факты, summary)
- **Domain** (`memory/domains/{name}/`) — контекст для субагента (decisions, status, changelog)
- Связка задаётся через поле `kgEntity` в registry.json

### Workflow для dev-project

1. Пользователь даёт задачу по проекту
2. Главный бот находит домен через `registry.json`
3. Загружает шаблон из `spawnTemplate`
4. Читает контекст домена: **workflow.md** (если есть), decisions.md, status.md, changelog (tail)
5. Подставляет плейсхолдеры: `{{domain}}`, `{{task}}`, `{{workflow}}`, `{{decisions}}`, `{{status}}`, `{{changelog_tail}}`
6. Спавнит субагента с `cleanup: "delete"` и фиксированным label
7. Субагент сам определяет где работать
8. После завершения главный бот обновляет домен

**Правило: всегда через шаблон.** Не писать промпт от руки — использовать `spawnTemplate` из registry. Это гарантирует что субагент получит Domain Lifecycle (пути к decisions, status, changelog).

### Создание домена с привязкой к KG

```bash
bun skills/engram/scripts/add-domain.js --domain engram --type dev-project --kg-entity projects/engram --description "Memory architecture skill"
```

## Создание домена

```bash
bun skills/engram/scripts/add-domain.js --domain {domain} --description "Описание"
bun skills/engram/scripts/add-domain.js --domain {domain} --type cron-task --description "Описание"
```

## Пример: домен мониторинга

### decisions.md
```markdown
# Правила: monitoring

## CPU Alert
**Условие**: CPU > 80% в течение 5 минут
**Действие**: уведомить в Telegram

## Disk Alert
**Условие**: свободное место < 10%
**Действие**: уведомить + запустить cleanup
```

### status.md
```markdown
# Статус: monitoring

## Текущее состояние
- **Последний запуск**: 2026-02-15 14:30
- **Результат**: ОК, все метрики в норме
- **CPU**: 45% (avg за час)
- **Disk**: 62% свободно
- **Следующий запуск**: 2026-02-15 15:00
```

### changelog.md
```markdown
# Журнал: monitoring

## 2026-02-15 14:30
**Действие**: проверка метрик сервера
**Результат**: всё в норме, CPU 45%, Disk 62%

## 2026-02-15 13:30
**Действие**: проверка метрик сервера
**Результат**: CPU spike 78% (компиляция), прошёл
```

## Шаблоны spawn

Готовые шаблоны в `templates/spawn-prompts/`:
- `dev-project.md` — для разработки (workflow + decisions + status + changelog tail)
- `cron-task.md` — для периодических задач (workflow + decisions + status)

Плейсхолдеры: `{{domain}}`, `{{task}}`, `{{workflow}}`, `{{decisions}}`, `{{status}}`, `{{changelog_tail}}`.
