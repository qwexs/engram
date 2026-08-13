# Long-Term Memory

> FROZEN — this file is a pointer, not a fact store. Do not edit it.
> Full contract: `skills/engram/SKILL.md`.

## Where memory lives

| Layer | Location | Write path |
|---|---|---|
| Knowledge Graph | `life/v3/` | `engram_memory_save` / `engram_memory_retract` in an authorized trusted source turn |
| Daily notes | `memory/` | `daily-note-append.js` |
| Domain memory | `memory/domains/` | domain workflow |
| Historical KG v2 | `life/**/items.json` | immutable, read-only |

Always use explicit `-c <collection>` flags for QMD retrieval.
