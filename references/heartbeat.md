# Heartbeat Integration

## Flow (every 30 minutes)

```
0. Daily Note Creation + Three-Layer Rotation
1. Weekly Synthesis (Mondays only)
2. Knowledge Graph Extraction (if notes changed)
3. Memory Maintenance (every few days)
3.5. Domain Supervisor Scan (if domains exist)
4. QMD Index Update
```

### Step 0: Daily Note Creation

- Check `memory/heartbeat-state.json` → `lastDailyNoteCreated[session]`
- If today's date differs, create `memory/agent-{id}/{session}/YYYY-MM-DD.md`
- Update `lastDailyNoteCreated[session]` to today
- **Three-Layer Rotation**: If any daily note >1000 lines:
  1. **Archive** (full preservation): Move original to `archives/YYYY-MM/YYYY-MM-DD.md` — nothing is lost
  2. **Stub with summary** (smart compaction): Replace with:
     - Header: `# YYYY-MM-DD` + `(full version: archives/YYYY-MM/YYYY-MM-DD.md)`
     - Auto-generated summary (10-20 lines): decisions, results, status changes, new entities
     - Each item references archive line (`→ L42`) or KG entity (`→ life/projects/xxx`)
     - Skip facts already in Knowledge Graph (no duplication)
     - When in doubt, include (redundancy > loss)
  3. **QMD index** (granular access): Archive indexed for detail retrieval via `qmd query`
  - Run rotation AFTER KG Extraction to minimize stub duplication

### Step 1: Weekly Synthesis (Mondays)

**Trigger**: Monday AND synthesis not done this week (check `weekly-synthesis-tracker.json`)

For each entity in `life/`:
1. Load `status: "active"` facts from `items.json`
2. Classify: Hot (7d), Warm (8-30d), Cold (30+d)
3. Low-confidence acceleration: `confidence < 0.5` → Cold at 14d
4. Frequency resistance: `accessCount >= 10` bumps Cold → Warm
5. Abstraction-aware inclusion:
   - `principle` (L3) — always include
   - `pattern` (L2) — include if Warm or Hot
   - `episode` (L1) — standard decay
6. Rewrite `summary.md` with included facts
7. Update `weekly-synthesis-tracker.json`

### Step 2: Knowledge Graph Extraction

Scan recent daily notes for durable facts:

**What to extract:**
- New people mentioned (relationships)
- Project milestones or status changes
- Decisions made
- Preferences discovered
- Important context

**Extraction aggressiveness — err on the side of capturing more:**
- Any decision, preference, or opinion expressed → extract
- Any tool/workflow discovery → extract as pattern
- Any person mentioned with context → extract or update existing
- Any project status change, even minor → extract
- If unsure whether to extract → extract with lower confidence (0.5-0.7)

**How to extract:**
1. Read today's + yesterday's daily notes
   - **Watermark check**: Look for `<!-- extracted:L{N}:{timestamp} -->` at the end of each note. If found, parse only lines **after** the last watermark. If no watermark exists, parse the entire file (backward compatible). Multiple watermarks may exist — always use the last one.
2. For each durable fact:
   - Add to existing entity's `items.json` (or create new entity)
   - Set confidence using rubric
   - Set abstractionLevel (episode/pattern/principle)
   - Add tags
3. Update `summary.md` if new Hot facts added
4. Update `life/index.md` if new entities created

**Skip:** casual chat, transient requests, already-captured facts.

**After extraction, write a watermark** at the end of each processed daily note:
```
<!-- extracted:L{lastLine}:{ISO timestamp} -->
```
Example: `<!-- extracted:L47:2026-02-18T03:22:00Z -->`

This tells the next heartbeat where extraction left off. Only new content (appended after the watermark) will be parsed next time. Dedup in `memory-write.js` provides a safety net against duplicate facts.

**Important:** Only heartbeat extraction writes watermarks. Inline (real-time) extraction does NOT — it writes facts via `memory-write.js` as usual, and heartbeat will see those lines after its last watermark. Dedup prevents duplicates.

**Rotation edge case:** When a daily note is rotated (>1000 lines), the watermark moves to the archive with the original file. The new stub (10-20 lines) has no watermark — this is correct: the stub is parsed entirely on next heartbeat, which is cheap. No special handling needed.

### Step 2.5: KG Validation

After any writes to items.json, validate the Knowledge Graph:

```bash
bun scripts/validate.js --fix
```

This catches:
- Malformed JSON (parse errors from interrupted writes)
- BOM encoding (Windows/PowerShell artifact)
- Legacy format migration (bare array → v2 wrapper)
- Schema violations (missing fields, invalid values)

If unfixable errors found, log in daily note and alert user.

### Step 2.6: Group Preferences Extraction

Extract group interests/questions/pain-points from group daily notes into the group's KG entity. This feeds adaptive content pipelines.

**For each active group session:**

1. Read today's (and yesterday's) group daily note
   - Use watermark check same as main KG extraction
   - If no new content → skip
2. Look for group-relevant signals:
   - **interest** — topics members discuss or ask about
   - **question** — specific questions asked by members
   - **pain-point** — frustrations or problems expressed
   - **feedback** — reactions to content (what liked / what ignored)
3. Write via `memory-write.js`:
   ```bash
   bun scripts/memory-write.js \
     --entity "areas/groups/{group-entity}" \
     --fact "Members interested in topic X" \
     --category interest \
     --confidence 0.8 \
     --abstraction pattern \
     --tags "tag1,tag2" \
     --source "YYYY-MM-DD"
   ```
4. Write extraction watermark in group daily note
5. Update group entity's `summary.md`

Memory decay handles relevance automatically — Hot topics appear in summary, Cold ones drop.

### Step 3: Memory Maintenance

Periodically (every few days):
1. Review recent daily notes for insights worth keeping in MEMORY.md
2. Update MEMORY.md with distilled learnings
3. Remove outdated info from MEMORY.md
4. Check `life/index.md` freshness

### Step 3.5: Domain Supervisor Scan

Check subagent domains (`memory/domains/`). **Skip if the directory does not exist.**

#### 3.5.1 PROPOSAL Review

```bash
qmd query "PROPOSAL" -c domains
```

- If a PROPOSAL is found → evaluate:
  - **Low-risk** (add search direction, change format) → update `decisions.md` automatically
  - **High-risk** (change alert thresholds, remove checks) → notify the user
- After processing: add a changelog entry that the PROPOSAL was accepted/rejected

#### 3.5.2 Liveness Check

For each domain, read `status.md`:
- If the domain has `workflow.md` — optionally verify that listed scripts/paths are correct
- Check **last run** — if missed >2x the schedule → alert
- Check **result** — if error → alert

Schedules are specified in each domain's `decisions.md` or in heartbeat-state.json.

#### 3.5.3 Changelog Rotation

For each domain, check `changelog.md`:
- If >1000 lines → move to `archives/changelog-YYYY-MM.md`
- Create a new `changelog.md` with header + link to archives

#### 3.5.4 KG Extraction (optional)

```bash
qmd query "result OR milestone OR decision" -c domains
```

- Extract significant facts (milestone, pattern) into the Knowledge Graph (`life/`)
- Only if changelog changed since the last scan
- Skip routine entries ("metrics check, all OK")

### Step 4: QMD Index Update

At end of heartbeat:
```bash
qmd update    # BM25 index (instant)
qmd embed     # Vector embeddings (GPU/Jina, ~1-2s)
# Multi-collection searches available: qmd query "text" -c col1 -c col2
```

Run ONCE per heartbeat to reduce GPU load.

## Tracker Files

### heartbeat-state.json
```json
{
  "lastDailyNoteCreated": {
    "main": "2026-02-15",
    "telegram-XXXXXXXXXX": null
  },
  "lastChecks": {
    "email": null,
    "calendar": null,
    "weather": null
  },
  "lastDomainScan": null
}
```

### weekly-synthesis-tracker.json
```json
{
  "lastRun": "2026-02-09",
  "weekNumber": 6,
  "year": 2026,
  "executedAt": "2026-02-09T14:32:00Z",
  "results": {
    "entitiesProcessed": 11,
    "totalFacts": 65,
    "hotFacts": 65,
    "warmFacts": 0,
    "coldFacts": 0,
    "summariesUpdated": 0,
    "summariesAlreadyUpToDate": 11
  },
  "nextRun": "2026-02-16 (Monday, Week 7)"
}
```
