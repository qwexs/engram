# Scripts Reference

> v3.5. ~55 entries: 49 `.js` (включая 5 `.test.js`), 6 `.test.ts`, `_lib/`, `lib/`, `lint-no-personal-data.ts`.
> Path resolution: `join(import.meta.dir, "..", "..", "..")` (3 уровня вверх до workspace root).
> Запуск: `bun skills/engram/scripts/<name>.js [args]`.

## install-hooks.js — Build + install OpenClaw hooks

```bash
bun skills/engram/scripts/install-hooks.js [--force] [--hooks-dir <path>]
```

Build (TypeScript → handler.js bun bundle) and install hooks из `skills/engram/hooks/<name>/` → `~/clawd/hooks/<name>/handler.js`. Per-skill junction, backup до overwrite. После install нужен `openclaw gateway restart`. Идемпотентно; --force для повторного билда.

## install-qmd.js — Install QMD search engine

```bash
bun skills/engram/scripts/install-qmd.js [--variant local|jina|ollama] [--jina-key <key>] [--ollama-key <key>] [--ollama-url <url>]
```

Interactive installer for QMD. Three variants:
- **local** — GPU/CPU embeddings via Vulkan/llama.cpp (recommended for desktop)
- **jina** — Cloud embeddings via Jina AI API, free tier 1M tokens/month (recommended for Docker/VPS)
- **ollama** — Ollama embeddings локально через REST. Альтернатива Local если Vulkan/CUDA недоступен.

Handles npm install, API key configuration, .env file creation, and verification.

## install-cron.js — Install heartbeat cron job

```bash
bun skills/engram/scripts/install-cron.js [install|uninstall|status] [options]
```

Provisions the OpenClaw cron job that drives the heartbeat. The default name includes the logical agent id (`Heartbeat (Engram runner) — <agent-id>`) because cron jobs are gateway-global. It detects the matching job, creates it if missing, and upgrades it to the current durable-handoff prose form. Existing routing, schedule and delivery are preserved; message, tools allow-list and heartbeat model are synchronized.

Use after `init.js`, or pass `--with-cron` to `init.js` to do both in one step.

Since 2026-07-05 the canonical payload includes `--spawn-rethink --spawn-rethink2` so fresh installs bootstrap the OLL loop without manual seeding. `install-cron.js` detects old payloads via `NEW_PAYLOAD_MARKER_5` (`"--spawn-rethink --spawn-rethink2"`) in `isOnNewFormat()` and patches them on `install`.

Since 2026-07-16 the payload dispatches each child with a unique `runtimeLabel` and `expectsCompletionMessage=false`. The child writes to the exact injected absolute `handoffPath` and returns `ANNOUNCE_SKIP` as fallback, avoiding retries against a finalized isolated cron session. `NEW_PAYLOAD_MARKER_6` plus the exact `toolsAllow` list force existing jobs onto this format.

`scripts/validate.js` (cron drift guard) flags any heartbeat job still on the pre-2026-06-23 echo form. See [references/heartbeat-legacy.md §Prompt format history](heartbeat-legacy.md#prompt-format-history) for the two forms, measured impact, and migration steps.

## init.js — Initialize memory system

```bash
bun skills/engram/scripts/init.js [--agent-id main] [--qmd-variant auto|local|jina] [--force]
```

Creates complete directory structure, copies templates, sets up QMD collections, runs initial index. Use `--force` to merge with existing directories.

## add-session.js — Add new session

```bash
bun skills/engram/scripts/add-session.js --platform telegram --id <groupId> [--agent-id main]
```

Creates session directory, copies group-knowledge templates, adds QMD collection, updates heartbeat-state.json.

## add-domain.js — Create subagent domain

```bash
bun skills/engram/scripts/add-domain.js --domain <name> [--description "Description"]
```

Creates `memory/domains/{domain}/` with decisions.md, status.md, changelog.md, README.md. Registers QMD collection `domains` (one for all domains). Warns if >20 domains.

For `type=topic-thread` (Telegram topic as memory contour), also creates:
- `agents.md` — operational ruleset for the topic-agent (QMD default, read/write rules). Injected into the daily note by `engram-topic-domain-load` as the `## Domain AGENTS (auto)` block.
- QMD collections: shared `domains`, per-domain `domain-{slug}`, per-entity `life-projects-{slug}` (opt-in if `--kg-entity` given).
- Telegram binding in `registry.json` (`topic: { chatId, topicId }`).

Example:
```bash
bun skills/engram/scripts/add-domain.js --domain engram \
  --type topic-thread \
  --topic <chatId>:<topicId> \
  --kg-entity projects/engram \
  --description "Engram memory architecture — design, RFC, decisions"
```

## backfill-domain-agents.js — Create/refresh agents.md for topic-thread domains

```bash
bun skills/engram/scripts/backfill-domain-agents.js             # create missing
bun skills/engram/scripts/backfill-domain-agents.js --force     # overwrite all
bun skills/engram/scripts/backfill-domain-agents.js --domain engram  # one domain
bun skills/engram/scripts/backfill-domain-agents.js --dry-run  # preview
```

Renders `templates/domain/topic-thread/agents.md` with substitutions and writes to `memory/domains/{slug}/agents.md`. Idempotent: skips existing files unless `--force` is passed. Archival-archived domains are skipped unless explicitly named.

## promote-domain.js — Promote pending → permanent topic-thread

```bash
bun skills/engram/scripts/promote-domain.js --domain <slug> [--dry-run]
```

Promote pending auto-suggested topic (created via `add-domain.js --pending`) → permanent `topic-thread` в registry. Удаляет флаг `pending: true`, добавляет полные domain files.

## list-pending.js — Список pending topic suggestions

```bash
bun skills/engram/scripts/list-pending.js [--json]
```

Список unbound topics с `pending: true` в registry, ожидающих accept/reject decision.

## render-agents-section.js — Render agents.md из shared template

```bash
bun skills/engram/scripts/render-agents-section.js --domain <slug> [--kg-entity <path>] [--spawn-type dev-project|cron-task]
```

Render `memory/domains/{slug}/agents.md` из `templates/spawn-prompts/_shared/agents-section.template.md` + per-domain context (QMD index, agentId, operator). Обязательная часть spawn pipeline — subagent без `{{agents}}` блока может дрифтить в cross-topic/cross-KG поиск.

## memory-repair.js — Repair corrupted items.json

```bash
bun skills/engram/scripts/memory-repair.js --entity <path> --id <fact-id> \
  [--confidence <0-1>] [--abstraction episode|pattern|principle] [--dry-run]
```

Repair schema fields on an existing fact without changing its factual content.
Supports confidence and abstractionLevel corrections. Idempotent.

## derive-facts.js — Build Derived Facts Layer

```bash
bun skills/engram/scripts/derive-facts.js [--dry-run]
```

Собрать все активные факты из `life/**/items.json` → `life/_derived/facts-active.md` для QMD индексации. ≈1 сек / 112 сущностей. Фильтрует superseded. Автоматически вызывается `memory-write.js` (шаг 8) и Phase 4 maintenance.

## audit-superseded.js — Audit supersede chain integrity

```bash
bun skills/engram/scripts/audit-superseded.js [--fix] [--quiet]
```

Detect orphan `supersedeBy` (target не существует), broken chains (A→B→C где C не active), mismatched dates. `--fix` ремонтирует мягкие cases.

## validate.js — Check integrity

```bash
bun skills/engram/scripts/validate.js [--fix] [--agent-id main]
```

Checks directory structure, required files, items.json validity, v2 schema compliance, ID uniqueness, supersededBy references. Use `--fix` to auto-repair.

## watchdog.js — Read-only workspace auditor

```bash
bun skills/engram/scripts/watchdog.js --workspace /path/to/workspace [--json]
bun skills/engram/scripts/watchdog.js --workspace /a --workspace /b --json
bun skills/engram/scripts/watchdog.js --all --workspaces-dir /path/to/workspaces --json
```

Audits drift around an Engram workspace without fixing anything: `validate.js` exit status, runtime hook drift, QMD collection references, registry ↔ domain folders, heartbeat-state ↔ session dirs, KG v2 schema / likely test pollution, and missing `cron.expectedJobName`. Options: `--output`, `--no-core`, `--no-qmd`, `--no-hooks`, `--exit-zero-on-warn`. Report schema: `engram.watchdog.v1`. Full reference: [watchdog.md](watchdog.md).

## migrate-v2.js — Migrate to v2 schema

```bash
bun skills/engram/scripts/migrate-v2.js [--dry-run]
```

Adds missing v2 fields (confidence, abstractionLevel, tags) to all items.json files with sensible defaults.

## memory-signal.js — Signal detection

```bash
bun skills/engram/scripts/memory-signal.js --text "I prefer TypeScript"
```

Classifies text as high/low/none signal. Regex-based, no LLM, <10ms. Returns categories, keywords, confidence.

## memory-write.js — Unified write pipeline

```bash
# Write a fact
bun skills/engram/scripts/memory-write.js --entity <path> --fact <text> --category <cat> \
  [--confidence 0.9] [--abstraction pattern] [--tags "a,b"] [--source "2026-02-16"] \
  [--description "Why this fact matters (max 150 chars)"] \
  [--entity-create] [--check-contradictions] [--cross-entity] \
  [--semantic-check] [--search-collections "life,collection2"]

# Track access (updates lastAccessed + accessCount for decay)
bun skills/engram/scripts/memory-write.js --access --entity <path> --id <fact-id>
```

Single entry point for all KG writes. Handles dedup, validation, QMD update, optional contradiction/semantic checks. Use `--entity-create` to create new entities on the fly. Use `--access` mode to bump a fact's recency (important for decay tiers).

## memory-dedup.js — Deduplication index

```bash
bun skills/engram/scripts/memory-dedup.js --seed    # Index all existing facts
bun skills/engram/scripts/memory-dedup.js --check --hash <sha256>  # Check if exists
```

Manages `workspace/memory-state/fact-hashes.json`. Run `--seed` after initial setup or weekly synthesis.

## memory-contradict.js — Contradiction detection

```bash
bun skills/engram/scripts/memory-contradict.js --fact <text> --entity <path> \
  [--cross-entity] [--collections "life,other"]
```

Finds conflicting facts via Jaccard similarity. Intra-entity by default; `--cross-entity` discovers related entities via QMD BM25.

## memory-observe.js — Capture operational observations

```bash
bun skills/engram/scripts/memory-observe.js --observation "text" --category friction [--description "desc"] [--dry-run]
```

Captures observations about system friction, surprises, or patterns. Categories: `friction`, `surprise`, `pattern`. Includes novelty check (Jaccard >0.7 rejects duplicates). Only the agent writes observations directly — subagents return `Flags:` in handoffs.

## memory-tension.js — Capture contradictions

```bash
bun skills/engram/scripts/memory-tension.js \
  --tension "text" --fact1 <id> --fact2 <id> \
  [--type factual|temporal|priority] [--confidence 0.8] [--description "desc"] [--dry-run]
```

Captures tensions between two KG facts. Validates both IDs exist in KG. Stores `fact1Text`/`fact2Text` from KG for hb-rethink review. Auto-created by `memory-write.js --check-contradictions` when Jaccard ≥0.5 + ≥3 common keywords. Novelty check (>0.7 → skip duplicate).

## memory-tension-resolve.js — Resolve or dissolve tensions

```bash
bun skills/engram/scripts/memory-tension-resolve.js --id tension-0001 --resolution "text"
bun skills/engram/scripts/memory-tension-resolve.js --id tension-0001 --dissolved --resolution "text"
```

Marks tension as `resolved` (contradiction fixed) or `dissolved` (not actually contradictory). Idempotent if already closed.

## memory-promote.js — Promote observation to KG or archive it

```bash
# Promote obs → KG fact (with backlink: obs.kgFactId ← fact.source = obs-id)
bun skills/engram/scripts/memory-promote.js \
  --obs-id obs-0002 --entity "projects/engram" --fact "text" \
  --category context --confidence 0.8 [--abstraction pattern] [--tags "..."] [--dry-run]

# Archive observation
bun skills/engram/scripts/memory-promote.js --archive --obs-id obs-0003 --reason "noise"
```

Updates `index.json stats` (total/pending/promoted/implemented/archived) after every status change.

## daily-note-append.js — Record session activity to daily note

```bash
bun skills/engram/scripts/daily-note-append.js \
  --session main --agent-id main --section events --text "Fixed 44 semantic duplicates in KG"
```

Atomically appends a bullet entry to a named section of today's daily note. Creates the note from template if it doesn't exist. Sections: `events`, `decisions`, `learnings`, `threads`, `next`. Never overwrites existing content, never touches watermarks or Heartbeat Report.

## rebuild-summaries.js — Rebuild summary.md from items.json

```bash
bun skills/engram/scripts/rebuild-summaries.js [--dry-run] [--entity people/alice] [--apply-decay] [--max-cold-principles 12]
```

Deterministically regenerates `summary.md` for all entities in `life/` from their `items.json`. No LLM involved.

**Without `--apply-decay`**: groups active facts by category, lists top 5 by confidence, shows counts per category and superseded stats.

**With `--apply-decay`**: applies Memory Decay tiers (Hot/Warm/Cold) based on `lastAccessed`/`createdAt`/`source` date. Summary format: `## Current (Hot)`, `## Background (Warm)`, `## Enduring (Principles)`. Cold facts excluded from summary unless selected by semantic priority. Cold principles capped by `--max-cold-principles` (default 12).

Decay algorithm: see [references/decay-rules.md](decay-rules.md). Used by `HB-SYNTHESIS.md` subagent during Monday heartbeat.

## rotate-notes.js — Three-Layer Rotation

```bash
bun skills/engram/scripts/rotate-notes.js --check --session main              # Check if daily note needs rotation
bun skills/engram/scripts/rotate-notes.js --check-domains                      # Check all domain changelogs
bun skills/engram/scripts/rotate-notes.js --rotate --file <path> --type daily  # Rotate daily note (>1000 lines)
bun skills/engram/scripts/rotate-notes.js --rotate --file <path> --type changelog  # Rotate changelog
# exit 0: nothing to rotate / done | exit 10: needs rotation (--check mode)
```

Handles Three-Layer Rotation for daily notes (archive + stub + QMD index) and simple rotation for domain changelogs. Called by heartbeat Phase 0.5. Daily note stubs contain a `<!-- STUB: ... -->` marker for the agent to fill with a summary later.

## heartbeat-state.js — State management

```bash
bun skills/engram/scripts/heartbeat-state.js --get-all
bun skills/engram/scripts/heartbeat-state.js --set pendingObservations 5
```

Atomic read/write of `memory/heartbeat-state.json`. All heartbeat phase trackers must be updated via this script — never edit the JSON directly.

## heartbeat-runner.js — Deterministic cron entrypoint

```bash
bun skills/engram/scripts/heartbeat-runner.js \
  --workspace /path/to/workspace \
  --agent-id main \
  --session main \
  --label-prefix hb
```

Runs the mechanical heartbeat path without relying on an LLM to interpret `HEARTBEAT.md`: lock handling, daily note creation, extraction watermark, weekly summary rebuild, heartbeat report, validation, `qmd update`, and `qmd embed`. Recommended production cron target.

Use `--all-active-sessions` for workspace-level heartbeat. Use `engram.json` `qmd.index`, `qmd.collections`, and optional `qmd.command` when a workspace has a named QMD index or needs a Windows-safe command path.

## heartbeat-report.js — Daily note report section

```bash
bun skills/engram/scripts/heartbeat-report.js --session main --date 2026-02-27 \
  --extraction "spawned (result pending)" \
  --synthesis  "skipped (not Monday)" \
  --domains    "spawned (result pending)" \
  --maintenance "ok — validate-kg.js: 0 errors"
```

Creates or updates `## Heartbeat Report` section in a daily note. Called by heartbeat orchestrator in Phase 6 and by `process-handoff.js`. Omit any flag to preserve its current value.

## extract-runner.js — hb-extract spawn helper

```bash
bun skills/engram/scripts/extract-runner.js --session <id> --date <YYYY-MM-DD> [--watermark <line>]
```

Spawn `hb-extract` subagent с templated prompt + watermark context. Используется heartbeat-runner Phase 1.

## domains-runner.js — hb-domains + hb-domains-write spawn helper

```bash
bun skills/engram/scripts/domains-runner.js --phase status|write|both
```

Phase 3 spawns `hb-domains` (status check); Phase 3.5 spawns `hb-domains-write` (apply pending changelog writes, каждый cron tick). `--phase both` запускает обе подряд с idempotency по entry-id.

## process-handoff-core.js — Importable handoff handler

```js
import { processHandoff } from "skills/engram/scripts/process-handoff-core.js";
await processHandoff(handoffBlock, { session: "main", date: "2026-02-27" });
```

Importable версия `process-handoff.js`: parse handoff block → update heartbeat-state → write watermark (HB-EXTRACT) → write report → handle observations/tensions → resolve tensions. Используется `heartbeat-runner.js` напрямую.

## spawn-pump.js — Claim-based spawn token queue

```bash
bun skills/engram/scripts/spawn-pump.js --enqueue '<payload-json>'  # добавить в очередь
bun skills/engram/scripts/spawn-pump.js --drain [--max <N>]           # drain с claim-токеном
bun skills/engram/scripts/spawn-pump.js --status                       # показать очередь
```

OLL Phase 5.5 ставит в очередь `hb-rethink2` / `hb-autoresearch` если не получилось direct spawn. Claim-токен TTL = 60 сек; один активный spawn at a time per workspace.

## spawn-claim.js — Drain spawn-pump queue → sessions_spawn

```bash
bun skills/engram/scripts/spawn-claim.js [--max <N>] [--label-prefix hb]
```

Claims queued JSON records, assigns a unique per-run `runtimeLabel`, moves them to `done/` with `status: spawned`, and emits records for OpenClaw `sessions_spawn`. After a durable handoff is applied, the matching JSON transitions idempotently to `status: done`.

## spawn-reconcile.js — Close stranded spawn records

```bash
bun skills/engram/scripts/spawn-reconcile.js --workspace <path> --older-than-hours 2
bun skills/engram/scripts/spawn-reconcile.js --workspace <path> --older-than-hours 2 --apply
```

Dry-run by default. Finds `done/*.json` records still marked `spawned` without a matching handoff and, with `--apply`, marks old records `failed` with `legacy-missing-handoff`. Fresh records and records with a pending durable handoff are left untouched.

## process-handoff.js — HB subagent handoff processor

```bash
printf '%s' "<handoff block>" | bun skills/engram/scripts/process-handoff.js --session main --date 2026-02-27
# exit 0: ok | exit 1: error | exit 2: alerts present ([ALERT] lines in stdout)
```

Processes `=== HB-* HANDOFF ===` blocks from subagent results. Handles HB-EXTRACT (watermark advance, lastExtraction, facts count), HB-DOMAINS (lastDomainScan), HB-SYNTHESIS (lastWeeklySynthesis). Updates heartbeat-state.json, advances watermark in daily note, and calls heartbeat-report.js automatically. Called by the heartbeat orchestrator Handoff Handler — do not call manually.
