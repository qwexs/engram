# Heartbeat Flow

> v3.5. 10-фазный оркестратор. LLM-фазы (1, 2, 3, 3.5) spawn'ят subagent'ов; механические фазы выполняются inline в `heartbeat-runner.js`.

PR 2 introduces a dual-read migration boundary. Legacy workspaces may still
execute the compatibility OLL phases. A workspace with
`oll.scheduleOwner=nightly` (or the durable cutover marker) keeps unrelated
heartbeat work but rejects all heartbeat-owned rethink/rethink2/autoresearch
dispatch and application. Nightly execution is not enabled by this boundary.

## Phase Table

| Phase | Kind | Назначение | Где |
|-------|------|-----------|-----|
| 0 | inline | Fast Init: read state, lock, check what to run | `heartbeat-runner.js` |
| 0.5 | inline | Rotation Check: daily notes >1000 lines → rotate | `rotate-notes.js` |
| 1 | subagent | Extraction: hb-extract (daily note → KG) | `extract-runner.js` |
| 1.5 | inline | Stub Summary: summarize rotated archive into stub | `heartbeat-runner.js` |
| 2 | legacy-only subagent | Synthesis: hb-synthesis (weekly summary, Mon only) | spawn `hb-synthesis` |
| 3 | subagent | Domains Status: hb-domains (check status of all domains) | spawn `hb-domains` |
| 3.5 | subagent | Domains Write: hb-domains-write (apply pending changelog writes) | spawn `hb-domains-write` |
| 4 | inline | Maintenance: `validate-kg.js --fix` → `qmd update` → `qmd embed` | `heartbeat-runner.js` |
| 5 | legacy-only inline | OLL Check: weighted scoring + rethink/autoresearch triggers | `heartbeat-runner.js` |
| 5.5 | legacy-only inline | OLL Spawn Queue: `spawn-pump.js` + `spawn-claim.js` (queued subagents) | `spawn-pump.js`, `spawn-claim.js` |
| 6 | inline | Report + Unlock: `heartbeat-report.js` → release lock → HEARTBEAT_OK | `heartbeat-report.js` |

## Heartbeat Flow (every 30 minutes)

```
0. Fast Init (state, lock, what to run) — heartbeat-runner.js
0.5. Three-Layer Rotation check (daily note >1000 lines) — rotate-notes.js
1. Knowledge Graph Extraction (if notes changed) — hb-extract subagent
1.5. Stub Summary (rotated archives) — inline
2. Legacy-only: Monday? → Weekly Synthesis — hb-synthesis (Mon only)
3. Domain Status check — hb-domains (if domains exist)
3.5. Domain Apply Phase — hb-domains-write (every tick)
4. Memory Maintenance (every few days) — validate-kg.js → qmd update → qmd embed
5. Legacy-only OLL Check (weighted scoring, rethink triggers)
5.5. Legacy-only OLL Spawn Queue — spawn-pump + spawn-claim (queued subagents)
6. Heartbeat Report + unlock — heartbeat-report.js → HEARTBEAT_OK
```

## Weekly Synthesis (Mondays)

Rewrites `summary.md` with memory decay applied:
- **Hot** (7 days) — prominent in summary
- **Warm** (8-30 days) — lower priority
- **Cold** (30+ days) — omitted from summary (stays in items.json)

Modifiers:
- `confidence < 0.5` → Cold threshold is 14 days
- `accessCount >= 10` → bumps Cold to Warm
- `principle` (L3) → always in summary
- `pattern` (L2) → in summary if Warm+

For full decay rules, see [references/decay-rules.md](decay-rules.md).

## Knowledge Graph Extraction

During heartbeats, scan daily notes for durable facts:
- **Watermark-based incremental parsing**: Check for `<!-- extracted:L{N}:{timestamp} -->` at the end of each daily note. If found, only parse lines after the last watermark. No watermark = parse entire file (backward compatible).
- Relationships, milestones, status changes, decisions, preferences
- Write to entity `items.json` with confidence and abstraction level
- Update `summary.md` for new Hot facts
- Create new entities when creation rules are met
- **After extraction**, append watermark: `<!-- extracted:L{lastLine}:{ISO timestamp} -->`
- **Only heartbeat writes watermarks** — inline extraction does NOT (dedup handles overlap)
- **After rotation**, watermark moves to archive with the original file; the stub has no watermark and is parsed entirely (cheap, 10-20 lines)
- Skip casual chat and transient requests

For the complete heartbeat flow, see [references/HEARTBEAT.md](HEARTBEAT.md).

## Heartbeat cron provisioning

New workspaces use `scripts/install-deterministic-heartbeat-cron.js`. The old
`scripts/install-cron.js` remains only for pre-cutover compatibility and must
not be used as the clean-install path. The compatibility payload runs the
runner, claims permitted queued work, spawns each child with a unique
`runtimeLabel` and `expectsCompletionMessage=false`, then emits a concise final
reply. Children persist to an injected absolute `handoffPath` and return
`ANNOUNCE_SKIP` as fallback; that historical form lives in `PROSE_TEMPLATE`.

Current deterministic and compatibility installers omit
`--spawn-rethink`, `--spawn-rethink2`, and `--spawn-autoresearch`. Existing
legacy workspaces retain parser/application compatibility only until the
reviewed cutover command writes its durable marker and migration journal.

Since 2026-07-16 `NEW_PAYLOAD_MARKER_6` requires the durable-handoff/`ANNOUNCE_SKIP` form. Successful apply moves the matching spawn record from `status: spawned` to `status: done`. `delivery.mode=none` remains unchanged.

For a new workspace:

```bash
bun skills/engram/scripts/install-deterministic-heartbeat-cron.js \
  --workspace <path> --agent-id <id> --schedule '*/30 * * * *'
```

For an existing workspace on the old form, re-run the same command — `isOnNewFormat()` returns false and the script emits `openclaw cron edit <id> --message <new>` automatically, preserving agentId, schedule, model, thinking, timeoutSeconds, lightContext, delivery, and sessionKey. The step is idempotent and safe to run repeatedly.

`scripts/validate.js` (cron drift guard) flags any heartbeat job still on the pre-2026-06-23 echo form. See [references/heartbeat-legacy.md §Prompt format history](heartbeat-legacy.md#prompt-format-history) for the two forms, measured impact, and migration steps.

## Domain Supervisor Scan

If subagent domains exist (`memory/domains/`), heartbeat acts as supervisor:

1. **PROPOSAL review** — `qmd query "PROPOSAL" -c domains` → auto-approve low-risk, alert user for high-risk
2. **Liveness check** — read each domain's `status.md`, alert if missed >2x schedule
3. **Changelog rotation** — rotate `changelog.md` >1000 lines to `archives/`
4. **KG extraction** — extract significant facts from changelogs to Knowledge Graph

For full details, see [references/HEARTBEAT.md](HEARTBEAT.md) and [references/subagent-memory.md](subagent-memory.md).

## Subagent Model Resolution

The heartbeat phases are model-agnostic. Model selection uses the canonical semantic phase via `scripts/config.js → resolveSubagentModel(workspace, phase)`, never a workspace-prefixed logical or runtime label. Resolution order:

1. `process.env.ENGRAM_MODEL_<PHASE_UPPER>` — explicit env override
2. `engram.json → models.heartbeat.subagents[phase]` — exact workspace phase mapping
3. selected deployment overlay → exact phase mapping
4. `engram.json → models.default` — grinding phases only
5. `engram.json → models.subagents_default` — legacy grinding-phase alias
6. `OSS_FALLBACK_MODEL = "sonnet-4-6"` — grinding phases only

**Known phases** (`HB_SUBAGENT_PHASES` in `config.js`): hb-extract, hb-synthesis, hb-domains, hb-domains-write, hb-rethink, hb-rethink2, hb-autoresearch.

**Full-reasoning phases** require an exact valid mapping and fail before dispatch rather than falling back to a cheap default.

**Helpers** exported from `scripts/config.js`:
- `getHbSubagentPhases()` → array of all 7 phases
- `isFullReasoningPhase(phase)` → boolean

Example `engram.json` override:
```json
{
  "models": {
    "default": "<your-default-model>",
    "subagents_default": "<your-default-model>",
    "heartbeat": {
      "orchestrator": "<your-cron-orchestrator-model>",
      "subagents": {
        "hb-extract": "<cheap-model>",
        "hb-synthesis": "<capable-model>"
      }
    }
  }
}
```

**On `init.js`:** fresh installs auto-detect the model from `openclaw.json → agents.defaults.model.primary` and inject it into the new `engram.json` template (`assets/templates/engram.json`, placeholders `{AGENT_ID}`, `{COLLECTION_NAME}`, `{MODEL_ID}`).

**Why configurable, not hardcoded:** Engram is model-agnostic. Models are configured per-workspace in `engram.json` (see `models.default` and `models.heartbeat.subagents`). Hardcoding deployment-specific aliases (e.g. `m3`, `m2.7`) in the protocol would leak private infra and break for other users.
