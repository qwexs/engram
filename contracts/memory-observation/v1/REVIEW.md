# PR0 contract and implementation-readiness review

Verdict: **architecture accepted / targeted PR0 rework verified / PR0 release
candidate / PR1 implementation gated**.

Independent critic and judge passes returned `TARGETED_REWORK`. The three
confirmed PR0 gaps are repaired and locally verified. The isolated repository
commit containing this pack is the PR0 release candidate; PR1 runtime work
remains gated by ordinary repository review and separate implementation
approval. No production runtime, scheduler, configuration, canonical memory,
background job, or rollout projection was changed by this work.

## Review scope

- This review covers the versioned schemas, registries, authority policies,
  derivation vectors, and synthetic fixtures in this contract pack.
- Independent critic and judge passes agreed on targeted PR0 rework rather
  than architecture redesign; the release and implementation gates remain.
- Deployment-specific evidence and operational read-back records are outside
  the public contract pack. This document does not authorize runtime rollout.

## Claim–evidence ledger

| PR0 requirement | Evidence | Status | Consequence |
|---|---|---|---|
| Trusted observation envelope | `observationJob` JSON Schema plus positive fixture | met | PR1 must mint it from runtime context only |
| Typed observation | class-bound payload/consumer conditions in schema | met | no generic `memory.write` destination exists |
| Typed sidecar/apply receipt | `applyReceipt.sourceProvenance` plus opaque entry-anchor join | met after rework | receipt preserves source turn, producer release, class, evidence refs and observation digest for its full 180-day lifetime |
| Append-only memory trace | stage/ref bindings and outcome verifier contract | met | raw content and self-assessed outcomes are rejected |
| Producer registry | closed registry with capability ceilings | met | observer has no canonical/rule/index mutation power |
| Class registry | exactly five classes, all advisory | met | unknown classes fail schema/registry admission |
| Separate authority/admission | executed authority/admission tests plus one policy per consumer | met after rework | exact stage/producer/authority/trusted-input and required-provenance checks pass; unknown versions fail closed |
| Daily/KG/OLL/QMD boundaries | disabled templates and explicit sole owners | met | enabling one consumer cannot enable another |
| Published derivations | stable SHA-256 control vectors for trace, source, observation, operation and event IDs | met after rework | prose formulas are now executable regression contracts |
| Positive/negative fixtures | schema, authority and admission tests | met | producer/digest/class/scope/policy-version/provenance/raw/outcome failures covered |
| Privacy/threat model | `THREAT-MODEL.md` | met | prohibited data and stop conditions are explicit |
| No runtime integration | no imports/config/plugin/scheduler changes | met | PR0 cannot produce downstream effects |
| Independent blocker review | separate critic and judge passes | met | verdict was `TARGETED_REWORK`; the three confirmed findings are repaired, but release and PR1 gates remain |

## Baseline findings

1. OpenClaw already derives a route-scoped stable `channel-user:v1` identity
   from provider, account, conversation, and message and carries it in host-only
   context. This is a reusable identity primitive, not a complete durable
   observation admission contract.
2. The current OLL daily compiler admits bullets by section/path and creates a
   fallback provenance root from statement text when none is supplied. Its
   authority registry proves session scope, not the bullet's producer. This is
   the exact downstream gap the typed sidecar must close before an observer
   daily canary.
3. KG v3 already has a separate typed explicit-intent writer. The PR0 policy
   keeps diagnostic durable-intent gaps outside that ingress, with no mutator.

## Closed decisions from SPEC §17

1. Storage root: `memory-state/memory-observation/v1/`.
2. Ownership: one workspace observation coordinator; separate consumer queues
   and sink-specific sole mutators.
3. Registry: versioned canonical JSON; JCS SHA-256 release digests pinned by
   producer reference and consumer policy.
4. Daily join: opaque `destinationEntryId` anchor plus typed receipt; missing or
   mismatched join fails closed.
5. Outcome authority: human adjudication or deterministic checks only.
6. Retention: evidence 72h; envelope/observation 30d; trace/receipt 180d;
   terminal diagnostics 90d; open diagnostics 30d.
7. Identity resolver: shared runtime/observation namespace, reusing semantics
   but not importing KG writer authority.
8. Durable-gap UI: absent from v1; report-only lifecycle.

## Ordered blockers before PR1

1. Review and publish the isolated PR0 release-candidate commit; pin no runtime
   digest before that review.
2. Approve a PR1 implementation plan naming the durable admission hook,
   coordinator trigger, purge trigger, crash checkpoints, capacity limits, and
   exact runtime repository target.
3. Keep every consumer disabled; PR1 may stop at envelope/ledger/trace shadow.

## Verification evidence

- `bun test tests/memory-observation-contracts-v1.test.ts` — 18 passed.
- Targeted OLL/KG/QMD boundary regression set — 57 passed.
- Full `bun test` suite — 1048 passed, 0 failed.
- `bun run typecheck` — passed.
- Personal-data lint over the changed contract/test files — passed.
