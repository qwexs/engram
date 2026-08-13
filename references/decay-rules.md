# Memory Decay Rules

## Recency Tiers

| Tier | Recency | In summary.md? | Notes |
|------|---------|-----------------|-------|
| **Hot** | Accessed in last 7 days | Yes (prominent) | Front-of-mind |
| **Warm** | Accessed 8-30 days ago | Yes (lower priority) | Available but secondary |
| **Cold** | Not accessed in 30+ days | No (omitted) | Still in items.json, searchable via QMD |

The v2 archive, its access counters, tiers, and summaries remain immutable.
Native v3 uses the same 7/30-day recency thresholds in a separate projection:
append-only `engram.kg-v3-access-event.v1` events are applied idempotently to
`memory-state/kg-v3/access/state.json`, then the daily coordinator rebuilds
`life/v3/current-summary.md` without changing canonical assertions.

## Modifiers

### Low-Confidence Acceleration (v2 only)
Frozen v2 facts with `confidence < 0.5` used a Cold threshold of **14 days**.
KG v3 assertions have no confidence field, so this modifier does not apply.

### Frequency Resistance
Facts with `accessCount >= 10` bump from Cold to Warm, regardless of recency.

### Kind-Aware Inclusion
- v3 `identity` and `constraint` — always include as stable context
- v3 `preference` and `decision` — include only when Hot or Warm
- frozen v2 `principle`/`pattern`/`episode` keep their historical behavior

## Summary Refresh Algorithm

Historical `summary.md` files are frozen materialized views of the v2 archive.
The active native projection is `life/v3/current-summary.md`.

The native v3 refresh algorithm is:

1. Load committed active assertions from `life/v3/assertions/`.
2. Apply pending access events once to the separate access-state overlay.
3. Calculate each tier from `lastAccessed`, falling back to `createdAt`.
4. Apply frequency resistance and kind-aware inclusion.
5. Sort Hot > Warm > Cold; within tier by `accessCount` descending.
6. Atomically replace `life/v3/current-summary.md` and mark KG QMD state dirty.
7. Rebuild `life/v3/search-index.md` from every active assertion so Cold
   content remains QMD-searchable without entering default prompt context.

If no assertion remains eligible, the refresh writes an explicit empty current
projection. It never leaves stale Hot/Warm content in place. Canonical active
assertions remain immutable and searchable through QMD.

## Tier Calculation

```
today = current date
daysSinceAccess = today - fact.lastAccessed

coldThreshold = 30

if daysSinceAccess <= 7:
    tier = "Hot"
elif daysSinceAccess <= coldThreshold:
    tier = "Warm"
else:
    tier = "Cold"

# Frequency resistance
if tier == "Cold" and fact.accessCount >= 10:
    tier = "Warm"
```

## Summary Inclusion Matrix

| KG v3 kind | Hot | Warm | Cold |
|-------------|-----|------|------|
| identity | ✅ | ✅ | ✅ |
| constraint | ✅ | ✅ | ✅ |
| preference | ✅ | ✅ | ❌ |
| decision | ✅ | ✅ | ❌ |
