# hb-synthesis: Weekly Synthesis Subagent

Read this document, then execute the synthesis task below.

## Runtime Context (injected by orchestrator)

Life root: {{life_root}}
Now: {{now_iso}}
Session: {{session}}

## Task

Rewrite `summary.md` for all entities in the Knowledge Graph with memory decay applied.

### Algorithm

For each entity directory in `{{life_root}}`:

1. Read `items.json` — load all facts with `status: "active"`
2. For each fact, calculate decay tier:

```
daysSinceAccess = today - fact.lastAccessed (in days)

if fact.confidence < 0.5:
    coldThreshold = 14
else:
    coldThreshold = 30

if daysSinceAccess <= 7:       tier = "Hot"
elif daysSinceAccess <= coldThreshold: tier = "Warm"
else:                          tier = "Cold"

# Frequency resistance
if tier == "Cold" AND fact.accessCount >= 10:
    tier = "Warm"
```

3. Apply abstraction inclusion rules:

| Abstraction | Hot | Warm | Cold |
|-------------|-----|------|------|
| principle   | ✅  | ✅   | ✅  |
| pattern     | ✅  | ✅   | ❌  |
| episode     | ✅  | ✅   | ❌  |

4. Sort included facts: Hot first, then Warm; within tier by `accessCount` desc
5. Write new `summary.md`:
   - Title: entity name
   - Hot facts: prominent section
   - Warm facts: secondary section
   - Cold principles: always-included section (if any)
   - Total fact count and last-updated timestamp at bottom
6. Skip entities with 0 included facts (leave summary.md unchanged)

### Summary Format

```markdown
# {Entity Name}

{2-3 sentence overview synthesizing the Hot facts}

## Current (Hot)
- Fact 1 (confidence: 0.9)
- Fact 2 (confidence: 0.85)

## Background (Warm)
- Fact 3 (confidence: 0.7)

## Enduring (Principles)
- Fact 4 (confidence: 1.0, principle)

---
*{N} active facts, {M} included in summary. Updated {ISO date}.*
```

Write naturally — not just bullet lists. The overview paragraph should synthesize,
not enumerate. Keep it concise: max 30 lines per entity.

## Rules

1. Only rewrite `summary.md` — do NOT modify `items.json`
2. Do NOT update `lastAccessed` or `accessCount` — that's the reader's job
3. If `items.json` doesn't exist or is empty — skip entity silently
4. If ALL facts are Cold (and no principles) — leave `summary.md` unchanged
5. Preserve any `<!-- ... -->` comments at the end of existing summary.md
6. After all entities processed — run `qmd update` to re-index summaries
7. Do NOT update heartbeat-state.json — the orchestrator handles this
8. Do NOT read or write MEMORY.md, AGENTS.md, or any file outside this task

## Handoff (MUST be your LAST output)

Your response MUST end with this block. Fill in the values:

```
=== HB-SYNTHESIS HANDOFF ===
Status: {ok | error}
Summary: {one line, e.g. "synthesized 12 entities, 8 updated, 4 unchanged"}
Stats: {"entities_total": N, "entities_updated": N, "entities_unchanged": N, "facts_included": N, "facts_cold_excluded": N}
Observations: []
Alerts: {[] or ["alert text"]}
=== END ===
```
