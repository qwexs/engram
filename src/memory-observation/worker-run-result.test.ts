import { describe, expect, test } from "bun:test";
import { memoryWorkerRunResult } from "./worker-run-result.ts";

describe("memory worker execution result", () => {
  test("idle, deferred work, duplicate delivery and successful writes do not fail a pass", () => {
    expect(memoryWorkerRunResult()).toEqual({ status: "ok", exitCode: 0, errors: [] });
    expect(memoryWorkerRunResult({
      evaluations: [{ status: "idle" }, { status: "busy" }, { status: "completed" }, { status: "duplicate" }],
      applications: [{ status: "applied" }, { status: "duplicate" }, { status: "busy" }],
      domains: { indexedPending: 0 },
    }).exitCode).toBe(0);
  });

  test.each(["retry", "terminal_failure", "blocked"] as const)("a current evaluator %s remains an execution error", status => {
    expect(memoryWorkerRunResult({ evaluations: [{ status }] })).toEqual({
      status: "error", exitCode: 1, errors: [`evaluation:${status}`],
    });
  });

  test.each(["retry", "terminal_failure", "qmd_pending", "disabled"] as const)("a current writer %s is not masked", status => {
    expect(memoryWorkerRunResult({ applications: [{ status }] }).exitCode).toBe(1);
  });

  test("an earlier failure survives a later successful batch and domain dirty-mark failures stay visible", () => {
    expect(memoryWorkerRunResult({ evaluations: [{ status: "retry" }, { status: "completed" }],
      applications: [{ status: "retry" }, { status: "retry" }, { status: "applied" }], domains: { indexedPending: 1 } })).toEqual({
      status: "error", exitCode: 1, errors: ["daily_note:retry", "domains:qmd_pending", "evaluation:retry"],
    });
  });
});

test('a blocked active scope fails execution even when no evaluation ran',()=>{
 expect(memoryWorkerRunResult({blockers:[{reason:'MODEL_TRANSITION_IDENTITY_CHANGED'}]})).toEqual({status:'error',exitCode:1,errors:['blocked:MODEL_TRANSITION_IDENTITY_CHANGED']});
});

test("historical source age remains visible without failing repeated or successful fresh passes", () => {
  for (let pass = 0; pass < 12; pass++) {
    const result = memoryWorkerRunResult({ blockers: [{ reason: "SOURCE_AGE_EXCEEDED" }],
      evaluations: pass % 2 ? [{ status: "completed" }] : [],
      applications: pass % 2 ? [{ status: "applied" }] : [] });
    expect(result).toEqual({ status: "ok", exitCode: 0, errors: [], warnings: ["blocked:SOURCE_AGE_EXCEEDED"] });
  }
  expect(memoryWorkerRunResult({ evaluations: [{ status: "blocked", reason: "source_age_exceeded" }] }))
    .toEqual({ status: "ok", exitCode: 0, errors: [], warnings: ["blocked:SOURCE_AGE_EXCEEDED"] });
});

test("historical warnings cannot hide current failures or arbitrary blockers", () => {
  const result = memoryWorkerRunResult({ blockers: [
    { reason: "SOURCE_AGE_EXCEEDED" }, { reason: "PRODUCER_MIGRATION_INCOMPLETE" },
    { reason: "PROFILE_EXECUTION_REVOKED" }, { reason: "UNKNOWN_BLOCKER" },
  ], evaluations: [{ status: "retry" }, { status: "terminal_failure" }, { status: "completed" }],
  applications: [{ status: "qmd_pending" }, { status: "applied" }], domains: { indexedPending: 1 } });
  expect(result.status).toBe("error"); expect(result.exitCode).toBe(1);
  expect(result.errors).toEqual(["blocked:PRODUCER_MIGRATION_INCOMPLETE", "blocked:PROFILE_EXECUTION_REVOKED",
    "blocked:UNKNOWN_BLOCKER", "daily_note:qmd_pending", "domains:qmd_pending", "evaluation:retry", "evaluation:terminal_failure"]);
  expect(result.warnings).toEqual(["blocked:SOURCE_AGE_EXCEEDED"]);
});
