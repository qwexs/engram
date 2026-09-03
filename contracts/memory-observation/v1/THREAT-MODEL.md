# Memory Observation Layer v1 — privacy and threat model

## Protected assets

Canonical daily notes, KG v3 assertions, OLL candidates/rules, QMD index
generations, raw turn evidence, session/workspace isolation, producer identity,
policy state, and the append-only audit trace.

## Trust boundaries

1. **Runtime → envelope:** only a completed, persisted source turn may cross.
2. **Evidence store → evaluator:** bounded redacted evidence; no destination or
   tool authority crosses with it.
3. **Evaluator → observation ledger:** typed advisory output only.
4. **Observation → consumer:** authority and admission are independently read
   back immediately before any side effect.
5. **Canonical sink → QMD:** only a canonical reference plus digest crosses;
   raw evidence and observation text never become index sources.
6. **Telemetry → outcome:** model self-assessment is untrusted; outcome labels
   require a human or deterministic verifier.

## Threats and mandatory controls

| Threat | Control | Required negative evidence |
|---|---|---|
| Model forges workspace/session/producer | Runtime-stamped envelope; registry-pinned producer digest | forged scope or producer denied |
| Prompt injection selects a sink or tool | evaluator has no tools/destination field; class→consumer registry is closed | unknown class/target rejected |
| Markdown location becomes authority | typed sidecar join; missing/mismatched sidecar is deny | daily bullet without receipt yields no OLL input |
| Observer silently creates KG assertion | KG policy accepts only explicit-intent ingress | observer observation cannot satisfy KG input schema |
| Observer silently creates OLL candidate/rule | batch Decisions require anchor → canonical receipt → source provenance → versioned producer registry; the shipped policy remains disabled and the registry has empty exact-scope/policy allowlists | missing/mismatched receipt, producer, scope, evaluator policy, read-back, or rollout state yields zero candidate/rule |
| Raw transcript/tool result reaches QMD | QMD accepts canonical refs only; raw evidence policy is constant false | raw evidence schema rejected |
| Replay bypasses a kill switch | apply-time read-back and replay reauthorization | queued item denied after policy disable |
| Same identity hides changed evidence | stable identity plus digest conflict | changed digest returns `CONTENT_CONFLICT` |
| Sidecar diverges from Markdown | one journaled apply, opaque entry anchor, read-back digest | mismatch returns `PROVENANCE_UNRESOLVED` |
| Source observation expires before its receipt | receipt embeds bounded `sourceProvenance` (turn, producer release, class, evidence refs, observation digest) without raw evidence | receipt remains attributable after observation TTL purge |
| Cross-session join or retrieval | exact scope equality, not collection membership | adjacent session scope denied |
| Reply chains import unrelated conversation history | exact workspace/session/channel transport links, maximum five ancestor pairs, evidence-digest read-back | missing, cyclic, expired, or cross-session ancestry returns partial context or fails closed |
| Trace becomes a copy of user data | identifiers/digests/reason codes only | content fields and reasoning rejected by schema |
| Outcome label is self-asserted | verifier source restricted to human/deterministic check | outcome event with null/model verifier rejected |
| Evidence persists indefinitely | 72-hour max TTL and independent purge owner | purge works with no later user turn |
| One coordinator accumulates sink powers | per-consumer queues and sole mutators | coordinator has no canonical mutation capability |

## Sensitive data classes

Raw credentials, secrets, authentication headers, full tool outputs, attachment
bytes, private media, hidden reasoning, and cross-session transcript ranges are
prohibited. Tool outcomes are default-deny; a future allowlist must identify
the exact tool/result fields and deterministic redactor version. Redaction runs
before persistence and before any model call.

The v1 negative corpus covers authorization headers, JWT, Telegram bot tokens,
GitHub and AWS credentials, Slack tokens, PEM private keys, secret assignments,
and credentials embedded in connection URIs. The runtime projection also pins
the provider/model to the configured default agent; mismatch fails closed
before a completion call.

## Crash and recovery checkpoints

PR1 must test crashes after: envelope durable write, evidence durable write,
queue claim, observation write, consumer plan, canonical mutation, sidecar
write, and trace append. Recovery starts from persisted immutable artifacts,
never by reclassifying a mutable transcript. A canonical mutation without a
matching terminal receipt is reconciled by read-back and the stable operation
identity; it is not blindly repeated.

## Stop conditions

Any unauthorized mutation, cross-scope effect, raw-evidence indexing,
unresolved provenance accepted downstream, digest conflict treated as update,
or outcome accepted from model self-assessment stops the canary. Rollback
disables new apply; committed canonical records use their native
supersession/retraction lifecycle and are never destructively deleted.
