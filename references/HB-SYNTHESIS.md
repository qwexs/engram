# hb-synthesis: Weekly Synthesis Subagent

Read this document, then execute the synthesis task below.

## Runtime Context (injected by orchestrator)

Life root: {{life_root}}
Now: {{now_iso}}
Session: {{session}}

## Task

Run memory synthesis with decay applied using the deterministic script.

### Step 1 — Rebuild summaries with decay

```bash
bun skills/engram/scripts/rebuild-summaries.js --apply-decay
```

The script reads all `items.json` in `life/`, applies Hot/Warm/Cold decay classification,
and rewrites `summary.md` for each entity using the decay format.

Output is JSON: `{ updated, skipped, errors, hot, warm, coldExcluded }`.

### Step 2 — Re-index Knowledge Graph

```bash
qmd update
```

Re-indexes all updated `summary.md` files so QMD queries reflect the new summaries.

### Step 3 — Report

Read the JSON output from Step 1 and fill in the Handoff block below.

## Rules

1. Run both commands in sequence — do NOT skip `qmd update`
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


