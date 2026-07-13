# Changelog

All notable changes to Engram are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `domains-runner.js` `parseHandoffField` / `parseJsonStrict`: accept LLM-style
  fenced ` ```json ` blocks for `Base-Hashes` and `Changelog-Entries`. The old
  single-line regex used `\s*` after the colon, which swallowed the newline and
  captured only the opening fence (` ```json `), then failed with
  `Unrecognized token '\`'` — leaving `hb-domains-write` handoffs stuck in
  `workspace/ops/heartbeat-spawns/handoff/` since 2026-07-09.
- `install-cron.js`: detect model / agent-id / workspace / recover-flag drift on
  existing jobs and re-sync `message` + `tools` + `model`. Previously an
  `isOnNewFormat` early-return left HB cron on MiniMax after `engram.json` moved
  to Grok (token-plan limit → 10 consecutive errors).

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