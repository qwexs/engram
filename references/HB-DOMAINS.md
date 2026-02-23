# hb-domains: Domain Status Subagent

Read this document, then execute the domain check task below.

## Runtime Context (injected by orchestrator)

Registry: {{registry_path}}
Domains root: {{domains_root}}
Now: {{now_iso}}

## Task

1. Read `{{registry_path}}` to get the list of domains
2. For each domain, perform the appropriate check (see below)
3. Collect alerts and observations
4. Return the handoff block at the end (MUST be your last output)

## Domain Check Rules

### cron-task domains

For each `cron-task` domain:
1. Read `{{domains_root}}/{name}/status.md`
2. Look for `lastRun:` field — check if it's stale (> 2x the scheduled interval or > 7 days if interval unknown)
   - **Exception:** if status says "disabled" or "paused" — skip liveness check, note as "disabled (expected)"
3. Read `{{domains_root}}/{name}/changelog.md` (last 20 lines)
4. Check for `PROPOSAL` keyword — if found, add to Alerts
5. Record result in Observations

### dev-project domains

For each `dev-project` domain:
1. Read `{{domains_root}}/{name}/status.md`
2. Note open/in-progress items
3. Read `{{domains_root}}/{name}/decisions.md` (last 20 lines)
4. Check for `PROPOSAL` keyword — if found, add to Alerts
5. Record result in Observations

## Rules

1. Read only `status.md`, `decisions.md`, `changelog.md` for each domain — do NOT read other files
2. If a file doesn't exist — note "missing {file}" in Observations, continue
3. Disabled cron-tasks are NOT alerts (they're intentionally paused)
4. PROPOSAL in any file IS an alert (requires human decision)
5. Do NOT modify any files — read-only task
6. Do NOT update heartbeat-state.json — the orchestrator handles this

## Handoff (MUST be your LAST output)

Your response MUST end with this block. Fill in the values:

```
=== HB-DOMAINS HANDOFF ===
Status: {ok | error}
Summary: {one line, e.g. "checked 8 domains (4 dev-project, 4 cron-task), 0 alerts"}
Stats: {"checked": N, "dev_project": N, "cron_task": N, "alerts": N, "proposals": N}
Alerts: {[] or ["domain: alert text"]}
Observations: {[] or ["domain: observation"]}
=== END ===
```
