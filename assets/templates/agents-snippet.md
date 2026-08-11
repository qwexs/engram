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

Extraction watermark is always the **last line** of the file (completion marker). Session boundaries are **inline** in text. High-signal sections above the watermark are rescanned each extract; dedup skips already-written facts.

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

Before session closes:

1. **OLL Review** — scan the session for friction/surprise/pattern moments:
   - Did a tool/process fail and you recovered unexpectedly? → `memory-observe.js --category friction`
   - Did something unexpected happen? → `memory-observe.js --category surprise`
   - Did the same issue come up again? → `memory-observe.js --category pattern`
   - Nothing notable? → skip (don't force observations)
   - **Max 1-3 observations per session.** Scarcity enforces quality.

2. **Daily note summary** — write to today's daily note:
   - `## Active Threads` — open tasks with status
   - `## Learnings` — new insights
   - `## Next` — priorities for next session

3. Run `qmd update`.

> `<!-- session:end -->` marker is written automatically by the `engram-session-end` hook on `/new` or `/reset`.

### 12. Inline (Real-Time) Extraction

Extract HIGH-signal facts during conversation (don't wait for heartbeat):
- **HIGH** (preference, decision, correction, milestone, identity, instruction) → `memory-write.js` immediately
- **LOW** (context) → daily note only
- **NONE** (casual) → skip

```bash
bun scripts/memory-write.js \
  --entity "people/alice" \
  --fact "Prefers Bun over Node.js" \
  --description "Runtime preference affecting all new projects" \
  --category preference \
  --confidence 0.9 \
  --abstraction pattern \
  --tags "tools,runtime" \
  --source "YYYY-MM-DD" \
  --semantic-check \
  --check-contradictions
```

**`--check-contradictions`**: add for categories `preference`, `decision`, `correction`. Auto-creates tensions when Jaccard ≥0.5 + ≥3 common keywords. Skip for `milestone`, `status` (time-bounded facts rarely contradict).

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

Facts decay over time (Hot → Warm → Cold). The changed entity is rebuilt after a successful `memory-write`; a global sequential daily coordinator reconciles all workspaces, and Monday heartbeat synthesis remains an additional check. Cold facts are excluded from `summary.md` but remain in `items.json` (searchable via QMD).

**Access tracking** — when you use a fact from KG in a reply, queue a recency event:
```bash
bun scripts/memory-access-buffer.js --entity "people/alice" --id <fact-id>
```
The command is append-only and fast. The nightly sequential coordinator resolves
the event, updates `lastAccessed` and `accessCount`, then rebuilds summaries.
If no ID is available, use the exact fact text instead:
```bash
bun scripts/memory-access-buffer.js --entity "people/alice" --fact "Exact fact text"
```

**When to track access:**
- You looked up a fact via QMD and used it in your reply
- A fact was referenced in a decision or recommendation
- NOT for bulk reads (e.g. rebuild-summaries, heartbeat extraction)

After an actual use, queue one event per fact in the same turn. Do not invent an
ID: use the ID returned by KG/QMD, or the exact-text fallback. Merely loading a
summary or search result is not use. `memory-write.js --access` remains an
operator repair command, not the normal dialogue path.

**Decay tiers** (full rules: `skills/engram/references/decay-rules.md`):
- **Hot** (≤7 days) → prominent in summary
- **Warm** (8-30 days) → secondary in summary
- **Cold** (30+ days) → excluded from summary (principles always included)

### 15. OLL — Inline Observation Capture

Observations are the agent's self-reflection on friction, surprises, and recurring patterns.
**Only the agent writes observations** — subagents flag candidates, agent decides.

**Three categories:** `friction` (something slowed/blocked), `surprise` (expected X got Y), `pattern` (same issue recurring).

**Write when:**
- Tool/process failed AND you recovered in an unexpected way
- User corrected you on something you were confident about
- Something worked notably better/worse than expected
- Same friction occurred for the N-th time (pattern!)

**Do NOT write when:**
- Everything went as expected
- Task completed normally
- Domain status changed (that's domain status, not observation)

```bash
bun skills/engram/scripts/memory-observe.js \
  --observation "Extraction missed 3 facts in long message — chunking needed?" \
  --category friction \
  --description "Messages >400 words lose facts at extraction"
```

**Max 1-3 observations per session.** Scarcity enforces quality.

### 16. Deterministic Heartbeat Is Part Of Init

`init.js --with-cron` installs the deterministic heartbeat only. Workspace-side
OLL is created in `observe-only` with `nightly.enabled=false`; the single fleet
nightly scheduler and registry enrollment remain acknowledgement-gated.

```bash
bun skills/engram/scripts/init.js --with-cron
# OR explicitly
bun skills/engram/scripts/install-deterministic-heartbeat-cron.js \
  --workspace <workspace> --schedule '*/30 * * * *'
```

The installer is **idempotent** and emits no rethink/rethink2/autoresearch
admission flags. Managed adaptation is owned only by the nightly coordinator.

### 17. Phase 5.5 Spawn Queue Is Automatic

The heartbeat runner writes subagent spawn requests to `workspace/ops/heartbeat-spawns/*.json`. The cron agent drains the queue via `spawn-claim.js` **twice**: Step 0 (stale leftovers from a prior fail-fast tick) and Step 2 (this tick after the runner), then dispatches each request as a `sessions_spawn`. **You do NOT do this manually.** If a handoff appears in `workspace/heartbeat/inbox/`, it is processed by the next cron tick (or by you directly if interactive). Why: the runner is a Bun script with no LLM tool access and cannot call `sessions_spawn` on its own — splitting the claim out of the runner is what makes fire-and-forget spawning reliable.
<!-- engram:rules:end -->
