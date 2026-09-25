# JEV memory decision layer — research handoff

> Status: accepted research direction, not an implementation specification.
> Recorded: 2026-09-25.
> Scope: planning only; QMD, Engram runtime, decay policy, configuration, and production remain unchanged.
> Canonical Wiki artifact: `Исследовательский артефакт: Jev и System One Models как управляющий слой Engram`, path `/doc/issledovatelskij-artefakt-jev-i-system-one-models-kak-upravlyayushij-sloj-engram-0X9Jd7s0Bq`, sections 18–23.

## Decision

Do not begin by replacing QMD's Jina reranker or modifying QMD core.

Research JEV as a typed **memory decision layer inside Engram**, around the existing
Engram QMD read adapter:

```text
user query
  -> JEV retrieval planning
  -> deterministic Engram scope/authorization
  -> unchanged QMD retrieval
  -> JEV evidence adjudication
  -> deterministic Engram context policy
  -> context pack for the answering model
```

QMD remains the index, hybrid retriever, and candidate generator. Engram continues
to own collection allowlists, caller scope, provenance, decay projection, and context
delivery. JEV provides advisory typed judgments; it does not authorize collections,
mutate canonical memory, change lifecycle, or delete facts.

## What JEV is

JEV is TypeSafe's System One decision model. It evaluates a shared `state` against
typed, atomic questions and returns structured answers that application code can
use directly. It is not a text generator and is not a Jina-compatible cross-encoder.

Public API contract confirmed during research:

- endpoint: `POST https://api.typesafe.ai/v1/systemone`;
- authorization: bearer token;
- request envelope: `{ state, model, questions }`;
- production experiments should pin an exact model version, not a moving alias;
- available primitives:
  - `Noul`: probability that an atomic statement is true, from 0 to 1;
  - `Choice`: selected option plus option probabilities and confidence;
  - `Score`: ordered rubric result plus level probabilities and confidence;
- multiple questions over the same state are evaluated independently and in
  parallel; adding atomic questions is the intended composition mechanism;
- complex decisions should be decomposed into atomic questions and recombined by
  deterministic application code;
- official patterns include speculative fan-out, confidence-gated routing,
  composite scoring, and intent routing;
- the official rerank cookbook evaluates one query/candidate pair per request with
  a `Noul`, then sorts client-side. Treat that as a useful baseline, not the target
  Engram architecture;
- there is no public Jina/OpenAI-compatible `query + documents[] -> ranked[]`
  endpoint and no server-side `top_n` contract;
- the public service documents transient errors and retries, but Russian retrieval
  quality, score calibration across content lengths, bulk evaluation, latency at
  Engram shortlist sizes, retention/ZDR requirements, and pinned-version support
  still require validation.

Primary documentation used:

- <https://docs.typesafe.ai/introduction>
- <https://docs.typesafe.ai/primitives>
- <https://docs.typesafe.ai/confidence>
- <https://docs.typesafe.ai/patterns>
- <https://docs.typesafe.ai/patterns/composite-scoring>
- <https://docs.typesafe.ai/cookbooks/rerank_typesafe>
- <https://docs.typesafe.ai/cookbooks/hierarchical_classification>
- <https://docs.typesafe.ai/cookbooks/classification_using_confidence>
- <https://docs.typesafe.ai/api>

## Why this fits Engram

### Before retrieval: typed retrieval planning

JEV can classify the information need without generating an unconstrained plan:

- current state versus historical explanation;
- fact, decision, event, constraint, preference, rule, or status;
- exact-keyword, semantic, or mixed retrieval need;
- relevant entities, dates, and temporal constraints;
- whether one query is enough or bounded query fan-out is useful;
- whether insufficient information should trigger clarification or abstention.

The model may propose semantic search parameters. Engram must derive the effective
collections and permissions from trusted caller context and intersect every plan
with its existing allowlist.

### After retrieval: evidence adjudication

JEV can evaluate each result with several independent questions instead of reducing
the candidate immediately to one opaque relevance score. Candidate dimensions to
test include:

- direct support for the requested answer;
- entity and scope fit;
- exactness and specificity;
- temporal fit;
- currentness;
- historical value;
- contradiction or supersession risk;
- evidence sufficiency.

Engram, not the model, applies weights, thresholds, stable ordering, conflict rules,
byte limits, and abstention policy and produces a provenance-preserving context pack.

## Relationship to decay

Current KG v3 decay is deterministic and remains authoritative:

- hot: accessed within 7 days;
- warm: accessed within 8-30 days;
- cold: not accessed for more than 30 days;
- frequency resistance at access count 10;
- stable identity and constraint assertions remain in default context;
- cold decisions and preferences leave the current projection but stay searchable;
- canonical assertions and lifecycle are not changed by decay.

JEV should first provide **query-time semantic decay**. A cold assertion is not
globally bad: it may be irrelevant to a current-status question but essential to a
historical or causal question. After QMD retrieval, JEV can judge temporal fit,
currentness, historical value, and direct support. Deterministic Engram policy then
decides whether the assertion belongs in the context pack.

Possible later uses, all advisory until separately specified and validated:

- classify assertions as evergreen, volatile, episodic, deadline-bound, or
  historical anchors for projection review;
- classify authoritative utilization as direct, supporting, historical,
  incidental, or conflicting;
- generate review candidates when old memory may require a freshness check.

Do not let JEV refresh access counters yet. Engram currently lacks authoritative live
adapters proving exact retrieval and final host utilization. Model self-report is not
proof of use. Any future weighted access scheme depends on trusted retrieval and
utilization receipts.

## Proposed research contracts

These names are placeholders to make the next session concrete; schemas are not yet
approved.

### `RetrievalPlan`

Expected fields to investigate:

- intent and temporal intent;
- normalized entities and constraints;
- bounded query variants;
- requested retrieval modes;
- desired evidence properties;
- confidence and abstention reason;
- question-set and model version.

It must not carry authoritative collection scope or mutation authority.

### `EvidenceJudgment`

Expected fields to investigate:

- result identity and source provenance reference;
- atomic decision vector;
- probability distributions/confidence where available;
- temporal/currentness classification;
- evidence sufficiency;
- conflict/supersession-review signal;
- question-set and model version.

It must not mutate lifecycle, access state, or canonical assertions.

### `ContextPack`

Deterministic Engram output containing selected evidence, exact provenance, ordering,
reason codes, omitted-result reasons, byte budget, and an explicit sufficient / search
again / abstain decision.

## First experiment

Build a side-effect-free evaluation harness around the existing Engram QMD read API.
Do not change QMD, production configuration, context delivery, or decay thresholds.

Compare:

1. current QMD behavior;
2. JEV retrieval planning plus QMD;
3. QMD plus JEV evidence adjudication;
4. JEV planning plus QMD plus JEV adjudication.

The corpus must contain real Russian memory questions covering current state,
historical explanation, exact recall, conflicting evidence, insufficient evidence,
and Hot/Warm/Cold assertions.

Measure at minimum:

- retrieval recall at 5;
- utilization accuracy;
- current-state accuracy;
- historical recall;
- stale-result leakage;
- abstention accuracy;
- provenance coverage;
- unauthorized collection access (must remain zero);
- context bytes and irrelevant evidence rate;
- latency, request count, token use, and estimated cost;
- performance by query class and decay tier.

Use pinned model and question-set versions. Preserve raw typed decisions in evaluation
artifacts without logging secrets. The experiment is successful only if the richer
pipeline improves semantic correctness or context efficiency over current QMD, not
merely if it produces plausible scores.

## Questions for the next session

1. Where is the earliest trusted ingress that exposes the user's memory question and
   caller/session scope to an Engram-owned planner?
2. What host boundary can consume `ContextPack`, and how will exact selected evidence
   become a durable utilization receipt?
3. Which atomic questions generalize across main, personal, company, and project
   workspaces without leaking scope?
4. Should classification run once per query and candidate questions once per result,
   or can safe speculative fan-out reduce calls without candidate contamination?
5. How should question-set versions, pinned JEV model versions, and policy digests enter
   cache keys and provenance?
6. What latency and cost budget is acceptable for interactive memory retrieval?
7. Which existing recall-evaluator fixtures can be extended, and which new adjudicated
   Russian cases are required?
8. Which uncertainty thresholds trigger a second bounded retrieval pass, clarification,
   or abstention?

## Explicit non-goals for the next session

- replacing Jina inside QMD;
- modifying QMD core;
- permitting model-selected collections;
- changing KG lifecycle or deleting assertions;
- allowing JEV to refresh access counters without trusted utilization evidence;
- production rollout before a side-effect-free corpus evaluation and contract review.
