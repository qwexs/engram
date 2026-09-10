import { isAdmissionGapRecovered } from "./admission-gap-recovery.ts";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { sha256 } from "./ledger.ts";
import { ADMISSION_CHECKPOINT_SCHEMA, ADMISSION_CHECKPOINT_STAGES } from "./admission-store.ts";

export type WorkerStateRow = { path: string; value: Record<string, any> };
export type WorkerReadError = { path: string; error: string };
/** Metadata scan only; a corrupt row is evidence of incomplete accounting, never an empty queue. */
export function readWorkerRows(path: string, errors: WorkerReadError[]): WorkerStateRow[] {
  let names: string[];
  try { names = readdirSync(path); }
  catch (error: any) {
    if (error.code !== "ENOENT") errors.push({ path, error: "directory_unreadable" });
    return [];
  }
  return names.filter(name => name.endsWith(".json")).sort().flatMap(name => {
    const file = join(path, name);
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_record");
      return [{ path: file, value }];
    } catch { errors.push({ path: file, error: "record_unreadable_or_invalid" }); return []; }
  });
}
export const WORKER_STALE_AFTER_SECONDS = 3600;
export function memoryWorkerSnapshot(workspace: string) {
  const root = join(workspace, "memory-state/memory-observation");
  const errors: WorkerReadError[] = [];
  const read = (path: string) => readWorkerRows(join(root, path), errors);
  return { root, observed: existsSync(root), captureObserved: existsSync(join(root, "v1")) || existsSync(join(root, "batch-live-store/memory-batch-live/v1")), errors,
    evaluator: read("v1/queues/evaluator"), daily: read("v1/consumers/daily-note/queue"),
    admission: read("v1/pre-admission/checkpoints"),
    jobs: read("batch-live-store/memory-batch-live/v1/jobs"), done: read("batch-live-store/memory-batch-live/v1/done") };
}
/** Completed operator recovery replaces the old job, not its historical failure evidence. */
function recoveredBatchJob(job: WorkerStateRow): boolean {
  if (!/^sha256:[a-f0-9]{64}$/.test(job.value.jobId)) return false;
  const root = join(dirname(dirname(job.path)), "recoveries", job.value.jobId.slice(7));
  if (!existsSync(root)) return false;
  try {
    return readdirSync(root).filter(name => /^[a-f0-9]{64}$/.test(name)).some(name => {
      try {
        const read = (file: string) => JSON.parse(readFileSync(join(root, name, file), "utf8"));
        const completed = read("completed.json"), authorization = read("authorization.json"), failure = read("failure.json"), done = read("done.json");
        const expectedId = sha256({ schema: "engram.memory-batch-terminal-recovery.v1", jobId: job.value.jobId,
          authorizedBy: completed.authorizedBy, authorizedAt: completed.authorizedAt, reason: completed.reason });
        return completed.schema === "engram.memory-batch-terminal-recovery.v1" && completed.status === "requeued"
          && completed.jobId === job.value.jobId && completed.bundleId === job.value.bundle?.bundleId
          && completed.recoveryId === expectedId && name === expectedId.slice(7)
          && authorization.recoveryId === expectedId && authorization.jobId === job.value.jobId
          && authorization.doneDigest === sha256(done) && authorization.failureDigest === sha256(failure)
          && done.jobId === job.value.jobId && sha256(done) === sha256(failure)
          && Array.isArray(authorization.queues) && authorization.queues.length > 0
          && sha256(completed.traceIds) === sha256(authorization.traceIds)
          && authorization.queues.every((queue: any) => queue.originalDigest === sha256(queue.original) && queue.requeuedDigest === sha256(queue.requeued)
            && queue.original.traceId === queue.traceId && queue.requeued.traceId === queue.traceId && queue.requeued.status === "queued");
      } catch { return false; }
    });
  } catch { return false; }
}
/** Accounting only: never mutates queues or changes the process-success contract. */
export function memoryWorkerHealth(workspace: string, now = new Date(), options: { staleAfterSeconds?: number; claimTtlSeconds?: number } = {}) {
  const snapshot = memoryWorkerSnapshot(workspace);
  const { evaluator, daily, admission, jobs, done, errors } = snapshot;
  const staleAfterSeconds = options.staleAfterSeconds ?? WORKER_STALE_AFTER_SECONDS;
  const claimTtlSeconds = options.claimTtlSeconds ?? 300;
  const terminalOk = new Set(["semantic_batch_write", "semantic_batch_skip", "semantic_batch_grouped_no_assertion", "semantic_write", "semantic_skip", "semantic_skip_noise", "semantic_skip_already_captured", "semantic_skip_incomplete", "pre_activation_not_evaluated"]);
  const dailyOk = new Set(["canonical_applied", "duplicate_receipt", "policy_superseded_before_apply"]);
  for (const [rows, statuses] of [[evaluator, ["queued", "claimed", "terminal"]], [daily, ["queued", "claimed", "qmd_pending", "terminal"]]] as const) {
    for (const row of rows) if (!statuses.includes(row.value.status)) errors.push({ path: row.path, error: "invalid_queue_status" });
  }
  for (const [rows, schema] of [[evaluator, "engram.memory-observation-ledger-queue.v1"], [daily, "engram.memory-observation-consumer-queue.v1"], [admission, ADMISSION_CHECKPOINT_SCHEMA]] as const) {
    for (const row of rows) if (row.value.schema !== schema) errors.push({ path: row.path, error: "invalid_record_schema" });
  }
  for (const row of [...evaluator, ...daily]) if (row.value.status === "claimed" && !Number.isFinite(Date.parse(row.value.claimedAt))) errors.push({ path: row.path, error: "invalid_claim_timestamp" });
  for (const row of admission) if (!(ADMISSION_CHECKPOINT_STAGES as readonly string[]).includes(row.value.stage)) errors.push({ path: row.path, error: "invalid_admission_stage" });
  const pending = evaluator.filter(row => row.value.status !== "terminal");
  const dailyPending = daily.filter(row => row.value.status !== "terminal");
  const admissionPending = admission.filter(row => !["terminal_gap", "ledger_admitted"].includes(row.value.stage));
  const doneIds = new Set(done.map(row => row.value.jobId));
  const unfinishedJobs = jobs.filter(row => !row.value.jobId || !doneIds.has(row.value.jobId));
  const recoveredJobs = unfinishedJobs.filter(recoveredBatchJob);
  const batchPending = unfinishedJobs.filter(row => !recoveredJobs.includes(row));
  const failures = evaluator.filter(row => row.value.status === "terminal" && !terminalOk.has(row.value.reasonCode));
  const dailyFailures = daily.filter(row => row.value.status === "terminal" && !dailyOk.has(row.value.reasonCode));
  const waiting = pending.filter(row => row.value.reasonCode === "semantic_batch_defer");
  const historicalGaps = admission.filter(row => row.value.stage === "terminal_gap");
  // Native command sessions never promise a conversational completion pair
  // (captureMessageReceived ignores them). Preserve, but classify, old gaps.
  const nativeCommandGaps = historicalGaps.filter(row => /^agent:[^:]+:telegram:slash:[^:]+$/.test(row.value.scope?.runtimeSessionKey ?? ""));
  const conversationalGaps = historicalGaps.filter(row => !nativeCommandGaps.includes(row));
  const recovered = conversationalGaps.filter(row => isAdmissionGapRecovered(workspace, row.value as any));
  const gaps = conversationalGaps.filter(row => !recovered.includes(row));
  const age = (row: WorkerStateRow) => {
    const created = Date.parse(row.value.createdAt);
    if (!Number.isFinite(created)) { errors.push({ path: row.path, error: "invalid_pending_timestamp" }); return 0; }
    return Math.max(0, Math.round((now.getTime() - created) / 1000));
  };
  const stages = Object.fromEntries(Object.entries({ evaluator: pending, daily: dailyPending, admission: admissionPending, batch: batchPending })
    .map(([stage, rows]) => {
      const ages = rows.map(age);
      const overdue = rows.filter(row => {
        const due = Date.parse(row.value.nextAttemptAt ?? row.value.expiresAt ?? row.value.createdAt);
        return Number.isFinite(due) && (now.getTime() - due) / 1000 > staleAfterSeconds;
      });
      return [stage, { pending: rows.length, oldestPendingAgeSeconds: Math.max(0, ...ages), stale: ages.filter(value => value > staleAfterSeconds).length, overdue: overdue.length }];
    }));
  const expiredClaims = [...pending, ...dailyPending].filter(row => row.value.status === "claimed"
    && Number.isFinite(Date.parse(row.value.claimedAt)) && now.getTime() - Date.parse(row.value.claimedAt) > claimTtlSeconds * 1000).length;
  const stalled = Object.values(stages).some(stage => stage.stale || stage.overdue);
  const totalPending = pending.length + dailyPending.length + admissionPending.length + batchPending.length;
  return { status: failures.length || gaps.length || dailyFailures.length || errors.length || stalled || expiredClaims ? "degraded" : !snapshot.captureObserved ? "not_observed" : waiting.length ? "waiting_context" : totalPending ? "pending" : "ok",
    pending: pending.length, totalPending, waitingContext: waiting.length, terminalFailures: failures.length, admissionGaps: gaps.length,
    recoveredAdmissionGaps: recovered.length, historicalAdmissionGaps: historicalGaps.length, nativeCommandGaps: nativeCommandGaps.length,
    dailyPending: dailyPending.length, qmdPending: dailyPending.filter(row => row.value.status === "qmd_pending" || row.value.phase === "qmd").length,
    admissionPending: admissionPending.length, batchPending: batchPending.length, recoveredBatchJobs: recoveredJobs.length, expiredClaims,
    dailyFailures: dailyFailures.length, oldestPendingAgeSeconds: Math.max(0, ...Object.values(stages).map(stage => stage.oldestPendingAgeSeconds)),
    stages, corruptRecords: errors.length, errors,
    reasons: [...new Set([...failures, ...dailyFailures].map(row => String(row.value.reasonCode)))].sort() };
}
