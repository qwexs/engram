# Heartbeat Orchestrator

Read this document top to bottom and execute each phase sequentially.

> **ARCHITECTURE NOTE — Fire-and-Forget**
> `sessions_spawn` is asynchronous: it returns immediately and auto-announces via system message.
> **Never poll or wait for a spawned subagent in the same response turn.**
> The heartbeat run spawns subagents and returns `HEARTBEAT_OK` without waiting.
> Subagent results are processed separately via the **Handoff Handler** (see below).

---

## Phase 0: Fast Init
1. Read `memory/heartbeat-state.json`
2. If `heartbeatInProgress === true`:
   - If `heartbeatLockedAt` exists and age > 10 minutes: log "stale lock, auto-resetting", set `heartbeatInProgress = false`, continue
   - If `heartbeatLockedAt` missing: treat as stale (same reset)
   - Otherwise (age <= 10 min): write "heartbeat skipped — lock active", STOP
3. Set `heartbeatInProgress = true` and `heartbeatLockedAt` = current ISO timestamp, write state
4. Create daily note for current session if `lastDailyNoteCreated[session] != today`
   - Update `lastDailyNoteCreated[session]` to today, write state
5. Determine what to run:
   - Extraction: always (watermark handles incremental)
   - Synthesis: if Monday AND `lastWeeklySynthesis` != this week Monday
   - Domains: if `memory/domains/registry.json` exists
   - Maintenance: always (inline, synchronous)

## Phase 1: Extraction
- **Watermark sanity check:** read daily note, count lines. If last watermark `L{N}` has N > total_lines, reset watermark to `L1` (log "watermark reset: L{N} > {total_lines} lines")
- Read `subagentExtraction` from state
  - If `true`: spawn hb-extract subagent via `sessions_spawn` with daily note path and validated watermark position. **Do not wait — result arrives via system message.**
  - If `false`: run extraction inline
    - Read daily note from validated watermark (or L1 if none)
    - Extract facts via `bun scripts/memory-write.js`
    - Append watermark and update `lastExtraction[session]` + `subagentRuns.hb-extract` in state immediately

## Phase 2: Synthesis (Monday only)
- If NOT Monday OR `lastWeeklySynthesis` == this week Monday — skip
- Spawn hb-synthesis subagent. **Do not wait — result arrives via system message.**

## Phase 3: Domains
- If `memory/domains/registry.json` does not exist — skip
- Spawn hb-domains subagent. **Do not wait — result arrives via system message.**

## Phase 4: Maintenance (inline, synchronous)
1. Run `bun scripts/validate-kg.js --fix`
2. If any phase wrote to `life/` — run `qmd update`

## Phase 5: Report + Unlock
1. Write partial report to daily note with what was spawned/run inline:
   ```
   ## Heartbeat Report
   - **Extraction**: spawned (result pending) | ok (inline, N facts)
   - **Synthesis**: spawned (result pending) | skipped (not Monday)
   - **Domains**: spawned (result pending) | skipped (no registry)
   - **Maintenance**: ok — validate-kg.js: N errors
   ```
2. Set `heartbeatInProgress = false`, `heartbeatLockedAt = null`, write final state
3. Return `HEARTBEAT_OK` — **always, regardless of pending subagents**

---

## Handoff Handler

Triggered when a system message arrives with a completed subagent result.

**Detect:** incoming system message contains `=== HB-` and `HANDOFF ===` block.

**Execute:**

### hb-extract handoff
1. Parse handoff block (see Handoff Protocol below)
2. If Status: ok:
   - Read `new_watermark` from Stats (e.g. `"L247"`)
   - Append `<!-- extracted:{new_watermark}:{ISO timestamp} -->` to daily note (**orchestrator is the ONLY watermark writer**)
   - Update `lastExtraction[session]` to now, record in `subagentRuns.hb-extract`
3. If Status: error — set `subagentRuns.hb-extract.status` to failed, write warning to daily note
4. Update heartbeat report line in daily note: replace "spawned (result pending)" with actual summary
5. If non-empty Alerts — surface to user

### hb-synthesis handoff
1. Parse handoff block
2. If Status: ok — update `lastWeeklySynthesis` to today, record in `subagentRuns.hb-synthesis`
3. If Status: error — record failed in `subagentRuns`
4. Update heartbeat report line in daily note
5. If non-empty Alerts — surface to user

### hb-domains handoff
1. Parse handoff block
2. If Status: ok — update `lastDomainScan` to now, record in `subagentRuns.hb-domains`
3. If Status: error — record failed in `subagentRuns`
4. Update heartbeat report line in daily note
5. If non-empty Alerts — surface to user

---

## Handoff Protocol

Every subagent must end its response with a handoff block:
```
=== HB-EXTRACT HANDOFF ===
Status: ok
Summary: extracted 3 facts from 2026-02-21.md (L209->L247)
Stats: {"facts_written": 3, "new_watermark": "L247"}
Alerts: []
=== END ===
```
Fields: Status (ok | error | partial), Summary (one line), Stats (JSON), Alerts (list)

**Parsing:** Find the line starting with `=== HB-` and ending with `HANDOFF ===`. Find `=== END ===`. Parse each line between as `FieldName: value`.

## Error Handling
- No handoff block found in system message — set `subagentRuns[phase].status` to failed, write warning to daily note
- Status: error — record status and Summary in `subagentRuns`, do NOT update phase trackers (`lastExtraction`, `lastWeeklySynthesis`, `lastDomainScan`)
- NEVER abort the entire heartbeat because one phase failed
