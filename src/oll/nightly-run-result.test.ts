import { expect, test } from "bun:test";
import type { NightlyCoordinatorReportV1 } from "./nightly-coordinator";
import { nightlyRunResult } from "./nightly-run-result";

const report: NightlyCoordinatorReportV1 = {
  schema: "oll.nightly-coordinator-report.v1", batchId: "synthetic-batch",
  resumed: false, status: "completed", completed: ["alpha"], failed: [],
  skipped: ["alpha"], processingOrder: ["alpha"], spawned: 0,
  maxConcurrentRethinkRuns: 0, registrySnapshotPath: "/synthetic/registry.json",
};

test("a completed batch with a failed workspace is a scheduler failure, without hiding its report", () => {
  const partial = { ...report, failed: ["beta"] };
  expect(nightlyRunResult(partial)).toEqual({ exitCode: 1, result: { status: "incomplete", report: partial } });
  expect(partial.failed).toEqual(["beta"]);
});

test("cancellation and unfinished batches cannot become fleet success merely because failed is empty", () => {
  for (const status of ["cancelled", "pending", "applying", "failed"]) {
    expect(nightlyRunResult({ ...report, status }).exitCode).toBe(1);
  }
});

test("completed skips and diagnostic-only shadow compiler failures retain their success semantics", () => {
  expect(nightlyRunResult(report).exitCode).toBe(0);
  expect(nightlyRunResult({ ...report, candidateShadow: { attempted: 1, succeeded: 0, failed: 1 } }).exitCode).toBe(0);
});
