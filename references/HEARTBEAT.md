# Heartbeat Orchestrator

Read this document top to bottom and execute each phase sequentially.

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
   - Maintenance: always

## Phase 1: Extraction
- **Watermark sanity check:** read daily note, count lines. If last watermark `L{N}` has N > total_lines, reset watermark to `L1` (log "watermark reset: L{N} > {total_lines} lines")
- Read `subagentExtraction` from state
  - If `true`: spawn hb-extract subagent via `sessions_spawn`
    - Prompt includes: daily note path, validated watermark position
  - If `false`: run extraction inline
    - Read daily note from validated watermark (or L1 if none)
    - Extract facts via `bun scripts/memory-write.js`
    - Produce handoff block yourself (see Handoff Protocol below)
- Parse handoff from subagent response (see Handoff Protocol)
- If Status: ok:
  1. Read `new_watermark` from handoff Stats (e.g. "L247")
  2. Append `<!-- extracted:{new_watermark}:{ISO timestamp} -->` to daily note (orchestrator is the ONLY watermark writer)
  3. Update `lastExtraction[session]` to now, record in `subagentRuns.hb-extract`
- If no handoff or Status: error — set `subagentRuns.hb-extract.status` to failed, write warning to daily note, do NOT update `lastExtraction`, CONTINUE

## Phase 2: Synthesis (Monday only)
- If NOT Monday OR `lastWeeklySynthesis` == this week Monday — skip
- Spawn hb-synthesis subagent (runs after extraction to see fresh facts)
- Parse handoff for `=== HB-SYNTHESIS HANDOFF ===`
- If Status: ok — update `lastWeeklySynthesis` to today, record in `subagentRuns.hb-synthesis`
- If no handoff or Status: error — record failed in `subagentRuns`, do NOT update `lastWeeklySynthesis`, CONTINUE

## Phase 3: Domains
- If `memory/domains/registry.json` does not exist — skip
- Spawn hb-domains subagent
- Parse handoff for `=== HB-DOMAINS HANDOFF ===`
- If Status: ok — update `lastDomainScan` to now, record in `subagentRuns.hb-domains`
- If no handoff or Status: error — record failed, do NOT update `lastDomainScan`, CONTINUE

## Phase 4: Maintenance
1. Run `bun scripts/validate-kg.js --fix`
2. If any phase wrote to `life/` — run `qmd update` then `qmd embed`

## Phase 5: Report + Unlock
1. Collect Summary line from each phase that ran (from parsed handoffs)
2. Write report to daily note — for each phase, paste its Summary line:
   - `## Heartbeat Report` then one bullet per phase with status and summary
3. Set `heartbeatInProgress = false`, `heartbeatLockedAt = null`, write final state
4. If any phase had non-empty Alerts: return the alert text as final response
5. If no alerts: return `HEARTBEAT_OK` as final response (OpenClaw suppresses notification)

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

**Parsing:** In the subagent response, find the line that starts with `=== HB-` and ends with `HANDOFF ===`. Find the line `=== END ===`. Extract all lines between these two markers. Parse each line as `FieldName: value`.

## Error Handling
- No handoff block found — set `subagentRuns[phase].status` to failed, write warning to daily note, CONTINUE
- Status: error — record status and Summary in `subagentRuns`, do NOT update phase trackers (`lastExtraction`, `lastWeeklySynthesis`, `lastDomainScan`), CONTINUE
- NEVER abort the entire heartbeat because one phase failed
