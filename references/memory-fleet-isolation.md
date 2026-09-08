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
  processing details; the normal fleet stdout still contains bounded diagnostics.
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

Alerts are sent with shell-free `openclaw message send` using existing host auth;
no keys are passed in argv/env or copied into state. A real matching Telegram
message receipt is mandatory. The same failed workspace/code set is suppressed
for six hours (configurable); a changed set or failure after a healthy pass alerts
again immediately. If delivery succeeds but the process stops before persisting
the acknowledgement, the next pass may repeat the alert (at-least-once delivery).
No claim of exactly-once messaging is made. Processing dedup remains the worker's
existing receipt contract.

## Verification / rollback

Run `bun test src/memory-observation/fleet-isolation.test.ts` and typecheck. Check
real operator delivery separately without running project workers. After opt-in,
inspect a naturally scheduled `latest.json` and the fleet's next completed run;
do not inject failures into production memory for this test.

Rollback: remove only `failureIsolation` from the approved manifest atomically.
Old fail-closed aggregate exit policy resumes. Preserve health history; no memory
queue, projection, or assertion rollback is needed. No Gateway restart is needed:
this is a standalone command-cron entrypoint, not a loaded plugin change.
