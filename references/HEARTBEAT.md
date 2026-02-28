# Heartbeat Orchestrator

Read this document top to bottom and execute each phase sequentially.
**State mutations:** use `bun scripts/heartbeat-state.js --set <path> <value>` for all state writes (`true`/`false`/`null`/numbers/JSON all parsed correctly). Read via `--get-all`.

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
   bun scripts/rotate-notes.js --check --session <session>
   ```
2. If exit code 10 (needs rotation):
   a. Run extraction FIRST on the full file (Phase 1 inline or via subagent)
   b. Then rotate:
      ```bash
      bun scripts/rotate-notes.js --rotate --file <path> --type daily
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
    5. Call `sessions_spawn(task=<filled template>, label="hb-extract", model="sonnet-4-6", cleanup="delete")`
    **Do not wait — result arrives via system message.**
  - If `false`: run extraction inline
    - Read daily note from validated watermark (or L1 if none)
    - Extract facts via `bun scripts/memory-write.js`
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

1. Run `bun scripts/validate-kg.js --fix`
2. Run `qmd update` (BM25 index — always, instant)
3. Run `qmd embed` (vector embeddings — updates since last run)
4. If any phase wrote to `life/` — already covered by steps 2-3

## Phase 5: OLL Check (inline, synchronous)

1. Count pending observations: read `workspace/ops/observations/index.json`, count items where status === "pending"
2. Count pending tensions: read `workspace/ops/tensions/index.json`, count items where status === "pending"
3. If pending observations > 20 OR pending tensions > 5:
   - Set alert: `OLL threshold exceeded: {count} observations, {count} tensions`
   - Surface in Phase 6 report

## Phase 6: Report + Unlock

1. Write/update report via script (handles create-or-replace, no identical-content errors):
   ```bash
   bun scripts/heartbeat-report.js \
     --extraction "<spawned (result pending) | ok (inline, N facts)>" \
     --synthesis  "<spawned (result pending) | skipped (not Monday)>" \
     --domains    "<spawned (result pending) | skipped (no registry)>" \
     --maintenance "ok — validate-kg.js: N errors, M files; qmd update+embed done"
   ```
   Omit any flag to preserve its current value from the existing section.
2. Release lock:
   ```bash
   bun scripts/heartbeat-state.js --set heartbeatInProgress false
   bun scripts/heartbeat-state.js --set heartbeatLockedAt null
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
   printf '%s' "<handoff block>" | bun scripts/process-handoff.js --session <session> --date <YYYY-MM-DD>
   ```
3. Check exit code:
   - **0** — processed OK, nothing else needed
   - **1** — script error; log the output to daily note
   - **2** — alerts present; read `[ALERT]` lines from stdout and surface to user
4. Return `HEARTBEAT_OK` (or alert text if exit 2)

> **That's it.** All state updates, watermark writes, observation processing, and report updates
> are handled by `process-handoff.js` automatically. No manual parsing required.

---

## Handoff Protocol

Every subagent must end its response with a handoff block:
```
=== HB-EXTRACT HANDOFF ===
Status: ok
Summary: extracted 3 facts from 2026-02-21.md (L209->L247)
Stats: {"facts_written": 3, "new_watermark": "L247"}
Observations: [{"id": "obs-0001", "observation": "KG extraction missed facts about email", "category": "friction"}, {"id": "obs-0002", "observation": "Watermark logic handles edge cases well", "category": "quality"}]
Alerts: []
=== END ===
```
Fields: Status (ok | error | partial), Summary (one line), Stats (JSON), Observations (JSON array with id, observation, category), Alerts (list)

## Error Handling

- `process-handoff.js` exit 1 — log output to daily note, continue
- Status: error — script sets `status: failed`, does NOT update phase trackers
- NEVER abort the entire heartbeat because one phase failed
- Rotation failure — log to daily note, continue without rotation
- `qmd embed` failure (GPU OOM) — log warning, continue (BM25 via `qmd update` still works)
