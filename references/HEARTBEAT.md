# Heartbeat Orchestrator

Read this document top to bottom and execute each phase sequentially.
**State mutations:** use `bun skills/engram/scripts/heartbeat-state.js --set <path> <value>` for all state writes (`true`/`false`/`null`/numbers/JSON all parsed correctly). Read via `--get-all`.

> **PR 2 CUTOVER BOUNDARY**
> When `engram.json → oll.scheduleOwner` is `nightly` or
> `memory-state/oll/legacy-admission-disabled.json` exists, Phases 5 and 5.5
> below are historical compatibility only: heartbeat cannot admit, claim, or
> apply `hb-rethink`, `hb-rethink2`, or `hb-autoresearch`. Their legacy state
> is removed from `heartbeat-state.json` and migrated to
> `memory-state/oll/state.json`. Nightly rethink itself remains disabled until
> the coordinator/canary rollout.

> **ARCHITECTURE NOTE — durable handoff, suppressed announce**
> `sessions_spawn` is asynchronous. The cron requester dispatches every claimed child and finishes
> without waiting. Each child writes its handoff to the exact absolute `handoffPath` injected in
> Runner Context. The spawn uses `expectsCompletionMessage=false`, so runtime does not register a
> completion announce; the child also returns `ANNOUNCE_SKIP` as a compatibility fallback. This
> intentionally suppresses completion announce
> because isolated cron runs are finalized before long-running children complete. The next runner
> tick applies the handoff idempotently and closes the spawn JSON lifecycle.

---

## Subagent Model Resolution

Each `sessions_spawn` call below says `model=<resolved via engram.json>`. The actual model is picked at spawn time by `scripts/config.js → resolveSubagentModel(workspace, phase)`, in this order:

1. `process.env.ENGRAM_MODEL_<PHASE_UPPER>` — explicit env override
2. `engram.json → models.heartbeat.subagents[phase]` — exact workspace phase mapping
3. selected deployment overlay → exact phase mapping
4. `engram.json → models.default` — grinding phases only
5. `engram.json → models.subagents_default` — legacy grinding-phase alias
6. `OSS_FALLBACK_MODEL = "sonnet-4-6"` — grinding phases only

**Known phases** (`HB_SUBAGENT_PHASES` in `config.js`): hb-synthesis,
hb-domains, hb-domains-write, hb-rethink, hb-rethink2, hb-autoresearch.

**Full-reasoning phases**: hb-synthesis, hb-rethink, hb-rethink2. They require an exact valid mapping and fail before dispatch instead of falling back to a cheap default.

**Helpers** exported from `scripts/config.js`:
- `getHbSubagentPhases()` → array of all 7 phases
- `isFullReasoningPhase(phase)` → boolean

Example `engram.json` override:
```json
{
  "models": {
    "default": "<your-default-model>",
    "subagents_default": "<your-default-model>",
    "heartbeat": {
      "orchestrator": "<your-cron-orchestrator-model>",
      "subagents": {
        "hb-synthesis": "<capable-model>"
      }
    }
  }
}
```

**On `init.js`:** fresh installs auto-detect the model from `openclaw.json → agents.defaults.model.primary` and inject it into the new `engram.json` template (`assets/templates/engram.json`, placeholders `{AGENT_ID}`, `{COLLECTION_NAME}`, `{MODEL_ID}`).

### Cron Orchestrator Model

The cron agent turn is configured independently from the subagents it spawns:

1. `ENGRAM_HEARTBEAT_ORCHESTRATOR_MODEL` — explicit environment override
2. `engram.json → models.heartbeat.orchestrator` — dedicated workspace setting
3. Unset — preserve the model of an existing cron job; for a new job omit `payload.model` so OpenClaw uses the agent's active/default model

`install-cron.js` never infers the orchestrator model from `models.default`, `models.subagents_default`, or `models.heartbeat.subagents.*`.

**Why this is configurable, not hardcoded:** Engram itself is model-agnostic — models are configured per-workspace in `engram.json` (see `models.default` and `models.heartbeat.subagents`). Hardcoding deployment-specific aliases (e.g. `m3`, `m2.7`) in the protocol would leak private infra and break for other users.

---

## Phase 0: Fast Init

1. Read `memory/heartbeat-state.json`
2. If `heartbeatInProgress === true`:
   - If `heartbeatLockedAt` exists and age > 10 minutes: log "stale lock, auto-resetting", `--set heartbeatInProgress false`, continue
   - If `heartbeatLockedAt` missing: treat as stale (same reset)
   - Otherwise (age <= 10 min): write "heartbeat skipped — lock active", STOP
3. Set lock: `--set heartbeatInProgress true` and `--set heartbeatLockedAt <ISO timestamp>`
4. Create daily note for current session if `lastDailyNoteCreated[session] != today`
   - `--set lastDailyNoteCreated.<session> <today>`
5. Determine what to run:
   - Rotation: always check (script determines if needed)
   - Cursor maintenance: always (no content classification or KG mutation)
   - Synthesis: if Monday and the current owner's weekly reconciliation
     watermark is not this week Monday (`heartbeat-state` before cutover,
     `memory-state/oll/state.json` after cutover)
   - Domains: if `domainsEnabled !== false` AND `memory/domains/registry.json` exists
   - Maintenance: always (inline, synchronous)

## Phase 0.5: Rotation Check (inline, synchronous)

Run BEFORE extraction — rotation must happen first so extraction works on the stub.

1. Check daily note size:
   ```bash
   bun skills/engram/scripts/rotate-notes.js --check --session <session>
   ```
2. If exit code 10 (needs rotation):
   a. Run extraction FIRST on the full file (Phase 1 inline or via subagent)
   b. Then rotate:
      ```bash
      bun skills/engram/scripts/rotate-notes.js --rotate --file <path> --type daily
      ```
   c. The stub contains a `<!-- STUB: ... -->` marker — record `needsStubSummary: true` for Phase 1.5
   d. Run `qmd update` to index the archive
3. If exit code 0 — continue to Phase 1

**Order matters:** Extract → Rotate → Index. Extracting from the stub would lose content.

## Phase 1: Cursor maintenance (automatic KG extraction retired)

Run `scripts/extract-runner.js` deterministically. It advances the daily-note
watermark and session cursor without classifying message bodies and without
writing to KG. The historical `HB-EXTRACT` handoff name remains temporarily as
a compatibility envelope for state and reporting.

Do not spawn an extraction subagent. Do not call `memory-write.js` from a
heartbeat. Durable KG v3 assertions are admitted only through the typed tool in
their trusted source turn.

## Phase 1.5: Stub Summary (if rotation happened)

Only runs if Phase 0.5 created a stub with `<!-- STUB: ... -->` marker.

This requires **cognitive work** (summarization) — the agent reads the archive and writes a 10-20 line summary into the stub. If running as haiku, spawn a subagent:

1. Read the archive file path from the stub's `<!-- Archive: ... -->` comment
2. Read the archive content
3. Write a 10-20 line summary covering:
   - Key events and decisions
   - Active threads at end of the day
   - Links to relevant KG entities
4. Replace the `<!-- STUB: ... -->` line with the summary
5. Run `qmd update` to re-index the stub

If the heartbeat model is too weak for summarization, defer to next interactive session.

## Phase 2: Synthesis (Monday only)

- If NOT Monday OR `lastWeeklySynthesis` == this week Monday — skip
- Build task from `skills/engram/references/HB-SYNTHESIS.md`:
  1. Read the file content
  2. Replace `{{life_root}}` with the absolute path to `life/`
  3. Replace `{{now_iso}}` with the current ISO timestamp
  4. Replace `{{session}}` with the current session key
  5. Call `sessions_spawn(task=<filled template>, label="hb-synthesis", model=<from engram.json>, cleanup="delete")`
  **Do not wait — result arrives via system message.**

## Phase 3: Domains

- If `domainsEnabled === false` in heartbeat-state.json — skip
- If `memory/domains/registry.json` does not exist — skip
- Build task from `skills/engram/references/HB-DOMAINS.md`:
  1. Read the file content
  2. Replace `{{registry_path}}` with the absolute path to `memory/domains/registry.json`
  3. Replace `{{domains_root}}` with the absolute path to `memory/domains`
  4. Replace `{{now_iso}}` with the current ISO timestamp
  5. Call `sessions_spawn(task=<filled template>, label="hb-domains", model="haiku", cleanup="delete", runTimeoutSeconds=600)`
  **Do not wait — result arrives via system message.**

## Phase 4: Maintenance (inline, synchronous)

1. Run `bun skills/engram/scripts/validate.js --fix`
2. Run `qmd update` (BM25 index — always, instant)
3. Run `qmd embed` (vector embeddings — updates since last run)
4. If any phase wrote to `life/` — already covered by steps 2-3

## Phase 5: OLL Check (inline, synchronous)

> **Legacy compatibility only.** Nightly-owned workspaces skip this phase
> before reading/scoring observations or tensions. The following algorithm is
> retained solely to migrate and diagnose a pre-cutover workspace.

1. Load `workspace/ops/observations/index.json` — collect pending obs IDs, read each file, count by category:
   - `friction_count` = pending obs where category === "friction"
   - `surprise_count` = pending obs where category === "surprise"
   - `pattern_count` = pending obs where category === "pattern" or "quality"

2. Load `workspace/ops/tensions/index.json` — count where status === "pending":
   - `tension_count` = pending tensions

3. Compute weighted score:
   ```
   weighted = friction_count * 3 + surprise_count * 2 + pattern_count * 1
   ```

4. Check time floor — read `heartbeat-state.json`:
   - `daysSinceRethink` = days since `lastRethink` (or 999 if never)

5. Check trigger conditions (any one):
   - `weighted >= 15`
   - `tension_count >= 3`
   - weekly cadence: `daysSinceRethink >= 7` AND `lastWeeklySynthesis` within the last 24h (rethink follows weekly synthesis)
   - `--force-rethink-once` bypasses the 7-day gate and synthesis proximity check

6. If trigger AND `rethinkInProgress !== true`:
   - Spawn hb-rethink subagent:
     ```
     sessions_spawn(task: HB-RETHINK.md with injected context, label: "hb-rethink", model: <from engram.json>, cleanup: "delete")
     ```
   - Set state:
     ```bash
     bun skills/engram/scripts/heartbeat-state.js --set rethinkInProgress true
     bun skills/engram/scripts/heartbeat-state.js --set rethinkStartedAt <ISO>
     ```
   - Surface in Phase 6 report: `"OLL rethink spawned (score: {weighted}, tensions: {tension_count})"`

7. If NOT triggered OR `rethinkInProgress === true`:
   - Surface counts in Phase 6 report: `"OLL: {weighted} score ({friction_count}f/{surprise_count}s/{pattern_count}p), {tension_count} tensions — below threshold"`
   - If `rethinkInProgress === true` AND age > 2h → auto-reset stale lock:
     ```bash
     bun skills/engram/scripts/heartbeat-state.js --set rethinkInProgress false
     bun skills/engram/scripts/heartbeat-state.js --set rethinkStartedAt null
     ```

## Phase 5.5: Autoresearch (after Rethink)

> **Note:** The `spawn-claim.js` step that drains the subagent-spawn queue is run by the cron agent itself (Step 2 of its payload), not by the heartbeat-runner. The runner enqueues requests to `workspace/ops/heartbeat-spawns/*.json`; the cron agent then claims and dispatches them. See the `Init` section at the bottom of this doc for how to provision this on a new agent.

Runs when there are approved experiments waiting to execute.

### Autoresearch Execution

1. **Check for pending experiments**:
   ```bash
   bun skills/engram/scripts/list-experiments.js --status pending --decision auto
   ```
   This returns experiments with `status: "pending"` AND `budget.decision: "auto"`.

2. **If experiments exist AND `autoresearchInProgress !== true`**:
   - Take the first pending+auto experiment (FIFO order by ID)
   - Read its spec from `workspace/research/EXP-{id}/spec.yaml`
   - Read `skills/engram/references/HB-AUTORESEARCH.md`
   - Replace template variables:
     - `{{experiment_id}}` → experiment ID
     - `{{date}}` → current date (YYYY-MM-DD)
     - `{{session}}` → current session key
     - `{{spec_yaml}}` → contents of spec.yaml
   - Spawn subagent:
     ```
     sessions_spawn(task: filled template, label: "hb-autoresearch", model: <from engram.json>, cleanup: "delete")
     ```
   - Update experiment status to "running":
     ```bash
     bun skills/engram/scripts/update-experiment.js --id {id} --status running
     ```
   - Set state:
     ```bash
     bun skills/engram/scripts/heartbeat-state.js --set autoresearchInProgress true
     bun skills/engram/scripts/heartbeat-state.js --set autoresearchStartedAt <ISO>
     bun skills/engram/scripts/heartbeat-state.js --set currentExperiment <id>
     ```
   - **Note**: Only ONE experiment per heartbeat cycle (avoid budget explosion)

3. **If `autoresearchInProgress === true` AND age > 30 min**:
   - Auto-reset stale lock
   - Mark experiment as failed:
     ```bash
     bun skills/engram/scripts/update-experiment.js --id {id} --status failed --summary "timeout"
     ```

4. **Surface in Phase 6 report**:
   - If spawned: `"Autoresearch: spawned EXP-{id}"`
   - If idle: `"Autoresearch: idle ({N} pending)"`

### Rethink₂: Post-Research Synthesis

After HB-AUTORESEARCH completes (detected via handoff), the orchestrator spawns Rethink₂:

1. Check `heartbeat-state.json` → `pendingRethink2` field
2. If set (contains experiment ID):
   - Read experiment report from `workspace/research/{id}/report.md`
   - Read experiment spec from `workspace/research/{id}/spec.yaml`
   - Read `skills/engram/references/HB-RETHINK2.md`
   - Replace template variables:
     - `{{experiment_id}}` → experiment ID
     - `{{date}}` → current date
     - `{{session}}` → current session
     - `{{report_content}}` → contents of report.md
     - `{{spec_yaml}}` → contents of spec.yaml
     - `{{delivery_config}}` → JSON.stringify(spec.delivery)
   - Spawn: `sessions_spawn(task: filled template, label: "hb-rethink2", model: <from engram.json>, cleanup: "delete")`
   - Clear flag: `--set pendingRethink2 null`
3. Do not wait — result arrives via handoff

### Morning Delivery Check

During Phase 5.5, also check delivery queue (only between 08:00-10:00 Moscow time):

1. Run: `bun skills/engram/scripts/deliver-research.js --dry-run`
2. If output contains pending deliveries AND current time is 08:00-10:00 MSK:
   - Run: `bun skills/engram/scripts/deliver-research.js`
   - Read stdout — each line is a JSON object with delivery instructions
   - Parse JSON and send via message tool to the specified chat_id
   - Surface as alert if actionable

## Phase 6: Report + Unlock

1. Write/update report via script (handles create-or-replace, no identical-content errors):
   ```bash
   bun skills/engram/scripts/heartbeat-report.js \
     --extraction "<spawned (result pending) | ok (inline, N facts)>" \
     --synthesis  "<spawned (result pending) | skipped (not Monday)>" \
     --domains    "<spawned (result pending) | skipped (no registry)>" \
     --maintenance "ok — validate: N errors, M warnings; qmd update+embed done"
   ```
   Omit any flag to preserve its current value from the existing section.
2. Release lock:
   ```bash
   bun skills/engram/scripts/heartbeat-state.js --set heartbeatInProgress false
   bun skills/engram/scripts/heartbeat-state.js --set heartbeatLockedAt null
   ```
3. Return `HEARTBEAT_OK` — **always, regardless of pending subagents**

---

## Handoff Handler

Triggered when a system message arrives with a completed subagent result.

**Detect:** incoming system message contains `=== HB-` and `HANDOFF ===` block.

**Execute — one command:**

1. Extract the full handoff block (from `=== HB-* HANDOFF ===` through `=== END ===`) from the system message
2. Pipe it to the script:
   ```bash
   printf '%s' "<handoff block>" | bun skills/engram/scripts/process-handoff.js --session <session> --date <YYYY-MM-DD>
   ```
3. Check exit code and stdout:
   - **0** + `[SILENT]` in output → **respond NO_REPLY** (nothing to surface)
   - **1** — script error; log the output to daily note → **respond NO_REPLY**
   - **2** + `[ALERT]` lines in output → surface ONLY the `[ALERT]` lines to user

> **🔴 CRITICAL RULE — NO CHAT LEAKAGE:**
> After processing a handoff, you MUST respond `NO_REPLY` unless `process-handoff.js`
> exits with code 2 AND stdout contains `[ALERT]` lines. This is non-negotiable.
> Do NOT summarize, narrate, or acknowledge the handoff result in chat.
> Do NOT forward subagent output, stats, or completion status to the user.
> The `[SILENT]` marker in stdout is your explicit signal: stay quiet.

> All state updates, watermark writes, observation processing, and report updates
> are handled by `process-handoff.js` automatically. No manual parsing required.

---

## Handoff Protocol

Every subagent must end its response with a handoff block:
```
=== HB-EXTRACT HANDOFF ===
Status: ok
Summary: extracted 3 facts from 2026-02-21.md (L209->L247)
Stats: {"facts_written": 3, "new_watermark": "L247"}
Flags: ["CANDIDATE_OBS: brief description of friction/surprise noticed"]
Alerts: []
=== END ===
```
Fields: Status (ok | error | partial), Summary (one line), Stats (JSON), Flags (string array — CANDIDATE_OBS only for real friction/surprise), Tensions (JSON array), Alerts (list)

## Error Handling

- `process-handoff.js` exit 1 — log output to daily note, continue
- Status: error — script sets `status: failed`, does NOT update phase trackers
- NEVER abort the entire heartbeat because one phase failed
- Rotation failure — log to daily note, continue without rotation
- `qmd embed` failure (GPU OOM) — log warning, continue (BM25 via `qmd update` still works)

## Init (one-time per workspace)

To provision a fresh workspace with deterministic heartbeat plus the disabled,
observe-only workspace-side OLL contract:

```bash
# After init.js:
bun skills/engram/scripts/install-deterministic-heartbeat-cron.js \
  --agent-id <id> --workspace <path> --schedule '*/30 * * * *'
# Or, do everything in one shot:
bun skills/engram/scripts/init.js --with-cron --agent-id <id>
```

This creates (or updates) a no-model script cron named
`Heartbeat (Engram deterministic) — <agent-id>`. It drains durable non-OLL
heartbeat spawn records and never schedules managed adaptation. The single
nightly OLL scheduler is a separate fleet-level, acknowledgement-gated install.

The installer:

- Detects the existing job by `--cron-name` (default `Heartbeat (Engram runner) — <agent-id>`)
- If the payload uses unique runtime labels and the durable-handoff/`expectsCompletionMessage=false` contract, prints `✅ already up to date` and exits 0
- If the payload is on an older form, calls `openclaw cron edit <id> --name … --message … --tools …` to patch the prose and allow-list. It preserves `agentId`, schedule, `sessionTarget`, delivery, and `sessionKey`.
- If no matching job exists, builds the full spec and calls `openclaw cron add …` with all flags (every 30m, optional model from `engram.json → models.heartbeat.orchestrator`, thinking medium, timeoutSeconds 900, lightContext true, no-deliver, isolated session)
- `--dry-run` prints the full spec JSON to stdout without invoking `openclaw` — useful for CI and for reviewing the spec before applying

Exit codes: `0` success, `1` openclaw error, `2` bad args, `3` openclaw not on PATH.

Use `--schedule` to pick a cadence: `30m` (default), `5m`, `1h`, or a cron expression (e.g. `*/15 * * * *`, Europe/Moscow tz).
