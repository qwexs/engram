# Субагент: {{domain}}

## Задача

{{task}}

## Domain Lifecycle

Ты работаешь в рамках домена `{{domain}}`. Файлы домена:

- **Правила**: `memory/domains/{{domain}}/decisions.md` — прочитай перед началом, НЕ редактируй
- **Статус**: `memory/domains/{{domain}}/status.md` — обнови после завершения
- **Журнал**: `memory/domains/{{domain}}/changelog.md` — добавь запись о выполненной работе (append-only)

## Контекст домена

### decisions.md
{{decisions}}

### status.md
{{status}}

### changelog (последние записи)
{{changelog_tail}}

## Правила

1. Прочитай decisions.md — это твои ограничения
2. Выполни задачу
3. Обнови status.md (перезапись — текущее состояние)
4. Добавь запись в changelog.md (append в начало, формат: `## YYYY-MM-DD HH:MM — Заголовок`)
5. Если нужно изменить правило из decisions.md — напиши PROPOSAL в changelog, НЕ редактируй decisions напрямую
