# hb-domains: Domain Status Subagent

Read this document, then execute the domain check task below.

## Runtime Context (injected by orchestrator)

Registry: {{registry_path}}
Domains root: {{domains_root}}
Now: {{now_iso}}

## Task

1. Read `{{registry_path}}` to get the list of domains
2. For each domain, perform the appropriate check (see below)
3. Collect observations as JSON objects: `{id, observation, category}` where category is friction/surprise/quality
4. Return the handoff block at the end (MUST be your last output)

## Domain Check Rules

### cron-task domains

For each `cron-task` domain:
1. Read `{{domains_root}}/{name}/status.md`
2. Look for `lastRun:` field — check if it's stale (> 2x the scheduled interval or > 7 days if interval unknown)
   - **Exception:** if status says "disabled" or "paused" — skip liveness check, note as observation with category "quality"
3. Read `{{domains_root}}/{name}/changelog.md` (last 20 lines)
4. Check for `PROPOSAL` keyword — if found, add to Alerts
5. Record observation with `{id, observation, category: "friction|quality|surprise"}`

### dev-project domains

For each `dev-project` domain:
1. Read `{{domains_root}}/{name}/status.md`
2. Note open/in-progress items
3. Read `{{domains_root}}/{name}/decisions.md` (last 20 lines)
4. Check for `PROPOSAL` keyword — if found, add to Alerts
5. Record observation with `{id, observation, category: "friction|quality|surprise"}`

## PROPOSAL Review

When a PROPOSAL is found in `changelog.md`:
1. Read the full PROPOSAL block (from `## YYYY-MM-DD — PROPOSAL` to next heading or EOF)
2. Assess risk:
   - **Low risk**: cosmetic changes, threshold tweaks, adding logging, documentation updates
   - **High risk**: new API endpoints, permission changes, data deletion, external service changes, architecture changes
3. Low-risk: add to Observations with `category: "quality"` and note "auto-approvable"
4. High-risk: add to **Alerts** — requires human decision
5. Include the PROPOSAL text in the alert for context

## Changelog Rotation Check

For each domain:
1. Count lines in `changelog.md`
2. If >1000 lines: run `bun scripts/rotate-notes.js --rotate --file <path> --type changelog`
3. Record rotation in Observations

## Rules

1. Read only `status.md`, `decisions.md`, `changelog.md` for each domain — do NOT read other files
2. If a file doesn't exist — add observation with category "friction", continue
3. Disabled cron-tasks are NOT alerts (they're intentionally paused)
4. Low-risk PROPOSALs are observations; high-risk PROPOSALs are alerts
5. Observations must be JSON objects: `{id, observation, category}` where category is friction/surprise/quality
6. Changelog rotation (>1000 lines) via `rotate-notes.js` — the ONLY write operation allowed
7. Do NOT update heartbeat-state.json — the orchestrator handles this

## Handoff (MUST be your LAST output)

Your response MUST end with this block. Fill in the values:

```
=== HB-DOMAINS HANDOFF ===
Status: {ok | error}
Summary: {one line, e.g. "checked 8 domains (4 dev-project, 4 cron-task), 0 alerts"}
Stats: {"checked": N, "dev_project": N, "cron_task": N, "alerts": N, "proposals": N}
Observations: [{id: "obs-0001", observation: "domain: liveness check passed", category: "quality"}, {id: "obs-0002", observation: "domain: proposal found in decisions.md", category: "friction"}]
Alerts: {[] or ["domain: alert text"]}
=== END ===
```
