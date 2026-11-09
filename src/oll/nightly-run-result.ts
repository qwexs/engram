import type { NightlyCoordinatorReportV1 } from "./nightly-coordinator";

/** A terminal coordinator batch can still contain failed workspaces. Preserve
 * that report, but never let a scheduler mistake it for fleet-wide success. */
export function nightlyRunResult(report: NightlyCoordinatorReportV1) {
  const ok = report.status === "completed" && report.failed.length === 0 && (report.quarantined?.length || 0) === 0;
  return {
    exitCode: ok ? 0 : 1,
    result: { status: ok ? "completed" : "incomplete", report },
  };
}
