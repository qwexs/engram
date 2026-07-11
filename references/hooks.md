# OpenClaw Hooks

> v3.5. Engram ships **8 OpenClaw hooks** that automate mechanical session tasks. Hooks run automatically — agents do NOT need to repeat these steps manually.

## Hook Table

| Hook | Event | What it does |
|------|-------|--------------|
| `engram-daily-note` | `gateway:startup` | Creates today's daily note for all sessions. |
| `engram-session-start` | `agent:bootstrap` | Appends `<!-- session:start:{ISO} -->` to daily note. Silently auto-creates a `topic-thread` domain (description `auto-bound`) on first bootstrap for an unbound Telegram topic (ISS-10 piggy-back). |
| `engram-session-end` | `command:new`, `command:reset` | Appends `<!-- session:end:{ISO} -->` to daily note. |
| `engram-session-memory` | `command:new`, `command:reset` | Save session transcript to `sessions/` subdir (QMD-indexed). Replaces native `session-memory`. |
| `engram-bootstrap-qmd` | `agent:bootstrap` | Runs `qmd update` (15s timeout, silent skip if unavailable). |
| `engram-message-log` | `message:received` | Logs messages to `workspace/message-log/YYYY-MM-DD.jsonl`. **Disabled by default** (opt-in). |
| `engram-topic-domain-load` | `message:received` | On Telegram topic, resolve domain via `entry.topic = {chatId, topicId}` and inject Domain Context + AGENTS via `openclaw system event`. |
| `engram-peer-domain-load` | `message:received` | On Telegram DM (`peer-direct`) or group without topics (`group-direct`), resolve domain via `entry.peer` or `entry.group` and inject Domain Context + AGENTS via `openclaw system event`. |

> **Note:** Disable the built-in `session-memory` hook when enabling `engram-session-memory` — they serve the same purpose but write to different locations.

## Execution order on `/new`

1. `engram-session-end` fires on `command:new` → writes `<!-- session:end -->`
2. `engram-session-memory` fires on `command:new` → archive session transcript (QMD-indexed)
3. New agent session starts → `agent:bootstrap` fires
4. `engram-session-start` → writes `<!-- session:start -->` (creates sessionDir + daily note)
5. `engram-daily-note` fires on `gateway:startup` → create daily note template
6. `engram-bootstrap-qmd` → refreshes QMD index (TTL+lock, silent skip)

## Topic-thread message flow

1. `engram-message-log` fires on `message:received` → logs to `workspace/message-log/`
2. `engram-topic-domain-load` fires on `message:received` → injects Domain Context + Domain AGENTS via system-event (idempotent per hash)
3. `engram-peer-domain-load` fires on `message:received` → same as #2 for DM (`peer-direct`) and group-without-topics (`group-direct`) sessions

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