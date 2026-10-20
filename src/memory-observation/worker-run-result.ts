import type { BatchLiveRunResult } from "./batch-live-worker.ts";
import type { DailyNoteApplicatorResult } from "./daily-note-applicator.ts";

/** Execution health is local to this pass. Historical memory health is reported
 * separately and must not repeatedly disable the scheduler that drains new work.
 * Exceptions (invalid state, route/policy failures, etc.) still fail the process.
 */
export function memoryWorkerRunResult(input: {
  evaluations?: readonly Pick<BatchLiveRunResult, "status">[];
  applications?: readonly Pick<DailyNoteApplicatorResult, "status">[];
  domains?: { indexedPending: number } | null;
  blockers?: readonly {reason:string}[];
} = {}) {
  const errors = new Set<string>();
  for (const blocker of input.blockers ?? []) errors.add(`blocked:${blocker.reason}`);
  for (const result of input.evaluations ?? []) {
    if (["retry", "terminal_failure", "blocked"].includes(result.status)) errors.add(`evaluation:${result.status}`);
  }
  for (const result of input.applications ?? []) {
    if (["retry", "terminal_failure", "qmd_pending", "disabled"].includes(result.status)) errors.add(`daily_note:${result.status}`);
  }
  // This is failed dirty-mark delivery, NOT merely an unfinished embedding job.
  if (input.domains?.indexedPending) errors.add("domains:qmd_pending");
  return { status: errors.size ? "error" as const : "ok" as const,
    exitCode: errors.size ? 1 as const : 0 as const, errors: [...errors].sort() };
}
