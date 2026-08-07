# Memory Decay Rules

## Recency Tiers

| Tier | Recency | In summary.md? | Notes |
|------|---------|-----------------|-------|
| **Hot** | Accessed in last 7 days | Yes (prominent) | Front-of-mind |
| **Warm** | Accessed 8-30 days ago | Yes (lower priority) | Available but secondary |
| **Cold** | Not accessed in 30+ days | No (omitted) | Still in items.json, searchable via QMD |

Conversation access is queued append-only during a reply. The daily sequential
summary coordinator flushes that queue before calculating tiers, so an access
recorded today affects the next nightly projection without adding QMD or summary
work to the user-facing turn.

## Modifiers

### Low-Confidence Acceleration
Facts with `confidence < 0.5` use a Cold threshold of **14 days** instead of 30.

### Frequency Resistance
Facts with `accessCount >= 10` bump from Cold to Warm, regardless of recency.

### Abstraction-Aware Inclusion
- `principle` (L3) — **always** include in summary regardless of tier
- `pattern` (L2) — include if Warm or Hot
- `episode` (L1) — standard decay rules (Hot + Warm only)

## Summary Refresh Algorithm

Summary is a materialized view of active facts. It is refreshed after each
successful `memory-write.js`, by one global sequential daily coordinator, and
during Monday heartbeat synthesis as a reconciliation/reporting path.

Every refresh uses the same algorithm:

1. For each entity in `life/`:
   - Load all facts with `status: "active"` from `items.json`
   - Calculate tier for each fact based on `lastAccessed`
   - Apply modifiers (low-confidence, frequency, abstraction)
2. Sort: Hot > Warm > Cold; within tier by `accessCount` desc
3. Write included facts into `summary.md`
4. Omit Cold episodes (they remain in items.json, searchable via QMD)
5. Update `heartbeat-state.json` → `lastWeeklySynthesis`

## Tier Calculation

```
today = current date
daysSinceAccess = today - fact.lastAccessed

if fact.confidence < 0.5:
    coldThreshold = 14
else:
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

| Abstraction | Hot | Warm | Cold |
|-------------|-----|------|------|
| principle | ✅ | ✅ | ✅ |
| pattern | ✅ | ✅ | ❌ |
| episode | ✅ | ✅ | ❌ |
