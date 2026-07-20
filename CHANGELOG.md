# Changelog

## Unreleased

- Follow-up hardening for schema repair: `memory-write.js` now rejects invalid
  abstraction levels at the write boundary; `memory-repair.js` refreshes the
  derived facts projection and entity summary after repairs; validation skips
  `workflow.md` for all chat-bound domain types; CLI docs now list the optional
  validation and QMD update flags accurately.
- `memory-repair.js` can now repair invalid `abstractionLevel` values as well
  as confidence, and its optional validation uses the workspace's configured
  agent instead of forcing `main`.
- `validate.js` no longer requests `workflow.md` for `meta-domain` conversation
  contours, matching the existing topic-thread and domains-runner contracts.
- Documented the QMD runtime boundary: indexes are SQLite files, CLI embeds
  are short-lived processes, and the embed lock is scoped to one physical
  index. Separate workspace indexes may embed concurrently, so host-level
  RAM/VRAM limits belong in scheduler orchestration rather than data layout.
- Added capability-aware watchdog warning `WD-QMD-014` for heartbeat
  configurations that pass multiple `-c` collections to a QMD version without
  multi-collection embed support. Heartbeat now requests the structured
  `qmd.embed.v1` result and records lock-held/no-work/embedded outcomes.
- Decoupled the heartbeat cron orchestrator model from subagent defaults. Configure it with `models.heartbeat.orchestrator` (or `ENGRAM_HEARTBEAT_ORCHESTRATOR_MODEL`); when unset, existing cron models are preserved and new jobs use the OpenClaw agent default.
- Added watchdog CLI coverage for explicit multi-workspace selection via repeated `--workspace`, including duplicate-path deduplication and exclusion of unselected workspaces.
- **test(hooks): align domain-load coverage with v4** — replaced the v3 daily-note / system-event / spawn-mock assertions in `tests/engram-topic-domain-load.test.ts` and `hooks/engram-topic-domain-load/tests/handler.test.ts` with a single consolidated v4 test file (26 tests) that verifies the actual contract: payload is delivered via `event.messages` (no daily-note file write, no `openclaw` spawn, no system event). Coverage now exercises bound/unbound topic resolution, chatId sign symmetry, OC66 event-shape fallbacks, event-surface gating, failure modes, unarchive-on-message, and a documented pin of v4's no-idempotency design. The old `tests/engram-topic-domain-load.test.ts` was deleted as a duplicate. The new file no longer mutates `process.env` at module load, which also resolves the `scripts/hooks-state.test.ts` "session-start registers active session" TZ pollution (Cluster 3 of the 2026-07-17 test audit).

All notable changes to Engram are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `engram.json` template now seeds `qmd.collections` as a heartbeat
  maintenance allowlist (`primary`, `life`, `openclaw-root`). Workspaces can
  still register vertical child collections for read access, but heartbeat
  `qmd embed` should only maintain self-owned collections. `watchdog` now warns
  when meta-domain vertical access has no maintenance allowlist (`WD-QMD-008`)
  or when the allowlist includes child access collections (`WD-QMD-009`).
- **Read-only workspace auditor**: `scripts/watchdog.js` and
  `scripts/_lib/workspace-watchdog.js` report Engram workspace drift without
  applying fixes. Checks cover `validate.js`, QMD collection references,
  registry ↔ domain folders, heartbeat-state ↔ session dirs, KG v2 schema /
  likely test pollution, and missing `cron.expectedJobName`. Includes JSON
  report schema `engram.watchdog.v1`, `--output`, `--all --workspaces-dir`,
  `--no-core`, `--no-qmd`, `--exit-zero-on-warn`, docs in
  `references/watchdog.md`, and synthetic tests in `scripts/watchdog.test.js`.
  Follow-up tuning: `qmd-config` is no longer treated as test pollution by name
  alone, missing session state for dormant topic-bound domains is reported as
  informational, and meta-domain coverage now checks that child topic domains
  are included directly or via an aggregate `*-domains` / `domains` collection.
- **Meta-domain type**: new domain type `meta-domain` with `qmdCollections` field
  for vertical QMD access across lower-level workspaces. Supported in
  `add-domain.js` (`--type meta-domain`, `--qmd-collections`, `--peer`,
  `--topic` bindings) and `domains-runner.js` (expected files, heartbeat
  Phase 3/3.5). Auto-propagation: when a new domain is created, its QMD
  collection names are automatically added to all meta-domains in the same
  registry. Templates: `templates/domain/meta-domain/`. Reference:
  [references/meta-domain.md](references/meta-domain.md).

### Fixed
- `watchdog` now passes `engram.json`'s `qmd.index` to `qmd collection list`,
  so named-index workspaces are audited against their own collections instead
  of the default QMD index.
- `watchdog` no longer reports workspace-owned, custom-named QMD collections as
  vertical child overreach (`WD-QMD-009`). Ownership is resolved from the
  workspace-local `.qmd/index.yml`; external child collections remain flagged.
- `domains-runner.js` `parseHandoffField` / `parseJsonStrict`: accept LLM-style
  fenced ` ```json ` blocks for `Base-Hashes` and `Changelog-Entries`. The old
  single-line regex used `\s*` after the colon, which swallowed the newline and
  captured only the opening fence (` ```json `), then failed with
  `Unrecognized token '\`'` — leaving `hb-domains-write` handoffs stuck in
  `workspace/ops/heartbeat-spawns/handoff/` since 2026-07-09.
- `install-cron.js`: detect model / agent-id / workspace / recover-flag drift on
  existing jobs and re-sync `message` + `tools` + `model`. Previously an
  `isOnNewFormat` early-return left HB cron sticky on an outdated model after
  config change.

### Added
- `scripts/init.js` single-command fresh-install bootstrap with `--with-cron`,
  `--auto-detect-sessions`, `--with-sample-domain`, `--dry-run`, and
  `--skip-gateway-restart` flags. One invocation now creates the full
  memory structure (directories, templates, registry defaults, QMD
  collections, hooks, gateway restart, cron, validation) — see
  [SKILL.md §Quick Start](SKILL.md#quick-start).
- Auto-detection of Telegram group, forum (parent + per-topic), and
  direct-chat sessions from `openclaw.json` → `bindings[]`, filtered by
  the current `agentId`. Canonical sessionKeys:
  `telegram-group-{chatId}`, `telegram-group-{chatId}-topic-{topicId}`,
  `telegram-{accountId}-direct-{userId}`.
- Sample `getting-started` domain scaffolding via `--with-sample-domain`
  for onboarding new workspaces.
- `--dry-run` mode prints the full plan without executing.
- Structured summary at end of init: `Created N / Skipped M / Warnings W / Errors E`.
- `assets/templates/domain/registry.json` with cadenceDays defaults
  (`dev-project=7`, `cron-task=3`, `topic-thread=2`).
- `assets/templates/heartbeat-state.json` with `activeSessions: []` scaffold.
- `tests/init-fresh-install.test.js` with 14 integration cases covering
  dry-run, registry defaults, dir structure, template files, structured
  summary, sample domain, validate.js postcondition, force/conflict
  paths, ops/{observations,tensions}, and regression tests for
  sessionKey/heartbeat-state/gateway-restart bugs.

### Changed
- `scripts/init.js` now reads cron schedule from `engram.json` →
  `cron.schedule`, `cron.expectedSchedule.expr`, or `cron.staggerMinutes`
  (in priority order) when `--cron-schedule` is not provided.
- `scripts/init.js` always restarts the gateway after hooks/cron install
  (idempotent; respects `--skip-gateway-restart`, `--dry-run`, and
  no-openclaw-on-PATH). Previously gated on `--with-cron || --with-sample-domain`,
  which left hooks-only runs un-picked-up until a manual restart.
- `scripts/init.js` runs `validate.js --quality` at the end and fails loud
  on errors (instead of silently printing "✅ Memory system initialized").
- `scripts/init.js` creates `life/areas/` which `validate.js` expects but
  was previously skipped.

### Fixed
- **Silent bug (AC1)**: `copyTemplate()` referenced
  `assets/templates/domain/registry.json` but the template physically
  lived at `templates/domain/registry.json`. `init` continued silently
  and printed "Memory system initialized" even though the cadenceDays
  defaults were never copied. Template now lives at the path
  `init.js` looks up.
- Auto-detected sessions were never added to
  `heartbeat-state.json:activeSessions` (defined `populateActiveSessions`
  wrapper was never called). Now batched in
  `updateHeartbeatStateForSessions()` — one read, one write — and called
  for every detected session.
- Help text for `--cron-schedule` previously claimed derivation from
  `models.subagents_default` (a model id, not a schedule); corrected to
  reflect the actual `cron.schedule` / `cron.expectedSchedule.expr` /
  `cron.staggerMinutes` lookup chain.

## Previous releases

See git history for releases before this changelog was introduced.
