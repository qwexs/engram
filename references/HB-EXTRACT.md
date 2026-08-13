# HB-EXTRACT — retired

The LLM extraction/promotion workflow was retired by the KG v3 cutover.

`scripts/extract-runner.js` now performs cursor maintenance only:

- it advances the daily-note watermark and the last processed session file;
- it does not read conversation bodies for durable-fact classification;
- it writes zero KG facts;
- it cannot be re-enabled by `engram.json` flags;
- it emits the historical `HB-EXTRACT` handoff shape only so existing
  heartbeat state/report consumers remain compatible during fleet rollout.

Canonical durable writes happen only through `engram_memory_save` or
`engram_memory_retract` inside an authorized trusted source turn. If typed
admission is unavailable or rejects an unregistered entity/predicate, do not
fall back to `memory-write.js`.
