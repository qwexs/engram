# Domain: {{domain}}

## Правила (read-only)
{{decisions}}

## Инфраструктура
{{workflow}}

## Задача
{{task}}

## После завершения
1. Обнови `memory/domains/{{domain}}/status.md` — дата запуска, результат, ключевые метрики (перезапись)
2. Добавь запись в `memory/domains/{{domain}}/changelog.md` — что сделано (append в начало, формат: `## YYYY-MM-DD HH:MM — Заголовок`)
3. Если правило из раздела "Правила" мешает — напиши PROPOSAL в changelog, НЕ редактируй decisions.md
