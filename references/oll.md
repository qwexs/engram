# Operational Learning Loop (OLL)

> v3.5. System observes its own friction — what worked, what failed, what patterns emerged — and accumulates these observations for review.

## Storage Structure

```
workspace/ops/
├── observations/          # Operational observations
│   ├── index.json         # Registry of all observations
│   └── obs-0001.json      # Individual observation files
└── tensions/              # Contradictions between facts
    ├── index.json         # Registry of all tensions
    └── tension-0001.json  # Individual tension files
```

## Capturing Observations

Only the agent writes observations — subagents return `Flags:` in handoffs for the agent to review.

```bash
bun skills/engram/scripts/memory-observe.js --observation "KG extraction missed facts about email" --category friction
bun skills/engram/scripts/memory-observe.js --observation "..." --category surprise --description "Why this matters"
```

**Categories:** `friction` (weight ×3), `surprise` (weight ×2), `pattern` (weight ×1)

## Capturing Tensions

Tensions are auto-created when `memory-write.js --check-contradictions` finds Jaccard ≥0.5 + ≥3 common keywords. Manual creation:

```bash
bun skills/engram/scripts/memory-tension.js \
  --tension "Fact A contradicts fact B" \
  --fact1 "alice-001" --fact2 "alice-005" \
  --type factual \
  --confidence 0.8 \
  --description "Context about the contradiction"
```

**Types:** `factual` (default), `temporal`, `priority`

## Promoting or Archiving Observations

```bash
# Promote obs → KG fact (with backlink)
bun skills/engram/scripts/memory-promote.js \
  --obs-id obs-0002 --entity "projects/engram" \
  --fact "Extraction finds no facts in heartbeat-only daily notes" \
  --category context --confidence 0.8 --abstraction pattern \
  --tags "extraction,heartbeat" [--dry-run]

# Archive (noise, status report, resolved friction)
bun skills/engram/scripts/memory-promote.js --archive \
  --obs-id obs-0003 --reason "domain status report, not friction"
```

**Backlink:** promoted KG fact gets `source: obs-id`; obs file gets `kgFactId`.

## OLL Rethink Trigger (Heartbeat Phase 5 + Phase 5.5)

Phase 5 computes weighted score и решает, какой subagent spawn'ить:

| Subagent | Trigger condition | Phase |
|----------|-------------------|-------|
| `hb-rethink` | weighted≥15 OR pending tensions≥3 OR ≥14 days since last rethink | 5 (direct spawn) |
| `hb-rethink2` | hb-rethink returned alert OR weights не распустились | 5.5 (queued) |
| `hb-autoresearch` | после успешного rethink, для self-experiment PROPOSAL | 5.5 (queued) |

Phase 5 пытается direct spawn через `sessions_spawn`; если не получилось — ставит в очередь через `spawn-pump.js`. Phase 5.5 drain'ит queue через `spawn-claim.js`.

**Etalon default**: cron payload includes `--spawn-rethink --spawn-rethink2` so the OLL loop bootstraps end-to-end on fresh installs without manual seeding. Cost is zero on ticks where triggers don't fire because `maybeQueue` filters by `wouldRunRethink` / `wouldRunRethink2`.

`--force-rethink-once` is a one-shot escape hatch — bypasses `daysSinceRethink>=14` for a single run when the days gate isn't satisfied, queues hb-rethink anyway. Used during init / cold-start or for ad-hoc reviews.

## Auto-seed from Maintenance

When `validate.js` produces ≥1 `❌` error or `⚠️` warning AND no auto-seed fired in the last 24h (`lastAutoSeedAt` in `heartbeat-state.json`), `hb-runner` writes a low-confidence friction observation via `memory-observe.js`. This converts maintenance warnings into observation signal so the OLL loop has continuous input on quiet workspaces.

`hb-rethink` (model from `engram.json → models.heartbeat.subagents["hb-rethink"]`) reviews observations + tensions, identifies patterns, generates proposals, and returns a `HB-RETHINK HANDOFF` block. `process-handoff.js` auto-executes low-risk actions (archive noise, promote facts) and surfaces an ALERT.

## Resolving Tensions

```bash
# Resolved: one fact supersedes the other
bun skills/engram/scripts/memory-tension-resolve.js \
  --id tension-0001 --resolution "fact-abc superseded by fact-xyz"

# Dissolved: not actually contradictory
bun skills/engram/scripts/memory-tension-resolve.js \
  --id tension-0001 --dissolved \
  --resolution "facts are scope-dependent (work vs personal context)"
```

## Schemas

**Observation:**
```json
{
  "id": "obs-0001",
  "observation": "KG extraction missed facts about email",
  "category": "friction",
  "status": "pending | promoted | implemented | archived",
  "createdAt": "2026-02-25T12:00:00.000Z",
  "promotedAt": null,
  "archivedAt": null,
  "kgFactId": null,
  "accessCount": 0
}
```

**Tension:**
```json
{
  "id": "tension-0001",
  "tension": "Possible contradiction: ...",
  "type": "factual | temporal | priority",
  "confidence": 0.72,
  "fact1": "alice-001",
  "fact1Text": "Prefers Bun over Node.js",
  "fact2": "alice-005",
  "fact2Text": "Uses Node.js for all projects",
  "description": "Auto-detected (Jaccard 0.72, 4 common words)",
  "status": "pending | resolved | dissolved",
  "createdAt": "2026-03-03T15:00:00.000Z"
}
```

**index.json stats:**
```json
{
  "observations": ["obs-0001", ...],
  "lastId": 10,
  "stats": { "total": 10, "pending": 1, "promoted": 2, "implemented": 1, "archived": 6 }
}
```

For full OLL details, see [references/HEARTBEAT.md](HEARTBEAT.md) (Phase 5) and [references/HB-RETHINK.md](HB-RETHINK.md).