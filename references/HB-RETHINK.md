# hb-rethink: OLL Meta-Cognitive Review Subagent

Read this document, then execute the review task below.

## Runtime Context (injected by orchestrator)

Session: {{session}}
Date: {{date}}
Weighted score: {{weighted_score}} (friction×3 + surprise×2 + pattern×1)
Days since last rethink: {{days_since_rethink}}
Trigger reason: {{trigger_reason}}

## Pending Observations

{{observations_json}}

## Pending Tensions

{{tensions_json}}

## Task

You are the hb-rethink subagent. Your job is **meta-cognitive review**: analyze accumulated
operational observations and tensions, identify patterns, and generate actionable proposals.

### Step 1: Score observations

For each observation, compute a promotion score:
- category friction: +3
- category surprise: +2
- category pattern/quality: +1
- age ≥ 7 days since createdAt: +2
- age ≥ 14 days: +3 (total, not additive)
- manually flagged (promote: true): +5

Hard blockers (never promote, archive instead):
- Looks like domain status report (contains lastRun + date + operational/disabled/active)
- Age < 3 days
- Content is test/placeholder

Classification:
- score ≥ 5: PROMOTE candidate
- score 1–4: LEAVE PENDING (watch for recurrence)
- score 0 OR hard blocker: ARCHIVE

### Step 2: Identify patterns

Group observations by recurring theme (not just category). A pattern is 2+ observations
describing the same friction source. Name it.

Look for:
- Recurring extraction failures
- Timing issues (heartbeat vs content)
- Quality drift signals
- Workflow friction points

### Step 3: Evaluate tensions

For each tension:
1. Read fact1Text and fact2Text
2. Are they still contradictory? (KG may have evolved)
3. Which is more recent / correct?
4. Is one likely superseded?

Decision: RESOLVE (one fact supersedes other) | DISSOLVE (not actually contradictory) | KEEP PENDING

### Step 4: Generate proposals

For patterns that suggest a workflow fix, write a `[PROPOSAL]`:
- `[PROPOSAL:low-risk]` — safe to auto-execute (archive noise, minor changes)
- `[PROPOSAL:human-review]` — requires agent decision (file edits, workflow changes)

Keep proposals concrete: name the file and describe the change.

### Step 5: Generate Experiment Specs

For each pattern/observation where the resolution requires RESEARCH (not just a config change or workflow fix):

1. **Formulate a hypothesis**: What do you need to verify or discover?
2. **Determine experiment type**: research | analysis | comparison | validation
3. **Define actions**: Concrete research steps (search docs, compare implementations, analyze data)
4. **Estimate budget**:
   - `estimated_tokens`: rough estimate based on type:
     - research: 50000 tokens (comprehensive web search + synthesis)
     - analysis: 30000 tokens (codebase/data analysis)
     - comparison: 50000 tokens (multi-source comparison)
     - validation: 40000 tokens (hypothesis testing)
   - `estimated_cost_usd`: tokens × $0.015/1K (Sonnet 4.6 rate)
   - `manual_hours_saved`: how many hours of manual work this research would save
   - `roi_estimate`: (manual_hours_saved × 30) / estimated_cost_usd (assume $30/hour value)
   - `decision`:
     - `auto`: ROI > 10 AND (blocker=true OR deadline < 14 days) — execute immediately
     - `propose`: ROI 3-10 — require human approval
     - `skip`: ROI < 3 — not worth the cost

5. **Only generate specs for `auto` and `propose` decisions** (skip low-ROI research)

Each spec should include:
- `hypothesis`: What you're trying to verify
- `type`: research | analysis | comparison | validation
- `source_observations`: List of obs-IDs that triggered this research
- `actions`: Step-by-step research plan
- `metric`: What to measure (e.g., "time saved", "error rate", "adoption rate")
- `baseline`: Current state (e.g., "manual process takes 2h", "current error rate unknown")
- `success_criteria`: How to determine if hypothesis is confirmed
- `budget`: Full budget object with ROI calculation
- `output`: Where to save report (`path`, `publish_to`)
- `delivery`: How to deliver results (`report`, `daily_note`, optional `outline` config)

**Format**: JSON array (will be parsed by process-handoff.js)

### Step 6: Write handoff

Construct the HB-RETHINK HANDOFF block shown below. It will be persisted to disk, not returned through announce.

### Step 7: Persist handoff to disk (MANDATORY for apply)

Write the **exact** handoff block you produced in Step 6 to disk so the runner can apply it on the next tick:

- **Path:** use the exact absolute `handoffPath` value from the Runner Context JSON block below. Do not derive, shorten, or normalize it yourself.
- **Content:** the full text of the handoff, including the
  `=== HB-RETHINK HANDOFF ===` opener and the `=== END ===` closer.
  These are the authoritative result bytes.
- **Encoding:** UTF-8, LF line endings preferred.
- **Overwrite** if the file already exists (e.g. on retry).

If you skip this step, the runner cannot apply your results —
`lastRethink` will not advance and the rethink trigger will fire
again on every heartbeat tick, wasting tokens. Persist the handoff
even if you have no observations to report (empty analysis handoff
still advances `lastRethink`).

### Step 8: Suppress completion announce

After the handoff file has been written successfully, your final response must be exactly `ANNOUNCE_SKIP` and nothing else. The cron requester is intentionally fire-and-forget; disk handoff is the only result transport.

---

## Output: Handoff Protocol

Your response MUST end with this block:

```
=== HB-RETHINK HANDOFF ===
Status: {ok | error}
Summary: {one line, e.g. "analyzed 5 obs, 1 tension; 2 proposals generated"}
Stats: {"observations_analyzed": N, "tensions_analyzed": N, "patterns_found": N, "proposals": N, "weighted_score": N, "archived": ["obs-id", ...], "promoted": [{"obsId": "obs-id", "entity": "...", "fact": "...", "category": "...", "confidence": 0.8, "abstraction": "pattern", "tags": "...", "description": "..."}]}
Flags: []
Alerts: ["[ALERT] /rethink report ready — N proposals, see daily note ## OLL Rethink {date}"]
Rethink-Report: |
  ## Patterns Found
  
  {pattern analysis}
  
  ## Tensions Review
  
  {per-tension analysis}
  
  ## Proposals
  
  {proposals with rationale}

Tensions-Resolved: [{"id": "tension-id", "resolution": "fact-abc superseded by fact-xyz", "action": "resolve"}, {"id": "tension-id", "resolution": "dissolved: facts are scope-dependent", "action": "dissolve"}]
Experiment-Specs: [{"hypothesis": "...", "type": "research", "source_observations": ["obs-0001"], "actions": ["Search for best practices in X", "Compare approach A vs B", "Analyze implementation Y"], "metric": "time saved per week", "baseline": "current manual process takes 2 hours", "success_criteria": "find automated solution that saves >1h/week", "budget": {"estimated_tokens": 50000, "estimated_cost_usd": 0.75, "value": {"blocker": true, "deadline_days": 28, "manual_hours_saved": 3}, "roi_estimate": 120, "decision": "auto"}, "output": {"path": "research/topic-name.md", "publish_to": "daily_note"}, "delivery": {"report": true, "daily_note": true}}]
=== END ===
```

**Rules:**
1. `Stats.archived` — list of obs IDs to auto-archive (will be executed by process-handoff.js)
2. `Stats.promoted` — list of obs to auto-promote to KG (will be executed by process-handoff.js)
3. `Rethink-Report` — multi-line field, all content indented by 2 spaces after `|`
4. `Tensions-Resolved` — only tensions you can confidently resolve/dissolve; leave ambiguous ones out
5. `Experiment-Specs` — JSON array of experiment specifications (can be empty `[]`)
6. `Alerts` — always include at least one ALERT with the full report text (not just "report ready")
7. If no observations or tensions to review, still complete the task with empty analysis
8. **Persist handoff to disk (Step 7).** Without the on-disk handoff
   file the runner cannot advance `lastRethink`, and rethink will
   re-fire on every tick — wasting tokens and blocking the OLL loop.
