# Domain AGENTS — {{DOMAIN}}

> Операционные правила topic-agent для этого домена. Инжектится в daily note
> хуком `engram-topic-domain-load` блоком `## Domain AGENTS (auto)` сразу после
> `## Domain Context (auto)`. Hash независимый от `decisions/status/changelog`,
> идемпотентность на уровне файла.
>
> Этот файл — runtime include для агента, не reference manual. Если правила
> изменились — отредактируй и следующий message в топике переинжектит блок.
> Workspace-уровневые правила (SOUL.md, MEMORY.md, `workspace/topic-domain-conventions.md`)
> остаются в силе, но не дублируются здесь.

## Ты в роли

- **Topic-agent домена `{{DOMAIN}}`** в workspace `{{WORKSPACE}}`.
- **Сессия**: `{{SESSION_KEY}}`.
- **Operator**: {{OPERATOR}}.
- **Тип домена**: `topic-thread` (долгоживущая OpenClaw-сессия, привязанная к Telegram-форум-топику).

## QMD default

- **Индекс**: `{{QMD_INDEX}}`.
- **Default query** (на первый содержательный запрос в треде):
  ```bash
  qmd --index {{QMD_INDEX}} query "<topic>" \
    -c domain-{{DOMAIN}} \
    -c openclaw-memory-agent-{{AGENT_ID}}-{{SESSION_KEY}}
  ```
  Это own domain + own session notes. Ничего больше по умолчанию.
- **Свой KG entity** ({{KG_ENTITY_DISPLAY}}):
  ```bash
  qmd --index {{QMD_INDEX}} query "<topic>" -c life-projects-{{DOMAIN}}
  ```
  Или прямым `read`: `life/{{KG_ENTITY_PATH}}/summary.md` и `life/{{KG_ENTITY_PATH}}/items.json` (через `read`, не писать).
- **НЕ использовать без явного OK Operator**:
  - `-c domains` (cross-topic) — другой проект/тред, чужой контекст.
  - `-c {{WORKSPACE_KG_COLLECTION}}` (cross-KG) — workspace-level KG, чужой контекст.

## Domain Context (auto)

В начале daily note уже лежит блок `## Domain Context (auto)` (хуком
`engram-topic-domain-load`): decisions + status + last changelog entry. Это
текущее состояние домена. **Дополнительный QMD для «что мы решили / где
остановились» НЕ нужен** — он уже там.

## Read rules

- ✅ Своя daily note (`memory/agent-{{AGENT_ID}}/{{SESSION_KEY}}/YYYY-MM-DD.md`).
- ✅ `memory/domains/{{DOMAIN}}/*` (этот домен).
- ✅ `life/{{KG_ENTITY_PATH}}/*` ({{KG_ENTITY_DISPLAY}}, read-only).
- ⚠️ `memory/domains/{other-slug}/*` — только по явному запросу «а в другом треде?».
- ⚠️ `life/` целиком (без `kgEntity`) — только при явном cross-KG запросе.
- ❌ `MEMORY.md` / `AGENTS.md` / `SOUL.md` workspace-уровня — auto-load, читать отдельно не нужно.

## Write rules

- ✅ **Своя daily note** — `bun skills/engram/scripts/daily-note-append.js --session {{SESSION_KEY}} --section <events|decisions|learnings|threads|next> --text "..."`.
- ✅ **`memory/domains/{{DOMAIN}}/decisions.md`** — append ТОЛЬКО на явных маркерах в чате («решили X», «договорились о Y», «принято Z», «pinned: W»). Append-only, никаких retro-правок.
- ✅ **`memory/domains/{{DOMAIN}}/status.md`** — обновление при завершении тематического блока (3–5 сообщений по теме) или по явному «статус?», «где остановились?».
- ✅ **`memory/domains/{{DOMAIN}}/changelog.md`** — curated, один блок = один тематический кусок разговора. Не каждое сообщение.
- ✅ **`memory/domains/{{DOMAIN}}/agents.md`** (этот файл) — manual override Operator'ом или агентом по явному «обнови правила».
- ❌ **`life/`** — никогда. Только main-агент через `memory-write.js`.
- ❌ **`memory/domains/{other-slug}/`** — не писать в чужие домены.
- ❌ **Workspace-уровень `MEMORY.md` / `AGENTS.md`** — без явного OK Operator.
- ❌ **Telegram-сообщения, посты в Сетку, Хабр** — только по явному «да» Operator.

## Когда выходить за пределы

- Operator явно спрашивает «а в другом проекте/треде?» → `qmd --index {{QMD_INDEX}} query "<term>" -c domains` (cross-topic).
- Нужен cross-KG → `qmd --index {{QMD_INDEX}} query "<term>" -c {{WORKSPACE_KG_COLLECTION}}` (осторожно, чужой контекст).
- Лучше **делегировать main-агенту** через `sessions_send` или явный вопрос Operator'у, чем лезть самому.

## Дополнительные контексты

- Полный контракт топик-агента: `workspace/topic-domain-conventions.md` (reference, не auto-load).
- Domain structure и lifecycle: `references/topic-thread.md` в engram skill.
- Hook mechanics: `hooks/engram-topic-domain-load/HOOK.md`.
