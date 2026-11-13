# Domain AGENTS — {{DOMAIN}}

> Правила долгоживущей topic-thread сессии. Хук `engram-topic-domain-load`
> доставляет их при bootstrap вместе с контекстом домена; это не блок,
> который агент должен самостоятельно дописывать в daily note.

## Роль и границы

- Домен: `{{DOMAIN}}`, workspace: `{{WORKSPACE}}`.
- Сессия: `{{SESSION_KEY}}`.
- Operator: {{OPERATOR}}.
- Назначение: {{DESCRIPTION}}.
- Читать только собственный домен `memory/domains/{{DOMAIN}}/` и точную
  session-memory `memory/agent-{{AGENT_ID}}/{{SESSION_KEY}}/`.
- Не читать `MEMORY.md`, `life/`, личные direct-сессии и чужие домены/workspace.
  Историческая привязка KG entity сама по себе не расширяет права топика.
- Не переносить сведения между топиками и не обращаться наружу без явного
  поручения. Запрос не отменяет effective readable policy и границы workspace.

## Поиск

Поиск по необходимости, только через workspace-aware Engram и с явными `-c`:

```bash
engram --workspace {{WORKSPACE_SHELL}} qmd query "<запрос>" \
  -c domain-{{DOMAIN}} -c topic-memory-{{DOMAIN}}
```

- Exact коллекции должны быть зарегистрированы и разрешены текущей policy;
  scaffold `--pending` не доказывает готовность поиска или Worker.
- Не запускать raw `qmd` и не подменять exact-session коллекцию агрегатом.
- Облачные `query`/`vsearch` выполнять через managed Gateway exec, если ключ
  провайдера хранится в Secret Store; не копировать защищённый секрет.
- Чужие коллекции не добавлять. Cross-topic поиск возможен только по явному
  поручению и в пределах уже разрешённой policy.

## Запись и ownership

- При действующей observer-owned exact binding Events/Decisions сохраняет
  Memory Worker. Не выбирать записи вручную, не дублировать их в daily note,
  `decisions.md` или `changelog.md`; не менять блок `engram-domain-recent`
  и другие Worker-owned проекции. Не ждать Worker перед обычным ответом.
- Если валидной активной exact binding нет, действует foreground fallback
  из workspace AGENTS: один краткий значимый результат/решение через штатный
  `daily-note-append.js` с абсолютным workspace и этой канонической сессией.
- Learnings — только самостоятельный повторно применимый вывод;
  threads/next — по необходимости передачи работы. Не переименовывать
  Events/Decisions ради дубля. Команда для foreground-owned разделов:

```bash
bun skills/engram/scripts/daily-note-append.js \
  --workspace {{WORKSPACE_SHELL}} --session {{SESSION_KEY}} \
  --section <разрешённый-раздел> --text "<краткий факт>"
```

- Не писать в `life/`, frozen `MEMORY.md`, чужие домены или workspace-правила.
  Изменение `agents.md` — только по явному поручению уполномоченного оператора.
- Не включать legacy heartbeat и не создавать новые Worker/QMD/OLL coordinators.
