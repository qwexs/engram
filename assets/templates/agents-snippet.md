<!-- engram:rules:start -->
## Engram Memory Rules

> Full docs: `skills/engram/SKILL.md` | References: `skills/engram/references/`

### 1. Session Isolation
Memory is isolated per session. Group chats **CANNOT** access `MEMORY.md` or `life/` (Knowledge Graph). Each session reads/writes only its own daily notes under `memory/agent-{id}/{session}/`.

### 2. Write Pipeline
**NEVER** write `items.json` directly. Always use:
```bash
bun scripts/memory-write.js --entity "..." --fact "..." --category ... --confidence ...
```
Direct writes bypass dedup, validation, and hash registration, causing schema mismatches. No exceptions — heartbeats, inline extraction, entity creation all go through the pipeline.

### 3. No-Deletion Rule
Facts are **NEVER** deleted. To correct or replace a fact, set `status: "superseded"` and link via `supersededBy`. Old facts remain in `items.json` forever.

### 4. QMD Collection Isolation
Always specify `-c <collection>` in QMD queries. Never query without a collection flag — it violates session boundaries.
```bash
qmd query "topic" -c openclaw-memory-agent-main-main
qmd query "topic" -c life
```

### 5. Daily Note Creation
Handled automatically by hooks:
- `engram-daily-note` (gateway:startup) — creates daily notes for all sessions
- `engram-session-start` (agent:bootstrap) — appends `<!-- session:start:{ISO} -->`
- `engram-session-end` (command:new/reset) — appends `<!-- session:end:{ISO} -->`

Paths: Main `memory/agent-{{AGENT_ID}}/main/YYYY-MM-DD.md`, Group `memory/agent-{{AGENT_ID}}/{platform}-{groupId}/YYYY-MM-DD.md`.

### 6. Heartbeat Order
During heartbeats: extract → rotate → embed. Rotating first loses unextracted facts.

### 7. Watermark Namespacing
Two watermark types coexist in daily notes — **use distinct prefixes to avoid conflicts**:
- `<!-- extracted:L{N}:{ISO} -->` — written by heartbeat orchestrator only (marks extraction point)
- `<!-- session:start:{ISO} -->` / `<!-- session:end:{ISO} -->` — written by agent at session boundaries

Extraction watermark is always the **last line** of the file. Session boundaries are **inline** in text.

### 8. Three-Space Routing

Is this about the agent itself (identity, methodology)?
├── YES → **self**: MEMORY.md, SOUL.md, AGENTS.md
└── NO → Is this durable domain knowledge?
    ├── YES → **notes**: life/ (via memory-write.js)
    └── NO → **ops**: memory/ (daily notes, domains)

Content flows: ops → notes/self. Never reverse.

**Route via scripts, not guesswork:**
- `bun scripts/memory-write.js` → writes to `life/` (notes)
- Daily note append → stays in `memory/` (ops)
- MEMORY.md/SOUL.md edits → self space

**Failure modes (what breaks when you mix spaces):**
- Operational facts in `life/` → pollute KG search, waste context budget
- Session logs as KG facts → archival ops data becomes "durable knowledge", QMD noise
- Heartbeat status in `life/` → "extracted N facts" is NOT a durable fact

### 9. Content Promotion

Content moves from ops → notes/self. Never the reverse.

- ops observation proves durable → promote to life/ via memory-write.js
- session insight is personally significant → update MEMORY.md
- life/ fact is NEVER moved back to memory/ (ops)
- MEMORY.md content is NEVER demoted to daily notes

Direction: ops → life/ or ops → self. One-way only.

### 10. Space Mixing — What Breaks

| Violation | Consequence |
|-----------|-------------|
| Writing ops data into life/ | QMD search returns session noise alongside durable facts |
| Writing domain knowledge into MEMORY.md | Agent identity file grows unbounded, Full Init slows down |
| Moving life/ facts back to memory/ | Facts lost on daily note rotation/archival |
| Writing agent identity into daily notes | Identity scattered across 50+ session files, inconsistent |

When unsure: default to ops (memory/daily note). If it proves durable, promote later.

### 11. Session-End Checklist

Before session closes, write to today's daily note:
- `## Active Threads` — open tasks with status
- `## Learnings` — new insights
- `## Next` — priorities for next session

> `<!-- session:end -->` marker is written automatically by the `engram-session-end` hook on `/new` or `/reset`.

Then run `qmd update`.

### 12. Inline (Real-Time) Extraction

Extract HIGH-signal facts during conversation (don't wait for heartbeat):
- **HIGH** (preference, decision, correction, milestone, identity, instruction) → `memory-write.js` immediately
- **LOW** (context) → daily note only
- **NONE** (casual) → skip

```bash
bun scripts/memory-write.js \
  --entity "people/sergey" \
  --fact "Prefers Bun over Node.js" \
  --description "Runtime preference affecting all new projects" \
  --category preference \
  --confidence 0.9 \
  --abstraction pattern \
  --tags "tools,runtime" \
  --source "YYYY-MM-DD" \
  --semantic-check
```

Rules: main session only, don't over-extract, when unsure → `confidence: 0.5-0.7` or skip to daily note.

### 13. Session Recording (Daily Notes)

Daily notes stay empty without explicit recording. Write to them **during** the session, not only at the end.

**Trigger rules** — record when:
- **Topic completed** — a task/discussion block finishes (every 5-10 messages)
- **Decision made** → `--section decisions`
- **Topic shift** — conversation moves to a new subject
- **Significant result** — something built, fixed, or discovered

```bash
bun scripts/daily-note-append.js --session {{SESSION_KEY}} --section events --text "Fixed 44 semantic duplicates in KG"
bun scripts/daily-note-append.js --session {{SESSION_KEY}} --section decisions --text "Jaccard ≥ 0.5 now blocks writes"
```

Rules: brief entries (1-2 lines), facts not feelings, record as you go.

### 14. Memory Decay & Access Tracking

Facts decay over time (Hot → Warm → Cold). Decay is applied weekly by `hb-synthesis` heartbeat subagent via `rebuild-summaries.js --apply-decay`. Cold facts are excluded from `summary.md` but remain in `items.json` (searchable via QMD).

**Access tracking** — when you read/use a fact from KG, bump its recency:
```bash
bun scripts/memory-write.js --access --entity "people/sergey" --id <fact-id>
```
This updates `lastAccessed` and `accessCount`, preventing useful facts from decaying to Cold.

**When to track access:**
- You looked up a fact via QMD and used it in your reply
- A fact was referenced in a decision or recommendation
- NOT for bulk reads (e.g. rebuild-summaries, heartbeat extraction)

**Decay tiers** (full rules: `skills/engram/references/decay-rules.md`):
- **Hot** (≤7 days) → prominent in summary
- **Warm** (8-30 days) → secondary in summary
- **Cold** (30+ days) → excluded from summary (principles always included)
<!-- engram:rules:end -->
