# Heartbeat Orchestrator

Read this document top to bottom and execute each phase sequentially.
**State mutations:** use `bun skills/engram/scripts/heartbeat-state.js --set <path> <value>` for all state writes (`true`/`false`/`null`/numbers/JSON all parsed correctly). Read via `--get-all`.

> **ARCHITECTURE NOTE — Fire-and-Forget**
> `sessions_spawn` is asynchronous: it returns immediately and auto-announces via system message.
> **Never poll or wait for a spawned subagent in the same response turn.**
> The heartbeat run spawns subagents and returns `HEARTBEAT_OK` without waiting.
> Subagent results are processed separately via the **Handoff Handler** (see below).

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
   - Extraction: always (watermark handles incremental)
   - Synthesis: if Monday AND `lastWeeklySynthesis` != this week Monday
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

## Phase 1: Extraction

- **Watermark sanity check:** read daily note, count lines. If last watermark `L{N}` has N > total_lines + 5, reset watermark to `L1` (log "watermark reset: L{N} > {total_lines} lines"). The +5 buffer tolerates minor drift from heartbeat-report.js rewrites (±1-2 lines). Only reset on true corruption (watermark far past end of file).
- Read `subagentExtraction` from state
  - If `true`: build task from `skills/engram/references/HB-EXTRACT.md`:
    1. Read the file content
    2. Replace `{{daily_note_path}}` with the absolute path to today's daily note
    3. Replace `{{watermark}}` with the validated watermark (e.g. `L7`)
    4. Replace `{{session}}` with the current session key (e.g. `main`)
    5. Replace `{{session_files_dir}}` with the absolute path to `memory/agent-main/<session>/sessions/`
    6. Replace `{{last_session_extracted}}` with `heartbeat-state.json` → `lastSessionExtracted.<session>`, or `none` if missing
    7. Call `sessions_spawn(task=<filled template>, label="hb-extract", model="sonnet-4-6", cleanup="delete")`
    **Do not wait — result arrives via system message.**
  - If `false`: run extraction inline
    - Read daily note from validated watermark (or L1 if none)
    - Extract facts via `bun skills/engram/scripts/memory-write.js`
    - Append watermark to daily note; `--set lastExtraction.<session> <ISO>`, `--set subagentRuns.hb-extract.status ok`

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
  5. Call `sessions_spawn(task=<filled template>, label="hb-synthesis", model="sonnet-4-6", cleanup="delete")`
  **Do not wait — result arrives via system message.**

## Phase 3: Domains

- If `domainsEnabled === false` in heartbeat-state.json — skip
- If `memory/domains/registry.json` does not exist — skip
- Build task from `skills/engram/references/HB-DOMAINS.md`:
  1. Read the file content
  2. Replace `{{registry_path}}` with the absolute path to `memory/domains/registry.json`
  3. Replace `{{domains_root}}` with the absolute path to `memory/domains`
  4. Replace `{{now_iso}}` with the current ISO timestamp
  5. Call `sessions_spawn(task=<filled template>, label="hb-domains", model="haiku", cleanup="delete")`
  **Do not wait — result arrives via system message.**

## Phase 4: Maintenance (inline, synchronous)

1. Run `bun skills/engram/scripts/validate.js --fix`
2. Run `qmd update` (BM25 index — always, instant)
3. Run `qmd embed` (vector embeddings — updates since last run)
4. If any phase wrote to `life/` — already covered by steps 2-3

## Phase 5: OLL Check (inline, synchronous)

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
   - `daysSinceRethink >= 14`

6. If trigger AND `rethinkInProgress !== true`:
   - Spawn hb-rethink subagent:
     ```
     sessions_spawn(task: HB-RETHINK.md with injected context, label: "hb-rethink", model: "sonnet-4-6", cleanup: "delete")
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
