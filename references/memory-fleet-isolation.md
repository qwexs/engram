# Memory topic fleet: partial-failure isolation (ISS-19)

The existing sequential fleet and per-workspace workers remain separate: no
cross-workspace model context, queue, or writer is introduced. No host patches,
additional model, scheduler, or worker retry queue are needed.

Enable explicitly in the approved fleet manifest:

```json
{
  "failureIsolation": {
    "stateDir": "/absolute/non-indexed/operations/fleet-health",
    "operator": { "channel": "telegram", "target": "OPERATOR_DIRECT_CHAT_ID", "accountId": "default" },
    "cooldownMs": 21600000
  }
}
```

Replace the placeholder with the authorized operator's positive numeric direct
chat ID. Group targets are rejected. The route is configuration, never inferred
from project data. Existing manifests without this block keep their old exit
semantics. Configure only after a delivery probe with the deployment identity.

## Result contract

- Each child is awaited sequentially with its own canonical workspace/projection
  validation and 300-second deadline. Exceptions and timeouts do not break the loop.
- A timed-out process group is killed (including child processes). Output tails
  are bounded and stdout/stderr drained concurrently. Completed child metadata is
  emitted to stderr to avoid no-output timeouts in a long pass.
- `passes.jsonl` is append-only metadata, `latest.json` the atomic current pass.
  Neither contains source text. Existing per-workspace queues/receipts retain
  processing details. The fleet requests Worker `--summary` and emits complete
  compact JSON with `reportMode: "compact-status-counts"`, not sliced child JSON.
  Per-workspace summaries retain execution status, blocked reasons, evaluated
  source count, pending count and open-debt count, including in `latest.json`.
  `reportingVersion: 2` and `passCounts` distinguish workspace executions without
  errors from healthy empty passes, passes that did work, and passes whose
  activity is unverified. These count workspaces, not saved messages or facts.
  `workState: idle` requires the Worker's explicit `no_pending_work` fast path;
  deferred/unknown activity is never called an empty completed queue.
  Consumers of old `output`
  strings must switch to these explicit fields; raw bodies remain in canonical
  private stores rather than the compact scheduler result.
- All healthy: status `ok`, exit 0.
- Some failed: `partial_failure`, exit 0 **only after** durable reporting and a
  confirmed operator alert, or a matching previously confirmed alert in cooldown.
  Cron `ok` now means the dispatcher completed, not that all memory writes succeeded.
  Consumers must inspect `status`/per-workspace results for memory health.
- All failed: status `failed`, exit 1, even during alert cooldown. System-wide
  outages still reach the scheduler's normal failure/auto-disable mechanism.
- Reporting failure, corrupted alert state, or failed/unconfirmed notification:
  exit 1. Do not claim partial success without visibility. This deliberately means
  failure of the shared monitoring infrastructure can still stop the fleet.

An active scope blocked on model/quality lineage or a producer-migration barrier
is not healthy idle. The CLI returns sanitized scope blocker codes and a failing
execution result. Fleet independently checks the JSON schema, workspace identity,
execution status and blockers, so even a zero child exit cannot conceal a
reported block. Unparseable/truncated or foreign output is `unverified`, not
green. Migration barrier outcomes are explicit `blocked` results before ordinary
discovery/claim; no model is called and no source budget is spent.

## Historical completeness is separate from execution

Historical alerts additionally separate `confirmedCompleted`, `failedRuns`,
`completionUnverified`, `identityUnverified` and `unclassified` open identities.
These presentation counts come from checksummed immutable source-debt metadata,
exclude verified closures/write-offs, and must sum to the exact open set. Mixed
classifications stay unknown rather than inferring successful completion. Legacy
snapshots without the optional breakdown remain explicitly unclassified. A new
breakdown does not close an incident or authorize replay; it clarifies that open
source identities are not a count of lost business facts.

Protected host `steerTargetRunId` identifies an additional input to an existing
run, not a new standalone source/run pair. The runtime adapter keeps it as an
optional checksummed checkpoint field and excludes that candidate from selecting
the next ordinary request. Restart/replay preserve the field; conflicting target
changes fail closed. Unverified steering still follows the existing expiry and
gap policy and is never silently converted into a semantic skip or recovered
source. A late transcript `runId` annotation alone is not proof it was available
to the earlier write hook.

Opt in to administrative source-debt reporting with an explicit subset of
existing manifest owners:

```json
{
  "memoryCompletenessWorkspaceIds": ["example-project"]
}
```

This option requires the configured `failureIsolation` direct operator route;
unknown/duplicate workspace IDs are rejected. It does not add readers, model
context or QMD grants between workspaces. A successful or empty Worker pass
does not close historical incidents.

`memory-incidents.json` retains per-workspace debt IDs and delivery acknowledgements.
Fresh, digest-verified `sourceDebtSnapshot` results alone can prove closure;
missing, corrupt, stale or foreign snapshots stay unverified. Notifications can
report partial recovery without declaring every source restored. A history with
no incident is `not_observed`, not proof of a complete historical inventory.
Operator notifications use a separate `WS <workspaceId>` line for each affected
workspace, including its open historical source count and current pass status.
The fleet passes that workspace's execution result directly to completeness
reporting; missing or foreign execution metadata cannot imply success. Current
timeouts, blocked-scope codes and sanitized execution-stage codes remain distinct
from historical debt. A successful current pass is explicitly not recovery.
Current failure reasons are handled by execution reporting and do not change the
historical incident fingerprint. This prevents error/idle flapping from
repeating a historical-debt alert. Fresh incident changes and proof-backed
closures notify immediately; unchanged open/unverified reports use the configured
cooldown. An unavailable first snapshot is unverified and alerts even when there
is no previously known incident. Write-offs and proof-backed closures retain separate
per-workspace accounting. No transcript/provider diagnostics are relayed.
All live incident files contain private administrative identities and must stay
outside public source/fixtures. See [source debt](memory-source-debt.md).

Alerts are sent with shell-free `openclaw message send` using existing host auth;
no keys are passed in argv/env or copied into state. A real matching Telegram
message receipt is mandatory. `alert.json` v2 stores independent receipts for
each scheduler/route/workspace/failure-signature. The same signature is suppressed
for six hours (configurable), including across healthy/idle passes and alternating
failed workspace sets. A new failed workspace or new error signature notifies
immediately; its notification may also summarize the other currently failing
workspaces. Successful passes do not acknowledge memory recovery. Existing v1
receipts migrate without resending their matching acknowledged failure set.
Only confirmed sends advance receipts; expired receipts are pruned. Invalid
state fails closed. If delivery succeeds but the process stops before persisting
the acknowledgement, the next pass may repeat the alert (at-least-once delivery).
No claim of exactly-once messaging is made. Processing dedup remains the worker's
existing receipt contract.

## Verification / rollback

Run `bun test src/memory-observation/fleet-isolation.test.ts` and typecheck. Check
real operator delivery separately without running project workers. After opt-in,
inspect a naturally scheduled `latest.json` and the fleet's next completed run;
do not inject failures into production memory for this test.
When running Worker CLI tests on the live host, give the tests a dedicated
`TMPDIR` inherited by their child processes: the inference lease is shared by
OS user and temporary root. Do not contend with or remove production leases.

Rollback: remove `memoryCompletenessWorkspaceIds` together with `failureIsolation`
from the approved manifest atomically if completeness reporting was enabled.
Old fail-closed aggregate exit policy resumes. Preserve health history; no memory
queue, projection, or assertion rollback is needed. No Gateway restart is needed:
this is a standalone command-cron entrypoint, not a loaded plugin change.
For a source-code rollback to a v1-only reporter, archive the v2 alert file and
restore its pre-rollout v1 receipt as part of the same bounded rollback. Do not
erase the append-only pass journal or incident history.
