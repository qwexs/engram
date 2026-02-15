# Домен: {{DOMAIN}}

{{DESCRIPTION}}

## Структура

| Файл | Назначение | Кто пишет |
|------|-----------|-----------|
| `decisions.md` | Правила и пороги | Main agent (PR-модель) |
| `status.md` | Текущее состояние | Субагент |
| `changelog.md` | Append-only лог действий | Субагент |
| `archives/` | Ротированные changelog | Heartbeat |

## Правила

1. **Один домен = один активный субагент** в любой момент времени
2. `decisions.md` — read-only для субагентов
3. Предложения по изменению правил → PROPOSAL в `changelog.md`
4. Субагент НЕ пишет в daily notes или life/

## Создан

{{DATE}}
