# OpenClaw Hooks

> v3.6. Engram ships **11 OpenClaw hooks** that automate mechanical session tasks. Hooks run automatically — agents do NOT need to repeat these steps manually.

## Hook Table

| Hook | Event | What it does |
|------|-------|--------------|
| `engram-daily-note` | `gateway:startup` | Reconciles state for today's existing notes; creates nothing. |
| `engram-session-start` | `agent:bootstrap` | Appends `<!-- session:start:{ISO} -->` to daily note. Silently auto-creates a `topic-thread` domain (description `auto-bound`) on first bootstrap for an unbound Telegram topic (ISS-10 piggy-back). |
| `engram-session-end` | `command:new`, `command:reset` | Appends `<!-- session:end:{ISO} -->` to daily note. |
| `engram-session-memory` | `command:new`, `command:reset` | Save session transcript to `sessions/` subdir (QMD-indexed). Replaces native `session-memory`. |
| `engram-bootstrap-qmd` | `agent:bootstrap` | Declares that QMD maintenance is delegated to the configured scheduler. |
| `engram-message-log` | `message:received` | Logs messages to `workspace/message-log/YYYY-MM-DD.jsonl`. **Disabled by default** (opt-in). |
| `engram-topic-domain-load` | `agent:bootstrap` | On Telegram topic, resolve `entry.topic` and append Domain Context + AGENTS to bootstrap messages. |
| `engram-peer-domain-load` | `agent:bootstrap` | On bound DM or group, resolve `entry.peer`/`entry.group` and append Domain Context + AGENTS to bootstrap messages. |
| `engram-rule-context-load` | `agent:bootstrap` | In explicit `active` mode, append the complete matching managed-rule projection; fail closed on person ambiguity, conflicts, or byte-cap overflow. |
| `engram-rule-rollback` | `message:received` | Suspend selected optimistic OLL rules when a user replies to their numbered notification with `Отменить N`. |
| `engram-kg-context-load` | `agent:bootstrap` | Inject only the guarded KG v3 current projection during an authorized canary. |

> **Note:** Disable the built-in `session-memory` hook when enabling `engram-session-memory` — they serve the same purpose but write to different locations.

## Execution order on `/new`

1. `engram-session-end` fires on `command:new` → writes `<!-- session:end -->`
2. `engram-session-memory` fires on `command:new` → archive session transcript (QMD-indexed)
3. New agent session starts → `agent:bootstrap` fires
4. `engram-session-start` → writes `<!-- session:start -->` (creates sessionDir + daily note)
5. `engram-daily-note` fires on `gateway:startup` → reconcile state for notes that already exist
6. `engram-session-start` creates a note lazily when a concrete session bootstraps
6. domain-load hooks append bound domain context to bootstrap messages
7. `engram-rule-context-load` appends matching active rules when rollout mode is `active`
8. `engram-bootstrap-qmd` leaves index maintenance to the configured scheduler

## Topic-thread bootstrap flow

1. `engram-message-log` fires on `message:received` → logs to `workspace/message-log/`
2. On the next `agent:bootstrap`, the matching domain-load hook appends Domain Context + Domain AGENTS to `event.messages`.
3. `engram-rule-context-load` independently resolves company/workspace/domain/person rules and appends only the matching active projection.

Note: auto-bind for unbound topics happens in `engram-session-start` on `agent:bootstrap` (ISS-10 piggy-back), not in the `message:received` hot path.

## Installation

Hooks are installed automatically by `scripts/init.js` (copies `skills/engram/hooks/engram-*` → `hooks/engram-*` in workspace root, only if not already present).

**Manual installation:**
```bash
# Copy hooks to workspace
cp -r skills/engram/hooks/engram-* hooks/

# Restart Gateway to activate
openclaw gateway restart
```

Hook source files are in `skills/engram/hooks/`. The workspace `hooks/` directory contains the live copies — do not edit skill source directly.

## Configuration

Hooks use `ENGRAM_TZ` (or `TZ`) environment variable for timezone. Default: `UTC`.

```bash
# Set in OpenClaw config (env.vars) or shell:
export ENGRAM_TZ="Europe/Moscow"
```

## Race-condition guard: `ensureSessionReady()`

**Правило для hook-author'ов:** все `message:received`-хуки должны начинать работу с `ensureSessionReady()` — идемпотентная гарантия, что `sessionDir`/daily note существует **до** любой работы с ними.

`ensureSessionReady()` три стратегии если session not ready:
- (a) дождаться `engram-session-start` через таймаут 50–100 ms;
- (b) сам создать stub sessionDir сенсорно, чтобы не блокировать;
- (c) skip + alert в `heartbeat-state.json`.

**Anti-pattern:** хук пишет блок в daily note + sentinel + pointer в `MEMORY.md`, надеясь что LLM-агент прочтёт и вызовет `message` tool. Предыдущий `engram-topic-domain-load` (до v3.5 ISS-15) использовал этот anti-pattern.

## Side-effect-delivered hook pattern

User-facing flows должны использовать **детерминистический канал доставки**, не «записать в файл и надеяться». Три допустимых канала (по убыванию предпочтения):

1. **Telegram Bot API inline-buttons** — `fetch('https://api.telegram.org/bot{TOKEN}/sendMessage')` с `reply_markup={inline_keyboard: [...]}`. Channel completion = Telegram, не модель.
2. **OpenClaw gateway system event injection** — `openclaw system event --mode now|next-heartbeat --session-key <key> --text <msg>`. Для tell-the-agent-X flows.
3. **Workspace-root transient file** — fallback при недоступности #2. Whitelist имён в OpenClaw `bootstrap-extra-files`.

**Не канал:** write-then-hope через daily note / MEMORY.md pointer / sentinel.
