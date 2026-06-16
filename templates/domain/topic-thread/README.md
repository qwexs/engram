# Домен: {{DOMAIN}}

> Топик Telegram-группы как memory contour. Один топик = один домен.

{{DESCRIPTION}}

## Структура

| Файл | Назначение | Кто пишет |
|------|-----------|-----------|
| `decisions.md` | Принятые решения и pinned-факты | Агент (по маркерам в чате) + участники через PROPOSAL |
| `status.md` | Где сейчас разговор, что открыто | Агент (при завершении тематического блока) |
| `changelog.md` | Лог значимых обменов | Агент (curated) |
| `agents.md` | Операционные правила топик-агента (QMD default, read/write rules) | Auto-create из шаблона, manual override Сергеем |
| `archives/` | Ротированные changelog | Heartbeat |

## Правила

1. **decisions.md** дописывается по явным маркерам в чате: «решили X», «договорились о Y»,
   «pinned: Z». Не каждое сообщение участника становится решением.
2. **status.md** обновляется при завершении тематического блока (3–5 сообщений по теме)
   или по явному запросу «статус?». Это handover для следующего захода.
3. **changelog.md** пишется в формате: что обсудили → что решили → что сделали. Не транскрипт.
4. **Без модерации**: любой участник топика может инициировать решение, агент фиксирует.
5. **Daily note остаётся**: это raw capture всех сообщений (включая болтовню). Домен —
   curated view. Синхронизация не нужна.
6. **Heartbeat** (через `memory/domains/{slug}/status.md` liveness): пропуск idle-доменов,
   ротация changelog >1000 строк, KG extraction значимых фактов.
7. **`agents.md` override**: если правила в `agents.md` нужно переопределить (например,
   «в этом топике пиши в changelog каждый обмен»), Сергей редактирует файл вручную.
   Следующий message в топике переинжектит блок с новым hash. Для backfill-применения
   обновлённого шаблона ко всем доменам — `bun skills/engram/scripts/backfill-domain-agents.js`.

## Создан

{{DATE}}

## More

For the full contract (binding format, hooks, archive lifecycle, QMD usage, registry fields), see `references/topic-thread.md` in the engram skill.
