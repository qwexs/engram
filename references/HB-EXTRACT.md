# hb-extract: KG Extraction Subagent

Read this document, then execute the extraction task below.

## Runtime Context (injected by orchestrator)

Daily note: {{daily_note_path}}
Watermark: {{watermark}}
Session: {{session}}

## Task

1. Read the daily note file at the path above
2. Start reading from line {{watermark}} (e.g., L47 means start at line 47). If L1, read the entire file.
3. For each durable fact found, write it via memory-write.js (see CLI Reference below)
4. Count facts written and facts skipped (dedup)
5. Note the last line number you processed
6. Return the handoff block at the end (MUST be your last output)

## What to Extract

Durable facts -- things worth remembering across sessions:
- **relationship** -- people, connections between entities
- **milestone** -- project events, achievements, completions
- **status** -- current state of a project/task/person
- **preference** -- likes, dislikes, tool choices, workflow preferences
- **context** -- important background information
- **decision** -- explicit decisions made
- **correction** -- updates to previous facts (write new fact with correct info)

**Aggressiveness:** err on the side of capturing more. If unsure, extract with lower confidence (0.5-0.7).
**Skip:** casual chat, transient requests ("show me X"), facts already captured by dedup.

## Confidence Lookup Table

| Signal | Confidence |
|--------|-----------|
| User stated directly ("I prefer X") | 1.0 |
| Explicitly discussed, clear conclusion | 0.85 |
| Inferred from actions/context | 0.7 |
| Mentioned in passing | 0.5 |

## Abstraction Levels

- **episode** -- single event (default for most facts)
- **pattern** -- recurring behavior or preference
- **principle** -- enduring truth, core value

## memory-write.js CLI Reference

```bash
bun scripts/memory-write.js \
  --entity "areas/people/sergey" \
  --fact "Predpochtitaet Bun vmesto Node.js" \
  --description "Tool preference affecting project setup decisions" \
  --category preference \
  --confidence 0.9 \
  --abstraction pattern \
  --tags "tools,runtime" \
  --source "2026-02-22" \
  --entity-create \
  --semantic-check \
  --search-collections "life"
```

**Required flags:** --entity, --fact, --category, --confidence, --source
**Optional flags:** --abstraction (default: episode), --tags, --entity-create (creates entity dir if missing)
**--description:** Why this fact matters / how to find it later (max 150 chars). Enables richer BM25 search with vocabulary different from the fact itself. Use it — it's the discovery-first gate.
**Valid --category values:** relationship, milestone, status, preference, context, decision, correction
**--source:** use the daily note date (YYYY-MM-DD)

**Entity routing:** determine the entity path from fact content:
- People: `areas/people/{name}`
- Projects: `projects/{name}`
- Tools/tech: `areas/tools/{name}`
- If entity doesn't exist, use `--entity-create`

## Rules

1. Extract ALL durable facts from the daily note content after the watermark
2. Use the exact --category values listed above (no variations)
3. Use the confidence lookup table (no guessing)
4. Always use `--semantic-check --search-collections "life"` when calling memory-write.js — this catches near-duplicates (same fact, different wording) that content-hash dedup misses. Critical when watermark resets to L1 and the file is re-processed.
5. Do NOT write watermarks to the daily note -- the orchestrator handles this
6. Do NOT update heartbeat-state.json -- the orchestrator handles this
7. Do NOT read or write MEMORY.md, AGENTS.md, or any file outside the extraction task
8. If no extractable facts found, still return the handoff block with facts_written: 0

## Handoff (MUST be your LAST output)

Your response MUST end with this block. Fill in the values:

```
=== HB-EXTRACT HANDOFF ===
Status: {ok | error}
Summary: {one line, e.g. "extracted 3 facts from 2026-02-22.md (L47->L89)"}
Stats: {"facts_written": N, "facts_skipped_dedup": N, "new_watermark": "L{last_line_processed}"}
Observations: {[] or [{"id": "obs-NNNN", "observation": "text", "category": "friction|surprise|quality"}]}
Alerts: {[] or ["alert text"]}
=== END ===
```
