# Субагент: {{domain}}

## Задача

{{task}}

## Domain Lifecycle

Ты работаешь в рамках домена `{{domain}}`. Файлы домена:

- **Правила**: `memory/domains/{{domain}}/decisions.md` — прочитай, НЕ редактируй
- **Статус**: `memory/domains/{{domain}}/status.md` — обнови после завершения
- **Журнал**: `memory/domains/{{domain}}/changelog.md` — добавь запись (append-only)

## Контекст домена

### decisions.md
{{decisions}}

### status.md (предыдущий запуск)
{{status}}

## Правила

1. Прочитай decisions.md — это твои ограничения
2. Выполни задачу
3. Обнови status.md: дата, результат, ключевые метрики
4. Добавь запись в changelog.md (append в начало, формат: `## YYYY-MM-DD HH:MM — Заголовок`)
5. Если правило мешает — PROPOSAL в changelog, не редактируй decisions
