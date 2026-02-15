# Subagent Persistent Memory

Паттерн для субагентов с `cleanup: "delete"` и долгосрочной памятью через файлы + QMD.

## Проблема

Субагенты с `cleanup: "delete"` теряют контекст после завершения. Им нужна persistent memory, изолированная от основной session memory.

## Решение: Домены

Каждая задача субагента привязана к **домену** — выделенной папке с собственными файлами:

```
memory/domains/{domain}/
├── decisions.md    # Правила и пороги (read-only для субагента)
├── status.md       # Текущее состояние (обновляется субагентом)
├── changelog.md    # Append-only лог действий
├── archives/       # Ротация changelog >1000 строк
└── README.md       # Описание домена
```

## Архитектура

### Три файла — три роли

| Файл | Кто пишет | Режим | Назначение |
|------|-----------|-------|-----------|
| `decisions.md` | Main agent | Read-only для субагента | Правила, пороги, конфигурация |
| `status.md` | Субагент | Перезапись | Текущее состояние, метрики |
| `changelog.md` | Субагент | Append-only | Лог всех действий |

### QMD namespace

Одна коллекция `domains` индексирует все домены (`memory/domains/**/*.md`). Не создавать отдельную коллекцию на каждый домен.

```bash
qmd query "мониторинг CPU" -c domains
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
2. Прочитать decisions.md (правила)
3. Прочитать status.md (предыдущее состояние)
4. Выполнить работу
5. Обновить status.md (новое состояние)
6. Добавить запись в changelog.md
7. Завершить → сессия удалена, файлы остаются
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

## Создание домена

```bash
bun skills/memory-system/scripts/add-domain.js --domain {domain} --description "Описание"
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
**Результат**: все в норме, CPU 45%, Disk 62%

## 2026-02-15 13:30
**Действие**: проверка метрик сервера
**Результат**: CPU spike 78% (компиляция), прошёл
```

## Промпт для spawn

См. `templates/spawn-prompt.md` — готовый шаблон с плейсхолдерами `{domain}`.
