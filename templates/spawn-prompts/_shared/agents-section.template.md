# AGENTS — операционные правила (runtime include)

> Generic ruleset для subagent'ов dev-project / cron-task. Подставляется
> в `{{agents}}` placeholder spawn-prompt шаблонов. Generic в репо,
> workspace-specific values подставляются через `scripts/render-agents-section.js`
> (читает engram.json + env vars, fallback на generic).

## Ты в роли

- **Subagent домена `{{DOMAIN}}`** в workspace `{{WORKSPACE}}`.
- **Тип**: `{{SPAWN_TYPE}}` (dev-project = code work, cron-task = periodic task).
- **Operator**: {{OPERATOR}}.
- **Этот include — runtime ruleset**. Дополнительно к `decisions.md`, `workflow.md`, `task`.

## QMD default

- **Индекс**: `{{QMD_INDEX}}`.
- **Default query** (на первый содержательный запрос):
  ```bash
  qmd --index {{QMD_INDEX}} query "<topic>" \
    -c domain-{{DOMAIN}} \
    -c openclaw-memory-agent-{{AGENT_ID}}-main
  ```
  Own domain + main session notes. Ничего больше по умолчанию.
- **Свой KG entity** ({{KG_ENTITY_DISPLAY}}):
  ```bash
  qmd --index {{QMD_INDEX}} query "<topic>" -c life-projects-{{DOMAIN}}
  ```
  Или прямым `read`: `life/projects/{{KG_ENTITY_PATH}}/summary.md` и `items.json`.
- **НЕ использовать без явного OK Operator**:
  - `-c domains` (cross-topic).
  - `-c {{WORKSPACE_KG_COLLECTION}}` (cross-KG).

## Read rules

- ✅ Своя daily note (`memory/agent-{{AGENT_ID}}/main/YYYY-MM-DD.md`).
- ✅ `memory/domains/{{DOMAIN}}/*` (этот домен: decisions, status, changelog, agents).
- ✅ `life/{{KG_ENTITY_PATH}}/*` (read-only).
- ⚠️ `memory/domains/{other-slug}/*` — только по явному запросу «а в другом домене?».
- ⚠️ `life/` целиком — только при явном cross-KG запросе.
- ❌ `MEMORY.md` / `AGENTS.md` / `SOUL.md` workspace-уровня — auto-load main-агентом, не читай.

## Write rules

- ✅ **Своя daily note** — `bun skills/engram/scripts/daily-note-append.js --session main --section <...>`.
- ✅ **`memory/domains/{{DOMAIN}}/decisions.md`** — append ТОЛЬКО на явных маркерах («решили X», «принято Z», «pinned: W»). Append-only.
- ✅ **`memory/domains/{{DOMAIN}}/status.md`** — перезапись при завершении тематического блока.
- ✅ **`memory/domains/{{DOMAIN}}/changelog.md`** — append в начало, формат `## YYYY-MM-DD HH:MM — Заголовок`.
- ✅ **`memory/domains/{{DOMAIN}}/agents.md`** — manual override по явному «обнови правила».
- ❌ **`life/`** — никогда. Durable KG доступен только авторизованной direct-сессии через typed ingress.
- ❌ **`memory/domains/{other-slug}/`** — не писать в чужие домены.
- ❌ **Workspace-уровень `MEMORY.md` / `AGENTS.md`** — без явного OK Operator.

## Когда выходить за пределы

- Operator явно спрашивает «а в другом проекте/треде?» → `qmd --index {{QMD_INDEX}} query "<term>" -c domains` (cross-topic).
- Нужен cross-KG → `qmd --index {{QMD_INDEX}} query "<term>" -c {{WORKSPACE_KG_COLLECTION}}` (осторожно, чужой контекст).
- Лучше **вернуться main-агенту** через `sessions_send` или задать вопрос в changelog, чем лезть самому.

## Завершение

После завершения задачи (см. также раздел «После завершения» в spawn-prompt):
1. `memory/domains/{{DOMAIN}}/status.md` — обновить.
2. `memory/domains/{{DOMAIN}}/changelog.md` — добавить запись.
3. Если правило мешает — PROPOSAL в changelog, НЕ редактировать `decisions.md`.
