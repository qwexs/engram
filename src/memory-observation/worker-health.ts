import { isAdmissionGapRecovered } from "./admission-gap-recovery.ts";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Accounting only: never mutates queues or treats an empty queue as success. */
export function memoryWorkerHealth(workspace: string, now = new Date()) {
  const root = join(workspace, "memory-state/memory-observation");
  const records = (path: string): any[] => !existsSync(path) ? [] : readdirSync(path).filter(name => name.endsWith(".json"))
    .map(name => JSON.parse(readFileSync(join(path, name), "utf8")));
  const queue = records(join(root, "v1/queues/evaluator"));
  const terminalOk = new Set(["semantic_batch_write", "semantic_batch_skip", "semantic_batch_grouped_no_assertion", "semantic_write", "semantic_skip", "semantic_skip_noise", "semantic_skip_already_captured", "semantic_skip_incomplete", "pre_activation_not_evaluated"]);
  const pending = queue.filter(row => row.status !== "terminal");
  const failures = queue.filter(row => row.status === "terminal" && !terminalOk.has(row.reasonCode));
  const waiting = pending.filter(row => row.reasonCode === "semantic_batch_defer");
  const checkpoints = records(join(root, "v1/pre-admission/checkpoints"));
  const historicalGaps = checkpoints.filter(row => row.stage === "terminal_gap");
  const recovered = historicalGaps.filter(row => isAdmissionGapRecovered(workspace, row));
  const gaps = historicalGaps.filter(row => !recovered.includes(row));
  const daily = records(join(root, "v1/consumers/daily-note/queue"));
  const dailyFailures = daily.filter(row => row.status === "terminal" && !["canonical_applied", "policy_superseded_before_apply"].includes(row.reasonCode));
  const oldest = pending.map(row => Date.parse(row.createdAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return { status: failures.length || gaps.length || dailyFailures.length ? "degraded" : waiting.length ? "waiting_context" : "ok",
    pending: pending.length, waitingContext: waiting.length, terminalFailures: failures.length, admissionGaps: gaps.length,
    recoveredAdmissionGaps: recovered.length, historicalAdmissionGaps: historicalGaps.length,
    dailyFailures: dailyFailures.length, oldestPendingAgeSeconds: oldest === undefined ? 0 : Math.max(0, Math.round((now.getTime() - oldest) / 1000)),
    reasons: [...new Set([...failures, ...dailyFailures].map(row => String(row.reasonCode)))].sort() };
}
