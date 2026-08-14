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

## install-cron.js — Legacy compatibility heartbeat cron

```bash
bun skills/engram/scripts/install-cron.js [install|uninstall|status] [options]
```

Compatibility installer for the older LLM-driven heartbeat cron. New installs
use `install-deterministic-heartbeat-cron.js`. If this command is used for an
upgrade, its generated payload contains no rethink/rethink2/autoresearch gate:
managed adaptation belongs only to the nightly coordinator.

`init.js --with-cron` no longer calls this compatibility installer.

Since 2026-07-16 the payload dispatches each child with a unique `runtimeLabel` and `expectsCompletionMessage=false`. The child writes to the exact injected absolute `handoffPath` and returns `ANNOUNCE_SKIP` as fallback, avoiding retries against a finalized isolated cron session. `NEW_PAYLOAD_MARKER_6` plus the exact `toolsAllow` list force existing jobs onto this format.

`scripts/validate.js` (cron drift guard) flags any heartbeat job still on the pre-2026-06-23 echo form. See [references/heartbeat-legacy.md §Prompt format history](heartbeat-legacy.md#prompt-format-history) for the two forms, measured impact, and migration steps.

## init.js — Initialize memory system

```bash
bun skills/engram/scripts/init.js [--agent-id main] [--qmd-variant auto|local|jina] [--force]
```

Creates the complete workspace-side OLL contract: explicit workspace ID,
nightly-only ownership, disabled/observe-only state, durable legacy-admission
barrier, adaptation stores, all nine hooks, and QMD collections. `--with-cron`
adds only the deterministic non-OLL heartbeat. Fleet registry enrollment and
the single nightly scheduler are deployment-level, acknowledgement-gated steps;
init never creates a second per-workspace OLL cron.

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

## memory-signal.js — Signal detection (diagnostic only)

```bash
bun skills/engram/scripts/memory-signal.js --text "I prefer TypeScript"
```

Classifies text as high/low/none signal. Regex-based, no LLM, <10ms. Returns
categories, keywords, confidence. It does not authorize or perform a KG write.

## KG v3 writer boundary

`engram_memory_save` / `engram_memory_retract` are the only canonical current
mutation tools and are exposed only inside a trusted, admitted source turn.
Legacy v2 writer, access-buffer, repair, auto-fix, and migration entrypoints were
physically removed after fleet acceptance. Native `engram_memory_access`
records actual use as append-only KG v3 events; the daily coordinator applies
them to a separate access-state overlay and rebuilds the v3 current projection.
`items.json` remains available only through the explicit immutable historical
reader.

```bash
bun skills/engram/scripts/kg-v3-zero-legacy-watchdog.ts
```

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

Captures tensions between two KG facts by explicit operator action. Validates both IDs exist in KG. Stores `fact1Text`/`fact2Text` from KG for hb-rethink review. Novelty check (>0.7 → skip duplicate). The retired v2 writer no longer creates tensions automatically.

## memory-tension-resolve.js — Resolve or dissolve tensions

```bash
bun skills/engram/scripts/memory-tension-resolve.js --id tension-0001 --resolution "text"
bun skills/engram/scripts/memory-tension-resolve.js --id tension-0001 --dissolved --resolution "text"
```

Marks tension as `resolved` (contradiction fixed) or `dissolved` (not actually contradictory). Idempotent if already closed.

## memory-promote.js — Archive an observation

```bash
bun skills/engram/scripts/memory-promote.js --archive --obs-id obs-0003 --reason "noise"
```

Automatic observation → KG promotion is retired and fails closed. Archiving
updates `index.json` stats; explicit durable assertions use typed KG v3 ingress.

## daily-note-append.js — Record session activity to daily note

```bash
bun skills/engram/scripts/daily-note-append.js \
  --session main --agent-id main --section events --text "Fixed 44 semantic duplicates in KG"
```

Atomically appends a bullet entry to a named section of today's daily note. Creates the note from template if it doesn't exist. Sections: `events`, `decisions`, `learnings`, `threads`, `next`. Never overwrites existing content, never touches watermarks or Heartbeat Report.

For an explicitly high-signal event, pass both optional flags
`--retrieval-id <stable-kebab-id>` and `--retrieval-title <short title>` to
also create a concise card under the active session's `retrieval/` directory.
The daily note remains canonical; the card is only an opt-in retrieval aid for
the same QMD memory collection. The flags must be used together. Never create
cards automatically, for routine conversation, or through a scheduled job.

## daily-summary-coordinator.js — Sequential daily summary reconciliation

```bash
bun skills/engram/scripts/daily-summary-coordinator.js \
  --workspace /opt/openclaw/workspace \
  --workspace /opt/openclaw/workspaces/elena \
  --json
```

Compatibility no-op that emits a deterministic retired report for explicit
workspaces. It never mutates v2, calls QMD, or invokes an LLM. The matching OLL
reconciliation path is also permanently non-mutating.

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

Atomic read/write of `memory/heartbeat-state.json`. After the OLL cutover this
file contains heartbeat mechanics only; weekly/rethink state lives in
`memory-state/oll/state.json` (`oll-nightly-state.v1`). Never edit either state
projection directly.

## oll-legacy-cutover.ts — PR 2 state separation and fleet cutover

```bash
# dry-run (default), one workspace
bun skills/engram/scripts/oll-legacy-cutover.ts \
  --workspace /path/to/workspace --workspace-id main

# reviewed fleet apply from an immutable registry snapshot
bun skills/engram/scripts/oll-legacy-cutover.ts \
  --registry-snapshot /private/registry-snapshot.json \
  --state-root /var/lib/engram --apply --ack-cutover
```

Writes a durable cutover marker first, then backs up source files with SHA-256
hashes, quarantines active/stale legacy queue and handoff records, migrates
watermarks into `oll-nightly-state.v1`, removes deprecated heartbeat keys, and
writes a resumable workspace/fleet journal. Duplicate runs are idempotent.
Terminal history is retained with an explicit disposition. Nightly rethink and
rule activation remain disabled (`nightly.enabled=false`, observe-only).

## oll-adaptation.ts — Trusted capture and managed review store

```bash
bun skills/engram/scripts/oll-adaptation.ts capture \
  --workspace /path --state-root /var/lib/engram --request-file /trusted/request.json
bun skills/engram/scripts/oll-adaptation.ts pending \
  --workspace /path --state-root /var/lib/engram
bun skills/engram/scripts/oll-adaptation.ts decide-review \
  --workspace /path --state-root /var/lib/engram --request-file /trusted/decision.json
```

PR 3 observe-only adapter. It writes UUID/CAS signal, rule, and review
projections under `memory-state/oll/`, serializes concurrent writers with a
workspace lock, deduplicates exact evidence, and appends privacy-minimized
audit events before projection changes. Actor/scope authority comes only from
trusted metadata plus `$ENGRAM_STATE_ROOT/oll/actors.v1.json`. Current registry
authorization is checked again on review decisions. No rule injection or
activation is performed in observe-only mode.

## Nightly coordinator core — PR 5 trusted orchestration candidate

`src/oll/nightly-coordinator.ts` is an injectable library rather than an
untrusted generic CLI. A deployment supplies a versioned registry adapter,
phase model resolver, and `TrustedSpawnTransport`; the latter maps exactly one
new runtime label to `sessions_spawn`. `src/oll/handoff-watcher.ts` performs a
bounded filesystem wait with pre/post checks and no polling.

The coordinator freezes discovery and context artifacts, owns a renewable
fenced lease, persists CAS batch state plus immutable events, retries with the
same evaluation snapshot, resumes interrupted batches, and enforces terminal
apply/failure before advancing FIFO. PR 5 does not install or modify a live
nightly cron; an operator-supplied declaration is the candidate boundary for a
later canary rollout.

## Rule context resolver and bootstrap hook — PR 6 rollout candidate

`src/oll/rule-context.ts` resolves active company/workspace/domain/person
rules, canonicalizes the rule identity hash, blocks conflicting directives,
and rejects the complete projection when it exceeds
`oll.adaptation.maxInjectedRuleBytes`. `preflightRuleActivation()` is reused by
the deterministic applicator so overflow/conflict becomes review before an
activation transition.

`hooks/engram-rule-context-load` covers main/direct, bound peer/group, and
topic bootstrap sessions through `event.messages`. Person rules require one
exact actor-registry binding and are excluded from multi-person contexts. The
hook is inert unless `oll.adaptation.mode=active`; default and production
configuration remain observe-only until PR 7.

## oll-rollout.ts — PR 7 canary and rollback operator boundary

```bash
# read-only deterministic plan
bun skills/engram/scripts/oll-rollout.ts plan \
  --request-file /trusted/rollout.json

# explicit mutations after reviewed evidence
bun skills/engram/scripts/oll-rollout.ts apply \
  --request-file /trusted/rollout.json --ack-rollout
bun skills/engram/scripts/oll-rollout.ts rollback \
  --request-file /trusted/rollback.json --ack-rollback
```

The request names exact workspace paths, release/batch IDs, scheduler job ID,
payload revision, scheduler CLI read-back evidence path, readiness evidence,
and target mode. Apply is sequential and
writes config/state projections, backup manifests, immutable events, and a
release marker. `active` is rejected until observe-only canary evidence is
true. Rollback preserves evidence, suspends batch rules, disables nightly
rethink, and never restores the legacy heartbeat owner. The CLI does not edit
the OpenClaw scheduler; that live deployment action remains external and
approval-gated.

## oll-memory-candidate-rollout.ts — candidate compiler Phase 5 boundary

```bash
# read-only plan/status/barrier
bun skills/engram/scripts/oll-memory-candidate-rollout.ts plan \
  --request-file /trusted/candidate-shadow.json
bun skills/engram/scripts/oll-memory-candidate-rollout.ts status \
  --request-file /trusted/candidate-status.json
bun skills/engram/scripts/oll-memory-candidate-rollout.ts barrier \
  --request-file /trusted/candidate-rollback.json

# explicit config/projection mutations
bun skills/engram/scripts/oll-memory-candidate-rollout.ts apply \
  --request-file /trusted/candidate-shadow.json --ack-rollout
bun skills/engram/scripts/oll-memory-candidate-rollout.ts rollback \
  --request-file /trusted/candidate-rollback.json --ack-rollback
```

The rollout request binds one exact workspace, policy, scope registry, release
ID, evidence path and evidence byte digest. Apply writes a backup before the
local projection and publishes the config activation bit only inside that
guarded transition, then hashes bytes read back from disk. `materialize` is a
separate explicit transition from a matching `shadow` projection; recorded
shadow cycle and health metrics are diagnostic, not blocking. Rollback disables
new batches, releases only pre-effect reservations, quarantines partial effects,
retains pending reviews and reports whether a binary rollback is safe. The CLI
does not select or activate a live canary by itself.

## oll-nightly-runtime.ts and install-oll-nightly-cron.ts — trusted deployment boundary

`oll-nightly-runtime.ts` bridges the fenced coordinator to OpenClaw Code Mode
through immutable spawn requests and acknowledgements. A dispatch interruption
is reconciled by exact runtime label before any new `sessions_spawn`; the
coordinator then resumes the same durable batch and filesystem watcher.

`install-oll-nightly-cron.ts --action plan` reads the existing `00:40 UTC` job
through `openclaw cron get`, builds the exact script payload, and reports both
current and candidate JCS/SHA-256 revisions without writing. Install requires
`--ack-scheduler`, saves the complete old job JSON, updates the same job, reads
it back, and writes scheduler release evidence. Rollback requires
`--ack-scheduler-rollback` plus that exact backup. The generated script always
runs deterministic reconciliation for the declared full fleet before the
OLL-only canary step, so a one-workspace canary cannot starve the other
workspaces or reconcile the canary twice. OpenClaw currently caps script jobs
at 900 seconds, so the payload uses an 840-second internal budget while the
six-hour batch timeout remains durable across invocations. Runtime source
revision is embedded in the payload evidence. Command rollback passes the
required managed environment marker and clears script-only tool restrictions;
the executable is taken from the operator-supplied scheduler declaration rather than
an obsolete absolute Bun path.

## heartbeat-runner.js — Deterministic cron entrypoint

```bash
bun skills/engram/scripts/heartbeat-runner.js \
  --workspace /path/to/workspace \
  --agent-id main \
  --session main \
  --label-prefix hb
```

Runs the mechanical heartbeat path without relying on an LLM to interpret `HEARTBEAT.md`: lock handling, daily note creation, extraction watermark, weekly summary rebuild, heartbeat report, validation, and QMD maintenance through the typed runtime adapter. Legacy/shadow workspaces retain scoped maintenance; coordinated workspaces delegate QMD to the single global scheduler. When `oll.scheduleOwner=nightly` or the durable cutover marker exists, legacy rethink/rethink2/autoresearch admission and handoff application fail closed while unrelated heartbeat work continues.

## heartbeat-dispatch-check.js — Conditional subagent-dispatch admission

```bash
bun skills/engram/scripts/heartbeat-dispatch-check.js --workspace /path/to/workspace
```

Read-only check for an OpenClaw cron trigger. It returns a trigger envelope
with `fire: true` only when `heartbeat-runner.js` left valid queued subagent
requests. A thin agent dispatcher can then claim and call `sessions_spawn`;
quiet ticks do not need a model turn.

## qmd-maintenance-coordinator.ts — Global maintenance entrypoint

Validates a private global registry/migration manifest, confirms that the
coordinator workspace resolves the expected named index, and runs one
generation-coalesced `update -> embed` pass under the physical-index lease.
It is the only scheduled execution entrypoint for coordinated mode.

## install-qmd-maintenance-cron.js — Deterministic coordinator cron

```bash
bun skills/engram/scripts/install-qmd-maintenance-cron.js \
  --manifest /private/migration.json --workspace /path/to/coordinator-workspace
```

Installs the global coordinator as an OpenClaw `command` payload rather than
an `agentTurn`. The manifest must be a global registry or a migration wrapper
containing one (not the scheduler declaration); use `--dry-run` to review the
exact argv before rollout.
The manifest stays deployment-private; the installer does not enable a
coordinator before its existing coordinated-mode and vector-backfill gates.

## install-deterministic-heartbeat-cron.js — No-model heartbeat cron

```bash
bun skills/engram/scripts/install-deterministic-heartbeat-cron.js \
  --workspace /path/to/agent-workspace --disabled
```

Creates an opt-in OpenClaw `script` payload. It runs the existing heartbeat
runner, claims durable spawn records before and after the run, and invokes
`sessions_spawn` directly — no LLM turn is created. Begin with `--disabled`;
before enabling, verify the gateway setting `cron.triggers.enabled=true`.
The legacy `install-cron.js` remains a compatibility path, but its generated
payload also excludes legacy OLL admission.

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

## extract-runner.js — retired extraction cursor maintenance

```bash
bun skills/engram/scripts/extract-runner.js --session <id> --date <YYYY-MM-DD>
```

Advances daily/session cursors without reading conversation bodies for durable
fact classification and without KG writes. The historical handoff name remains
only for state/report compatibility. No extraction subagent is spawned.

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

Importable версия `process-handoff.js`: parse handoff block → update heartbeat
state/report → handle domain/synthesis/OLL compatibility handoffs. For
HB-EXTRACT it records cursor-maintenance results only; automatic KG promotion
is retired.

## spawn-pump.js — Claim-based spawn token queue

```bash
bun skills/engram/scripts/spawn-pump.js --enqueue '<payload-json>'  # добавить в очередь
bun skills/engram/scripts/spawn-pump.js --drain [--max <N>]           # drain с claim-токеном
bun skills/engram/scripts/spawn-pump.js --status                       # показать очередь
```

Legacy OLL Phase 5.5 может выдать `hb-rethink2` / `hb-autoresearch` только до PR 2 cutover. После cutover `spawn-pump` не эмитит legacy spawn-записи даже при ручном возврате queue-файла.

## spawn-claim.js — Drain spawn-pump queue → sessions_spawn

```bash
bun skills/engram/scripts/spawn-claim.js [--max <N>] [--label-prefix hb]
```

Claims permitted queued JSON records, assigns a unique per-run `runtimeLabel`, moves them to `done/` with `status: spawned`, and emits records for OpenClaw `sessions_spawn`. After cutover, legacy OLL phases are rejected before claim. After a durable permitted handoff is applied, the matching JSON transitions idempotently to `status: done`.

## spawn-ack.js — Persist dispatch acknowledgement

```bash
bun skills/engram/scripts/spawn-ack.js --workspace /path --run-id <uuid> \
  --accepted true --dispatch-ref-uri <encoded-ref> --json
```

Persists the actual `sessions_spawn` acknowledgement together with the exact
resolved model and full-UUID runtime label. Replays with identical correlation
data are idempotent; conflicting acknowledgements fail closed.

## migrate-workspace-id.js — Add canonical workspace identity

```bash
bun skills/engram/scripts/migrate-workspace-id.js \
  --workspace /path/to/workspace --workspace-id managers --dry-run --json
```

Atomically adds `schemaVersion: 1` and `workspace.id` to an existing
`engram.json`. It derives the ID from `agent` when omitted, is idempotent, and
rejects conflicts or path-like identifiers.

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

Processes `=== HB-* HANDOFF ===` blocks. HB-EXTRACT is now a deterministic
cursor-maintenance compatibility envelope; HB-DOMAINS and HB-SYNTHESIS retain
their state/report roles. Called by the heartbeat orchestrator — do not call
manually.
