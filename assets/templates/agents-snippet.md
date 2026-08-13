<!-- engram:rules:start -->
## Engram Memory Rules

> Full docs: `skills/engram/SKILL.md` | References: `skills/engram/references/`

### 1. Session Isolation
Memory is isolated per session. Group chats **CANNOT** access `MEMORY.md` or `life/` (Knowledge Graph). Each session reads/writes only its own daily notes under `memory/agent-{id}/{session}/`.

### 2. Write Pipeline
**NEVER** write `items.json` directly. When KG v3 live ingress is enabled, use
only `engram_memory_save` / `engram_memory_retract` for one explicit durable
assertion from the current trusted turn. Do not fall back to the legacy writer
after typed admission rejects an intent.

The fleet rollout is complete. The compatibility writer is physically absent;
do not recreate it or bypass typed admission with direct file writes. Automatic
heartbeat or session promotion is retired in every workspace.

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
During heartbeats: rotate/maintain cursors → index maintenance. Heartbeat does
not extract or promote KG facts after the KG v3 cutover.

### 7. Watermark Namespacing
Two watermark types coexist in daily notes — **use distinct prefixes to avoid conflicts**:
- `<!-- extracted:L{N}:{ISO} -->` — written by heartbeat orchestrator only (marks extraction point)
- `<!-- session:start:{ISO} -->` / `<!-- session:end:{ISO} -->` — written by agent at session boundaries

The historical extraction watermark remains the **last line** of the file as a
cursor-maintenance marker. Session boundaries are **inline** in text. The
heartbeat does not rescan message bodies or deduplicate facts.

### 8. Three-Space Routing

Is this about the agent itself (identity, methodology)?
├── YES → **self**: MEMORY.md, SOUL.md, AGENTS.md
└── NO → Is this durable domain knowledge?
    ├── YES → **notes**: life/ (via typed KG v3 ingress when enabled)
    └── NO → **ops**: memory/ (daily notes, domains)

Content flows: ops → notes/self. Never reverse.

**Route via scripts, not guesswork:**
- `engram_memory_save` / `engram_memory_retract` → canonical typed KG v3 ingress
- Daily note append → stays in `memory/` (ops)
- MEMORY.md/SOUL.md edits → self space

**Failure modes (what breaks when you mix spaces):**
- Operational facts in `life/` → pollute KG search, waste context budget
- Session logs as KG facts → archival ops data becomes "durable knowledge", QMD noise
- Heartbeat status in `life/` → "extracted N facts" is NOT a durable fact

### 9. Content Routing

Durable content is admitted at its trusted source turn. Never promote stored
ops/session material into KG automatically.

- explicit durable assertion in a KG v3-enabled source turn → typed ingress
- unregistered assertion → daily/domain note; extend the registry separately
- session insight is personally significant → update MEMORY.md
- life/ fact is NEVER moved back to memory/ (ops)
- MEMORY.md content is NEVER demoted to daily notes

Direction is source turn → typed KG, or source turn → ops/self. No automatic
ops → KG replay.

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

### 12. Inline Typed Admission

Extract HIGH-signal facts during conversation (don't wait for heartbeat):
- **HIGH** (preference, decision, correction, milestone, identity, instruction) → typed KG v3 tool immediately when registered
- **LOW** (context) → daily note only
- **NONE** (casual) → skip

Rules: main/direct authorized scope only; at most one KG mutation per source
turn; never store operational progress, test output or a synthetic canary fact.
If entity or predicate is not registered, keep the intent in daily/domain
memory and change the registry through a reviewed release.

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

### 14. Legacy Archive Boundary

The v2 archive is immutable after the fleet cutover. No dialogue, heartbeat,
coordinator, repair, decay, access-tracking, or summary path may mutate it.
Native v3 access/decay tracking requires a separate reviewed contract.

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
