# hb-synthesis: retired v2 workflow

The v2 summary synthesis workflow is retired after KG v3 fleet cutover. The v2
archive and `summary.md` projections are immutable; no synthesis command exists.

## Runtime Context (injected by orchestrator)

Life root: {{life_root}}
Now: {{now_iso}}
Session: {{session}}

## Task

Run memory synthesis with decay applied using the deterministic script.

### Step 1 — Verify the archive boundary

Run `bun skills/engram/scripts/kg-v3-zero-legacy-watchdog.ts`. Do not rebuild or
rewrite v2 projections.

### Step 2 — Re-index Knowledge Graph

```bash
qmd update
```

Re-indexes all updated `summary.md` files so QMD queries reflect the new summaries.

### Step 3 — Report

Read the JSON output from Step 1 and fill in the Handoff block below.

## Rules

1. Do not run v2 synthesis or summary rebuild commands
2. Do NOT modify `items.json` — script is read-only on facts
3. Do NOT update `lastAccessed` or `accessCount`
4. Do NOT update `heartbeat-state.json` — the orchestrator handles this
5. Do NOT read or write `MEMORY.md`, `AGENTS.md`, or any file outside this task
6. If the script exits with code 1 — report the error in Alerts, do not retry

## Handoff (MUST be your LAST output)

Your response MUST end with this block. Fill in the values:

```
=== HB-SYNTHESIS HANDOFF ===
Status: {ok | error}
Summary: {one line, e.g. "synthesized 12 entities, 8 updated, 4 unchanged"}
Stats: {"entities_total": N, "entities_updated": N, "entities_unchanged": N, "facts_hot": N, "facts_warm": N, "facts_cold_excluded": N}
Observations: []
Alerts: {[] or ["alert text"]}
=== END ===
```

