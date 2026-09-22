# Engram Context Delivery Owner — implementation design

**Status:** accepted Stage 1 design for OpenClaw `2026.9.4`; implementation is
still observe-only until the gates in this document pass.

## 1. Decision and evidence boundary

Engram will have one **read-only delivery owner** for KG v3, OLL active rules,
bound domain context, and exact-session working memory. It may read immutable
projections and configuration,
render one bounded envelope, and emit metadata-only receipts. It must not write
memory, projections, session state, configuration, or host state.

The owner is an ordinary OpenClaw feature plugin. For the installed
OpenClaw `2026.9.4`, its only prompt contribution is the typed plugin hook:

```ts
api.on("before_prompt_build", (event, ctx) => {
  const result = owner.prepare(event, ctx);
  return result.context ? { prependContext: result.context } : undefined;
});
```

It does not use external `agent:bootstrap`, mutate `event.messages` or
`context.bootstrapFiles`, invent a virtual bootstrap file, or register a second
prompt-contribution hook.

This corrects the rejected Stage 1A draft. The installed SDK has no
`before_agent_start` hook name. Its `PluginHookName` contains
`agent_turn_prepare` and `before_prompt_build`; the latter returns
`PluginHookBeforePromptBuildResult`, including `prependContext`, and is already
used by the live Engram KG plugin for Codex app-server turns. The exact model
input still requires rollout evidence; a type declaration is not delivery
proof.

### Confirmed evidence at design time

| scope | evidence | conclusion |
|---|---|---|
| main/direct | real Codex rollout exits 2 with `kg,oll` missing | legacy delivery missed this model input |
| topic | real Codex rollout exits 2 with `domain` missing | legacy delivery missed this model input |
| peer/group | no accepted rollout | unproven |
| utilization | no answer probe | unproven |

## 2. Typed host contract

The owner consumes only fields declared by `PluginHookBeforePromptBuildEvent`
and `PluginHookAgentContext` in the installed SDK.

```ts
type DeliveryHookInput = {
  event: { prompt: string; messages: unknown[] };
  ctx: {
    runId?: string;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    channel?: string;
    accountId?: string;
    chatId?: string;
    senderId?: string;
    channelContext?: unknown;
    trigger?: string;
    contextTokenBudget?: number;
    contextWindowSource?: "model" | "modelsConfig" | "agentContextTokens" | "default";
    contextWindowReferenceTokens?: number;
  };
};
```

The owner requires a non-empty `runId`, `agentId`, `sessionKey`, and absolute
`workspaceDir`. It requires the agent id encoded by the canonical session key
to equal `ctx.agentId`. The plugin obtains the expected workspace through the
public `api.runtime.agent.resolveAgentWorkspaceDir(config, agentId)` API and
requires its real path to equal `ctx.workspaceDir`; that workspace must contain
an `engram.json` whose workspace id matches the selected projections. Missing
or contradictory identity fails closed.

An explicit non-user `ctx.trigger` is rejected. Because the SDK declares this
field optional and some Gateway user-turn paths omit it, an absent trigger may
continue only after the canonical session, agent, channel, and workspace checks
all succeed; cron/subagent keys remain outside the accepted grammar.

`ctx.workspaceDir` is the host-provided workspace for the current run. The
owner does not invent a session-to-domain resolver. It may parse the
already-established Engram session-key grammar only to classify and
cross-check scope:

- `agent:<agentId>:main`
- `agent:<agentId>:telegram:direct:<actorId>`
- `agent:<agentId>:telegram:group:<chatId>`
- `agent:<agentId>:telegram:group:<chatId>:topic:<topicId>`

The parser returns `main | peer-direct | group-direct | topic-thread`. Direct
and group coordinates are cross-checked with typed channel context when those
fields are present. Topic identity is validated by its exact session key and
domain binding because Codex may expose a conversation reference with a suffix
as `ctx.chatId`; there is no separate typed `topicId`. User prompt text is never
an identity or authorization source.

`contextTokenBudget` is an effective total context-window value, not the
remaining capacity after history and tools. It can support a minimum-window
gate, but cannot replace the hard rendered-byte cap.

## 3. Deterministic authorization and source selection

Authorization is evaluated before source bodies are read. Each source uses its
existing Engram projection/registry and cannot widen another source.

| source | permitted scope | authorization |
|---|---|---|
| KG | `main`; trusted `peer-direct` when explicitly granted | KG v3 default-context and runtime grant projections; group/topic denied |
| OLL | any canonical scope with a matching active projection | OLL resolver; person rules denied in multi-person scopes |
| domain | exact bound `topic-thread`, `peer-direct`, or `group-direct` | domain registry exact binding; no main fallback |
| session | the current canonical session only | exact `memory/agent-<agentId>/<normalized-session>/`; no QMD or neighboring-session fallback |

A source is selected only if authorization succeeds and its artifact is valid,
fresh under its own contract, digestible, and within its individual cap.
Failures omit that source independently and never grant a fallback wider scope.

Stable presentation order is `OLL > domain > session > KG`: managed rules
first, scoped domain state second, exact-session continuity third, and durable
general memory last. This is rendering order, not semantic conflict resolution.

## 4. Snapshot and budgets

One `DeliverySnapshotV1` captures scope kind, observed time, policy digests,
source artifact digests, and host budget metadata before rendering. Adapters
must bind their read to a stable file digest or reject it as
`SNAPSHOT_UNAVAILABLE`.

Initial hard UTF-8 caps include markers and headings:

| cap | value |
|---|---:|
| total envelope | 24 KiB |
| KG | 12 KiB |
| OLL | 8 KiB |
| domain | 12 KiB |
| session | 8 KiB |

Blocks are never cut mid-record. The owner considers complete blocks in
precedence order and omits a block that exceeds either its source cap or the
remaining total cap. A configured minimum `contextTokenBudget` may make the
owner fail closed for small windows; no code may claim to know remaining
tokens.

The owner policy schema is `engram.context-delivery-owner-policy.v2`. Stage 2
added the exact `session` cap before any policy was installed; the unreleased
three-source v1 shape is rejected rather than silently reinterpreted.

## 5. Envelope, markers, and provenance

The owner returns exactly one deterministic envelope when at least one source
is selected:

```text
<!-- engram-context-delivery:v1 envelope=sha256:<64hex> policy=sha256:<64hex> -->
<!-- engram-context-source:oll:v1 digest=sha256:<64hex> -->
<!-- engram-bootstrap-context-hash:sha256:<64hex> -->
... complete OLL projection ...
<!-- engram-context-source:domain:v1 digest=sha256:<64hex> -->
<!-- engram-system-event-hash:<8hex> -->
... complete domain projection ...
<!-- engram-context-source:session:v1 digest=sha256:<64hex> -->
<!-- engram-session-context:v1 digest=sha256:<64hex> -->
... exact-session Active Threads, Next, recent Decisions and Events, or a completed rotated Summary fallback ...
<!-- engram-context-source:kg:v3-current digest=sha256:<64hex> -->
<!-- engram-kg-v3-current -->
... complete KG projection ...
```

The envelope digest covers canonical JSON containing schema, ordered selected
`{ source, artifactDigest, renderedBytes }`, policy digest, and scope kind. It
excludes raw identity, paths, and source text. Source-specific legacy markers
remain temporarily so the Stage 0 rollout inspector can verify continuity.

Markers prove presence, not source attribution or answer utilization. A
positive delivery gate requires both a matching metadata-only owner receipt and
exactly one envelope marker in serialized model input.

## 6. Idempotency and receipts

There is one owner plugin and one registered prompt-contribution hook. For a
given prompt build, the handler returns at most one envelope. It never combines
the same source twice.

Provider retries may invoke `before_prompt_build` again for the same run. The
owner must deterministically return the same envelope for the same
`(runId, snapshotDigest)`; it must not suppress the retry and accidentally
remove context from a rebuilt prompt. Receipt logging is deduplicated by that
key, while rollout tests assert exactly one envelope occurrence in each
individual serialized model input.

`DeliveryReceiptV1` contains only mode, scope digest, policy/source/envelope
digests, selected and omitted source reason codes, byte counts/caps, host budget
metadata, and timestamp. It contains no prompt, source body, raw session key,
sender id, or absolute path. Initial implementation may keep receipts in memory
and structured logs only; persistence needs a separate approved contract.

## 7. Modes and reason codes

| mode | behavior |
|---|---|
| `legacy` | plugin does not observe or inject; legacy hooks retain ownership |
| `shadow` | resolve, authorize, snapshot, budget, and receipt; return no context |
| `canary` | return context only for exact policy-selected canonical session keys |
| `active` | return context for all policy-authorized scopes |

Stable reasons include:

- `DELIVERED`, `OBSERVED_WOULD_DELIVER`, `CANARY_NOT_SELECTED`
- `SESSION_UNRESOLVED`, `WORKSPACE_MISMATCH`, `SCOPE_DENIED`
- `AUTH_DENIED`, `AMBIGUOUS_ACTOR`, `DOMAIN_UNBOUND`
- `SNAPSHOT_UNAVAILABLE`, `SOURCE_MISSING`, `SOURCE_INVALID`
- `BUDGET_SOURCE_CAP`, `BUDGET_TOTAL_CAP`, `HOST_CONTEXT_BUDGET_TOO_SMALL`
- `DUPLICATE_SOURCE`, `INTERNAL_ERROR`

Mode and canary scope come only from a versioned operator policy artifact. A
message cannot select delivery mode, source, scope, or budget.

## 8. Legacy cutover and rollback

Legacy external `agent:bootstrap` hooks remain installed during shadow, but all
Engram delivery paths read one versioned `delivery-owner-policy.json` before a
fresh run:

1. `legacy`: legacy hooks may inject; plugin is observe-only.
2. `shadow`: legacy hooks may inject; plugin computes receipts only.
3. `canary`: exact selected session keys are plugin-owned; legacy hooks return
   no Engram delivery for those keys before the plugin is enabled for them.
4. `active`: plugin owns all enabled scopes; legacy delivery is disabled only
   after every mandatory E2E gate passes.

The selector is implemented in Engram-owned hook/plugin code, not OpenClaw
host code. It is switched between fresh sessions; in-flight turns are not
claimed to change atomically. The policy has schema, revision, digest, mode,
exact canary selectors, and rollback target. Every reader validates the same
digest. The plugin fails closed on malformed state; legacy hooks deliberately
retain legacy ownership when the policy is missing, malformed, or cannot be
mapped to one canonical session. This cannot widen access beyond their existing
authorization and prevents a broken selector from dropping all context.

Rollback writes a previously validated `legacy` policy through the Engram
installer/rollout command, starts a fresh session, and proves legacy-owner
evidence. It does not rewrite prior prompts or delete context.

## 9. Implementation slices

1. **Pure contracts:** canonical scope cross-checker, policy parser/digest,
   source interfaces, renderer, marker and receipt schemas, unit tests.
2. **Read adapters:** KG/OLL/domain/session snapshot-bound adapters with authorization,
   precedence, and budget tests.
3. **Observe-only plugin shell:** one `before_prompt_build` registration,
   metadata-only receipt, compile/wiring test against installed SDK.
4. **Shadow gate:** compare prospective receipts with known projections; no
   prompt contribution.
5. **Canary:** add the shared Engram-owned selector, disable matching legacy
   delivery, run fresh-session matrix and rollback drill.
6. **Active:** expand only after all mandatory gates; keep rollback policy.

## 10. Acceptance matrix

Unit tests must cover malformed/mismatched identity, all scope kinds,
agent/workspace disagreement, allow/deny/ambiguous authorization, invalid or
changing source digests, exact ordering, all caps without truncation,
deterministic markers, retry determinism, receipt redaction, modes, and reason
codes.

Plugin wiring tests must compile against the pinned installed SDK and assert:

- exactly one `before_prompt_build` registration;
- no `agent:bootstrap`, bootstrap-file mutation, or second prompt hook;
- only `prependContext` is returned in canary/active;
- observe-only returns no prompt contribution;
- no write API is called.

The plugin manifest/config must explicitly admit conversation access and prompt
injection (`hooks.allowConversationAccess: true` and the supported
`allowPromptInjection` setting) before canary; presence in source is not proof
that the loaded generation has those capabilities.

Fresh-session E2E cases:

| scope | expected sources | mandatory proof |
|---|---|---|
| main | authorized KG + matching OLL + exact-session state | exact markers once; owner receipt agrees |
| trusted peer-direct | granted KG, matching OLL, exact domain if bound, exact-session state | marker/receipt agreement |
| topic-thread | bound domain + non-person OLL + exact-session state; no KG | positive domain/OLL/session and negative KG proof |
| group-direct | bound domain + non-person OLL + exact-session state; no KG | positive domain/OLL/session and negative KG proof |
| denied/unbound | no denied source | absence plus explicit denial receipt |

Every positive case inspects the actual Codex rollout before the first assistant
record. Retry and rebuild cases inspect each serialized model input for exactly
one envelope. Separate answer probes measure utilization; marker presence never
substitutes for them.

## 11. Remaining blockers before active mode

1. `before_prompt_build` must be proven on every target harness; current local
   evidence covers its type and existing Codex use, not the whole fleet.
2. Peer/group rollouts and utilization probes are still absent.
3. The exact legacy hooks must be wired to the shared Engram owner policy and
   exercised in a rollback drill.
4. The 24 KiB cap is a safety limit, not remaining-token proof; latency and
   prompt-pressure metrics must pass in canary.
5. No production activation occurs until the installed plugin digest, config
   read-back, fresh-session evidence, and rollback evidence agree.
