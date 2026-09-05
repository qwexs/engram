# Memory retrieval provenance

> Status: source/index contract implemented; live retrieval and final-host utilization adapters absent.

## Required chain

```text
canonical_applied
  → memory-index-handoff
  → qmd.index-generation / canonical_indexed
  → memory-retrieval-receipt / retrieved
  → memory-utilization-receipt / utilized
```

Every arrow preserves one `traceId`, exact workspace/session scope, canonical
reference and digest, producer release, and policy digest. The index receipt
also preserves the physical index key, exact collection/root, dirty generation,
and deterministic SQLite snapshot digest.

## Evidence rules

- A dirty mark proves only that maintenance is owed.
- `canonical_indexed` requires completed update and embed generations plus an
  exact SQLite read-back of the collection root, document path, entry anchor,
  and canonical digest. After physical-index rotation, unrelated generation
  counters are not reused: the new index must also contain the exact vector row.
- A future `retrieved` writer requires both a stored index-generation
  predecessor and a durable QMD operation/result artifact containing the exact
  ranked hit. A caller-supplied rank or opaque digest is insufficient.
- A future `utilized` writer requires a host-owned final-selection callback
  containing the exact retrieval receipt IDs. Retrieval alone is not
  utilization, and copying a public producer identifier is not authority.
- Model self-report, response citations, substring search in the prompt, and a
  generic `llm_input` event are not sufficient proof of selection.

## Implemented, enabled, observed

| Stage | Implemented | Live enabled | Live observed |
|---|---|---|---|
| index handoff | yes | follows exact-session QMD binding | not claimed by this change |
| canonical indexed | yes, coordinator reconciliation | source code wired | not claimed by this change |
| retrieved | reserved strict schema only; absent rule/admission denies | no authoritative QMD result adapter | no |
| utilized | reserved strict schema only; absent rule/admission denies | no selected-reference host hook | no |

The installed OpenClaw surfaces do not expose a durable exact ranked-result
artifact, and the final `llm_input` hook does not expose which memory references
the host selected. Until OpenClaw adds those predecessors, or separately
reviewed adapters own retrieval plus final selection, both live stages remain
rollout blockers. No production receipt writer is shipped in this change. A
future adapter must pass receipt IDs directly; it must not send raw prompt
content, accept caller-supplied rank as proof, or let the model attest its use.

Apply receipts, index handoffs, and index-generation receipts use dependency-
aware retention: an older predecessor is retained while its newer dependent is
inside the 180-day audit window. Coordinator reconciliation failures make the
maintenance process fail so scheduler alerting cannot report a false success.
