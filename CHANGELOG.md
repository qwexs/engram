# Changelog

## Unreleased

- **fix(domains/windows): make topic-domain OpenClaw calls portable and bounded.**
  The new topic enrollment runtime now reuses the Windows shim-safe, headless
  OpenClaw executor for Gateway reads and restarts, applies explicit process
  deadlines, accepts the known state-migration warning prefix, and compares
  workspace and registry paths case-insensitively on Windows.

- **fix(memory/windows): keep scheduled OpenClaw child commands headless.**
  The shared command executor now bypasses the Windows `openclaw.cmd` shim,
  suppresses console windows, and disables launcher respawn for both memory
  worker config read-back and model-run inference. The fix applies to every
  enrolled workspace; no agent-specific scheduler or manifest logic is used.

- **fix(kg): inject the current projection into canonical Telegram direct sessions.**
  The bootstrap hook now normalizes colon-form OpenClaw runtime keys and maps
  an actor-matched direct contour through the canonical runtime-grant registry
  to the existing authority grant. Authority and runtime-grant entries are
  normalized too, so both `main` and exact colon-form personal grants remain
  compatible without relying on optional bootstrap metadata. Ambiguous,
  explicitly untrusted, actor-mismatched, group, and topic sessions remain
  fail-closed. Watchdog now reports an installed KG hook that lacks this
  direct-session contract.

- **feat(domains): make topic-domain creation complete Memory Worker and QMD setup.**
  In an already enrolled forum workspace, `add-domain.js --type topic-thread`
  now adds the explicit OpenClaw topic route through Gateway config CAS,
  registers the domain and exact-session QMD collections, extends the existing
  projection by one binding, republishes its pinned QMD snapshot, and verifies
  the complete read-back. Repeating the same command resumes partial setup.
  Fleet manifests, cron jobs and Worker runtime remain unchanged. Stale hook
  documentation no longer claims silent topic auto-binding.

- **fix(memory): restore the proven single-envelope contextual contract.**
  Contextual producer policy v15 uses the byte-identical frozen v13 prompt and canonical JSON
  envelope after v14 JSONL repeatedly returned incomplete source coverage.
  Historical v14 jobs retain their JSONL parser and policy identity; v15 keeps
  the strict canonical validator and one-inference-call budget without fallback.

- **fix(memory): reduce routine capture noise and account recovered completion
  deadlines.** Contextual prompt v13 now skips one-off mechanical requests and
  results unless they establish reusable state, and coalesces one bounded
  request with its reported completion into one compact assertion. Worker
  health retains every historical `final_wait_deadline` receipt but no longer
  reports active completion debt after the same exact source has passed
  admission, terminal semantic evaluation, and canonical daily-note apply.

- **fix(qmd/bootstrap/watchdog): preserve the managed-exec scheduler contract.**
  The QMD installer now emits an exec-only script (one tool call, synchronous,
  600/650/660 second nested budgets), propagates nonzero/incomplete execution,
  defaults fresh jobs to disabled, preserves ID/activation on update, and writes
  a declaration only after read-back. Init can explicitly provision it from an
  existing deployment manifest; workspace-only cannot. Watchdog detects live
  payload/schedule drift, unverified inventory, stale/failed reports and provenance,
  plus host-owned Workshop containment errors without modifying host code/models.
  Clean-install and operations documentation now distinguish scaffold, activation
  gates, successful scheduling and actual embedding/provenance evidence.

- **feat(memory): add source-specific QMD index and recall provenance.**
  A successful canonical apply now publishes an immutable, content-free index
  handoff after the exact dirty generation. The global maintenance coordinator
  reconciles those handoffs only after update and embed have completed the
  generation and an exact SQLite read-back matches collection root, entry
  anchor, and canonical digest; it then emits `qmd.index-generation.v1` and a
  `canonical_indexed` trace. Handoff publication rereads both the immutable
  apply receipt and the durable maintenance reason/generation; a same-root
  physical-index or collection-name rotation can be proven only by a unique
  same-root document read-back plus the exact vector row under the current
  registry allowlist, not by comparing unrelated generation counters. Apply
  receipts and handoffs remain retained while a newer dependent provenance
  artifact is inside its audit window. Coordinator provenance failures return
  a failing process status. New retrieval and utilization schemas
  reserve the content-free joins needed downstream, but deliberately ship no
  emitter: the installed OpenClaw hook surface exposes neither an authoritative
  QMD ranked-result artifact nor the final selected memory references. Those
  content-free shapes have no registered producer, authority rule, consumer
  admission, or writer until reviewed host adapters supply those durable
  predecessors.

- **fix(memory): resolve family QMD handoff by exact runtime session.**
  A v3 family canary must now pin its workspace registry slice and resolve each
  concrete runtime session to exactly one owned/readable `*.md` collection.
  The effective consumer policy records the canonical root, collection,
  registry digest and physical index key; resolution runs before canonical
  mutation and is rechecked at apply time. Missing, ambiguous, broad-mask,
  symlinked or drifted mappings remain recoverable as `qmd_pending` without a
  primary/name-prefix fallback. Dirty publication verifies `expectedIndexKey`
  before mutating coordinator state. The immutable apply receipt preserves the
  concrete binding used for the canonical write; a retry may adopt a newer
  registry/index revision only when both bindings prove the same exact
  canonical session root, and Recall Authority verifies that proof. Receipt
  lookup treats the operation record as canonical and repairs a missing entry
  alias after a crash between the two immutable publications.

- **fix(memory): make checkpointed runtime admission crash-accountable.**
  The runtime adapter now persists a monotonic checkpoint before publishing
  process-local correlation, resumes the trusted hook chain across adapter
  restart, and emits one immutable content-free gap receipt when a checkpointed
  candidate cannot reach ledger admission. Completed spool evidence is
  sanitized before publication and stripped after terminal disposition;
  content-free terminal state shares the 180-day replay-protection window, and
  the first immutable receipt repairs an interrupted checkpoint update. A
  per-candidate cross-process lock and full envelope+queue+trace probe prevent
  a post-admission crash from producing a second gap, partial ledger admission
  remains repairable, reordered hooks reuse the original completion timestamp,
  legacy v1 spools are sanitized and upgraded before replay, and
  transient projection failures retain work for retry. Corrupt records no
  longer block valid recovery. The guarantee deliberately
  begins at the first accepted `message_received` checkpoint—host failures
  before hook invocation remain a bounded transcript-SDK research item.

- **fix(memory): recognize live batch dispositions in shadow campaign baselines.**
  Campaign snapshots preserve `write`, `skip`, and bounded `defer` semantics
  from current batch terminal reason codes, keep technical failures distinct,
  and require an exact validated batch observation for every historical write.

- **fix(memory): make completed-spool and family-batch recovery crash-complete.**
  Completed runtime turns are durably spooled before ledger admission and
  reconciled on plugin startup; replay after either side of the admission
  boundary remains idempotent and rejects identity drift. Exact-scope workers
  no longer block on another family session's pending batch, and consumer work
  made permanently ineligible by a replacement policy receives a terminal
  disposition instead of remaining queued forever. The batch scheduler now
  discovers those nonterminal consumer records across replaced exact-scope
  boundaries so the terminal reconciler is always reachable.

- **fix(memory): bound semantic-defer replay and restore queue liveness.** A
  deferred batch gets one retry-neutral reconsideration window; replay of the
  unchanged immutable result then records terminal per-source traces instead
  of leaving the same bundle at the head of the evaluator queue forever.
  Pending jobs also honor the durable `nextAttemptAt` retry boundary before
  replaying provider or validator failures.

- **fix(memory): bind batch replay identity to evaluator releases.** Batch
  policy digests now include the prompt contract and installed plugin
  bytes, preventing a new evaluator from colliding with an immutable terminal
  created for an older deferred bundle. A managed scheduler installer also
  propagates nested `exec` status and nonzero exit codes instead of recording
  failed workers as successful cron runs.

- **fix(memory): require actor-aligned source citations in batch output.** A
  write assertion must now cite an exact current `source-turn` whose user or
  assistant segment matches `actorRef`; bounded reply context may support
  interpretation but cannot independently authorize a durable assertion.

- **fix(memory): close the consolidated batch contract gaps.** Batch apply and
  replay now reauthorize current producer and trace policy, validate the full
  canonical observation shape, pin exact plugin bytes, reread live consumer
  policy, run independent retention purge, and resume terminal recovery across
  crashes and stale locks.

- **feat(memory): make Recall Authority batch-aware.** Multiple assertions may
  share one source trace while retaining distinct observation, receipt, and
  canonical-entry identities; the compiler verifies full batch provenance.

- **feat(memory): bridge receipt-backed observer Decisions into OLL.** Only
  allowlisted batch Decisions with exact scope, evaluator policy, canonical
  receipt, destination read-back, and live rollout state are eligible.

- **feat(memory): preserve exact model routing, QMD handoff, and typed recall
  evaluation in the consolidated runtime.** The observer requests its sealed
  provider/model through a one-model plugin allowlist, daily-note applies can
  durably retry an exact QMD dirty handoff, and recall evaluation remains
  read-only, scope-bound, and reproducible.

- **feat(memory): expand the bounded batch canary to the main-agent family.**
  Projection v3 admits `agent:main:*` while retaining exact source-session
  provenance, owner checks, one model call per scheduled run, and one
  canonical daily-note apply per wake. Scope-aware claiming prevents one
  session applicator from consuming another session's queue.

- **fix(memory): stop bootstrap noise from inactive sessions and stale writer
  guidance.** Gateway startup now reconciles only daily notes that already
  exist; the active session bootstrap remains the sole lazy creator. KG v3
  bootstrap replaces the prompt copy of frozen `MEMORY.md` without mutating
  the file, canonical templates no longer advertise removed writer paths, and
  the zero-legacy watchdog covers those instructions.

- **refactor(kg): retire automatic legacy producer branches.** Mechanical
  session/daily extraction is permanently cursor-only without reading message
  bodies, domain and legacy OLL
  promotions are terminally suppressed, and the old configuration switch can
  no longer restore those writer calls. A static audit freezes this boundary.

- **fix(kg): make live plugin digest verification path-stable.** The status and
  rollout CLI now builds from the canonical repository working directory, so
  identical source bytes produce the same digest regardless of caller cwd.

- **feat(kg): add guarded OpenClaw live-turn ingress for KG v3.** A thin
  plugin binds typed save/retract calls to server-stamped inbound run,
  message, sender, and session metadata; each source turn has one
  expiring mutation authority. Per-workspace release/plugin projections keep
  installation dormant until explicit activation, with plan, byte read-back,
  readiness, status, and non-destructive rollback tooling.

- **feat(kg): contain legacy automatic KG ingress fleet-wide.** Session/daily
  extraction, domain promotions and legacy OLL promotions are suppressed while
  terminally consuming their checkpoints. Explicit v2 writes remain gated
  until typed v3 rollout reaches each workspace.

- **feat(cron): add deterministic maintenance primitives.** Global QMD
  maintenance can now be provisioned as an OpenClaw command job rather than
  an agent turn. `heartbeat-dispatch-check.js` provides a read-only trigger
  contract so a future split heartbeat scheduler invokes a model only when
  queued subagent work exists.

- **feat(cron): add opt-in no-model heartbeat installer.** A constrained
  OpenClaw script payload now executes the fixed runner/claim/spawn sequence;
  it supports disabled-canary rollout and leaves the legacy agent-turn
  installer untouched until an operator switches it deliberately.

- **fix(decay): replace stale empty projections with an explicit summary stub.**
  When all active facts become Cold or are filtered from the summary, the
  rebuild now replaces the prior Hot/Warm content instead of skipping the
  entity and leaving stale memory visible. Active facts remain in `items.json`
  and QMD.

- **fix(qmd): resolve dirty marks through canonical KG ownership.** KG writers,
  repairs and access flushes now use `qmd.workspaceKgCollection` after a
  shared-index cutover instead of retaining the legacy generic `life` name.
- **fix(cron): distinguish disabled heartbeat jobs from missing jobs.** The
  validation guard now uses `openclaw cron list --all` and reports an
  intentionally disabled job as a warning during a maintenance freeze.
- **feat(qmd): add explicit initial-backfill batches.** The coordinator accepts
  a registry-validated collection subset; `--initial-backfill` is rejected
  without that explicit scope and marks only the selected vectors dirty.

- **refactor(qmd): route bootstrap and watchdog diagnostics through the typed
  core.** Added narrow probe and collection-list operations plus a policy-bound
  synchronous diagnostic runner for existing synchronous callers. Initial setup
  now registers collections without running index maintenance; installer,
  bootstrap, and watchdog no longer create raw QMD subprocesses.
- **fix(qmd): make shared-index migration enter coordinated mode.** The
  migration proposal now switches workspace heartbeats to delegation after the
  raw-call cutover; the global coordinator remains disabled pending the
  separate embedding approval.

## 3.6.1 — 2026-08-07

- **refactor(qmd): centralize runtime maintenance ownership.** Bootstrap and
  session-end hooks no longer execute QMD. Workspace heartbeat uses the typed
  policy adapter in legacy/shadow mode and delegates without spawning QMD in
  coordinated mode. Added a manifest-validated global coordinator entrypoint
  for the single physical-index scheduler; routine maintenance still never
  uses `-f`.

## 2026-07-25

- feat(heartbeat): weekly rethink cadence (7-day gate + weekly-synthesis proximity check)
- feat(memory): BOILERPLATE_DENYLIST in memory-write.js — skip extraction artifacts before KG write
- feat(heartbeat): --apply-low-risk-proposals flag for rethink proposal audit trail
- refactor(heartbeat): replace isWeeklySynthesisRecent() with direct synthesis-tick check
- feat(rethink): proposals summary sent to main session via sessions_send (business language)
- feat(cron): add sessions_send to HEARTBEAT_TOOLS_ALLOW for rethink subagent

## 3.6.0 — 2026-08-07

- **feat(qmd): add privacy-safe global-index migration and provisioning.**
  Deployment topology stays in ignored local manifests. The migration planner
  is dry-run-first with hash-guarded config backup/rollback; named-index
  provisioning is idempotent, argv-safe, rejects collection drift, and never
  invokes `qmd update` or `qmd embed` automatically.

- **feat(qmd): add the disabled-by-default global maintenance coordinator
  core.** Trusted coordinator calls use explicit collection scope, while
  `update` remains index-wide. Atomic dirty generations, cross-process leases,
  stale recovery and failure-safe `update` → incremental `embed` coalesce
  writes without routine `-f`. Production call sites, scheduler and index
  topology are intentionally unchanged.

- **feat(cli): add the Bun-based Engram QMD CLI.** Added canonical workspace /
  physical-index resolution, argv-safe QMD execution, typed operation policy,
  read-only diagnostics, and controlled `search` / `query` / `vsearch` with
  mandatory collection scopes. JSON output uses stable result/error envelopes
  and exit-code semantics. Generic passthrough and public `update` / `embed`
  commands are intentionally absent.
- **feat(cli): add a safe launcher installer and architecture gate.**
  `scripts/install-cli.js` supports dry-run, idempotent install, version
  post-check, and ownership-safe uninstall in the Bun bin directory. The raw
  QMD audit freezes 27 reviewed legacy call sites until later migration PRs.
- **docs(cli): document install, protocol, rollout, and rollback.** Added the
  operator contract, trust boundary, canary procedure, four-heartbeat
  observation gate, and state-free rollback runbook.

- **fix(qmd): remove duplicate heartbeat maintenance.** The bootstrap QMD hook
  now skips cron, heartbeat, subagent, and ephemeral sessions, leaving Phase 4
  as the single `qmd update` owner for cron-driven Engram heartbeat. Interactive
  bootstrap freshness is unchanged. Heartbeat reports also avoid rewriting an
  unchanged daily note, preventing service-only index churn.
- **fix(cron): drain spawn queue before runner + use tools.exec.** Heartbeat
  cron payload now runs `spawn-claim` as Step 0 (stale queue) before
  `heartbeat-runner`, and again after the runner for this tick. Fail-fast on a
  long/backgrounded runner no longer leaves `hb-domains-write` queued forever.
  Payload calls `tools.exec` (allow-list), not `tools.shell_command`. Re-run
  `install-cron.js install` on each workspace to re-sync cron messages.
- **feat(extract): Domain-first KG policy.** By default, heartbeat extract
  writes to `life/` only for `main` and `meta-domain` sessions (e.g. General).
  Topic-thread / project / unbound chat sessions skip KG; durable memory is
  domain `decisions` / `status` / `changelog` via `hb-domains-write`. Watermark
  still advances so extract does not thrash. Override:
  `engram.json` → `extraction.kgPolicy` = `domain-first` | `all` | `main-only`.
- **fix(extract): rescans high-signal daily sections above EOF watermark.**
  `collectDailyCandidates` no longer starts at the physical line of
  `<!-- extracted:L… -->`. Agents write Events/Decisions/Learnings via
  `daily-note-append.js` above Heartbeat Report + watermark at EOF; the old
  cursor permanently produced `0 facts` while content existed (managers
  an unrelated synthetic project). Watermark remains a completion marker; idempotency is via
  `memory-write.js` dedup. Heartbeat Report / `## Next` stay non-candidates.
- **fix(domains): inline-noop peeks Decisions and Learnings, not only Events.**
  Decision-only topic days (empty Events) spawn `hb-domains-write`. Keyword
  gate against domain `decisions.md` applies only to Events-only notes so new
  topics are not suppressed by stale keywords.
- Fixed a heartbeat regression that merged `qmd.verticalAccess.collections`
  into every `qmd embed` invocation. `qmd.collections` is again the sole
  maintenance allowlist, so upper-level workspaces do not repeatedly embed
  child workspaces. Vertical vector auditing is now explicitly opt-in via
  `verticalAccess.checkEmbeddings: true`.
- Added opt-in `qmd.verticalAccess` checks to the built-in workspace watchdog.
  Hierarchical deployments can declare the complete expected external
  collection set and detect missing registrations, path drift, missing
  meta-domain references, and active documents without vectors
  (`WD-QMD-015`…`WD-QMD-020`). Flat deployments remain unchanged when the
  section is absent or disabled.

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

### Changed
- **qmd:** KG write, access tracking, schema repair, and cross-entity
  contradiction paths no longer launch raw QMD subprocesses. Successful writes
  only mark an owned collection dirty for the coordinator. The former
  cross-collection semantic/contradiction checks report an explicit deferred
  status until they can run through a controlled read path with trusted caller
  context; `--qmd-update` on `memory-repair.js` is retained as a deprecated
  compatibility flag and does not run maintenance.
- **qmd:** session/domain registration and pending-domain promotion now use the
  typed, argv-safe QMD collection provisioning core. They register explicit
  collection scope only and never launch `update` or `embed`.

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
